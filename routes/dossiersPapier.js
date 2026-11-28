// routes/dossiersPapier.js — Onglet « Archiviste » (28/11, Esdras : « je peux savoir quand un dossier entre dans l'archive, avec sa date, mais je ne sais pas quand il en sort »).
// Suivi de l'emplacement du dossier PAPIER d'un patient : « entré à l'archiviste » / « sorti de l'archiviste », chaque coche gardée avec qui et quand (heure du serveur).
//  - Le droit est celui de l'archiviste (dossier_numero_saisir) ou de la direction (direction_voir) : aucun nouveau droit à répartir dans la matrice des rôles.
//  - Un mouvement coché par erreur est ANNULÉ (annule = true, avec qui et quand), jamais effacé.
//  - La sortie « automatique » (un médicament acheté à la caisse) est DÉDUITE des paiements À LA LECTURE (GET /api/dossiers-papier/suivi, voir utils/suiviDossiersPapier.js) : rien n'est écrit dans le chemin
//    de l'argent (POST /api/paiements est inchangé), et l'archiviste — qui n'a pas le droit de lire les paiements — voit quand même l'état et la date de sortie.
//  - Tant que sql/mouvements_dossier_papier.sql n'est pas appliqué, la lecture renvoie une liste vide et l'écriture répond 503 avec la consigne.
const { construireSuivi, fenetreJourHaiti } = require('../utils/suiviDossiersPapier');

module.exports = function monterDossiersPapier(app, { aPermission, enregistrerAuditServeur, lireParLotsDIds, lireToutesLesPages, supabase }) { // @enveloppe
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
// Le suivi : les patients qui ont fait une transaction le JOUR demandé (jour d'Haïti, AAAA-MM-JJ), ou — avec q (2 lettres au moins) — les patients dont le nom ou le numéro de dossier ressemble, quelle que soit la date.
// Chaque ligne porte l'état du dossier papier (pas entré / dans l'archive / sorti), la date d'entrée et la date de sortie (à la main ou automatique : médicament acheté à la caisse).
app.get('/api/dossiers-papier/suivi', async (req, res) => {
  if (!(await peutSuivreLesDossiersPapier(req.user.id))) return res.status(403).json({ error: "Permission 'dossier_numero_saisir' ou 'direction_voir' requise." });
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const jour = typeof req.query.jour === 'string' ? req.query.jour.trim() : '';
  const recherche = q.length >= 2;
  const fenetre = recherche ? null : fenetreJourHaiti(jour);
  if (!recherche && !fenetre) return res.status(400).json({ error: 'jour (AAAA-MM-JJ) ou q (2 lettres au moins) requis.' });
  try {
    let dossiers;
    if (recherche) {
      const motif = `%${q.replace(/[%_\\]/g, ' ')}%`;
      const [parNom, parNumero] = await Promise.all([
        supabase.from('dossiers').select('id, nom, numero_dossier').is('fusionne_dans', null).ilike('nom', motif).order('nom').limit(50),
        supabase.from('dossiers').select('id, nom, numero_dossier').is('fusionne_dans', null).ilike('numero_dossier', motif).order('nom').limit(50),
      ]);
      if (parNom.error) throw parNom.error;
      if (parNumero.error) throw parNumero.error;
      const vus = new Map(); [...(parNom.data || []), ...(parNumero.data || [])].forEach(d => vus.set(d.id, d));
      dossiers = [...vus.values()].slice(0, 50);
    } else {
      const duJour = await lireToutesLesPages(() => supabase.from('paiements').select('id, episode_id').or('annule.eq.false,annule.is.null').is('supprime_le', null)
        .gte('date_paiement', fenetre.debut).lt('date_paiement', fenetre.fin).order('date_paiement').order('id'));
      const idsEpisodes = [...new Set(duJour.map(p => p.episode_id).filter(Boolean))];
      const episodesDuJour = await lireParLotsDIds(idsEpisodes, lot => supabase.from('episodes').select('id, dossier_id').in('id', lot).order('id'));
      const idsDossiers = [...new Set(episodesDuJour.map(e => e.dossier_id).filter(Boolean))];
      dossiers = await lireParLotsDIds(idsDossiers, lot => supabase.from('dossiers').select('id, nom, numero_dossier').in('id', lot).is('fusionne_dans', null).order('id'));
    }
    const idsDossiers = dossiers.map(d => d.id);
    const episodes = await lireParLotsDIds(idsDossiers, lot => supabase.from('episodes').select('id, dossier_id').in('dossier_id', lot).is('supprime_le', null).order('id'));
    const paiements = await lireParLotsDIds(episodes.map(e => e.id), lot => supabase.from('paiements')
      .select('id, numero_paiement, episode_id, fiche_id, mode, date_paiement, annule, supprime_le').in('episode_id', lot).or('annule.eq.false,annule.is.null').is('supprime_le', null).order('date_paiement').order('id'));
    const fiches = await lireParLotsDIds([...new Set(paiements.map(p => p.fiche_id).filter(Boolean))], lot => supabase.from('fiches').select('id, breakdown').in('id', lot).order('id'));
    let mouvements = [];
    try { mouvements = await lireParLotsDIds(idsDossiers, lot => supabase.from('mouvements_dossier_papier').select('*').in('dossier_id', lot).eq('annule', false).order('date').order('id')); }
    catch (e) { if (!tableDossiersPapierAbsente(e)) throw e; } // SQL pas encore appliqué : aucun mouvement connu, tout est « pas entré »
    res.json({ jour: fenetre ? jour : null, q: recherche ? q : null, lignes: construireSuivi({ dossiers, episodes, paiements, fiches, mouvements, fenetre }) });
  } catch (e) {
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
