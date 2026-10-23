// routes/partenaires.js — Partenaires (ONG) : transfert d'un épisode, remboursement, lots, renommage.
// Découpé de server.js le 23/10 sans changer une ligne de logique : le texte des routes est celui d'avant. Ce module reçoit de server.js
// l'application Express et ses dépendances partagées (base, droits, journal d'audit, lecteurs communs) ; voir « montage des routes » dans server.js.


module.exports = function monterPartenaires(app, { aPermission, calculerSoldeDepot, enregistrerAuditServeur, episodeVersFlat, supabase }) { // @enveloppe
// Retour d'Esdras (27/08, remplace l'ancienne route POST /api/fiches/:id/rembourser-partenaire du
// 25/08 — même principe étendu à tout un épisode plutôt qu'une fiche à la fois, après un long
// brainstorming) : transformer un patient privé en partenaire distingue 2 cas bien différents.
//
// CAS 1 (ci-dessous, /transferer-partenaire) : le partenaire prend en charge le patient À PARTIR
// DE MAINTENANT (déjà à l'hôpital, payait normalement jusqu'ici) — AUCUN remboursement des
// services déjà rendus (déjà payés, déjà consommés) : ils restent tels quels sur l'épisode
// d'origine, qui se ferme simplement pour laisser place à un nouvel épisode partenaire pour la
// suite. Seul le solde de dépôt NON DÉPENSÉ est remboursé (ce n'est pas un service déjà rendu,
// juste de l'argent que le patient n'a plus besoin de laisser une fois le partenaire responsable).
//
// CAS 2 (plus bas, /rembourser-transferer-partenaire) : le partenaire couvrait DÉJÀ le patient
// (référence, notification de groupe...) mais la notification n'a pas atteint la caisse à temps —
// TOUT ce qui a été payé sur les fiches choisies est remboursé aujourd'hui (cash ET dépôt
// confondus), un solde à crédit (jamais réellement encaissé) est simplement annulé plutôt que
// remboursé, et les fiches choisies sont transférées vers UN SEUL nouvel épisode partenaire.
//
// Les 2 cas restent réservés à paiement_annuler (jamais une caissière, jamais l'auto-traitement
// n'est un souci ici — retour d'Esdras : "la direction ne fait pas de décaissement").
app.post('/api/episodes/:id/transferer-partenaire', async (req, res) => {
  if (!(await aPermission(req.user.id, 'paiement_annuler'))) {
    return res.status(403).json({ error: "Permission 'paiement_annuler' requise." });
  }
  const { ong_partenaire, motif, autorise_par } = req.body;
  if (!ong_partenaire) return res.status(400).json({ error: "Le partenaire est requis." });
  if (!motif || !motif.trim()) return res.status(400).json({ error: "Un motif est requis." });
  if (!autorise_par || !autorise_par.trim()) return res.status(400).json({ error: "Le nom de la personne qui autorise ce changement est requis." });

  const { data: episode, error: erreurEpisode } = await supabase.from('episodes').select('*').eq('id', req.params.id).maybeSingle();
  if (erreurEpisode) return res.status(500).json({ error: erreurEpisode.message });
  if (!episode) return res.status(404).json({ error: "Épisode introuvable." });
  // Sans remboursement n'a de sens que pour un épisode encore ouvert (le patient est encore là,
  // le partenaire prend le relais À PARTIR DE MAINTENANT) — un épisode déjà fermé n'a plus de
  // "suite" à transférer, voir /rembourser-transferer-partenaire pour une correction rétroactive.
  if (episode.statut !== 'ouvert') return res.status(400).json({ error: "Seul un épisode ouvert peut être transféré sans remboursement." });

  const { data: dossier } = await supabase.from('dossiers').select('nom').eq('id', episode.dossier_id).maybeSingle();
  const encaissePar = req.user.email || req.user.id;
  const maintenant = new Date().toISOString();
  const detailsAudit = { motif: motif.trim(), autorise_par: autorise_par.trim(), ong_partenaire };

  const { data: paiements, error: erreurPaiements } = await supabase
    .from('paiements').select('*').eq('episode_id', episode.id).or('annule.eq.false,annule.is.null').is('supprime_le', null);
  if (erreurPaiements) return res.status(500).json({ error: erreurPaiements.message });
  const { soldeDepot } = calculerSoldeDepot(paiements);

  let paiementDepot = null;
  if (soldeDepot > 0) {
    const { data, error } = await supabase.from('paiements').insert({
      episode_id: episode.id, fiche_id: null, patient_nom: dossier?.nom || null,
      montant: soldeDepot, mode: 'remboursement_patient',
      date_paiement: maintenant, encaisse_par: encaissePar, traite_par_uid: req.user.id,
      details: detailsAudit,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    paiementDepot = data;
  }

  const { data: nouvelEpisode, error: erreurNouvelEpisode } = await supabase.from('episodes').insert({
    dossier_id: episode.dossier_id, voie_entree: episode.voie_entree, service: episode.service,
    type_patient: 'partenaire', ong_partenaire, statut: 'ouvert', est_hospitalisation: episode.est_hospitalisation,
  }).select().single();
  if (erreurNouvelEpisode) {
    if (paiementDepot) await supabase.from('paiements').delete().eq('id', paiementDepot.id);
    return res.status(500).json({ error: erreurNouvelEpisode.message });
  }

  // Referme l'épisode d'origine — best-effort, jamais bloquant (la correction ci-dessus est déjà
  // complète et valide à ce stade), même philosophie que le Cas 2 plus bas.
  await supabase.from('episodes').update({ statut: 'ferme' }).eq('id', episode.id).select();

  res.status(201).json({ paiementDepot, nouvelEpisode: await episodeVersFlat(nouvelEpisode) });
});

app.post('/api/episodes/:id/rembourser-transferer-partenaire', async (req, res) => {
  if (!(await aPermission(req.user.id, 'paiement_annuler'))) {
    return res.status(403).json({ error: "Permission 'paiement_annuler' requise." });
  }
  const { ong_partenaire, motif, autorise_par, fiche_ids } = req.body;
  if (!ong_partenaire) return res.status(400).json({ error: "Le partenaire est requis." });
  if (!motif || !motif.trim()) return res.status(400).json({ error: "Un motif est requis." });
  if (!autorise_par || !autorise_par.trim()) return res.status(400).json({ error: "Le nom de la personne qui autorise ce changement est requis." });
  if (!Array.isArray(fiche_ids) || fiche_ids.length === 0) return res.status(400).json({ error: "Au moins une fiche doit être sélectionnée." });

  const { data: episode, error: erreurEpisode } = await supabase.from('episodes').select('*').eq('id', req.params.id).maybeSingle();
  if (erreurEpisode) return res.status(500).json({ error: erreurEpisode.message });
  if (!episode) return res.status(404).json({ error: "Épisode introuvable." });

  const { data: fiches, error: erreurFiches } = await supabase.from('fiches').select('*').eq('episode_id', episode.id).in('id', fiche_ids).is('supprime_le', null);
  if (erreurFiches) return res.status(500).json({ error: erreurFiches.message });
  if ((fiches || []).length !== fiche_ids.length) return res.status(400).json({ error: "Une ou plusieurs fiches sélectionnées n'appartiennent pas à cet épisode." });

  const { data: paiementsEpisode, error: erreurPaiementsEpisode } = await supabase
    .from('paiements').select('*').eq('episode_id', episode.id).or('annule.eq.false,annule.is.null').is('supprime_le', null);
  if (erreurPaiementsEpisode) return res.status(500).json({ error: erreurPaiementsEpisode.message });

  // Validé AVANT de toucher à quoi que ce soit : le paiement "encaissable ou à crédit" d'origine
  // de chaque fiche (pas déjà annulé — donc pas déjà transféré via cette même route, qui annule ou
  // rembourse toujours l'original — ni un mode qui n'a pas de sens ici).
  const paiementsOriginaux = new Map();
  for (const fiche of fiches) {
    const paiementOriginal = paiementsEpisode.find(p => p.fiche_id === fiche.id && !['ong', 'exoneration', 'remboursement_patient', 'remboursement_credit'].includes(p.mode));
    if (!paiementOriginal) {
      return res.status(400).json({ error: `Aucun paiement encaissable ou à crédit trouvé pour la fiche N°${fiche.numero_fiche} (déjà transférée, déjà annulée, ou déjà facturée à un partenaire).` });
    }
    paiementsOriginaux.set(fiche.id, paiementOriginal);
  }

  // Audit du 01/09 : une fiche à crédit voit son solde simplement ANNULÉ (rien n'a été encaissé,
  // donc rien à rendre). Sauf si le patient avait déjà remboursé une partie de ce crédit en
  // espèces : cet argent-là est bien sorti de sa poche et bien entré dans le tiroir. L'annulation
  // ne le lui rend pas, et le partenaire est facturé pour la fiche entière — l'hôpital serait payé
  // deux fois pour la même somme, et le patient perdrait ce qu'il a versé, sans que rien ne
  // l'affiche nulle part.
  // On ne peut pas rembourser automatiquement : un remboursement de crédit est rattaché à
  // l'ÉPISODE, jamais à une fiche précise (voir toPaiementApi côté navigateur, aucun fiche_id) —
  // impossible donc de savoir quelle part revient à quelle fiche. On refuse plutôt que de faire
  // disparaître de l'argent en silence, en disant le montant exact et quoi faire.
  const auMoinsUneFicheACredit = [...paiementsOriginaux.values()].some(p => p.mode === 'credit');
  if (auMoinsUneFicheACredit) {
    const dejaRembourse = paiementsEpisode
      .filter(p => p.mode === 'remboursement_credit')
      .reduce((s, p) => s + (parseFloat(p.montant) || 0), 0);
    if (dejaRembourse > 0) {
      return res.status(409).json({
        error: `Ce patient a déjà remboursé ${dejaRembourse} Gdes de son crédit sur cet épisode. Annuler le crédit ne lui rendrait PAS cet argent, alors que le partenaire serait facturé pour la totalité — l'hôpital serait payé deux fois. Rends-lui d'abord ces ${dejaRembourse} Gdes à la caisse, puis recommence ce transfert. (Ou décoche les fiches payées à crédit.)`,
      });
    }
  }

  const { data: dossier } = await supabase.from('dossiers').select('nom').eq('id', episode.dossier_id).maybeSingle();
  const encaissePar = req.user.email || req.user.id;
  const maintenant = new Date().toISOString();
  const motifTrim = motif.trim(); const autoriseParTrim = autorise_par.trim();
  const detailsAudit = { motif: motifTrim, autorise_par: autoriseParTrim, ong_partenaire };

  // Un seul nouvel épisode, OUVERT (retour d'Esdras, 29/08 : "je vois que le nouvel épisode créé
  // est aussi archivé, il devrait être actif avec les nouvelles fiches non ?") — reçoit TOUTES les
  // fiches transférées, jamais un épisode par fiche. Créé fermé jusqu'ici (pensé comme une pure
  // correction comptable rétroactive, "pas une nouvelle visite") : en pratique le patient est
  // souvent encore à l'hôpital au moment du transfert, et la caisse doit pouvoir continuer à
  // ajouter des fiches sur ce même épisode partenaire par la suite — un épisode 'ferme' l'en
  // empêchait (voir PUT /api/episodes/:id, qui réserve la modif d'un épisode fermé à
  // facturation_modifier). Reste à fermer normalement plus tard, via Archiver, comme tout épisode.
  const { data: nouvelEpisode, error: erreurNouvelEpisode } = await supabase.from('episodes').insert({
    dossier_id: episode.dossier_id, voie_entree: 'consultation', service: episode.service || 'Général',
    type_patient: 'partenaire', ong_partenaire, statut: 'ouvert', est_hospitalisation: false,
  }).select().single();
  if (erreurNouvelEpisode) return res.status(500).json({ error: erreurNouvelEpisode.message });

  // Nettoyage en cas d'échec en cours de route — tout ce qui a déjà été inséré est retiré, dans
  // l'ordre inverse, pour ne jamais laisser une correction financière à moitié faite. Une fiche
  // annulée (cas crédit) n'est PAS ré-activée par ce nettoyage — best-effort, comme partout
  // ailleurs dans ce fichier, mais l'échec se produit avant ou après selon l'étape.
  const aNettoyer = { paiements: [], fiches: [], episodes: [nouvelEpisode.id] };
  const nettoyer = async () => {
    for (const id of aNettoyer.paiements) await supabase.from('paiements').delete().eq('id', id);
    for (const id of aNettoyer.fiches) await supabase.from('fiches').delete().eq('id', id);
    for (const id of aNettoyer.episodes) await supabase.from('episodes').delete().eq('id', id);
  };

  let numeroFiche = 1;
  const resultats = [];
  try {
    for (const fiche of fiches) {
      const paiementOriginal = paiementsOriginaux.get(fiche.id);

      if (paiementOriginal.mode === 'credit') {
        // Rien n'a jamais été réellement encaissé pour cette fiche — pas de sortie de cash, le
        // solde à crédit est simplement annulé (le patient ne le doit plus, transféré au partenaire).
        const { error } = await supabase.from('paiements').update({
          annule: true, annule_par: autoriseParTrim, annule_par_uid: req.user.id,
          annule_le: maintenant, motif_annulation: `Transféré à ${ong_partenaire} : ${motifTrim}`,
        }).eq('id', paiementOriginal.id).select().single();
        if (error) throw new Error(error.message);
      } else {
        const { data: remb, error } = await supabase.from('paiements').insert({
          episode_id: episode.id, fiche_id: fiche.id, patient_nom: paiementOriginal.patient_nom,
          montant: fiche.total_global, mode: 'remboursement_patient',
          date_paiement: maintenant, encaisse_par: encaissePar, traite_par_uid: req.user.id,
          details: detailsAudit,
        }).select().single();
        if (error) throw new Error(error.message);
        aNettoyer.paiements.push(remb.id);
      }

      // Fiche "reconduite" (mêmes articles/montant que l'originale) — aucun nouvel article, donc
      // aucun décrément de stock : les articles ont déjà été distribués à la création d'origine.
      const { data: nouvelleFiche, error: erreurNouvelleFiche } = await supabase.from('fiches').insert({
        episode_id: nouvelEpisode.id, numero_fiche: numeroFiche++, cree_par: encaissePar, cree_par_uid: req.user.id,
        raw_state: fiche.raw_state, total_global: fiche.total_global, breakdown: fiche.breakdown, mode_paiement: 'ong',
      }).select().single();
      if (erreurNouvelleFiche) throw new Error(erreurNouvelleFiche.message);
      aNettoyer.fiches.push(nouvelleFiche.id);

      const { data: paiementOng, error: erreurPaiementOng } = await supabase.from('paiements').insert({
        episode_id: nouvelEpisode.id, fiche_id: nouvelleFiche.id, patient_nom: paiementOriginal.patient_nom,
        montant: fiche.total_global, mode: 'ong', ong_partenaire, solde_restant: 0,
        date_paiement: maintenant, encaisse_par: encaissePar, traite_par_uid: req.user.id,
      }).select().single();
      if (erreurPaiementOng) throw new Error(erreurPaiementOng.message);
      aNettoyer.paiements.push(paiementOng.id);

      resultats.push({ ficheOriginale: fiche.id, nouvelleFiche: nouvelleFiche.id });
    }

    // Solde de dépôt restant sur l'épisode — remboursé une seule fois pour tout l'épisode, jamais
    // par fiche (un dépôt n'est jamais lié à une fiche précise).
    const { soldeDepot } = calculerSoldeDepot(paiementsEpisode);
    let paiementDepot = null;
    if (soldeDepot > 0) {
      const { data, error } = await supabase.from('paiements').insert({
        episode_id: episode.id, fiche_id: null, patient_nom: dossier?.nom || null,
        montant: soldeDepot, mode: 'remboursement_patient',
        date_paiement: maintenant, encaisse_par: encaissePar, traite_par_uid: req.user.id,
        details: detailsAudit,
      }).select().single();
      if (error) throw new Error(error.message);
      paiementDepot = data;
      aNettoyer.paiements.push(paiementDepot.id);
    }

    // Referme l'épisode d'origine — TOUJOURS, même si certaines fiches n'ont pas été incluses
    // (retour d'Esdras, 27/08 : "oui, toujours fermé").
    await supabase.from('episodes').update({ statut: 'ferme' }).eq('id', episode.id).select();

    res.status(201).json({ resultats, paiementDepot, nouvelEpisode: await episodeVersFlat(nouvelEpisode) });
  } catch (e) {
    await nettoyer();
    res.status(500).json({ error: e.message });
  }
});

// Numéro de lot suivant, pour un partenaire — ATOMIQUE (une seule requête SQL qui lit et
// incrémente en même temps), contrairement à l'ancien calcul côté navigateur (max des lots
// existants + 1) qui pouvait attribuer 2 fois le même numéro si généré 2 fois à quelques
// secondes d'écart. ong_partenaires.prochain_numero devient la vraie source, mise à jour à
// chaque appel — plus besoin de la recalculer depuis l'historique des lots.
app.post('/api/lots/prochain-numero', async (req, res) => {
  if (!(await aPermission(req.user.id, 'facturation_exporter'))) {
    return res.status(403).json({ error: "Permission 'facturation_exporter' requise." });
  }
  const { ong_partenaire } = req.body;
  if (!ong_partenaire) return res.status(400).json({ error: 'ong_partenaire requis' });
  const { data, error } = await supabase.rpc('incrementer_prochain_numero_lot', { p_ong: ong_partenaire });
  if (error) return res.status(500).json({ error: error.message });
  if (data === null || data === undefined) return res.status(404).json({ error: `Partenaire "${ong_partenaire}" introuvable.` });
  res.json({ numero: data });
});

// Renommer un partenaire (16/10) : le nom du partenaire, celui de tous ses épisodes et paiements, et la clé de ses dons de médicaments changent EN UN BLOC
// (fonction SQL renommer_partenaire, sql/renommer_partenaire_avec_dons.sql) — l'historique reste d'un seul morceau. RÉSERVÉ aux rôles « administrateur » et « direction »
// (demande d'Esdras) : volontairement un contrôle de rôle et non une permission, comme /api/admin/anomalies, donc pas modifiable par l'écran Rôles & permissions.
app.patch('/api/ong-partenaires/:id/renommer', async (req, res) => {
  const { data: profil, error: erreurProfil } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
  if (erreurProfil) return res.status(500).json({ error: erreurProfil.message });
  if (!profil || !['administrateur', 'direction'].includes(profil.role)) return res.status(403).json({ error: "Réservé à l'administrateur et à la direction." });
  const nouveauNom = typeof req.body.nom === 'string' ? req.body.nom.trim().replace(/\s+/g, ' ') : '';
  if (!nouveauNom) return res.status(400).json({ error: 'Le nouveau nom est requis.' });
  if (nouveauNom.length > 100) return res.status(400).json({ error: 'Le nom est trop long (100 caractères au plus).' });
  const { data: avant } = await supabase.from('ong_partenaires').select('nom').eq('id', req.params.id).is('supprime_le', null).maybeSingle();
  const { data, error } = await supabase.rpc('renommer_partenaire', { p_id: req.params.id, p_nouveau_nom: nouveauNom });
  if (error) {
    const statut = { CHF20: 400, CHF21: 404, CHF22: 409 }[error.code] || 500;
    return res.status(statut).json({ error: error.message });
  }
  if (!data.inchange) await enregistrerAuditServeur(req, 'renommer_partenaire', { id: req.params.id, ancien_nom: avant ? avant.nom : null, nouveau_nom: nouveauNom, episodes: data.episodes, paiements: data.paiements, dons: data.dons });
  res.json({ ...data, nom: nouveauNom });
});
}; // @enveloppe
