// routes/caisse.js — Caisse : paiements, sorties de caisse, autres revenus, annulation d'un paiement.
// Découpé de server.js le 23/10 sans changer une ligne de logique : le texte des routes est celui d'avant. Ce module reçoit de server.js
// l'application Express et ses dépendances partagées (base, droits, journal d'audit, lecteurs communs) ; voir « montage des routes » dans server.js.
const { validerPaiementPartiel, soldeAjouteParPaiement } = require('../utils/paiementPartiel');
const { middlewareHeureServeur, appliquerHeureAuPaiement, estRejeu, ENTETE_HEURE } = require('../utils/heureServeur');
const { validerMontantPaiement, normaliserMontant } = require('../utils/validationMontant');
const { estFonctionAbsente, estRefusRemboursement, messageRefusRemboursement } = require('../utils/soldeAtomique');
const { verifierTotalFiche, verifierPaiementContreFiche, MODES_VENTE } = require('../utils/verificationPrixFiche');
const { estAutorisateurSortieCaisse, MESSAGE_AUTORISATEUR_INVALIDE } = require('../utils/autorisateursSortieCaisse');

module.exports = function monterCaisse(app, { aPermission, calculerSoldeDepot, enregistrerAuditServeur, estUnVraiUuid, lireToutesLesPages, supabase, synchroListes }) { // @enveloppe
// Route : récupération des paiements
// Faille trouvée le 27/08 (audit avant mise en production) : cette route renvoyait TOUTE la
// table paiements (montants, modes, motifs de transfert...) à n'importe quel utilisateur
// authentifié, sans vérifier fiche_patient_voir_finances — un archiviste ou un infirmier
// pouvait ainsi contourner, en appelant directement l'API, la même restriction déjà appliquée
// correctement sur GET /api/dossiers/:id/historique ("ne peuvent pas voir si le patient a un
// solde ou statut de paiement", retour d'Esdras du 26/08). caisse_travailler et
// demandes_repondre ajoutés en plus de fiche_patient_voir_finances : Demandes.js (approbation
// d'exonération) en a besoin sans que demandes_repondre implique nécessairement l'autre
// permission. rapport_chf_voir volontairement EXCLU (il ne montre aucun montant). Depuis le 30/09,
// infirmier_chef et medecin voient les paiements via fiche_patient_voir_finances (choix explicite).
app.get('/api/paiements', async (req, res) => {
  // caisse_voir (28/08) ajouté : le tableau de bord Caisse en lecture seule (visiteur) a besoin
  // des mêmes paiements que la version normale pour calculer sa ventilation/rapport partenaire.
  if (!(await aPermission(req.user.id, 'fiche_patient_voir_finances')) && !(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'demandes_repondre')) && !(await aPermission(req.user.id, 'caisse_voir'))) {
    return res.status(403).json({ error: "Permission 'fiche_patient_voir_finances', 'caisse_travailler', 'demandes_repondre' ou 'caisse_voir' requise." });
  }
  // Paginée (voir lireToutesLesPages) : cette route alimente la fiche de caisse, le rapprochement
  // et les rapports partenaires. Un plafond de lignes côté Supabase aurait fait disparaître les
  // paiements les plus ANCIENS sans la moindre erreur — un manque d'argent invisible dans les
  // comptes. `.order('id')` en second rend le tri total, obligatoire dès qu'on pagine.
  try {
    if (req.query.synchro === '1') return res.json(await synchroListes.paiements(req.query.depuis || null));
    res.json(await lireToutesLesPages(
      () => supabase.from('paiements').select('*').is('supprime_le', null).order('date_paiement', { ascending: false }).order('id')));
  } catch (e) {
    console.error('GET /api/paiements: lecture paginée échouée :', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Audit du 21/10 (rappel d'Esdras : exonération et paiement partiel) : le montant d'une LIGNE DE PAIEMENT n'était jamais comparé à sa fiche — une caissière pouvait
// enregistrer 500 Gdes pour une fiche de 5000 en espèces et garder la différence. Total de la fiche = montant versé + dépôt déduit + exonération (accordée par la direction)
// + reste dû plus tard (crédit ou paiement partiel) : voir utils/verificationPrixFiche.js::verifierPaiementContreFiche. Placé AVANT la route (et non dedans) : même patron
// que les autres contrôles, et la route elle-même garde exactement la même forme. Les modes qui ne sont pas une vente (dépôt, remboursements) ne passent pas par ici.
app.use('/api/paiements', async (req, res, next) => {
  if (req.method !== 'POST' || (req.path !== '/' && req.path !== '') || !req.body || !MODES_VENTE.includes(req.body.mode)) return next();
  try {
    if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'demandes_repondre'))) return next(); // la route répondra 403
    const corps = req.body;
    const localId = corps.local_id || corps.localId || null;
    if (localId) {
      const { data: dejaLa } = await supabase.from('paiements').select('id').eq('local_id', localId).maybeSingle();
      if (dejaLa) return next(); // rejeu : déjà enregistré (et déjà vérifié à ce moment-là)
    }
    let fiche = null;
    if (estUnVraiUuid(corps.fiche_id)) {
      ({ data: fiche } = await supabase.from('fiches').select('id, episode_id, total_global, supprime_le').eq('id', corps.fiche_id).maybeSingle());
    }
    if (!fiche && localId) {
      ({ data: fiche } = await supabase.from('fiches').select('id, episode_id, total_global, supprime_le').eq('local_id', localId).maybeSingle());
    }
    if (!fiche && localId && localId.endsWith('-paiement')) { // ⚡ Achat Express : la fiche est créée avec l'épisode, qui porte le même identifiant sans le suffixe
      const { data: episodeExpress } = await supabase.from('episodes').select('id').eq('local_id', localId.slice(0, -'-paiement'.length)).maybeSingle();
      if (episodeExpress) {
        const { data: fichesExpress } = await supabase.from('fiches').select('id, episode_id, total_global, supprime_le').eq('episode_id', episodeExpress.id).is('supprime_le', null);
        if (fichesExpress && fichesExpress.length === 1) fiche = fichesExpress[0];
      }
    }
    // HORS LIGNE (rejeu de la file d'attente) : jamais refusé — l'argent est déjà pris et le reçu remis ; un refus ferait PERDRE la transaction (échec définitif dans la file du
    // téléphone). On enregistre et on SIGNALE à la direction (journal d'audit, action sensible). En ligne, le refus reste immédiat.
    const rejeu = estRejeu(req);
    const refuserOuSignaler = (erreur, details) => {
      if (rejeu) {
        enregistrerAuditServeur(req, 'paiement_suspect', { episode_id: corps.episode_id || null, fiche_id: fiche ? fiche.id : null, montant: corps.montant, mode: corps.mode, erreur, hors_ligne: true, ...details });
        return next();
      }
      enregistrerAuditServeur(req, 'paiement_refuse', { episode_id: corps.episode_id || null, fiche_id: fiche ? fiche.id : null, montant: corps.montant, mode: corps.mode, erreur, ...details });
      return res.status(400).json({ error: erreur, code: 'PAIEMENT_FICHE_INCOHERENT' });
    };
    if (fiche && fiche.supprime_le) return refuserOuSignaler('Cette fiche est supprimée : le paiement ne peut pas lui être rattaché.');
    if (fiche && corps.episode_id && fiche.episode_id !== corps.episode_id) return refuserOuSignaler("Ce paiement est rattaché à la fiche d'un autre dossier.");
    let soldeDepotDisponible = 0;
    if (corps.details && Number(corps.details.montant_depot_utilise) > 0 && corps.episode_id) {
      const { data: paiementsEpisode } = await supabase.from('paiements').select('*').eq('episode_id', corps.episode_id).or('annule.eq.false,annule.is.null').is('supprime_le', null);
      soldeDepotDisponible = calculerSoldeDepot(paiementsEpisode || []).soldeDepot;
    }
    // Trouvé en TESTANT hors ligne sur le vrai site (21/10) : deux ventes de suite hors ligne déduisaient chacune le MÊME dépôt (l'app ne sait pas encore, pendant la coupure, que la
    // 1re vient de le consommer) — 1 100 Gdes de dépôt « utilisés » pour 1 000 déposés, 100 Gdes que le patient ne devait plus au registre. Au REJEU (vente déjà faite, argent déjà
    // pris), le serveur ramène le dépôt à ce qui existe vraiment et met l'EXCÉDENT en dette (reste à payer) : le total de la fiche reste exact, rien n'est refusé, la direction est prévenue.
    const depotDemande = Number(corps.details && corps.details.montant_depot_utilise) || 0;
    if (rejeu && fiche && depotDemande > soldeDepotDisponible + 0.02) {
      const arrondi = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
      const depotReel = Math.max(0, arrondi(soldeDepotDisponible));
      const excedent = arrondi(depotDemande - depotReel);
      corps.details = { ...corps.details, depot_excedentaire_en_dette: excedent };
      if (depotReel > 0) corps.details.montant_depot_utilise = depotReel; else delete corps.details.montant_depot_utilise;
      const montantPaye = Number(corps.montant) || 0;
      if (corps.mode === 'credit') {
        corps.solde_restant = arrondi((Number(corps.solde_restant) || 0) + excedent);
      } else if (corps.details.paiement_partiel === true) {
        corps.solde_restant = arrondi((Number(corps.solde_restant) || 0) + excedent);
        corps.details.reste = arrondi((Number(corps.details.reste) || 0) + excedent);
      } else if (['cash', 'moncash', 'virement', 'cheque'].includes(corps.mode)) {
        if (montantPaye > 0) Object.assign(corps.details, { paiement_partiel: true, total_fiche: Number(fiche.total_global) || 0, montant_paye: montantPaye, reste: excedent }), corps.solde_restant = excedent;
        else { corps.mode = 'credit'; corps.solde_restant = excedent; }
      }
      enregistrerAuditServeur(req, 'paiement_depot_corrige', { episode_id: corps.episode_id || null, fiche_id: fiche.id, depot_demande: depotDemande, depot_disponible: depotReel, mis_en_dette: excedent, mode: corps.mode });
    }
    const verdict = verifierPaiementContreFiche({ corps, fiche, soldeDepotDisponible });
    if (!verdict.ok) return refuserOuSignaler(verdict.erreur);
    return next();
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Route : création d'un paiement — idempotente via local_id, même principe que /api/fiches.
// Appelée depuis la caisse (caisse_travailler), l'approbation d'une exonération
// (demandes_repondre) ET l'enregistrement d'un remboursement de crédit (Fiche Patient) — d'où
// aussi caisse_travailler puisque manier de l'argent reste une action de caisse.
app.post('/api/paiements', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'demandes_repondre'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' ou 'demandes_repondre' requise." });
  }
  // Même correctif que POST /api/fiches ci-dessus (faille d'audit du 21/10) : seule la direction (demandes_repondre) peut enregistrer un paiement d'exonération.
  // 22/10 (Esdras) : la caisse accorde aussi (exoneration_accorder). Hors direction : motif obligatoire (en ligne ; un rejeu hors ligne n'est jamais refusé) et ligne « exoneration_accordee_caisse » dans le journal d'audit.
  let auditExoneration = null; // écrit seulement une fois le paiement réellement enregistré
  if (req.body.mode === 'exoneration') {
    const parLaDirection = await aPermission(req.user.id, 'demandes_repondre');
    if (!parLaDirection && !(await aPermission(req.user.id, 'exoneration_accorder'))) {
      return res.status(403).json({ error: "Tu n'as pas le droit d'accorder une exonération (permission 'exoneration_accorder' ou 'demandes_repondre').", code: 'EXONERATION_NON_AUTORISEE' });
    }
    if (!parLaDirection) {
      const exo = (req.body.exoneration && typeof req.body.exoneration === 'object') ? req.body.exoneration : {};
      const motifExo = typeof exo.motif === 'string' ? exo.motif.trim() : '';
      const rejeuExo = estRejeu(req);
      if (motifExo.length < 3 && !rejeuExo) {
        return res.status(400).json({ error: "Écris le motif de l'exonération (3 caractères au moins).", code: 'MOTIF_EXONERATION_REQUIS' });
      }
      auditExoneration = {
        fiche_id: req.body.fiche_id || req.body.ficheId || null, episode_id: req.body.episode_id || null, patient: req.body.patient_nom || null,
        montant_exonere: Number(exo.montantExonere) || null, pourcentage: Number(exo.pourcentage) || null, motif: motifExo || null, rejeu: rejeuExo,
      };
    }
  }
  const local_id = req.body.local_id || req.body.localId;
  if (local_id) {
    const { data: existant } = await supabase.from('paiements').select('*').eq('local_id', local_id).maybeSingle();
    if (existant) return res.status(200).json(existant);
  }

  const corps = { ...req.body };
  // Heure RÉELLE (13/10) : en direct, l'heure du serveur fait foi ; un rejeu de la file hors ligne garde l'heure corrigée de l'app (jamais dans le futur).
  appliquerHeureAuPaiement(corps, req);

  // Montant contrôlé AVANT tout calcul de solde : un montant négatif ou illisible fausserait les soldes, les totaux et l'écart de caisse.
  const erreurMontant = validerMontantPaiement(corps);
  if (erreurMontant) return res.status(400).json({ error: erreurMontant });
  normaliserMontant(corps);

  // Paiement partiel (13/10) : montant versé + reste dû sur UNE ligne — voir utils/paiementPartiel.js.
  const erreurPartiel = validerPaiementPartiel(corps);
  if (erreurPartiel) return res.status(400).json({ error: erreurPartiel });

  // Solde ATOMIQUE (13/10, liste de contrôle fintech d'Esdras : « deux retraits en même temps ne doivent pas dépenser le même argent »). Lire le dernier solde puis
  // écrire le paiement en deux temps laissait deux paiements simultanés du même épisode partir du même ancien solde (le 2e écrasait le report du 1er). La fonction
  // enregistrer_paiement_atomique (sql/solde_atomique.sql) fait lecture + calcul + écriture d'un seul bloc, sous un verrou par épisode. Tant que ce script SQL n'est pas
  // appliqué en base, on retombe sur l'ancien chemin ci-dessous (inchangé) : jamais une panne.
  if (corps.mode === 'remboursement_credit' && !corps.episode_id) return res.status(400).json({ error: 'episode_id requis pour un remboursement de crédit.' });
  {
    const ajout = corps.mode === 'remboursement_credit' || !corps.episode_id ? 0 : soldeAjouteParPaiement(corps);
    const { data: dataAtomique, error: erreurAtomique } = await supabase.rpc('enregistrer_paiement_atomique', {
      p_corps: { ...corps, local_id: local_id || null }, p_ajout: ajout, p_remboursement_credit: corps.mode === 'remboursement_credit',
      p_heure_serveur: !estRejeu(req), // en direct : la base date le paiement sous le verrou ; rejeu hors ligne : date de l'appareil gardée
    });
    if (!erreurAtomique) { if (auditExoneration) enregistrerAuditServeur(req, 'exoneration_accordee_caisse', auditExoneration); return res.status(201).json(dataAtomique); }
    if (estRefusRemboursement(erreurAtomique)) return res.status(400).json({ error: messageRefusRemboursement(erreurAtomique) });
    if (erreurAtomique.code === '23505') {
      const { data: existant } = local_id ? await supabase.from('paiements').select('*').eq('local_id', local_id).maybeSingle() : { data: null };
      if (existant) return res.status(200).json(existant);
    }
    if (!estFonctionAbsente(erreurAtomique)) return res.status(500).json({ error: erreurAtomique.message });
    // Fonction pas encore en base : ancien chemin (lecture puis écriture), voir plus bas.
  }

  // Le solde de crédit d'un épisode = le solde_restant de son DERNIER paiement non annulé. C'est
  // la définition utilisée partout : Créances (DashboardCaisse), statut et plafond de
  // remboursement (Fiche Patient), solde affiché au Calculateur, et le remboursement ci-dessous.
  // Un paiement ANNULÉ ne doit jamais servir de référence (24/08, audit financier).
  // .is('supprime_le', null) (25/09, audit avant mise en production) : depuis la corbeille 30 jours
  // (12/09), supprimer une fiche ne fait plus disparaître ses paiements, elle les MARQUE — mais
  // cette lecture ne regardait pas la marque. Une fiche à crédit supprimée restait donc la
  // référence du solde : la dette effacée continuait d'être due, et se reportait sur chaque
  // nouveau paiement de l'épisode (voir le report juste en dessous).
  const lireSoldeEpisode = async (episodeId) => {
    const { data, error } = await supabase
      .from('paiements').select('solde_restant').eq('episode_id', episodeId)
      .or('annule.eq.false,annule.is.null').is('supprime_le', null)
      .order('date_paiement', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    return (data && data.solde_restant) || 0;
  };

  // ⚠️ Correctif majeur (audit du 01/09) — une dette pouvait DISPARAÎTRE toute seule.
  // Le navigateur envoie solde_restant = 0 pour tout paiement qui n'est pas à crédit (voir
  // CalculateurPanel.js), et n'en envoie aucun pour un dépôt. Comme le solde de l'épisode se lit
  // sur le DERNIER paiement, n'importe quel paiement postérieur remettait la dette à zéro :
  //   - un patient hospitalisé dont la fiche du lendemain est réglée en cash ;
  //   - un patient qui doit encore de l'argent et qui laisse un dépôt pour une prochaine visite.
  // Dans les deux cas la créance disparaissait de la liste des Créances, du tableau de bord
  // Direction et de la Fiche Patient — et le serveur refusait ensuite tout remboursement
  // ("Aucun solde de crédit à rembourser"). L'hôpital cessait purement et simplement de réclamer
  // cet argent, sans que rien ne le signale.
  // Le solde est donc REPORTÉ sur chaque nouveau paiement de l'épisode : un crédit s'ajoute à ce
  // qui était déjà dû, tout autre mode le laisse inchangé. Sur un épisode sans dette (le cas de
  // loin le plus fréquent), le report vaut 0 : comportement rigoureusement identique à avant.
  if (corps.mode === 'remboursement_credit') {
    if (!corps.episode_id) return res.status(400).json({ error: 'episode_id requis pour un remboursement de crédit.' });
    let soldeActuel;
    try { soldeActuel = await lireSoldeEpisode(corps.episode_id); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    const montant = parseFloat(corps.montant) || 0;
    if (soldeActuel <= 0) return res.status(400).json({ error: 'Aucun solde de crédit à rembourser pour cet épisode.' });
    if (montant <= 0) return res.status(400).json({ error: 'Le montant du remboursement doit être supérieur à 0.' });
    if (montant > soldeActuel) return res.status(400).json({ error: `Le remboursement (${montant} Gdes) dépasse le solde restant (${soldeActuel} Gdes).` });
    corps.solde_restant = soldeActuel - montant;
  } else if (corps.episode_id) {
    let soldeAnterieur;
    try { soldeAnterieur = await lireSoldeEpisode(corps.episode_id); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    const soldeDeCePaiement = soldeAjouteParPaiement(corps);
    corps.solde_restant = soldeAnterieur + soldeDeCePaiement;
  }

  const { data, error } = await supabase
    .from('paiements')
    .insert({ ...corps, local_id: local_id || null })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') {
      const { data: existant } = await supabase.from('paiements').select('*').eq('local_id', local_id).maybeSingle();
      if (existant) return res.status(200).json(existant);
    }
    return res.status(500).json({ error: error.message });
  }
  if (auditExoneration) enregistrerAuditServeur(req, 'exoneration_accordee_caisse', auditExoneration);
  res.status(201).json(data);
});

// Retour d'Esdras (31/08) : "on a l'habitude de retirer de l'argent à la caisse pour faire des
// achats" — une pratique réelle jamais tracée nulle part jusqu'ici (table depenses_caisse déjà
// créée, mais aucune route ni aucun écran ne la touchait — confirmé par recherche dans les 2
// dépôts). Corrigé le même soir : Esdras a précisé que ce n'est PAS le caissier qui décide de
// sortir de l'argent — c'est LA DIRECTION qui le lui demande, et LUI qui accorde ou refuse selon
// ce qu'il a en caisse. Même schéma de verrouillage que demandes_exoneration (Demandes.js) :
// 'en_attente' -> 'accorde'/'refuse' via un UPDATE conditionnel, pour qu'un seul caissier puisse
// traiter une demande donnée même si 2 postes l'ont ouverte en même temps. Passé par le backend
// (comme paiements), pas par le shim db, pour appliquer une vraie permission plutôt que la clé
// anon libre. Fonctionnalité pensée comme TEMPORAIRE : le comptable venu pour la firme a dit que
// ce retrait direct ne durera pas une fois leur propre système en place — d'où le paramètre
// 'sortiesCaisseActivees' (GestionParametres.js) qui masque tout l'écran d'un coup côté navigateur
// le jour où ce n'est plus utile, sans qu'il faille retoucher au code ni perdre l'historique déjà
// enregistré.
app.get('/api/depenses-caisse', async (req, res) => {
  // sortie_caisse_demander (direction, qui veut voir le statut de ses demandes) + caisse_travailler
  // (le caissier, qui doit voir ce qui est en attente) + caisse_voir/fiche_patient_voir_finances
  // (même écran que GET /api/paiements, pour le rapprochement).
  if (!(await aPermission(req.user.id, 'sortie_caisse_demander')) && !(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'caisse_voir')) && !(await aPermission(req.user.id, 'fiche_patient_voir_finances'))) {
    return res.status(403).json({ error: "Permission 'sortie_caisse_demander', 'caisse_travailler', 'caisse_voir' ou 'fiche_patient_voir_finances' requise." });
  }
  try {
    res.json(await lireToutesLesPages(
      () => supabase.from('depenses_caisse').select('*').order('date_demande', { ascending: false }).order('id')));
  } catch (e) {
    console.error('GET /api/depenses-caisse: lecture paginée échouée :', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Crée la DEMANDE (statut 'en_attente') — c'est la direction qui l'initie, jamais le caissier.
app.post('/api/depenses-caisse', async (req, res) => {
  if (!(await aPermission(req.user.id, 'sortie_caisse_demander'))) {
    return res.status(403).json({ error: "Permission 'sortie_caisse_demander' requise." });
  }
  const { motif, montant } = req.body;
  if (!motif || typeof motif !== 'string' || !motif.trim()) return res.status(400).json({ error: 'motif requis.' });
  const montantNombre = parseFloat(montant);
  if (!(montantNombre > 0)) return res.status(400).json({ error: 'montant doit être un nombre supérieur à 0.' });

  // Idempotence via local_id, même principe que /api/paiements et /api/fiches — nécessaire pour
  // que la file hors ligne (api/supabase.js) puisse rejouer cette création sans risquer de la
  // dupliquer si la confirmation du 1er essai s'est perdue en route.
  const local_id = req.body.local_id || req.body.localId;
  if (local_id) {
    const { data: existant } = await supabase.from('depenses_caisse').select('*').eq('local_id', local_id).maybeSingle();
    if (existant) return res.status(200).json(existant);
  }

  const { data, error } = await supabase
    .from('depenses_caisse')
    .insert({
      motif: motif.trim(), montant: montantNombre,
      demandeur: req.user.email || req.user.id, demandeur_uid: req.user.id,
      statut: 'en_attente', local_id: local_id || null,
    })
    .select()
    .single();
  if (error) {
    if (error.code === '23505' && local_id) {
      const { data: existant } = await supabase.from('depenses_caisse').select('*').eq('local_id', local_id).maybeSingle();
      if (existant) return res.status(200).json(existant);
    }
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

// Le caissier accorde (il a l'argent, il le donne) ou refuse (il ne l'a pas) une demande en
// attente. Verrouillage atomique identique à claimerDemande() dans Demandes.js : la clause
// .eq('statut', 'en_attente') sur l'UPDATE garantit que si 2 caissiers répondent à la même
// demande à quelques instants d'écart, un seul des deux modifie réellement une ligne — l'autre
// reçoit 0 ligne modifiée (409) plutôt qu'une double sortie d'argent.
app.patch('/api/depenses-caisse/:id/repondre', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { accorde } = req.body;
  if (typeof accorde !== 'boolean') return res.status(400).json({ error: 'accorde (booléen) requis.' });

  const { data, error } = await supabase
    .from('depenses_caisse')
    .update({
      statut: accorde ? 'accorde' : 'refuse',
      caissier: req.user.email || req.user.id, caissier_uid: req.user.id,
      date_reponse: new Date().toISOString(),
    })
    .eq('id', req.params.id).eq('statut', 'en_attente')
    .select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.status(409).json({ error: "Cette demande a déjà été traitée entre-temps." });
  res.json(data[0]);
});

// 27/10 (Esdras) : « Rendre le dépôt » — un patient laisse un dépôt et n'en dépense pas la totalité : la caisse lui rend le reste. Même esprit que « Passer » une sortie de caisse : la direction décide
// sur papier, la caisse saisit le montant, le motif et « autorisé par », puis un clic. Ligne « remboursement_patient » (argent qui SORT du tiroir, comme partout) qui baisse le dépôt disponible du dossier
// du même montant, sous le verrou par épisode (sql/rendre_depot.sql) ; jamais plus que le dépôt réellement disponible. Jamais en file hors ligne.
app.post('/api/episodes/:id/rendre-depot', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise pour rendre un dépôt." });
  }
  if (!estUnVraiUuid(req.params.id)) return res.status(400).json({ error: 'Épisode invalide.' });
  const motif = typeof (req.body && req.body.motif) === 'string' ? req.body.motif.trim() : '';
  const autorisePar = typeof (req.body && req.body.autorise_par) === 'string' ? req.body.autorise_par.trim() : '';
  if (motif.length < 3) return res.status(400).json({ error: 'Le motif est requis (3 caractères au moins).', code: 'MOTIF_REQUIS' });
  if (motif.length > 300) return res.status(400).json({ error: 'Motif trop long (300 caractères au maximum).' });
  if (autorisePar.length < 2) return res.status(400).json({ error: "« Autorisé par » est requis : écris le nom de la personne qui a décidé de rendre ce dépôt.", code: 'AUTORISE_PAR_REQUIS' });
  if (autorisePar.length > 100) return res.status(400).json({ error: '« Autorisé par » est trop long (100 caractères au maximum).' });
  if (!estAutorisateurSortieCaisse(autorisePar)) return res.status(400).json({ error: MESSAGE_AUTORISATEUR_INVALIDE, code: 'AUTORISE_PAR_INVALIDE' });
  const corpsMontant = { mode: 'remboursement_patient', montant: req.body && req.body.montant };
  const erreurMontant = validerMontantPaiement(corpsMontant);
  if (erreurMontant) return res.status(400).json({ error: erreurMontant.replace('du paiement', 'à rendre') });
  normaliserMontant(corpsMontant);
  const montant = corpsMontant.montant;
  const localId = (req.body && (req.body.local_id || req.body.localId)) || null;
  if (localId) {
    const { data: dejaLa } = await supabase.from('paiements').select('*').eq('local_id', localId).maybeSingle();
    if (dejaLa) return res.status(200).json(dejaLa);
  }
  const { data: episode, error: erreurEpisode } = await supabase.from('episodes').select('id, dossier_id, type_patient, ong_partenaire').eq('id', req.params.id).is('supprime_le', null).maybeSingle();
  if (erreurEpisode) return res.status(500).json({ error: erreurEpisode.message });
  if (!episode) return res.status(404).json({ error: 'Épisode introuvable.' });
  const { data: dossier } = await supabase.from('dossiers').select('nom').eq('id', episode.dossier_id).maybeSingle();
  const corps = {
    patient_nom: (dossier && dossier.nom) || null, type_patient: episode.type_patient || null, ong_partenaire: episode.ong_partenaire || null,
    encaisse_par: req.user.email || req.user.id, traite_par_uid: req.user.id, local_id: localId,
    details: { motif, autorise_par: autorisePar },
  };
  const { data, error } = await supabase.rpc('rendre_depot_atomique', { p_episode: req.params.id, p_montant: montant, p_corps: corps, p_heure_serveur: true });
  if (error) {
    if (estRefusRemboursement(error)) return res.status(400).json({ error: messageRefusRemboursement(error), code: error.code });
    if (estFonctionAbsente(error)) return res.status(503).json({ error: "Mise à jour du serveur en cours (la fonction « rendre_depot_atomique » n'est pas encore en base). Réessaie dans quelques minutes.", code: 'FONCTION_ABSENTE' });
    if (error.code === '23505' && localId) {
      const { data: existant } = await supabase.from('paiements').select('*').eq('local_id', localId).maybeSingle();
      if (existant) return res.status(200).json(existant);
    }
    return res.status(500).json({ error: error.message });
  }
  enregistrerAuditServeur(req, 'depot_rendu', { episode_id: req.params.id, patient: (dossier && dossier.nom) || null, montant, motif, autorise_par: autorisePar });
  res.status(201).json(data);
});

// Autres revenus (20/10, Esdras) : de l'argent encaissé à la caisse qui ne concerne AUCUN patient (certificat, location, don...). Table à part (sql/autres_revenus.sql) : jamais mélangé aux revenus des soins.
// Même contrôle que les paiements : il faut caisse_travailler pour en enregistrer, paiement_annuler pour en annuler (et jamais soi-même).
const MESSAGE_AUTRE_REVENU_MOTIF = 'Le motif est requis (3 à 300 caractères).';
app.get('/api/autres-revenus', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'caisse_voir')) && !(await aPermission(req.user.id, 'fiche_patient_voir_finances'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler', 'caisse_voir' ou 'fiche_patient_voir_finances' requise." });
  }
  try {
    res.json(await lireToutesLesPages(() => supabase.from('autres_revenus').select('*').order('date_revenu', { ascending: false }).order('id')));
  } catch (e) {
    // Table pas encore créée (script SQL pas collé) : liste vide plutôt que d'empêcher l'app de se charger.
    if (/autres_revenus/.test(String(e.message)) && /does not exist|schema cache|relation/.test(String(e.message))) return res.json([]);
    console.error('GET /api/autres-revenus: lecture paginée échouée :', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/autres-revenus', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  const motif = typeof req.body.motif === 'string' ? req.body.motif.trim().replace(/\s+/g, ' ') : '';
  if (motif.length < 3 || motif.length > 300) return res.status(400).json({ error: MESSAGE_AUTRE_REVENU_MOTIF });
  const montant = Math.round((Number(req.body.montant) + Number.EPSILON) * 100) / 100;
  if (!(montant > 0) || montant > 100000000) return res.status(400).json({ error: 'Le montant doit être supérieur à 0.' });
  const payeur = typeof req.body.payeur === 'string' && req.body.payeur.trim() ? req.body.payeur.trim().replace(/\s+/g, ' ').slice(0, 100) : null;
  const local_id = req.body.local_id || req.body.localId || null;
  if (local_id) {
    const { data: existant } = await supabase.from('autres_revenus').select('*').eq('local_id', local_id).maybeSingle();
    if (existant) return res.status(200).json(existant);
  }
  const { data, error } = await supabase.from('autres_revenus').insert({
    montant, motif, payeur, caissier: req.user.email || req.user.id, caissier_uid: req.user.id, local_id,
  }).select().single();
  if (error) {
    if (error.code === '23505' && local_id) {
      const { data: existant } = await supabase.from('autres_revenus').select('*').eq('local_id', local_id).maybeSingle();
      if (existant) return res.status(200).json(existant);
    }
    return res.status(500).json({ error: error.message });
  }
  await enregistrerAuditServeur(req, 'autre_revenu_enregistre', { id: data.id, montant, motif, payeur });
  res.status(201).json(data);
});
app.patch('/api/autres-revenus/:id/annuler', async (req, res) => {
  if (!(await aPermission(req.user.id, 'paiement_annuler'))) return res.status(403).json({ error: "Permission 'paiement_annuler' requise pour annuler un autre revenu." });
  const motif = typeof req.body.motif === 'string' ? req.body.motif.trim() : '';
  if (motif.length < 5) return res.status(400).json({ error: "Un motif d'annulation (5 caractères au moins) est requis." });
  const { data: revenu, error: erreurLecture } = await supabase.from('autres_revenus').select('*').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!revenu) return res.status(404).json({ error: 'Autre revenu introuvable.' });
  if (revenu.annule) return res.status(400).json({ error: 'Cet autre revenu est déjà annulé.' });
  if (revenu.caissier_uid === req.user.id) return res.status(403).json({ error: "Tu ne peux pas annuler un revenu que tu as toi-même enregistré : demande à la direction." });
  const { data, error } = await supabase.from('autres_revenus')
    .update({ annule: true, annule_par: req.user.email || req.user.id, annule_par_uid: req.user.id, annule_le: new Date().toISOString(), motif_annulation: motif })
    .eq('id', req.params.id).eq('annule', false).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.status(409).json({ error: 'Cet autre revenu vient d\'être annulé par quelqu\'un d\'autre.' });
  await enregistrerAuditServeur(req, 'autre_revenu_annule', { id: revenu.id, montant: revenu.montant, motif: revenu.motif, motifAnnulation: motif });
  res.json(data[0]);
});

// Annulation d'un paiement — réservée à direction/administrateur (jamais celui qui a
// encaissé lui-même, pour éviter qu'une caissière encaisse en cash puis annule pour
// empocher). Le paiement n'est jamais supprimé, juste marqué — la trace reste complète.
app.patch('/api/paiements/:id/annuler', async (req, res) => {
  if (!(await aPermission(req.user.id, 'paiement_annuler'))) {
    return res.status(403).json({ error: "Permission 'paiement_annuler' requise pour annuler une transaction déjà encaissée." });
  }
  const { motif } = req.body;
  if (!motif || !motif.trim()) return res.status(400).json({ error: "Un motif est requis pour annuler une transaction." });

  const { data: paiement, error: erreurLecture } = await supabase.from('paiements').select('*').eq('id', req.params.id).single();
  if (erreurLecture) return res.status(404).json({ error: "Paiement introuvable." });
  if (paiement.annule) return res.status(400).json({ error: "Ce paiement est déjà annulé." });
  // Empêche d'annuler sa propre transaction (une caissière — ou n'importe qui ayant aussi
  // caisse_travailler — ne doit jamais pouvoir encaisser en cash puis annuler pour empocher).
  // traite_par_uid absent (ex: paiement d'exonération) = pas de vérification possible, on laisse
  // passer plutôt que de bloquer une annulation légitime sans piste d'identification.
  if (paiement.traite_par_uid && paiement.traite_par_uid === req.user.id) {
    return res.status(403).json({ error: "Impossible d'annuler une transaction que vous avez vous-même encaissée — demande à quelqu'un d'autre." });
  }

  const { data, error } = await supabase
    .from('paiements')
    .update({ annule: true, annule_par: req.user.email || req.user.id, annule_par_uid: req.user.id, annule_le: new Date().toISOString(), motif_annulation: motif })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 24/10 (Esdras) : « Exonérer cette créance » — la direction décide SUR PAPIER de pardonner tout ou partie de la dette d'un patient ; c'est la caisse qui passe l'écriture
// (même droit que toute exonération : exoneration_accorder, ou demandes_repondre pour la direction). Ligne de paiement en mode « exoneration » de 0 Gdes (aucun argent dans le tiroir),
// la dette baisse du montant pardonné, sous le verrou par épisode (sql/exoneration_creance.sql). Motif obligatoire (ce que la direction a écrit) + ligne dans le journal d'audit.
// Jamais en file hors ligne : la dette réelle doit être lue sur le serveur au moment de l'écriture.
app.post('/api/episodes/:id/exonerer-creance', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'demandes_repondre'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' ou 'demandes_repondre' requise." });
  }
  const parLaDirection = await aPermission(req.user.id, 'demandes_repondre');
  if (!parLaDirection && !(await aPermission(req.user.id, 'exoneration_accorder'))) {
    return res.status(403).json({ error: "Tu n'as pas le droit d'accorder une exonération (permission 'exoneration_accorder' ou 'demandes_repondre').", code: 'EXONERATION_NON_AUTORISEE' });
  }
  if (!estUnVraiUuid(req.params.id)) return res.status(400).json({ error: 'Épisode invalide.' });
  const motif = typeof (req.body && req.body.motif) === 'string' ? req.body.motif.trim() : '';
  if (motif.length < 3) return res.status(400).json({ error: "Écris le motif (ce que la direction a décidé, 3 caractères au moins).", code: 'MOTIF_EXONERATION_REQUIS' });
  if (motif.length > 300) return res.status(400).json({ error: 'Motif trop long (300 caractères au maximum).' });
  const corpsMontant = { mode: 'exoneration', montant: req.body && req.body.montant };
  const erreurMontant = validerMontantPaiement(corpsMontant);
  if (erreurMontant) return res.status(400).json({ error: erreurMontant.replace('du paiement', 'à exonérer') });
  normaliserMontant(corpsMontant);
  const montant = corpsMontant.montant;
  const localId = (req.body && (req.body.local_id || req.body.localId)) || null;
  if (localId) {
    const { data: dejaLa } = await supabase.from('paiements').select('*').eq('local_id', localId).maybeSingle();
    if (dejaLa) return res.status(200).json(dejaLa);
  }
  const { data: episode, error: erreurEpisode } = await supabase.from('episodes').select('id, dossier_id, type_patient, ong_partenaire').eq('id', req.params.id).is('supprime_le', null).maybeSingle();
  if (erreurEpisode) return res.status(500).json({ error: erreurEpisode.message });
  if (!episode) return res.status(404).json({ error: 'Épisode introuvable.' });
  const { data: dossier } = await supabase.from('dossiers').select('nom').eq('id', episode.dossier_id).maybeSingle();
  const texteMotif = `Exonération de créance — ${motif}`;
  const corps = {
    patient_nom: (dossier && dossier.nom) || null, type_patient: episode.type_patient || null, ong_partenaire: episode.ong_partenaire || null,
    encaisse_par: req.user.email || req.user.id, traite_par_uid: req.user.id, local_id: localId,
    details: { exoneration_creance: true, montant_exonere: montant },
    exoneration: { montantExonere: montant, motif: texteMotif, creance: true },
  };
  const { data, error } = await supabase.rpc('exonerer_creance_atomique', { p_episode: req.params.id, p_montant: montant, p_corps: corps, p_heure_serveur: true });
  if (error) {
    if (estRefusRemboursement(error)) return res.status(400).json({ error: messageRefusRemboursement(error), code: error.code });
    if (estFonctionAbsente(error)) return res.status(503).json({ error: "Mise à jour du serveur en cours (la fonction « exonerer_creance_atomique » n'est pas encore en base). Réessaie dans quelques minutes.", code: 'FONCTION_ABSENTE' });
    if (error.code === '23505' && localId) {
      const { data: existant } = await supabase.from('paiements').select('*').eq('local_id', localId).maybeSingle();
      if (existant) return res.status(200).json(existant);
    }
    return res.status(500).json({ error: error.message });
  }
  enregistrerAuditServeur(req, 'exoneration_creance_accordee', {
    episode_id: req.params.id, patient: (dossier && dossier.nom) || null, montant_exonere: montant, motif: texteMotif,
    dette_apres: data && data.solde_restant != null ? Number(data.solde_restant) : null, par_la_direction: parLaDirection,
  });
  res.status(201).json(data);
});
}; // @enveloppe
