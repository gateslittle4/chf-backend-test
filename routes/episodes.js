// routes/episodes.js — Épisodes : création, modification, corbeille, restauration.
// Découpé de server.js le 23/10 sans changer une ligne de logique : le texte des routes est celui d'avant. Ce module reçoit de server.js
// l'application Express et ses dépendances partagées (base, droits, journal d'audit, lecteurs communs) ; voir « montage des routes » dans server.js.
const { memePatient, formaterNomPropre, erreurIdentiteDossier } = require('../utils/dossiers');
const { numeroProvisoire, erreurNumeroDossier, erreurNumeroDepart, donnerNumeroAuPremierEpisode, marquerExamensSeulement } = require('../utils/numeroDossier');
const { middlewareHeureServeur, appliquerHeureAuPaiement, estRejeu, ENTETE_HEURE } = require('../utils/heureServeur');
const { verifierTotalFiche, verifierPaiementContreFiche, MODES_VENTE } = require('../utils/verificationPrixFiche');

module.exports = function monterEpisodes(app, { aPermission, calculerSoldeDepot, dateOuNull, enregistrerAuditServeur, episodeVersFlat, episodesVersFlatEnLot, estUnVraiUuid, ficheVersColonnes, flatVersStatut, flatVersTypePatient, lireParLotsDIds, lireToutesLesPages, signatureModification, supabase, synchroListes }) { // @enveloppe
// Utilisé par le Calculateur (CalculateurPanel.js) au moment de facturer, pour savoir combien de
// dépôt reste réellement disponible sur cet épisode — jamais le total brut déposé.
// Audit du 31/08 : cette route renvoie un solde de dépôt — une donnée financière. La même donnée
// servie par /api/dossiers/:id/historique est, elle, filtrée sur 'fiche_patient_voir_finances'
// (permission volontairement refusée à archiviste et infirmier, qui consultent le dossier pour son
// historique clinique, pas ses montants). Ici, aucun contrôle : la même information restait
// accessible par un autre chemin. Aligné. Aucun appelant côté navigateur aujourd'hui
// (chf.getSoldeDepot n'est utilisé nulle part), donc aucun risque de régression.
app.get('/api/episodes/:id/solde-depot', async (req, res) => {
  if (!(await aPermission(req.user.id, 'fiche_patient_voir_finances'))) {
    return res.status(403).json({ error: "Permission 'fiche_patient_voir_finances' requise." });
  }
  const { data: paiements, error } = await supabase
    .from('paiements').select('mode, montant, details').eq('episode_id', req.params.id)
    .or('annule.eq.false,annule.is.null').is('supprime_le', null);
  if (error) return res.status(500).json({ error: error.message });
  res.json(calculerSoldeDepot(paiements));
});

app.get('/api/episodes', async (req, res) => {
  // 21/10 : même correctif — la liste complète des épisodes (dossiers, totaux, statuts) n'avait aucune vérification de permission.
  if (!(await aPermission(req.user.id, 'fiche_patient_voir'))) return res.status(403).json({ error: "Permission 'fiche_patient_voir' requise." });
  // Lecture groupée (voir episodesVersFlatEnLot) : un nombre constant de requêtes par lot au lieu
  // de 3 par épisode. Résultat strictement identique — les deux chemins partagent le même
  // assemblage (assemblerEpisodeFlat).
  try {
    // ?synchro=1 : réponse incrémentale { mode, curseur, lignes, supprimes } (utils/synchroListes.js).
    // Sans ce paramètre : le tableau complet d'avant, pour les versions de l'app encore en cache.
    if (req.query.synchro === '1') return res.json(await synchroListes.episodes(req.query.depuis || null));
    // Paginée elle aussi : sans ça, un plafond de lignes côté Supabase aurait tronqué la liste
    // des épisodes EN SILENCE (les plus anciens auraient simplement disparu des rapports, sans
    // erreur) — le reste du correctif n'y aurait rien changé, puisque tout part de cette lecture.
    const episodes = await lireToutesLesPages(
      () => supabase.from('episodes').select('*').is('supprime_le', null).order('date_ouverture', { ascending: false }).order('id'));
    res.json(await episodesVersFlatEnLot(episodes));
  } catch (e) {
    // lireParLotsDIds relaie l'erreur Supabase plutôt que de renvoyer une liste incomplète en
    // silence : mieux vaut un échec visible que des dossiers manquants dans un rapport financier.
    console.error('GET /api/episodes: lecture groupée échouée :', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Création : pas de dossier_id fourni par l'ancien flux (il ne connaît que la
// création directe) → on crée un dossier ET un épisode ensemble dans ce cas.
// Le flux anti-doublon (chercher un dossier existant d'abord) reste le rôle
// du nouvel onglet "Dossier/Épisode", pas de cette route de compatibilité.
app.post('/api/episodes', async (req, res) => {
  if (!(await aPermission(req.user.id, 'dossier_creer'))) {
    return res.status(403).json({ error: "Permission 'dossier_creer' requise." });
  }
  const d = req.body;
  // Tous les appelants passent par toEpisodeApi() côté navigateur avant d'envoyer, donc le
  // corps reçu ici est en snake_case (nom_patient, pas nomPatient) — lire les champs en
  // camelCase les laissait toujours undefined, et cette création échouait systématiquement.
  // Un nom manquant/vide laissait l'erreur brute de Postgres remonter telle quelle à l'écran
  // ("null value in column nom... violates not-null constraint") au lieu d'un message clair.
  if (!d.nom_patient || !String(d.nom_patient).trim()) {
    return res.status(400).json({ error: "Le nom du patient est requis pour créer un dossier." });
  }

  // Idempotence — même principe que /api/dossiers, /api/fiches, /api/paiements et
  // /api/dossiers/:dossierId/episodes. Cette route-ci était la SEULE route de création à ne pas
  // l'avoir (constaté le 25/09, avant la mise en production à l'hôpital), alors qu'elle est
  // empruntée par Achat Express — donc par la file d'attente hors ligne. Une vente comptoir dont
  // la requête atteignait le serveur mais dont la réponse se perdait (coupure réseau au mauvais
  // moment, courant en Haïti) était rejouée au retour d'internet et créait un SECOND dossier,
  // avec sa fiche : un doublon de vente, visible dans le registre et dans les archives.
  if (d.local_id) {
    const { data: dejaCree } = await supabase.from('episodes').select('*').eq('local_id', d.local_id).maybeSingle();
    if (dejaCree) return res.status(200).json(await episodeVersFlat(dejaCree));
  }

  // Faille d'audit du 21/10 : cette route (compatibilité, utilisée par ⚡ Achat Express) insère aussi des FICHES (d.fiches) avec leur total_global/breakdown
  // venus tels quels du téléphone — le même trou que POST /api/fiches, jamais couvert par ce premier correctif puisque c'est une route différente. Même
  // vérification ici, AVANT tout insert (dossier/épisode non encore créés à ce stade) : rien n'est créé si une seule fiche a un montant refusé. Jamais
  // appliqué à la restauration d'une sauvegarde (import_sauvegarde) : d'anciennes données, déjà telles quelles, peuvent légitimement ne plus correspondre
  // au catalogue ou aux tarifs d'AUJOURD'HUI.
  if (Array.isArray(d.fiches) && d.fiches.length > 0 && d.import_sauvegarde !== true) {
    const episodePourPrix = { type_patient: flatVersTypePatient(d.type_patient), ong_partenaire: d.ong_partenaire || null };
    const [{ data: catalogueMed }, { data: catalogueActes }, { data: parametresData }] = await Promise.all([
      supabase.from('catalog').select('items').eq('type', 'medicaments').maybeSingle(),
      supabase.from('catalog').select('items').eq('type', 'actes').maybeSingle(),
      supabase.from('catalog').select('items').eq('type', 'parametres').maybeSingle(),
    ]);
    let ongDocExpress = null;
    if (episodePourPrix.ong_partenaire) {
      const { data } = await supabase.from('ong_partenaires').select('date_fin_contrat').eq('nom', episodePourPrix.ong_partenaire).maybeSingle();
      if (data) ongDocExpress = { dateFinContrat: data.date_fin_contrat };
    }
    const catalogue = { med: (catalogueMed && catalogueMed.items) || [], actes: (catalogueActes && catalogueActes.items) || [] };
    const parametresPourVerif = (parametresData && parametresData.items) || {};
    for (const f of d.fiches) {
      const verification = verifierTotalFiche({
        raw_state: f.rawState !== undefined ? f.rawState : f.raw_state, total_global: f.totalGlobal, breakdown: f.breakdown,
        episode: episodePourPrix, catalogue, parametres: parametresPourVerif, ongDoc: ongDocExpress,
      });
      if (!verification.ok) {
        // Même règle qu'à POST /api/fiches : un rejeu hors ligne n'est jamais refusé (vente déjà faite), seulement signalé.
        if (estRejeu(req)) {
          enregistrerAuditServeur(req, 'fiche_montant_suspect', { episode_id: null, total_global: f.totalGlobal, breakdown: f.breakdown, erreur: verification.erreur, route: '/api/episodes', hors_ligne: true });
        } else {
          enregistrerAuditServeur(req, 'fiche_montant_refuse', { episode_id: null, total_global: f.totalGlobal, breakdown: f.breakdown, erreur: verification.erreur, route: '/api/episodes' });
          return res.status(400).json({ error: verification.erreur, code: 'MONTANT_FICHE_REFUSE' });
        }
      }
    }
  }
  // 15/10 : cette route crée aussi le DOSSIER. Même règle que POST /api/dossiers (numéro, sexe, date de naissance obligatoires), sauf deux cas
  // qui n'enregistrent pas un vrai patient : la vente comptoir (⚡ Express : client de passage, numéro « AUTO-… ») et l'import d'une sauvegarde
  // (anciennes données, déjà telles quelles).
  const exempteIdentite = d.voie_entree === 'vente_comptoir' || d.import_sauvegarde === true;
  // 16/10 : hors vente comptoir et import, le numéro n'est plus exigé — et seule la caisse peut en fournir un ; sans numéro, le dossier est « en attente » (EN-ATTENTE-…).
  let numeroDuDossier = d.numero_dossier || null;
  if (!exempteIdentite) {
    const erreurIdentite = erreurIdentiteDossier({ sexe: d.sexe, date_naissance: d.date_naissance });
    if (erreurIdentite) return res.status(400).json({ error: erreurIdentite, code: 'IDENTITE_INCOMPLETE' });
    if (numeroDuDossier && String(numeroDuDossier).trim()) {
      if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
        return res.status(403).json({ error: "Seule la caisse peut donner un numéro de dossier. Crée le dossier sans numéro : la caisse le donnera après le paiement.", code: 'NUMERO_RESERVE_CAISSE' });
      }
      const erreurNumero = erreurNumeroDossier(numeroDuDossier);
      if (erreurNumero) return res.status(400).json({ error: erreurNumero });
      numeroDuDossier = String(numeroDuDossier).trim();
    } else {
      numeroDuDossier = numeroProvisoire();
    }
  }
  const { data: dossier, error: erreurDossier } = await supabase
    .from('dossiers')
    .insert({
      numero_dossier: numeroDuDossier || `AUTO-${Date.now()}`,
      nom: formaterNomPropre(d.nom_patient), date_naissance: dateOuNull(d.date_naissance), telephone: d.telephone, adresse: d.adresse,
      ...(d.sexe === 'M' || d.sexe === 'F' ? { sexe: d.sexe } : {}),
    })
    .select().single();
  if (erreurDossier) return res.status(500).json({ error: erreurDossier.message });

  const { data: episode, error: erreurEpisode } = await supabase
    .from('episodes')
    .insert({
      dossier_id: dossier.id,
      // Avant : voie_entree/est_hospitalisation étaient figés en dur ('consultation'/false),
      // donc un épisode "Achat Express" (voir components/AchatExpress.js) était indiscernable
      // d'une vraie consultation classique en base. Maintenant lus depuis le corps de la requête
      // (comme la route POST /api/dossiers/:dossierId/episodes le fait déjà) — les 3 autres
      // appelants de cette route (nouveau dossier rapide, archivage sans id serveur, restauration
      // de sauvegarde) n'envoient pas ces champs et gardent donc exactement le même comportement
      // par défaut qu'avant.
      voie_entree: d.voie_entree || 'consultation', service: d.service_choisi || 'Général',
      type_patient: flatVersTypePatient(d.type_patient), ong_partenaire: d.ong_partenaire || null,
      statut: flatVersStatut(d.status), est_hospitalisation: !!d.est_hospitalisation,
      // 19/10 : un épisode créé déjà clôturé (Achat Express) porte sa date de fermeture dès le départ.
      ...(d.status === 'archived' ? { date_fermeture: new Date().toISOString() } : {}),
      // Sans cette colonne renseignée, la vérification d'idempotence ci-dessus ne trouve jamais
      // rien et l'index unique episodes_local_id_unique ne protège rien : les deux ne servent
      // qu'ensemble.
      local_id: d.local_id || null,
    })
    .select().single();
  if (erreurEpisode) {
    // Deux rejeux simultanés peuvent passer la vérification ci-dessus en même temps (la lecture
    // et l'insertion ne sont pas atomiques) : c'est l'index unique en base qui tranche, et 23505
    // signifie alors que l'autre a gagné la course — on renvoie son résultat plutôt qu'une erreur.
    if (erreurEpisode.code === '23505' && d.local_id) {
      const { data: dejaCree } = await supabase.from('episodes').select('*').eq('local_id', d.local_id).maybeSingle();
      if (dejaCree) return res.status(200).json(await episodeVersFlat(dejaCree));
    }
    return res.status(500).json({ error: erreurEpisode.message });
  }

  if (Array.isArray(d.fiches) && d.fiches.length > 0) {
    // Avant : le résultat de cette insertion n'était jamais vérifié — un échec ici laissait
    // quand même passer un 201 "succès" pour tout le dossier, fiches manquantes en silence.
    const { error: erreurFiches } = await supabase.from('fiches').insert(d.fiches.map(f => ({ episode_id: episode.id, ...ficheVersColonnes(f) })));
    if (erreurFiches) return res.status(500).json({ error: `Dossier créé, mais échec de l'enregistrement des fiches : ${erreurFiches.message}` });
  }
  res.status(201).json(await episodeVersFlat(episode));
});

app.put('/api/episodes/:id', async (req, res) => {
  const d = req.body;

  // Même défaut que POST /api/episodes ci-dessus : tous les appelants envoient du snake_case
  // via toEpisodeApi() — lire ces champs en camelCase les laissait toujours undefined, donc
  // ces mises à jour (lot de facturation, service, ONG, type patient, suspension, report au
  // mois suivant) réussissaient (200 OK) sans jamais rien écrire.
  const { data: episodeActuel, error: erreurActuel } = await supabase.from('episodes').select('statut, dossier_id').eq('id', req.params.id).maybeSingle();
  if (erreurActuel) return res.status(500).json({ error: erreurActuel.message });
  // Modifier un dossier déjà archivé (statut 'ferme' — donc potentiellement déjà facturé/lotté)
  // n'avait aucun contrôle de rôle, contrairement à DELETE juste en dessous. Même logique ici,
  // avec la permission 'facturation_modifier' : un dossier encore ouvert reste librement
  // modifiable (saisie rétroactive normale), un dossier déjà archivé ne l'est plus pour tous.
  if (episodeActuel && episodeActuel.statut === 'ferme') {
    if (!(await aPermission(req.user.id, 'facturation_modifier'))) {
      return res.status(403).json({ error: "Permission 'facturation_modifier' requise pour modifier un dossier déjà archivé." });
    }
  }

  const maj = {};
  if (d.service_choisi !== undefined) maj.service = d.service_choisi;
  if (d.type_patient !== undefined) maj.type_patient = flatVersTypePatient(d.type_patient);
  if (d.ong_partenaire !== undefined) maj.ong_partenaire = d.ong_partenaire;
  if (d.status !== undefined) {
    maj.statut = flatVersStatut(d.status);
    maj.date_suspension = d.status === 'suspendu' ? (d.date_suspension || new Date().toISOString()) : null;
    maj.mois_report = d.status === 'reporte' ? (d.mois_report || null) : null;
    // Motif de sortie (hospitalisation uniquement — voir HebergementForm.js) : capturé au
    // moment de la clôture, sur ce même chemin (Archiver), plutôt que via la route dédiée
    // /fermer qui existait déjà mais qu'aucun écran n'appelait.
    if (d.status === 'archived') {
      maj.motif_fermeture = d.motif_fermeture || null;
      maj.date_fermeture = new Date().toISOString();
    }
  }
  if (d.numero_lot !== undefined) maj.numero_lot = d.numero_lot;
  if (d.verrouille_facture !== undefined) maj.verrouille_facture = d.verrouille_facture;
  // Lots & Facturation (version chf-demo2, portée le 08/09) : mois_lot (badge affiché sur le lot,
  // modifiable/rétro-rempli automatiquement) et lot_verrouille (verrouillage d'un lot déjà
  // approuvé par le partenaire — distinct de verrouille_facture, qui protège un dossier
  // individuel). Colonnes ajoutées par sql/ajoute_lot_mois_verrouillage_episodes.sql.
  if (d.mois_lot !== undefined) maj.mois_lot = d.mois_lot;
  if (d.lot_verrouille !== undefined) maj.lot_verrouille = d.lot_verrouille;
  // « Dossier complet » (onglet Lots, version chf-demo2) : strictement vrai ou faux, jamais une chaîne ni un nombre.
  if (d.dossier_complet !== undefined) {
    if (typeof d.dossier_complet !== 'boolean') return res.status(400).json({ error: 'dossier_complet doit valoir true ou false.' });
    maj.dossier_complet = d.dossier_complet;
  }

  if (Object.keys(maj).length > 0) {
    // Chaque modification signe le dossier (modifie_par / modifie_par_uid). Si les colonnes n'existent pas encore (SQL pas collé),
    // la modification passe quand même SANS signature — sauf « dossier complet », qui a besoin de sa colonne.
    let { data, error } = await supabase.from('episodes').update({ ...maj, ...(await signatureModification(req.user)) }).eq('id', req.params.id).select();
    if (error && error.code === '42703') {
      if (d.dossier_complet !== undefined) return res.status(500).json({ error: "La colonne dossier_complet n'existe pas encore dans Supabase — colle sql/ajoute_dossier_complet_modifie_par_episodes.sql dans le SQL Editor." });
      ({ data, error } = await supabase.from('episodes').update(maj).eq('id', req.params.id).select());
    }
    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.status(404).json({ error: "Dossier introuvable — rien n'a été modifié." });
  }

  // Le nom du patient vit sur la table dossiers, pas episodes — cette route ne le touchait
  // jamais, donc corriger un nom depuis Archives affichait "succès" sans rien enregistrer.
  if (d.nom_patient !== undefined && String(d.nom_patient).trim() && episodeActuel) {
    const { data: nomMaj, error: erreurNom } = await supabase.from('dossiers').update({ nom: formaterNomPropre(d.nom_patient) }).eq('id', episodeActuel.dossier_id).select();
    if (erreurNom) return res.status(500).json({ error: erreurNom.message });
    if (!nomMaj || nomMaj.length === 0) return res.status(404).json({ error: "Dossier lié introuvable — le nom n'a pas été modifié." });
  }

  // Fiches : upsert (id fourni = mise à jour, sinon = nouvelle fiche). Ne supprime
  // jamais une fiche absente du tableau reçu — cette route ne gère que l'ajout/modif,
  // pas la suppression de fiches individuelles (aucun ancien appel ne l'utilisait ainsi).
  if (Array.isArray(d.fiches)) {
    for (const f of d.fiches) {
      if (estUnVraiUuid(f.id)) {
        // Avant : ni l'erreur ni le nombre de lignes touchées n'étaient vérifiés ici —
        // même angle mort que /api/catalog (succès silencieux même si rien n'est écrit).
        // Le numéro d'une fiche existante n'est JAMAIS réécrit depuis le navigateur (14/10) : depuis la renumérotation automatique (insertion /
        // suppression d'une fiche), un écran resté sur d'anciens numéros écraserait la bonne numérotation, ou violerait la contrainte d'unicité.
        const { numero_fiche: _numeroIgnore, ...colonnesSansNumero } = ficheVersColonnes(f);
        const { data: fd, error: fe } = await supabase.from('fiches').update(colonnesSansNumero).eq('id', f.id).select();
        if (fe) return res.status(500).json({ error: `Fiche ${f.id} : ${fe.message}` });
        if (!fd || fd.length === 0) return res.status(404).json({ error: `Fiche ${f.id} introuvable — rien n'a été modifié.` });
      }
      else {
        const { error: ei } = await supabase.from('fiches').insert({ episode_id: req.params.id, ...ficheVersColonnes(f) });
        if (ei) return res.status(500).json({ error: `Nouvelle fiche : ${ei.message}` });
      }
    }
  }

  const { data: episode, error: erreurLecture } = await supabase.from('episodes').select('*').eq('id', req.params.id).single();
  if (erreurLecture) return res.status(404).json({ error: 'Épisode introuvable' });
  res.json(await episodeVersFlat(episode));
});

app.delete('/api/episodes/:id', async (req, res) => {
  // Aucun rôle n'était vérifié ici : n'importe quel utilisateur connecté pouvait supprimer
  // définitivement n'importe quel dossier, même déjà archivé/facturé. On distingue maintenant :
  // annuler un brouillon jamais envoyé (statut 'ouvert') reste libre pour qui l'a créé, mais
  // supprimer un dossier déjà archivé (statut 'ferme') est réservé à direction/administrateur.
  const { data: episode, error: erreurLecture } = await supabase.from('episodes').select('statut').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (episode && episode.statut === 'ferme') {
    if (!(await aPermission(req.user.id, 'facturation_supprimer'))) {
      return res.status(403).json({ error: "Permission 'facturation_supprimer' requise pour supprimer un dossier déjà archivé." });
    }
  }
  // Corbeille 30 jours (retour d'Esdras, 01/09 : "j'aime pas trop suppression irréversible") —
  // phase 2, jamais branchée jusqu'ici malgré les colonnes déjà en place (voir
  // sql/corbeille_30_jours.sql). Un UPDATE de supprime_le au lieu d'un vrai DELETE : la ligne
  // reste en base, purgée pour de bon seulement après 30 jours (voir purgerCorbeilleDossiers()).
  // fiches/paiements de CET épisode suivent avec le MÊME horodatage (le vrai DELETE cascadait
  // déjà automatiquement vers eux au niveau base — episodes.dossier_id/fiches.episode_id/
  // paiements.episode_id sont ON DELETE CASCADE — un simple UPDATE ne déclenche pas cette
  // cascade, donc il faut la refaire à la main ici). .is('supprime_le', null) : ne touche jamais
  // une fiche déjà mise à la corbeille séparément plus tôt pour une autre raison, avec sa propre
  // date — cette date sert de repère exact pour distinguer, à la restauration, ce qui a été
  // supprimé AVEC ce dossier de ce qui l'a été indépendamment (voir la route de restauration).
  const maintenant = new Date().toISOString();
  const { data: episodeMaj, error } = await supabase.from('episodes').update({ supprime_le: maintenant }).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!episodeMaj || episodeMaj.length === 0) return res.status(404).json({ error: 'Dossier introuvable.' });
  await supabase.from('fiches').update({ supprime_le: maintenant }).eq('episode_id', req.params.id).is('supprime_le', null).select();
  await supabase.from('paiements').update({ supprime_le: maintenant }).eq('episode_id', req.params.id).is('supprime_le', null).select();
  res.json({ success: true });
});

// Restauration d'un dossier mis à la corbeille — même permission que sa suppression (un
// utilisateur qui peut supprimer un dossier archivé peut aussi annuler ce geste). Ne restaure
// QUE les fiches/paiements dont supprime_le correspond EXACTEMENT à celui de l'épisode — ceux-là
// ont été mis à la corbeille EN MÊME TEMPS que lui (par la cascade ci-dessus), jamais une fiche
// supprimée séparément avant ou après pour une raison qui n'a rien à voir.
app.post('/api/episodes/:id/restaurer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'facturation_supprimer'))) {
    return res.status(403).json({ error: "Permission 'facturation_supprimer' requise pour restaurer un dossier." });
  }
  const { data: episode, error: erreurLecture } = await supabase.from('episodes').select('supprime_le').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!episode) return res.status(404).json({ error: 'Dossier introuvable.' });
  if (!episode.supprime_le) return res.status(400).json({ error: "Ce dossier n'est pas à la corbeille." });
  const horodatageSuppression = episode.supprime_le;
  const { data: episodeRestaure, error } = await supabase.from('episodes').update({ supprime_le: null }).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!episodeRestaure || episodeRestaure.length === 0) return res.status(404).json({ error: 'Dossier introuvable.' });
  await supabase.from('fiches').update({ supprime_le: null }).eq('episode_id', req.params.id).eq('supprime_le', horodatageSuppression).select();
  await supabase.from('paiements').update({ supprime_le: null }).eq('episode_id', req.params.id).eq('supprime_le', horodatageSuppression).select();
  res.json({ success: true });
});

// Liste des dossiers à la corbeille — alimente l'onglet "🗑️ Corbeille" d'Archives, même
// principe que la corbeille du catalogue (GrilleEdition.js) : montrer ce qui reste avant la
// purge définitive à 30 jours, avec la possibilité de restaurer avant.
app.get('/api/episodes/corbeille', async (req, res) => {
  if (!(await aPermission(req.user.id, 'facturation_supprimer'))) {
    return res.status(403).json({ error: "Permission 'facturation_supprimer' requise pour voir la corbeille." });
  }
  // Lectures paginées et par lots (25/09, audit avant mise en production) : la liste des épisodes
  // était plafonnée en silence à 1000 lignes, et un seul .in() mettait TOUS les ids de dossiers
  // dans l'URL — une corbeille bien remplie (30 jours de suppressions) aurait fini par dépasser la
  // limite de longueur, et l'onglet Corbeille aurait cessé de s'afficher. Voir TAILLE_LOT_IDS.
  let episodes, dossiers;
  try {
    episodes = await lireToutesLesPages(() => supabase
      .from('episodes').select('id, dossier_id, supprime_le').not('supprime_le', 'is', null).order('supprime_le', { ascending: false }).order('id'));
    const dossierIds = [...new Set(episodes.map(e => e.dossier_id))];
    dossiers = await lireParLotsDIds(dossierIds, lot => supabase.from('dossiers').select('id, nom').in('id', lot).order('id'));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  const nomParDossier = new Map(dossiers.map(d => [d.id, d.nom]));
  res.json(episodes.map(e => ({ id: e.id, nomPatient: nomParDossier.get(e.dossier_id) || null, supprimeLe: e.supprime_le })));
});
}; // @enveloppe
