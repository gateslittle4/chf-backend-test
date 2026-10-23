// routes/fiches.js — Fiches : création, lecture, suppression, retrait par la caisse, restauration.
// Découpé de server.js le 23/10 sans changer une ligne de logique : le texte des routes est celui d'avant. Ce module reçoit de server.js
// l'application Express et ses dépendances partagées (base, droits, journal d'audit, lecteurs communs) ; voir « montage des routes » dans server.js.
const { compterActesNaissance, conflitActeNaissance, motifDerogationValide } = require('../utils/actesNaissance');
const { evaluerRetraitCaisse, estRefusSolde, MOTIF_MIN } = require('../utils/retraitFicheCaisse');
const { middlewareHeureServeur, appliquerHeureAuPaiement, estRejeu, ENTETE_HEURE } = require('../utils/heureServeur');
const { estFonctionAbsente, estRefusRemboursement, messageRefusRemboursement } = require('../utils/soldeAtomique');
const { verifierTotalFiche, verifierPaiementContreFiche, MODES_VENTE } = require('../utils/verificationPrixFiche');

module.exports = function monterFiches(app, { aPermission, enregistrerAuditServeur, estUnVraiUuid, supabase }) { // @enveloppe
// 19/10 (Esdras) : UN SEUL acte de naissance par épisode (accouchement, césarienne, délivrance : voir utils/actesNaissance.js). Contrôle placé AVANT la route de création (la route elle-même reste inchangée).
// Comptés : les fiches déjà enregistrées de l'épisode (ni supprimées, ni au paiement annulé) + la nouvelle fiche. Exception : droit « acte_naissance_derogation » + motif écrit, tracée au journal
// (action « derogation_acte_naissance », écrite par la route après la création de la fiche). Un rejeu de la file hors ligne (local_id déjà enregistré) n'est jamais refusé.
app.use('/api/fiches', async (req, res, next) => {
  if (req.method !== 'POST' || (req.path !== '/' && req.path !== '')) return next();
  try {
    const { episode_id, raw_state, local_id } = req.body || {};
    if (!episode_id || !raw_state || compterActesNaissance(raw_state.lignesCalcul) === 0) return next();
    if (local_id) {
      const { data: existante } = await supabase.from('fiches').select('id').eq('local_id', local_id).maybeSingle();
      if (existante) return next();
    }
    const { data: fichesDeLEpisode, error: erreurFiches } = await supabase.from('fiches').select('id, raw_state').eq('episode_id', episode_id).is('supprime_le', null);
    if (erreurFiches) return res.status(500).json({ error: erreurFiches.message });
    const { data: annules } = await supabase.from('paiements').select('fiche_id').eq('episode_id', episode_id).eq('annule', true).not('fiche_id', 'is', null);
    const idsAnnules = new Set((annules || []).map(p => p.fiche_id));
    const verdict = conflitActeNaissance({ fichesExistantes: (fichesDeLEpisode || []).filter(f => !idsAnnules.has(f.id)), lignesNouvelles: raw_state.lignesCalcul });
    if (!verdict.conflit) return next();
    const derogation = req.body.derogation_naissance;
    if (!(motifDerogationValide(derogation) && await aPermission(req.user.id, 'acte_naissance_derogation'))) {
      return res.status(409).json({ error: verdict.message, code: 'ACTE_NAISSANCE_MULTIPLE' });
    }
    req.derogationNaissanceAAuditer = { episode_id, motif: derogation.motif.trim(), deja: verdict.deja, nouveau: verdict.nouveau };
    return next();
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Même règle pour les fiches créées avec l'épisode (Achat Express, POST /api/episodes) — sans dérogation possible ici.
app.use('/api/episodes', (req, res, next) => {
  if (req.method !== 'POST' || (req.path !== '/' && req.path !== '') || !req.body || !Array.isArray(req.body.fiches) || req.body.import_sauvegarde === true) return next();
  const verdict = conflitActeNaissance({ lignesNouvelles: req.body.fiches.flatMap(f => (f && f.rawState && f.rawState.lignesCalcul) || (f && f.raw_state && f.raw_state.lignesCalcul) || []) });
  if (verdict.conflit) return res.status(409).json({ error: verdict.message, code: 'ACTE_NAISSANCE_MULTIPLE' });
  return next();
});

// Fiches — rattachées à un épisode. Appelée depuis le Calculateur (caisse_travailler) ET
// depuis l'approbation d'une exonération (demandes_repondre) — voir Demandes.js.
// Retour d'Esdras (29/09) : un dossier suspendu redevient ACTIF dès qu'une nouvelle fiche y est
// enregistrée, où que ce soit (Calculateur, Dossier/Épisode, fiche envoyée après une coupure).
// Ici plutôt que dans chaque écran : toutes les fiches passent par cette route. Appelée seulement à
// la vraie création d'une fiche, JAMAIS sur un rejeu idempotent — un rejeu tardif de la file hors
// ligne ne doit pas réactiver un dossier suspendu volontairement depuis. Un dossier archivé
// (statut 'ferme') ou reporté n'est pas touché. Sans effet sur la fiche si cette mise à jour échoue.
async function reactiverEpisodeSuspendu(episodeId) {
  try {
    const { error } = await supabase.from('episodes').update({ date_suspension: null })
      .eq('id', episodeId).eq('statut', 'ouvert').not('date_suspension', 'is', null).select();
    if (error) console.error('Réactivation du dossier suspendu impossible :', error.message);
  } catch (e) {
    console.error('Réactivation du dossier suspendu impossible :', e.message);
  }
}

app.post('/api/fiches', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'demandes_repondre'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' ou 'demandes_repondre' requise." });
  }
  const { episode_id, cree_par, cree_par_uid, raw_state, local_id, total_global, breakdown, mode_paiement, inserer_apres } = req.body;
  if (!episode_id) return res.status(400).json({ error: 'episode_id est requis' });
  // Faille d'audit du 21/10 : une exonération ne peut être APPLIQUÉE (fiche créée avec ce mode) que par quelqu'un qui peut l'ACCORDER (demandes_repondre) —
  // sans ce contrôle, n'importe quel compte ayant seulement caisse_travailler (ex. comptable, pharmacien) pouvait appeler cette route directement (hors écran)
  // avec mode_paiement: 'exoneration' et s'auto-accorder une remise, sans jamais passer par la direction (voir Demandes.js, le seul appelant légitime).
  // 22/10 (Esdras) : la CAISSE peut aussi accorder une exonération (droit exoneration_accorder), sans attendre la direction — motif obligatoire et trace dans le journal d'audit, voir POST /api/paiements.
  if (mode_paiement === 'exoneration' && !(await aPermission(req.user.id, 'demandes_repondre')) && !(await aPermission(req.user.id, 'exoneration_accorder'))) {
    return res.status(403).json({ error: "Tu n'as pas le droit d'accorder une exonération (permission 'exoneration_accorder' ou 'demandes_repondre').", code: 'EXONERATION_NON_AUTORISEE' });
  }

  // Idempotence : si cette transaction précise a déjà été enregistrée (réponse perdue
  // lors d'une coupure réseau, puis renvoyée par la file d'attente), on renvoie
  // l'enregistrement existant au lieu d'en créer un doublon.
  if (local_id) {
    const { data: existante } = await supabase.from('fiches').select('*').eq('local_id', local_id).maybeSingle();
    if (existante) return res.status(200).json(existante);
  }

  // Faille d'audit du 21/10, la plus sérieuse trouvée : le montant d'une fiche (total_global/breakdown) venait ENTIÈREMENT du téléphone, jamais revérifié —
  // une caissière malhonnête pouvait soigner normalement puis envoyer une fiche à un prix fabriqué plus bas, encaisser le vrai montant en espèces et garder
  // la différence, sans que rien ne le signale. Revérifié ici avec la MÊME formule que l'app (utils/verificationPrixFiche.js) : chaque prix de ligne doit être
  // un prix RECONNU de l'article (ancien OU nouveau prix — la caissière garde son vrai choix — ou le tarif du contrat ONG), l'hébergement est recalculé des
  // dates et du tarif réglé par la direction, la ventilation par service doit concorder. Seule la chirurgie hors-catalogue (texte libre + montant libre) reste
  // invérifiable par nature, juste bornée. `raw_state` absent (appelant inconnu) n'est jamais bloqué, par prudence.
  // raw_state absent (jamais le cas des appelants connus) : rien à relire, on ne fait aucune requête de plus — voir verifierTotalFiche.
  if (raw_state !== undefined && raw_state !== null) {
    const { data: episodePourPrix } = await supabase.from('episodes').select('type_patient, ong_partenaire').eq('id', episode_id).maybeSingle();
    const [{ data: catalogueMed }, { data: catalogueActes }, { data: parametresData }] = await Promise.all([
      supabase.from('catalog').select('items').eq('type', 'medicaments').maybeSingle(),
      supabase.from('catalog').select('items').eq('type', 'actes').maybeSingle(),
      supabase.from('catalog').select('items').eq('type', 'parametres').maybeSingle(),
    ]);
    let ongDoc = null;
    if (episodePourPrix && episodePourPrix.ong_partenaire) {
      const { data } = await supabase.from('ong_partenaires').select('date_fin_contrat').eq('nom', episodePourPrix.ong_partenaire).maybeSingle();
      if (data) ongDoc = { dateFinContrat: data.date_fin_contrat };
    }
    const verification = verifierTotalFiche({
      raw_state, total_global, breakdown, episode: episodePourPrix || null,
      catalogue: { med: (catalogueMed && catalogueMed.items) || [], actes: (catalogueActes && catalogueActes.items) || [] },
      parametres: (parametresData && parametresData.items) || {}, ongDoc,
    });
    if (!verification.ok) {
      // HORS LIGNE (rejeu de la file d'attente, en-tête X-CHF-Rejeu) : jamais refusé. La vente a déjà eu lieu (argent pris, reçu remis) alors que le téléphone ne pouvait pas
      // joindre le serveur : un prix qui a changé entre-temps (nouveaux tarifs appliqués, contrat terminé) ne doit pas faire PERDRE la transaction. On l'enregistre et on la SIGNALE
      // à la direction (journal d'audit, action sensible) — détectée, jamais perdue. En ligne, le refus reste immédiat.
      if (estRejeu(req)) {
        enregistrerAuditServeur(req, 'fiche_montant_suspect', { episode_id, total_global, breakdown, erreur: verification.erreur, hors_ligne: true });
      } else {
        enregistrerAuditServeur(req, 'fiche_montant_refuse', { episode_id, total_global, breakdown, erreur: verification.erreur });
        return res.status(400).json({ error: verification.erreur, code: 'MONTANT_FICHE_REFUSE' });
      }
    }
  }


  // Bug financier découvert le 28/08 : numero_fiche venait du CLIENT (CalculateurPanel.js,
  // Math.max(fichesDossier) + 1) — un état local qui peut rester en retard, notamment quand le
  // paiement d'une fiche précédente échoue (la fiche existe déjà en base, mais l'app n'apprend
  // jamais son numéro puisqu'elle ne l'ajoute à son état local qu'après un encaissement COMPLET).
  // Résultat observé en production : 2 fiches distinctes portant le même numéro dans le même
  // dossier. On calcule désormais toujours le vrai prochain numéro ICI, à partir de ce qui existe
  // réellement en base au moment de l'insertion — la contrainte unique (episode_id, numero_fiche,
  // voir sql/ajoute_contrainte_numero_fiche_unique.sql) sert de filet pour la course plus rare
  // entre 2 requêtes vraiment simultanées (2 postes/onglets) : on relit et on retente.
  for (let tentative = 0; tentative < 5; tentative++) {
    // .not(... null) : une fiche à la corbeille a pu lâcher son numéro (NULL, voir sql/renumerotation_fiches.sql) — en tri décroissant
    // Postgres range les NULL EN PREMIER, la « dernière » fiche serait alors NULL et le numéro suivant retomberait à 1.
    const { data: derniere, error: erreurDerniere } = await supabase
      .from('fiches').select('numero_fiche').eq('episode_id', episode_id).not('numero_fiche', 'is', null)
      .order('numero_fiche', { ascending: false }).limit(1).maybeSingle();
    if (erreurDerniere) return res.status(500).json({ error: erreurDerniere.message });
    let numero_fiche = (derniere?.numero_fiche || 0) + 1;

    // Insertion d'une fiche oubliée ENTRE deux fiches (14/10, reprise de chf-demo2) : `inserer_apres` = id de la fiche après laquelle
    // elle se place, ou 'DEBUT'. Les fiches suivantes avancent d'un numéro (decaler_fiches, atomique) ; le numéro est calculé ICI.
    let decalees = 0;
    if (inserer_apres) {
      let cible = 1;
      if (inserer_apres !== 'DEBUT') {
        if (!estUnVraiUuid(inserer_apres)) return res.status(400).json({ error: "inserer_apres doit être l'id d'une fiche du dossier, ou 'DEBUT'." });
        const { data: apres, error: erreurApres } = await supabase.from('fiches').select('numero_fiche, episode_id')
          .eq('id', inserer_apres).is('supprime_le', null).maybeSingle();
        if (erreurApres) return res.status(500).json({ error: erreurApres.message });
        if (!apres || apres.episode_id !== episode_id || apres.numero_fiche == null) {
          return res.status(400).json({ error: "La fiche après laquelle insérer est introuvable dans ce dossier (supprimée entre-temps ?)." });
        }
        cible = apres.numero_fiche + 1;
      }
      if (cible <= numero_fiche - 1 || (inserer_apres === 'DEBUT' && numero_fiche > 1)) {
        const { data: nb, error: erreurDecalage } = await supabase.rpc('decaler_fiches', { p_episode: episode_id, p_a_partir_de: cible });
        if (erreurDecalage) {
          return res.status(500).json({ error: erreurDecalage.code === '42883' || erreurDecalage.code === 'PGRST202'
            ? "Insertion impossible : le script sql/renumerotation_fiches.sql n'a pas encore été collé dans Supabase." : erreurDecalage.message });
        }
        decalees = Number(nb) || 0;
        numero_fiche = cible;
      }
    }

    // total_global/breakdown/mode_paiement sont écrits dès la création (pas seulement à
    // l'archivage) — sinon un dossier encore actif affiche un total de 0 malgré des
    // transactions déjà encaissées.
    const { data, error } = await supabase
      .from('fiches').insert({
        episode_id, numero_fiche, cree_par, cree_par_uid: cree_par_uid || null,
        raw_state: raw_state || {}, local_id: local_id || null,
        total_global: total_global || 0, breakdown: breakdown || {}, mode_paiement: mode_paiement || null,
      }).select().single();
    if (!error) {
      await reactiverEpisodeSuspendu(episode_id);
      if (req.derogationNaissanceAAuditer) enregistrerAuditServeur(req, 'derogation_acte_naissance', { ...req.derogationNaissanceAAuditer, fiche_id: data.id, numero_fiche });
      if (inserer_apres && decalees > 0) {
        enregistrerAuditServeur(req, 'fiche_inseree', { episode_id, fiche_id: data.id, numero_fiche, inserer_apres, fiches_decalees: decalees });
        const { data: apres } = await supabase.from('fiches').select('id, numero_fiche').eq('episode_id', episode_id).is('supprime_le', null).order('numero_fiche');
        return res.status(201).json({ ...data, renumerotation: apres || [] });
      }
      return res.status(201).json(data);
    }

    if (error.code === '23505') {
      if (local_id) {
        const { data: existante } = await supabase.from('fiches').select('*').eq('local_id', local_id).maybeSingle();
        if (existante) return res.status(200).json(existante);
      }
      // Conflit sur (episode_id, numero_fiche) : une autre requête vient d'insérer le même
      // numéro entre notre lecture et notre écriture — on relit le vrai dernier numéro et on
      // retente, plutôt que d'échouer ou de créer un doublon.
      continue;
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(500).json({ error: "Impossible d'attribuer un numéro de fiche après plusieurs tentatives (forte contention)." });
});

app.get('/api/fiches/episode/:episodeId', async (req, res) => {
  // 21/10 : même correctif.
  if (!(await aPermission(req.user.id, 'fiche_patient_voir'))) return res.status(403).json({ error: "Permission 'fiche_patient_voir' requise." });
  // .is('supprime_le', null) manquait ici (trouvé le 13/09 en testant la corbeille dossiers avec un
  // compte réel) — cette route sert à ROUVRIR un dossier dans le Calculateur pour continuer à le
  // facturer (voir AppHospitaliere.js, GestionOng.js) : une fiche mise à la corbeille par erreur, une
  // fois le dossier rouvert, réapparaissait dans les totaux comme si de rien n'était. Même classe de
  // bug que celui du 24/08 juste en dessous (paiement annulé compté quand même), sur le même écran.
  const { data, error } = await supabase
    .from('fiches').select('*').eq('episode_id', req.params.episodeId).is('supprime_le', null).order('date_creation');
  if (error) return res.status(500).json({ error: error.message });
  // Même correctif que episodeVersFlat (24/08, audit financier) : marque chaque fiche dont le
  // paiement associé a été annulé, pour que le Calculateur/Fiche Patient (qui consomme cette route
  // pour rouvrir un dossier en cours de facturation) ne compte plus cette fiche dans ses totaux
  // affichés — jusqu'ici seuls Statistiques/Direction/Archives (via episodeVersFlat) avaient ce
  // filtre, cet écran-ci en était encore dépourvu.
  const { data: paiementsAnnules } = await supabase
    .from('paiements').select('fiche_id').eq('episode_id', req.params.episodeId).eq('annule', true).not('fiche_id', 'is', null);
  const fichesAvecPaiementAnnule = new Set((paiementsAnnules || []).map(p => p.fiche_id));
  res.json((data || []).map(f => ({ ...f, paiement_annule: fichesAvecPaiementAnnule.has(f.id) })));
});

// Retour d'Esdras (23/08, bug financier URGENT) : cette route N'EXISTAIT PAS — "🗑️ Supprimer" côté
// client (CalculateurPanel.js) ne faisait qu'un retrait de l'état React local + restitution de
// stock, jamais rien côté serveur. Une fiche "supprimée" réapparaissait donc (avec son paiement)
// dès qu'on rechargeait la page ou rouvrait le dossier, puisqu'elle n'avait jamais quitté la base.
// Supprime aussi les paiements liés (fiche_id) — sans ça, un paiement orphelin resterait compté
// dans les totaux de Caisse/Direction pour une fiche qui n'existe plus.
app.delete('/api/fiches/:id', async (req, res) => {
  if (!(await aPermission(req.user.id, 'dossier_annuler'))) {
    return res.status(403).json({ error: "Permission 'dossier_annuler' requise pour supprimer une fiche." });
  }
  // .is('supprime_le', null) plutôt que juste .select('id') : une fiche déjà à la corbeille
  // (supprimée une 1re fois, rejeu de la file hors ligne) doit rester idempotente, pas se
  // retrouver avec un supprime_le "rafraîchi" à chaque nouvel essai.
  const { data: fiche, error: erreurLecture } = await supabase.from('fiches').select('id, episode_id, numero_fiche').eq('id', req.params.id).is('supprime_le', null).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!fiche) return res.status(200).json({ success: true }); // déjà supprimée (idempotent — utile pour une relecture de la file hors ligne)

  // Corbeille 30 jours (phase 2, même principe que /api/episodes/:id ci-dessus) — UPDATE au lieu
  // de DELETE, cascade manuelle vers les paiements de CETTE fiche (paiements.fiche_id est ON
  // DELETE CASCADE en base, mais seulement pour un vrai DELETE).
  const maintenant = new Date().toISOString();
  // 23/10 : fiche + paiements à la corbeille ET dette des paiements d'après recalculée, en une opération (sql/retrait_fiche_solde.sql) — avant, supprimer une
  // fiche à crédit laissait sa dette recopiée dans les paiements postérieurs. Fonction pas encore collée : ancien chemin.
  const { data: paiementsFiche, error: erreurLecturePaiements } = await supabase.from('paiements').select('id').eq('fiche_id', req.params.id).is('supprime_le', null);
  if (erreurLecturePaiements) return res.status(500).json({ error: erreurLecturePaiements.message });
  const { error: erreurSolde } = await supabase.rpc('retirer_fiche_ajuster_solde', { p_fiche: req.params.id, p_paiements: (paiementsFiche || []).map(p => p.id), p_horodatage: maintenant });
  if (erreurSolde) {
    if (estRefusSolde(erreurSolde)) return res.status(409).json({ error: erreurSolde.message, code: erreurSolde.code });
    if (!estFonctionAbsente(erreurSolde)) return res.status(500).json({ error: erreurSolde.message });
    const { error: erreurPaiements } = await supabase.from('paiements').update({ supprime_le: maintenant }).eq('fiche_id', req.params.id).is('supprime_le', null);
    if (erreurPaiements) return res.status(500).json({ error: erreurPaiements.message });
    const { error: erreurFiche } = await supabase.from('fiches').update({ supprime_le: maintenant }).eq('id', req.params.id).select();
    if (erreurFiche) return res.status(500).json({ error: erreurFiche.message });
  }

  // Les fiches suivantes remontent d'un numéro (14/10, reprise de chf-demo2) : supprimer la Fiche 1 ne laisse pas un dossier qui commence à la
  // Fiche 2. Renumérotation atomique en base (sql/renumerotation_fiches.sql). Si le script n'est pas encore collé, la suppression reste valable
  // (numéros inchangés, comme avant) : on le dit dans `renumerotation: null` plutôt que d'échouer.
  let renumerotation = null;
  if (fiche.episode_id) {
    const { data: numeros, error: erreurRenumerotation } = await supabase.rpc('renumeroter_fiches', { p_episode: fiche.episode_id });
    if (erreurRenumerotation) console.warn('Renumérotation des fiches non faite (script SQL pas collé ?) :', erreurRenumerotation.message);
    else {
      renumerotation = numeros || [];
      enregistrerAuditServeur(req, 'fiches_renumerotees', { episode_id: fiche.episode_id, fiche_supprimee: fiche.id, ancien_numero: fiche.numero_fiche, numeros_apres: renumerotation.map(n => ({ id: n.id, numero_fiche: n.numero_fiche })) });
    }
  }
  res.json({ success: true, renumerotation });
});

// 21/10 (Esdras) : un client prend un service puis n'en veut plus, ou le médecin déplace l'acte — la caisse doit pouvoir retirer
// la fiche déjà encaissée, sans passer par la direction, pour les petits montants. Mêmes effets que DELETE /api/fiches/:id
// (fiche + paiements à la corbeille, renumérotation) ; les limites (montant < paramètre « montantRetraitFicheCaisse », jour même ou
// session de caisse ouverte, dossier non facturé) sont dans utils/retraitFicheCaisse.js. « dossier_annuler »
// (direction) garde son droit sans ces limites. Rejeu hors ligne : jamais refusé pour le délai, seulement signalé dans l'audit.
// 22/10 : « Corriger » (le corps porte `correction: true`) = le même retrait, suivi côté écran de la fiche refaite à la même place ;
// tous les modes de paiement sont acceptés et la DETTE du patient est recalculée par la base (sql/retrait_fiche_solde.sql) : retirer une
// fiche à crédit ou en paiement partiel la retire aussi du solde de chaque paiement d'après.
app.post('/api/fiches/:id/retirer-caisse', async (req, res) => {
  const peutTout = await aPermission(req.user.id, 'dossier_annuler');
  if (!peutTout && !(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise pour retirer une fiche encaissée." });
  }
  const { data: fiche, error: erreurLecture } = await supabase.from('fiches')
    .select('id, episode_id, numero_fiche, total_global, date_creation, cree_par').eq('id', req.params.id).is('supprime_le', null).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!fiche) return res.status(200).json({ success: true }); // déjà retirée (idempotent — rejeu de la file hors ligne)

  const { data: episode } = fiche.episode_id
    ? await supabase.from('episodes').select('id, local_id, verrouille_facture, numero_lot').eq('id', fiche.episode_id).maybeSingle()
    : { data: null };
  let { data: paiements, error: erreurPaiements } = await supabase.from('paiements')
    .select('id, mode, montant, solde_restant, details, date_paiement').eq('fiche_id', fiche.id).is('supprime_le', null).neq('annule', true);
  if (erreurPaiements) return res.status(500).json({ error: erreurPaiements.message });
  // ⚡ Achat Express : le paiement peut n'être relié à sa fiche que par local_id (« <épisode>-paiement »), jamais laissé orphelin.
  if ((!paiements || paiements.length === 0) && episode && episode.local_id) {
    const { data: parLocalId } = await supabase.from('paiements')
      .select('id, mode, montant, solde_restant, details, date_paiement').eq('local_id', `${episode.local_id}-paiement`).is('supprime_le', null).neq('annule', true);
    paiements = parLocalId || [];
  }
  const { data: parametresDoc } = await supabase.from('catalog').select('items').eq('type', 'parametres').maybeSingle();
  // Session de caisse OUVERTE de la personne : un encaissement fait depuis son ouverture compte comme « la même session » (voir utils/retraitFicheCaisse.js).
  const { data: ligneSessions } = await supabase.from('catalog').select('items').eq('type', 'sessions_caisse').maybeSingle();
  const sessionOuverte = ((ligneSessions && ligneSessions.items) || []).find(x => x && x.uid === req.user.id && x.statut === 'ouverte' && !x.fermetureISO);
  const debutSessionMs = sessionOuverte ? Date.parse(sessionOuverte.ouvertureISO) : null;
  const rejeu = estRejeu(req);
  const motif = req.body && req.body.motif;
  const correction = !!(req.body && req.body.correction);
  let horsDelai = false;
  if (!peutTout) {
    const verdict = evaluerRetraitCaisse({ fiche, paiements, episode, parametres: parametresDoc && parametresDoc.items, motif, debutSessionMs, rejeu });
    if (!verdict.ok) {
      enregistrerAuditServeur(req, 'fiche_retrait_caisse_refuse', { fiche_id: fiche.id, numero_fiche: fiche.numero_fiche, total: fiche.total_global, code: verdict.code, correction, rejeu });
      return res.status(403).json({ error: verdict.message, code: verdict.code });
    }
    horsDelai = verdict.horsDelai;
  } else if (String(motif || '').trim().length < MOTIF_MIN) {
    return res.status(400).json({ error: `Un motif d'au moins ${MOTIF_MIN} caractères est obligatoire.`, code: 'MOTIF_REQUIS' });
  }

  const maintenant = new Date().toISOString();
  const idsPaiements = (paiements || []).map(p => p.id);
  // Une seule opération de la base (sql/retrait_fiche_solde.sql) : paiements + fiche à la corbeille ET dette des paiements d'après recalculée,
  // sous le verrou de l'épisode. Fonction pas encore collée (42883 / PGRST202) : ancien chemin, sans recalcul de dette.
  let resultatSolde = null;
  const { data: dataSolde, error: erreurSolde } = await supabase.rpc('retirer_fiche_ajuster_solde', { p_fiche: fiche.id, p_paiements: idsPaiements, p_horodatage: maintenant });
  if (erreurSolde) {
    if (estRefusSolde(erreurSolde)) return res.status(409).json({ error: erreurSolde.message, code: erreurSolde.code });
    if (!estFonctionAbsente(erreurSolde)) return res.status(500).json({ error: erreurSolde.message });
    if (idsPaiements.length > 0) {
      const { error } = await supabase.from('paiements').update({ supprime_le: maintenant }).in('id', idsPaiements).is('supprime_le', null);
      if (error) return res.status(500).json({ error: error.message });
    }
    const { error: erreurFiche } = await supabase.from('fiches').update({ supprime_le: maintenant }).eq('id', fiche.id).select();
    if (erreurFiche) return res.status(500).json({ error: erreurFiche.message });
  } else resultatSolde = dataSolde || null;

  let renumerotation = null;
  if (fiche.episode_id) {
    const { data: numeros, error: erreurRenumerotation } = await supabase.rpc('renumeroter_fiches', { p_episode: fiche.episode_id });
    if (erreurRenumerotation) console.warn('Renumérotation des fiches non faite (script SQL pas collé ?) :', erreurRenumerotation.message);
    else renumerotation = numeros || [];
  }
  enregistrerAuditServeur(req, correction ? 'fiche_corrigee_caisse' : 'fiche_retiree_caisse', {
    fiche_id: fiche.id, episode_id: fiche.episode_id, numero_fiche: fiche.numero_fiche, total: fiche.total_global,
    montant_rembourse: (paiements || []).reduce((s, p) => s + (Number(p.montant) || 0), 0),
    modes: [...new Set((paiements || []).map(p => p.mode))], motif: String(motif).trim(),
    fiche_creee_par: fiche.cree_par || null, avec_droit_direction: peutTout, hors_delai: horsDelai, rejeu,
    dette_retiree: resultatSolde ? Number(resultatSolde.dette_retiree) || 0 : null, paiements_ajustes: resultatSolde ? Number(resultatSolde.paiements_ajustes) || 0 : null,
    session_de_caisse: sessionOuverte ? sessionOuverte.id || null : null,
  });
  res.json({ success: true, renumerotation, dette_retiree: resultatSolde ? Number(resultatSolde.dette_retiree) || 0 : 0 });
});

// Restauration d'une fiche mise à la corbeille — même logique que /api/episodes/:id/restaurer :
// ne restaure que les paiements dont supprime_le correspond exactement à celui de la fiche.
app.post('/api/fiches/:id/restaurer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'dossier_annuler'))) {
    return res.status(403).json({ error: "Permission 'dossier_annuler' requise pour restaurer une fiche." });
  }
  const { data: fiche, error: erreurLecture } = await supabase.from('fiches').select('supprime_le, numero_fiche, episode_id').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!fiche) return res.status(404).json({ error: 'Fiche introuvable.' });
  if (!fiche.supprime_le) return res.status(400).json({ error: "Cette fiche n'est pas à la corbeille." });
  const horodatageSuppression = fiche.supprime_le;
  // Une fiche supprimée a pu lâcher son numéro (NULL, voir renumeroter_fiches) : elle revient à la FIN du dossier, au prochain numéro libre.
  const modifsRestauration = { supprime_le: null };
  if (fiche.numero_fiche == null && fiche.episode_id) {
    const { data: derniere } = await supabase.from('fiches').select('numero_fiche').eq('episode_id', fiche.episode_id).not('numero_fiche', 'is', null)
      .order('numero_fiche', { ascending: false }).limit(1).maybeSingle();
    modifsRestauration.numero_fiche = (derniere?.numero_fiche || 0) + 1;
  }
  const { data: ficheRestauree, error } = await supabase.from('fiches').update(modifsRestauration).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!ficheRestauree || ficheRestauree.length === 0) return res.status(404).json({ error: 'Fiche introuvable.' });
  await supabase.from('paiements').update({ supprime_le: null }).eq('fiche_id', req.params.id).eq('supprime_le', horodatageSuppression).select();
  res.json({ success: true });
});
}; // @enveloppe
