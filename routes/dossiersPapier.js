// routes/dossiersPapier.js — Onglet « Archiviste » (28/11, Esdras : « je peux savoir quand un dossier entre dans l'archive, avec sa date, mais je ne sais pas quand il en sort »).
// Suivi de l'emplacement du dossier PAPIER d'un patient : « entré à l'archiviste » / « sorti de l'archiviste », chaque coche gardée avec qui et quand (heure du serveur).
//  - Le droit est celui de l'archiviste (dossier_numero_saisir) ou de la direction (direction_voir) : aucun nouveau droit à répartir dans la matrice des rôles.
//  - Un mouvement coché par erreur est ANNULÉ (annule = true, avec qui et quand), jamais effacé.
//  - La sortie « automatique » (un médicament acheté à la caisse) est DÉDUITE des paiements côté application : rien n'est écrit dans le chemin de l'argent (POST /api/paiements est inchangé).
//  - Tant que sql/mouvements_dossier_papier.sql n'est pas appliqué, la lecture renvoie une liste vide et l'écriture répond 503 avec la consigne.
module.exports = function monterDossiersPapier(app, { aPermission, enregistrerAuditServeur, lireToutesLesPages, supabase }) { // @enveloppe
const tableDossiersPapierAbsente = (e) => /mouvements_dossier_papier/.test(String(e && e.message)) && /does not exist|schema cache|relation/.test(String(e && e.message));
const peutSuivreLesDossiersPapier = async (uid) => (await aPermission(uid, 'dossier_numero_saisir')) || (await aPermission(uid, 'direction_voir'));
const MESSAGE_SQL_DOSSIERS_PAPIER = "Le suivi des dossiers papier n'est pas encore activé : colle mouvements_dossier_papier.sql dans le SQL Editor de Supabase.";
app.get('/api/dossiers-papier/mouvements', async (req, res) => {
  if (!(await peutSuivreLesDossiersPapier(req.user.id))) return res.status(403).json({ error: "Permission 'dossier_numero_saisir' ou 'direction_voir' requise." });
  try {
    res.json(await lireToutesLesPages(() => supabase.from('mouvements_dossier_papier').select('*').eq('annule', false).order('date', { ascending: false }).order('id')));
  } catch (e) {
    if (tableDossiersPapierAbsente(e)) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/dossiers-papier/mouvements', async (req, res) => {
  if (!(await peutSuivreLesDossiersPapier(req.user.id))) return res.status(403).json({ error: "Permission 'dossier_numero_saisir' ou 'direction_voir' requise." });
  const dossierId = typeof req.body.dossier_id === 'string' ? req.body.dossier_id.trim() : '';
  const type = req.body.type;
  if (!dossierId || dossierId.length > 100) return res.status(400).json({ error: 'dossier_id requis.' });
  if (type !== 'entree' && type !== 'sortie') return res.status(400).json({ error: "type doit être 'entree' ou 'sortie'." });
  const local_id = req.body.local_id || req.body.localId || null;
  const note = typeof req.body.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 300) : null;
  if (local_id) {
    const { data: deja, error: erreurLecture } = await supabase.from('mouvements_dossier_papier').select('*').eq('local_id', local_id).maybeSingle();
    if (erreurLecture && tableDossiersPapierAbsente(erreurLecture)) return res.status(503).json({ error: MESSAGE_SQL_DOSSIERS_PAPIER });
    if (deja) return res.status(200).json({ success: true, mouvement: deja, deja_enregistre: true }); // rejeu : déjà enregistré
  }
  const { data: dossier, error: erreurDossier } = await supabase.from('dossiers').select('id, nom').eq('id', dossierId).maybeSingle();
  if (erreurDossier) return res.status(500).json({ error: erreurDossier.message });
  if (!dossier) return res.status(404).json({ error: 'Dossier introuvable.' });
  const { data, error } = await supabase.from('mouvements_dossier_papier').insert({
    dossier_id: dossierId, type, note, par: req.user.email || req.user.id, par_uid: req.user.id, local_id,
  }).select().single();
  if (error) {
    if (tableDossiersPapierAbsente(error)) return res.status(503).json({ error: MESSAGE_SQL_DOSSIERS_PAPIER });
    if (error.code === '23505' && local_id) return res.status(200).json({ success: true, deja_enregistre: true });
    return res.status(500).json({ error: error.message });
  }
  await enregistrerAuditServeur(req, type === 'entree' ? 'dossier_papier_entree' : 'dossier_papier_sortie', { dossier_id: dossierId, nom: dossier.nom || null, mouvement_id: data.id });
  res.status(201).json({ success: true, mouvement: data });
});
app.patch('/api/dossiers-papier/mouvements/:id/annuler', async (req, res) => {
  if (!(await peutSuivreLesDossiersPapier(req.user.id))) return res.status(403).json({ error: "Permission 'dossier_numero_saisir' ou 'direction_voir' requise." });
  const { data, error } = await supabase.from('mouvements_dossier_papier')
    .update({ annule: true, annule_par: req.user.email || req.user.id, annule_par_uid: req.user.id, annule_le: new Date().toISOString() })
    .eq('id', req.params.id).eq('annule', false).select().maybeSingle();
  if (error) return res.status(tableDossiersPapierAbsente(error) ? 503 : 500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Mouvement introuvable, ou déjà annulé.' });
  await enregistrerAuditServeur(req, 'dossier_papier_annule', { dossier_id: data.dossier_id, type: data.type, mouvement_id: data.id });
  res.json({ success: true, mouvement: data });
});
}; // @enveloppe
