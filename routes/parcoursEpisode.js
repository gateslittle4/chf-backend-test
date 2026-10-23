// routes/parcoursEpisode.js — Parcours d'un épisode : hospitalisation, fermeture, attente de résultats, transfert, lit.
// Découpé de server.js le 23/10 sans changer une ligne de logique : le texte des routes est celui d'avant. Ce module reçoit de server.js
// l'application Express et ses dépendances partagées (base, droits, journal d'audit, lecteurs communs) ; voir « montage des routes » dans server.js.
const { hospitaliserEpisode } = require('../utils/hospitalisation');

module.exports = function monterParcoursEpisode(app, { aPermission, calculerSoldeDepot, enregistrerAuditServeur, episodeVersFlat, supabase }) { // @enveloppe
// Ancienne bascule « est_hospitalisation » sur place (même épisode) : remplacée le 19/10 par POST /api/episodes/:id/hospitaliser-nouvel-episode (nouvel épisode lié, transfert des soldes).
// Aucun écran ne l'utilisait ; elle est refusée pour qu'on ne fabrique jamais une hospitalisation qui mélange la consultation payée et le séjour.
app.patch('/api/episodes/:id/hospitaliser', (req, res) => {
  res.status(410).json({ error: "Cette route n'existe plus : utilisez « Hospitaliser » (nouvel épisode lié) — POST /api/episodes/:id/hospitaliser-nouvel-episode." });
});

// 19/10 (Esdras) : « Hospitaliser » — la consultation ouverte est fermée et une hospitalisation s'ouvre dans un nouvel épisode lié ; dépôt et crédit (dette) restants passent au nouvel épisode.
// Voir utils/hospitalisation.js. Même droit que créer un épisode (le bouton est sur la liste des épisodes ouverts de Dossier/Épisode).
app.post('/api/episodes/:id/hospitaliser-nouvel-episode', async (req, res) => {
  if (!(await aPermission(req.user.id, 'episode_creer'))) {
    return res.status(403).json({ error: "Permission 'episode_creer' requise pour hospitaliser un patient." });
  }
  try {
    const r = await hospitaliserEpisode({ supabase, episodeId: req.params.id, service: req.body && req.body.service, typeLit: req.body && req.body.type_lit, utilisateur: req.user, calculerSoldeDepot });
    enregistrerAuditServeur(req, 'consultation_vers_hospitalisation', { consultation: req.params.id, hospitalisation: r.nouvelEpisode.id, dossier_id: r.nouvelEpisode.dossier_id, service: r.nouvelEpisode.service, type_lit: r.nouvelEpisode.type_lit, depot_transfere: r.transfere.depot, dette_transferee: r.transfere.dette });
    res.status(201).json({ nouvelEpisode: await episodeVersFlat(r.nouvelEpisode), nouvelEpisodeBrut: r.nouvelEpisode, consultationFermee: r.consultationFermee, transfere: r.transfere });
  } catch (e) {
    res.status(e.statut || 500).json({ error: e.message, code: e.code });
  }
});

// Fermeture d'un épisode (exeat normal ou sans autorisation — même mécanisme, motif différent)
app.patch('/api/episodes/:id/fermer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { motif_fermeture } = req.body;
  const { data, error } = await supabase
    .from('episodes')
    .update({ statut: 'ferme', motif_fermeture, date_fermeture: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Badge ⏳ — uniquement pertinent quand la résolution déborde sur un autre jour
app.patch('/api/episodes/:id/attente-resultats', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { en_attente } = req.body;
  const { data, error } = await supabase
    .from('episodes').update({ en_attente_resultats: !!en_attente }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Transfert d'un patient hospitalisé vers un autre service (retour d'Esdras du 23/08) — ex.
// Maternité -> Néonatologie. Rien ne traçait ça avant : chaque service voyait juste "son"
// épisode séparément, sans lien formel. Change episode.service ET garde une trace (table
// transferts_service) — motif, qui, quand, ancien/nouveau service.
app.patch('/api/episodes/:id/transferer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { nouveau_service, motif, transfere_par, service_attendu } = req.body;
  if (!nouveau_service || !String(nouveau_service).trim()) {
    return res.status(400).json({ error: 'nouveau_service est requis.' });
  }
  const { data: episode, error: erreurLecture } = await supabase
    .from('episodes').select('service, est_hospitalisation, statut').eq('id', req.params.id).single();
  if (erreurLecture) return res.status(404).json({ error: 'Épisode introuvable' });
  if (!episode.est_hospitalisation) return res.status(400).json({ error: 'Seul un épisode en hospitalisation peut être transféré entre services.' });
  if (episode.statut !== 'ouvert') return res.status(400).json({ error: 'Épisode déjà fermé — impossible de le transférer.' });

  // Détection de conflit (retour d'Esdras du 23/08, chantier de robustesse hors ligne, item 8) —
  // même principe que /lit ci-dessous : service_attendu = le service que le poste appelant
  // voyait pour ce patient avant de préparer ce transfert. Si cette requête a attendu en file
  // hors ligne et que quelqu'un d'autre a déjà transféré ce même patient entre-temps (en ligne),
  // appliquer quand même écraserait ce transfert sans prévenir personne.
  if (service_attendu !== undefined && episode.service !== service_attendu) {
    return res.status(409).json({
      error: `Conflit : le service de ce patient a été changé entre-temps par quelqu'un d'autre (actuellement "${episode.service}", tu voyais "${service_attendu}"). Recharge la page pour voir l'état actuel avant de réessayer.`
    });
  }

  // Le lit assigné (retour d'Esdras du 23/08) appartient à l'ANCIEN service — il faut le vider,
  // sinon le patient "occupe" encore un lit d'un service où il n'est plus, et ce lit reste
  // faussement indisponible pour un autre patient.
  const { data, error } = await supabase
    .from('episodes').update({ service: nouveau_service.trim(), lit: null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  const { error: erreurTrace } = await supabase.from('transferts_service').insert({
    episode_id: req.params.id, ancien_service: episode.service, nouveau_service: nouveau_service.trim(),
    motif: motif || null, transfere_par: transfere_par || null, transfere_par_uid: req.user.id,
  });
  if (erreurTrace) console.error('Transfert effectué mais non tracé (transferts_service) :', erreurTrace.message);

  res.json(data);
});

app.get('/api/episodes/:id/transferts', async (req, res) => {
  const { data, error } = await supabase
    .from('transferts_service').select('*').eq('episode_id', req.params.id).order('date_transfert', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Assignation d'un lit nommé (retour d'Esdras du 23/08) — "on sait 12 patients hospitalisés à
// Maternité" mais pas "Lit 3 occupé, Lit 4 libre". lit=null libère le lit (retour, sortie...).
// Refuse d'assigner un lit déjà pris par un AUTRE épisode ouvert du même service — un lit
// physique ne peut pas avoir 2 patients en même temps.
app.patch('/api/episodes/:id/lit', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { lit, lit_attendu } = req.body;
  const { data: episode, error: erreurLecture } = await supabase
    .from('episodes').select('service, est_hospitalisation, statut, lit').eq('id', req.params.id).single();
  if (erreurLecture) return res.status(404).json({ error: 'Épisode introuvable' });
  if (!episode.est_hospitalisation) return res.status(400).json({ error: "Seul un épisode en hospitalisation peut avoir un lit assigné." });
  if (episode.statut !== 'ouvert') return res.status(400).json({ error: 'Épisode déjà fermé.' });

  // Détection de conflit (retour d'Esdras du 23/08, chantier de robustesse hors ligne, item 8) —
  // lit_attendu = le lit que le poste appelant voyait pour ce patient AVANT de préparer ce
  // changement (transmis par le frontend, voir HospitalisationPanel.js). Si cette requête a
  // attendu en file hors ligne et que quelqu'un d'autre a changé le lit de ce même patient
  // entre-temps (en ligne), appliquer quand même écraserait ce changement sans prévenir personne
  // — jusqu'ici seule la CRÉATION avait une protection de ce genre (local_id), pas la
  // modification. Optionnel : un appelant qui ne l'envoie pas garde l'ancien comportement.
  if (lit_attendu !== undefined && (episode.lit || null) !== (lit_attendu || null)) {
    return res.status(409).json({
      error: `Conflit : le lit de ce patient a été changé entre-temps par quelqu'un d'autre (actuellement "${episode.lit || 'aucun'}", tu voyais "${lit_attendu || 'aucun'}"). Recharge la page pour voir l'état actuel avant de réessayer.`
    });
  }

  if (lit) {
    const { data: occupants, error: erreurOccupants } = await supabase
      .from('episodes').select('id').eq('service', episode.service).eq('lit', lit).eq('statut', 'ouvert').neq('id', req.params.id).is('supprime_le', null);
    if (erreurOccupants) return res.status(500).json({ error: erreurOccupants.message });
    if (occupants && occupants.length > 0) return res.status(409).json({ error: `${lit} est déjà occupé par un autre patient de ${episode.service}.` });
  }

  const { data, error } = await supabase
    .from('episodes').update({ lit: lit || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
}; // @enveloppe
