// routes/rechercheDossiers.js — Recherche d'un dossier et numéro de dossier donné par la caisse.
// Découpé de server.js le 23/10 sans changer une ligne de logique : le texte des routes est celui d'avant. Ce module reçoit de server.js
// l'application Express et ses dépendances partagées (base, droits, journal d'audit, lecteurs communs) ; voir « montage des routes » dans server.js.
const { numeroProvisoire, erreurNumeroDossier, erreurNumeroDepart, donnerNumeroAuPremierEpisode, marquerExamensSeulement } = require('../utils/numeroDossier');

module.exports = function monterRechercheDossiers(app, { aPermission, enregistrerAuditServeur, supabase }) { // @enveloppe
// ============================================================
// DOSSIER / ÉPISODE / FICHES — nouvelle structure (le vrai flux anti-doublon,
// via l'onglet "🔍 Dossier/Épisode", séparé de la compatibilité ci-dessus)
// ============================================================

// Recherche par nom exact OU par numéro de dossier (si le patient a sa carte). Pour le nom :
// tolérante aux fautes de frappe/accents (fonction Postgres atomique rechercher_dossiers_flou,
// extension pg_trgm — voir fonction_recherche_floue_dossiers.sql) — sans ça, la moindre variation
// (espace en trop, faute de frappe) faisait croire qu'aucun dossier n'existait, créant un doublon
// au lieu de retrouver le patient existant. Repli sur %nom% si la fonction/l'extension n'existe
// pas encore (comme les autres fonctions atomiques du projet, code d'erreur 42883).
app.get('/api/dossiers/recherche', async (req, res) => {
  // 21/10 : faille d'audit — cette route (et les suivantes du même bloc) n'avait aucune vérification de permission, juste un jeton valide. Tous les rôles
  // par défaut ont déjà fiche_patient_voir (aucun changement de comportement aujourd'hui) : ferme le trou pour un futur rôle créé sans ce droit.
  if (!(await aPermission(req.user.id, 'fiche_patient_voir'))) return res.status(403).json({ error: "Permission 'fiche_patient_voir' requise." });
  const nom = (req.query.nom || '').trim();
  const numero = (req.query.numero || '').trim();
  if (!nom && !numero) return res.json([]);

  if (numero) {
    const { data, error } = await supabase.from('dossiers').select('*').eq('numero_dossier', numero);
    if (error) return res.status(500).json({ error: error.message });
    // 14/10 : un dossier FUSIONNÉ dans un autre renvoie le dossier final (le numéro de l'ancien dossier retrouve la bonne personne).
    const fusionnes = (data || []).filter(d => d.fusionne_dans);
    if (fusionnes.length === 0) return res.json(data);
    const { data: finaux } = await supabase.from('dossiers').select('*').in('id', fusionnes.map(d => d.fusionne_dans));
    return res.json((data || []).filter(d => !d.fusionne_dans).concat(finaux || []));
  }

  const { data, error } = await supabase.rpc('rechercher_dossiers_flou', { p_nom: nom });
  if (error) {
    if (error.code === '42883') {
      let { data: repli, error: erreurRepli } = await supabase.from('dossiers').select('*').is('fusionne_dans', null).ilike('nom', `%${nom}%`);
      if (erreurRepli && erreurRepli.code === '42703') ({ data: repli, error: erreurRepli } = await supabase.from('dossiers').select('*').ilike('nom', `%${nom}%`)); // base pas encore migrée
      if (erreurRepli) return res.status(500).json({ error: erreurRepli.message });
      return res.json(repli);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// Liste des patients pour la recherche HORS LIGNE (audit du 28/09 avant la mise en production).
// Esdras : "on doit pouvoir chercher des personnes récentes hors ligne". Jusqu'ici, un appareil
// hors ligne ne retrouvait un patient que s'il avait déjà une VISITE chargée sur cet appareil (la
// copie locale ne contenait que les épisodes) : un dossier créé le matin par l'infirmier sur SA
// tablette restait introuvable à la caisse pendant une coupure. Chaque appareil connecté recopie
// maintenant cette liste (voir chf-app2, api/apiDossierEpisode.js, rafraichirListeHorsLigne).
// nom_origine (28/09) : un bébé renommé au retour du néonat doit rester retrouvable hors ligne
// par son nom de naissance. Colonnes réduites au strict nécessaire pour RETROUVER quelqu'un (pas d'adresse, rien de
// financier). Même accès que /api/dossiers/recherche (toute personne connectée), qui renvoie déjà
// davantage. Paginée : un select unique s'arrêterait en silence à 1000 lignes.
// ============================================================================================
// NUMÉRO DE DOSSIER DONNÉ PAR LA CAISSE (16/10, Esdras) — voir utils/numeroDossier.js et sql/numero_dossier_compteur.sql.
// « Seule la caisse donne un numéro, quand la personne a payé ; le site le donne automatiquement, c'est moi qui définis où ça commence, la caisse peut le modifier. »
// Droit : caisse_travailler (direction, comptable, pharmacien, pharmacien en chef, administrateur) ; infirmier et archiviste n'ont PAS ce droit.
// ⚠️ Ces routes sont déclarées AVANT /api/dossiers/:id (sinon « numero-propose » serait pris pour un identifiant de dossier).
// ============================================================================================
app.get('/api/dossiers/numero-propose', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) return res.status(403).json({ error: "Seule la caisse peut donner un numéro de dossier.", code: 'NUMERO_RESERVE_CAISSE' });
  const { data, error } = await supabase.rpc('numero_dossier_propose');
  if (error) {
    if (['42883', 'PGRST202'].includes(String(error.code))) return res.status(503).json({ error: "Le script sql/numero_dossier_compteur.sql n'est pas encore collé dans Supabase : le numéro automatique n'est pas disponible." });
    return res.status(500).json({ error: error.message });
  }
  res.json({ numero: data });
});

// Donne (ou change) le numéro d'un dossier. Corps : { numero }. Le serveur refuse un numéro déjà pris (409) ; le compteur n'avance que si c'est le numéro proposé.
app.post('/api/dossiers/:id/numero', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) return res.status(403).json({ error: "Seule la caisse peut donner ou changer un numéro de dossier.", code: 'NUMERO_RESERVE_CAISSE' });
  const erreurNumero = erreurNumeroDossier(req.body && req.body.numero);
  if (erreurNumero) return res.status(400).json({ error: erreurNumero });
  const numero = String(req.body.numero).trim();
  const { data, error } = await supabase.rpc('attribuer_numero_dossier', { p_dossier: req.params.id, p_numero: numero });
  if (error) {
    if (['42883', 'PGRST202'].includes(String(error.code))) return res.status(503).json({ error: "Le script sql/numero_dossier_compteur.sql n'est pas encore collé dans Supabase : le numéro automatique n'est pas disponible." });
    const statut = { CHF30: 400, CHF31: 404, CHF32: 409 }[error.code] || (error.code === '22P02' ? 404 : 500);
    return res.status(statut).json({ error: error.message });
  }
  if (!data.inchange) {
    await enregistrerAuditServeur(req, 'numero_dossier_donne', { dossier_id: req.params.id, ancien_numero: data.ancien, nouveau_numero: data.numero, automatique: !!data.automatique });
  }
  res.json(data);
});
}; // @enveloppe
