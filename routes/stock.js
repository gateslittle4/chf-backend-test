// routes/stock.js — Stock et réquisitions : sorties, restitutions, réceptions, dons.
// Découpé de server.js le 23/10 sans changer une ligne de logique : le texte des routes est celui d'avant. Ce module reçoit de server.js
// l'application Express et ses dépendances partagées (base, droits, journal d'audit, lecteurs communs) ; voir « montage des routes » dans server.js.


module.exports = function monterStock(app, { aPermission, enregistrerAuditServeur, envoyerCallMeBot, lireToutesLesPages, supabase }) { // @enveloppe
// Décrémente le stock de façon atomique (voir fonction_decrementer_stock_et_numerotation_lots.sql) — remplace le
// calcul côté navigateur + réécriture complète du catalogue, qui pouvait perdre une vente si
// 2 ventes du même médicament arrivaient presque en même temps (2e écriture qui efface la
// 1ère au lieu de s'additionner). Tout-ou-rien : si un seul article manque, rien n'est décrémenté.
app.post('/api/stock/decrementer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { decrements } = req.body; // [{ id, qte }, ...]
  if (!Array.isArray(decrements) || decrements.length === 0) {
    return res.status(400).json({ error: 'decrements (tableau non vide) requis.' });
  }
  // Idempotence (audit hors ligne du 01/09) : c'était la SEULE route d'écriture de la file hors
  // ligne sans protection contre un rejeu. Depuis que syncPending garde les opérations "en vol"
  // jusqu'à confirmation du serveur (api/supabase.js), un arrêt brutal entre l'envoi et sa
  // confirmation fait rejouer l'opération au démarrage suivant — sans garde, le stock aurait été
  // décrémenté deux fois pour une seule vente. La trace est posée dans la MÊME transaction que le
  // décrément (voir decrementer_stock_medicaments(jsonb, text), sql/idempotence_decrement_stock.sql).
  const local_id = req.body.local_id || req.body.localId || null;
  // Retour d'Esdras (29/08) : alerte WhatsApp quand un médicament FRANCHIT son seuil critique —
  // lu AVANT le décrément pour ne comparer qu'à ce moment précis (avant > seuil, après <= seuil),
  // sinon chaque vente suivante d'un article déjà bas redéclencherait une alerte à chaque fois.
  const { data: avantData } = await supabase.from('catalog').select('items').eq('type', 'medicaments').single();
  const avantParId = new Map((avantData?.items || []).map(m => [m.id, m]));

  // 22/10 (Esdras) : un épisode d'un SERVICE puise d'abord dans le stock de ce service (celui de ses réquisitions), puis dans la pharmacie — voir sql/stock_par_service.sql.
  // Sans service (consultation, Achat Express...) : le stock de la pharmacie, comme avant.
  const serviceVente = typeof req.body.service === 'string' ? req.body.service.trim() : '';
  const { data, error } = serviceVente
    ? await supabase.rpc('decrementer_stock_service', { p_service: serviceVente, p_decrements: decrements, p_local_id: local_id })
    : await supabase.rpc('decrementer_stock_medicaments', { p_decrements: decrements, p_local_id: local_id });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL decrementer_stock_medicaments n'existe pas encore dans Supabase — colle fonction_decrementer_stock_et_numerotation_lots.sql puis idempotence_decrement_stock.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  // Rejeu détecté : le stock a déjà été décrémenté par le premier envoi (voir local_id ci-dessus).
  // On répond 200 avec l'état actuel, comme pour un succès — c'est ce que la file hors ligne attend
  // pour considérer l'opération terminée et la sortir définitivement.
  if (data.deja_applique) {
    console.log(`↩️ Décrément de stock déjà appliqué (local_id=${local_id}) — rejeu ignoré.`);
    return res.json({ success: true, deja_applique: true, items: data.items });
  }
  if (!data.succes) {
    const detail = (data.manquants || []).map(m => `${m.nom || m.id} (${m.disponible} restant)`).join(', ');
    return res.status(409).json({ error: `Stock insuffisant : ${detail}`, manquants: data.manquants });
  }

  const { data: parametresData } = await supabase.from('catalog').select('items').eq('type', 'parametres').maybeSingle();
  const seuilParDefaut = parametresData?.items?.seuilStockBas ?? 5;
  const franchissements = decrements
    .map(d => avantParId.get(d.id))
    .filter(Boolean)
    .map(avant => ({ avant, apres: (data.items || []).find(m => m.id === avant.id) }))
    .filter(({ avant, apres }) => apres && (avant.seuilAlerte ?? seuilParDefaut) < avant.quantite && apres.quantite <= (avant.seuilAlerte ?? seuilParDefaut));
  if (franchissements.length > 0) {
    const detail = franchissements.map(({ avant, apres }) => `${avant.nom} (reste ${apres.quantite})`).join(', ');
    envoyerCallMeBot(`📦 CHF : stock bas — ${detail}`); // best-effort, ne bloque jamais la réponse à la caisse
  }

  res.json({ success: true, items: data.items, ...(data.repartition ? { repartition: data.repartition } : {}) });
});

// Restitution d'une vente annulée (fiche supprimée, encaissement échoué) : chaque article revient là où il avait été pris — stock du service ou pharmacie
// (voir restituer_stock_ventes, sql/stock_par_service.sql). entrees : [{ fiche | origine, lignes: [{ id, qte }] }]. Idempotent par local_id.
app.post('/api/stock/restituer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { entrees } = req.body;
  if (!Array.isArray(entrees) || entrees.length === 0 || entrees.length > 100) {
    return res.status(400).json({ error: 'entrees (1 à 100) requises.' });
  }
  for (const e of entrees) {
    const bonneRef = (typeof e?.fiche === 'string' && e.fiche) || (typeof e?.origine === 'string' && e.origine);
    const bonnesLignes = Array.isArray(e?.lignes) && e.lignes.length > 0 && e.lignes.every(l => l && typeof l.id === 'string' && Number(l.qte) > 0);
    if (!bonneRef || !bonnesLignes) return res.status(400).json({ error: 'Chaque entrée a besoin d\'une fiche (ou origine) et de lignes { id, qte > 0 }.' });
  }
  const local_id = req.body.local_id || req.body.localId || null;
  const { data, error } = await supabase.rpc('restituer_stock_ventes', { p_entrees: entrees, p_local_id: local_id });
  if (error) {
    if (error.code === '42883') return res.status(500).json({ error: "La fonction SQL restituer_stock_ventes n'existe pas encore dans Supabase — colle stock_par_service.sql dans le SQL Editor." });
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, ...(data.deja_applique ? { deja_applique: true } : {}), items: data.items });
});

// ============================================================
// RÉQUISITIONS — retour d'Esdras (23/08) : jusqu'ici, réquisitionner du stock pour un autre
// service voulait dire aller corriger chaque médicament un par un dans "Gestion des stocks"
// (fastidieux, aucune trace de quel service a pris quoi). Réutilise la fonction Postgres
// atomique de décrément déjà utilisée pour les ventes (tout-ou-rien, jamais de survente), avec
// une trace en plus (table requisitions) pour le rapport "médicaments par service".
// ============================================================

// stock_gerer : même permission que le reste de "Gestion des stocks" — une réquisition retire du
// vrai stock, ce n'est pas une vente (donc pas caisse_travailler).
app.post('/api/requisitions', async (req, res) => {
  if (!(await aPermission(req.user.id, 'stock_gerer'))) {
    return res.status(403).json({ error: "Permission 'stock_gerer' requise." });
  }
  const { service_demandeur, lignes, demande_par } = req.body;
  if (!service_demandeur || !String(service_demandeur).trim()) {
    return res.status(400).json({ error: 'service_demandeur est requis.' });
  }
  if (!Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ error: 'lignes (tableau non vide) requis.' });
  }
  // Audit hors ligne du 03/09 : cette route était la PIRE des trois trouvées — un rejeu sortait le
  // stock DEUX fois ET laissait 2 lignes au registre pour une seule demande réelle (le service
  // reçoit 10 sérums, le stock en compte 20 de moins). Le commentaire d'origine justifiait
  // l'absence de local_id par "les réquisitions ne passent jamais par la file hors ligne" — c'était
  // faux : chf.creerRequisition() est un this.request() ordinaire, donc mis en file comme le reste.
  // Double protection, exactement comme dossiers/fiches/paiements :
  //   1. la ligne déjà écrite est renvoyée telle quelle (200) si ce local_id est déjà connu ;
  //   2. le décrément passe par la surcharge idempotente (p_local_id) — donc même si l'insert
  //      ci-dessous échoue et que l'opération est rejouée, le stock ne sort qu'une fois.
  const local_id = req.body.local_id || req.body.localId || null;
  if (local_id) {
    const { data: existante } = await supabase.from('requisitions').select('*').eq('local_id', local_id).maybeSingle();
    if (existante) return res.status(200).json({ ...existante, deja_applique: true });
  }
  // 22/10 (Esdras) : une réquisition DONNE le stock au service (la pharmacie diminue, le stock du service augmente) ; les épisodes de ce service puisent ensuite dedans.
  // Atomique (une seule fonction SQL, voir sql/stock_par_service.sql), tout-ou-rien, idempotente par local_id.
  if (lignes.some(l => !l || !l.id || !(Number(l.qte) > 0))) {
    return res.status(400).json({ error: 'Chaque ligne a besoin d\'un médicament et d\'une quantité supérieure à 0.' });
  }
  const { data, error } = await supabase.rpc('transferer_stock_service', {
    p_service: String(service_demandeur).trim(),
    p_lignes: lignes.map(l => ({ id: l.id, qte: Number(l.qte) })),
    p_local_id: local_id,
  });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL transferer_stock_service n'existe pas encore dans Supabase — colle stock_par_service.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  if (!data.succes) {
    const detail = (data.manquants || []).map(m => `${m.nom || m.id} (${m.disponible} restant à la pharmacie)`).join(', ');
    return res.status(409).json({ error: `Stock insuffisant : ${detail}`, manquants: data.manquants });
  }
  // Les noms viennent du catalogue à jour renvoyé par le décrément (pas de req.body) — la
  // réquisition doit rester lisible même si un médicament est renommé/supprimé plus tard.
  const lignesAvecNoms = lignes.map(l => {
    const article = (data.items || []).find(i => i.id === l.id);
    return { id: l.id, nom: article ? article.nom : l.id, quantite: l.qte };
  });
  const { data: requisition, error: erreurInsert } = await supabase.from('requisitions').insert({
    service_demandeur: service_demandeur.trim(), lignes: lignesAvecNoms,
    demande_par: demande_par || null, demande_par_uid: req.user.id, local_id: local_id || null,
    stock_par_service: true, // les réquisitions d'avant (stock simplement sorti de la pharmacie) gardent l'ancien comportement à l'annulation / modification
  }).select().single();
  if (erreurInsert) {
    // 23505 = ce local_id est déjà en base : un rejeu a doublé l'insert entre la lecture ci-dessus
    // et ici (deux onglets, ou une reprise de file très rapprochée). La ligne existe donc bien —
    // la renvoyer vaut mieux qu'une erreur 500 qui ferait retenter indéfiniment.
    if (erreurInsert.code === '23505' && local_id) {
      const { data: existante } = await supabase.from('requisitions').select('*').eq('local_id', local_id).maybeSingle();
      if (existante) return res.status(200).json({ ...existante, deja_applique: true });
    }
    return res.status(500).json({ error: erreurInsert.message });
  }
  res.status(201).json({ ...requisition, items: data.items });
});

// analytics_voir en plus de stock_gerer : Direction/comptable doivent pouvoir consulter le
// rapport "médicaments par service" sans avoir le droit de sortir du stock eux-mêmes.
app.get('/api/requisitions', async (req, res) => {
  // requisitions_voir (28/08) ajouté : l'écran Réquisitions en lecture seule (visiteur) a besoin
  // de pouvoir lister les réquisitions, sans le droit d'en créer une (stock_gerer, inchangé).
  if (!(await aPermission(req.user.id, 'stock_gerer')) && !(await aPermission(req.user.id, 'analytics_voir')) && !(await aPermission(req.user.id, 'requisitions_voir'))) {
    return res.status(403).json({ error: "Permission 'stock_gerer', 'analytics_voir' ou 'requisitions_voir' requise." });
  }
  // Paginée (25/09, audit avant mise en production) : sans ça, au-delà de 1000 réquisitions, les
  // plus anciennes disparaissaient en silence du rapport "médicaments par service".
  try {
    res.json(await lireToutesLesPages(
      () => supabase.from('requisitions').select('*').order('date_requisition', { ascending: false }).order('id')));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Réception de médicaments, annulation et modification des réquisitions (20/10, Esdras)
//  - La réception (achat ou don) a son propre onglet : on n'ajoute plus de stock « au clic » depuis la liste du stock. Chaque réception laisse une trace (qui, quand, quoi, source).
//    Un médicament reçu en DON peut être marqué « exonération jusqu'à 50 % ».
//  - Une réquisition déjà faite s'annule (le stock revient) ou se modifie (le stock suit la différence) ; jamais supprimée : la trace reste.
// ============================================================
const SOURCES_RECEPTION = ['achat', 'don'];
app.get('/api/receptions-medicaments', async (req, res) => {
  if (!(await aPermission(req.user.id, 'stock_reception')) && !(await aPermission(req.user.id, 'stock_gerer')) && !(await aPermission(req.user.id, 'stock_voir'))) {
    return res.status(403).json({ error: "Permission 'stock_reception', 'stock_gerer' ou 'stock_voir' requise." });
  }
  try {
    res.json(await lireToutesLesPages(() => supabase.from('receptions_medicaments').select('*').order('date_reception', { ascending: false }).order('id')));
  } catch (e) {
    if (/receptions_medicaments/.test(String(e.message)) && /does not exist|schema cache|relation/.test(String(e.message))) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/stock/reception', async (req, res) => {
  if (!(await aPermission(req.user.id, 'stock_reception'))) return res.status(403).json({ error: "Permission 'stock_reception' requise." });
  const { lignes } = req.body;
  if (!Array.isArray(lignes) || lignes.length === 0 || lignes.length > 100) return res.status(400).json({ error: 'lignes (1 à 100) requises.' });
  for (const l of lignes) {
    if (!l || !l.id || !(Number(l.quantite) > 0) || Number(l.quantite) > 10000000) return res.status(400).json({ error: 'Chaque ligne a besoin d\'un médicament et d\'une quantité supérieure à 0.' });
    if (!SOURCES_RECEPTION.includes(l.source)) return res.status(400).json({ error: "Chaque ligne a besoin d'une source : achat ou don." });
    if (l.source === 'don' && typeof l.exoneration_50 !== 'boolean') return res.status(400).json({ error: "Pour un don, indique « exonération jusqu'à 50 % » : oui ou non." });
  }
  const local_id = req.body.local_id || req.body.localId || null;
  const note = typeof req.body.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 300) : null;
  const recuPar = req.user.email || req.user.id;
  let items = null;
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
    const idLigne = local_id ? `${local_id}-l${i}` : null;
    if (idLigne) {
      const { data: deja } = await supabase.from('receptions_medicaments').select('id').eq('local_id', idLigne).maybeSingle();
      if (deja) continue; // rejeu : cette ligne est déjà entrée
    }
    const quantite = Number(l.quantite);
    const { data: item, error } = await supabase.rpc('ajouter_stock_medicament', { p_id: l.id, p_quantite_ajoutee: quantite, p_local_id: idLigne ? `${idLigne}-stock` : null });
    if (error) return res.status(500).json({ error: `Ligne ${i + 1} (${l.id}) : ${error.message}`, lignes_deja_recues: i });
    const nom = (item && (item.item ? item.item.nom : item.nom)) || l.nom || l.id;
    if (l.source === 'don') {
      const { error: erreurFlag } = await supabase.rpc('marquer_exoneration_50_medicament', { p_id: l.id, p_valeur: l.exoneration_50 });
      if (erreurFlag) console.warn('Réception : marque « exonération 50 % » non enregistrée :', erreurFlag.message);
    }
    const { error: erreurTrace } = await supabase.from('receptions_medicaments').insert({
      medicament_id: l.id, nom, quantite, source: l.source, exoneration_50: l.source === 'don' ? l.exoneration_50 : null,
      note, recu_par: recuPar, recu_par_uid: req.user.id, local_id: idLigne,
    });
    if (erreurTrace && erreurTrace.code !== '23505') console.warn('Réception : trace non enregistrée :', erreurTrace.message);
  }
  const { data: catalogue } = await supabase.from('catalog').select('items').eq('type', 'medicaments').maybeSingle();
  items = (catalogue && catalogue.items) || [];
  await enregistrerAuditServeur(req, 'reception_medicaments', { lignes: lignes.map(l => ({ id: l.id, quantite: Number(l.quantite), source: l.source, exoneration_50: l.source === 'don' ? l.exoneration_50 : null })), note });
  res.status(201).json({ success: true, items });
});

// Compare l'ancienne et la nouvelle liste d'une réquisition : { id -> variation } (positif = il faut sortir plus de stock).
function variationsRequisition(anciennes, nouvelles) {
  const delta = new Map();
  for (const l of anciennes || []) delta.set(l.id, (delta.get(l.id) || 0) - (Number(l.quantite) || 0));
  for (const l of nouvelles || []) delta.set(l.id, (delta.get(l.id) || 0) + (Number(l.qte) || 0));
  return [...delta.entries()].filter(([, v]) => v !== 0).map(([id, variation]) => ({ id, variation }));
}
app.patch('/api/requisitions/:id/annuler', async (req, res) => {
  if (!(await aPermission(req.user.id, 'requisition_modifier'))) return res.status(403).json({ error: "Permission 'requisition_modifier' requise." });
  const motif = typeof req.body.motif === 'string' ? req.body.motif.trim() : '';
  if (motif.length < 5) return res.status(400).json({ error: "Un motif d'annulation (5 caractères au moins) est requis." });
  const { data: requisition, error: erreurLecture } = await supabase.from('requisitions').select('*').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!requisition) return res.status(404).json({ error: 'Réquisition introuvable.' });
  if (requisition.annulee) return res.status(400).json({ error: 'Cette réquisition est déjà annulée.' });
  // Réservation : un double clic ou deux postes ne peuvent pas rendre le stock deux fois.
  const { data: reservee, error: erreurReservation } = await supabase.from('requisitions')
    .update({ annulee: true, annulee_par: req.user.email || req.user.id, annulee_par_uid: req.user.id, annulee_le: new Date().toISOString(), motif_annulation: motif })
    .eq('id', req.params.id).eq('annulee', false).select();
  if (erreurReservation) return res.status(500).json({ error: erreurReservation.message });
  if (!reservee || reservee.length === 0) return res.status(409).json({ error: 'Cette réquisition vient d\'être annulée par quelqu\'un d\'autre.' });
  let items = null;
  const rouvrir = () => supabase.from('requisitions').update({ annulee: false, annulee_par: null, annulee_par_uid: null, annulee_le: null, motif_annulation: null }).eq('id', req.params.id).select();
  if (requisition.stock_par_service) {
    // 22/10 : le stock de cette réquisition est dans le service — il retourne à la pharmacie, mais seulement ce que le service n'a pas déjà utilisé.
    const { data, error } = await supabase.rpc('transferer_stock_service', {
      p_service: requisition.service_demandeur,
      p_lignes: (requisition.lignes || []).map(l => ({ id: l.id, qte: -(Number(l.quantite) || 0) })),
      p_local_id: `${requisition.id}-annulation`,
    });
    if (error || !data || !data.succes) {
      await rouvrir();
      if (error) return res.status(500).json({ error: `Stock non remis : ${error.message}` });
      const detail = (data.manquants || []).map(m => `${m.nom || m.id} (il en reste ${m.disponible} dans le service)`).join(', ');
      return res.status(409).json({ error: `Annulation impossible : le service a déjà utilisé une partie de ce stock — ${detail}. Utilise « Retourner à la pharmacie » pour ce qui reste.`, manquants: data.manquants });
    }
  } else {
    for (const l of requisition.lignes || []) {
      const { data, error } = await supabase.rpc('ajouter_stock_medicament', { p_id: l.id, p_quantite_ajoutee: Number(l.quantite) || 0, p_local_id: `${requisition.id}-annulation-${l.id}` });
      if (error) {
        // Le stock n'a pas pu être remis : on rouvre la réquisition (les lignes déjà remises le sont une seule fois grâce à leur identifiant).
        await rouvrir();
        return res.status(500).json({ error: `Stock non remis (${l.nom || l.id}) : ${error.message}` });
      }
    }
  }
  const { data: catalogue } = await supabase.from('catalog').select('items').eq('type', 'medicaments').maybeSingle();
  items = (catalogue && catalogue.items) || [];
  await enregistrerAuditServeur(req, 'requisition_annulee', { id: requisition.id, service: requisition.service_demandeur, lignes: requisition.lignes, motif });
  res.json({ ...reservee[0], items });
});
app.put('/api/requisitions/:id', async (req, res) => {
  if (!(await aPermission(req.user.id, 'requisition_modifier'))) return res.status(403).json({ error: "Permission 'requisition_modifier' requise." });
  const { service_demandeur, lignes } = req.body;
  if (!service_demandeur || !String(service_demandeur).trim()) return res.status(400).json({ error: 'service_demandeur est requis.' });
  if (!Array.isArray(lignes) || lignes.length === 0 || lignes.some(l => !l || !l.id || !(Number(l.qte) > 0))) return res.status(400).json({ error: 'lignes (non vides, quantités supérieures à 0) requises.' });
  const { data: requisition, error: erreurLecture } = await supabase.from('requisitions').select('*').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!requisition) return res.status(404).json({ error: 'Réquisition introuvable.' });
  if (requisition.annulee) return res.status(400).json({ error: 'Une réquisition annulée ne peut plus être modifiée.' });
  const variations = variationsRequisition(requisition.lignes, lignes);
  const jeton = req.body.local_id || req.body.localId || `${Date.now()}`;
  const aSortir = variations.filter(v => v.variation > 0);
  const aRemettre = variations.filter(v => v.variation < 0);
  let items = null;
  if (requisition.stock_par_service) {
    // 22/10 : le stock est dans le service. Changer de service = annuler puis refaire (le stock d'un service ne se déplace pas en douce vers un autre).
    if (String(service_demandeur).trim() !== String(requisition.service_demandeur).trim()) {
      return res.status(400).json({ error: "Pour changer de service, annule cette réquisition puis refais-en une pour le bon service." });
    }
    if (variations.length > 0) {
      const { data, error } = await supabase.rpc('transferer_stock_service', {
        p_service: requisition.service_demandeur,
        p_lignes: variations.map(v => ({ id: v.id, qte: v.variation })),
        p_local_id: `${requisition.id}-modif-${jeton}`,
      });
      if (error) return res.status(500).json({ error: error.message });
      if (!data.succes) {
        const detail = (data.manquants || []).map(m => `${m.nom || m.id} (${m.disponible} disponible ${m.lieu === 'service' ? 'dans le service' : 'à la pharmacie'})`).join(', ');
        return res.status(409).json({ error: `Stock insuffisant : ${detail}`, manquants: data.manquants });
      }
      items = data.items;
    }
  } else {
    if (aSortir.length > 0) {
      const { data, error } = await supabase.rpc('decrementer_stock_medicaments', { p_decrements: aSortir.map(v => ({ id: v.id, qte: v.variation })), p_local_id: `${requisition.id}-modif-${jeton}` });
      if (error) return res.status(500).json({ error: error.message });
      if (!data.succes) {
        const detail = (data.manquants || []).map(m => `${m.nom || m.id} (${m.disponible} disponible)`).join(', ');
        return res.status(409).json({ error: `Stock insuffisant : ${detail}`, manquants: data.manquants });
      }
      items = data.items;
    }
    for (const v of aRemettre) {
      const { error } = await supabase.rpc('ajouter_stock_medicament', { p_id: v.id, p_quantite_ajoutee: -v.variation, p_local_id: `${requisition.id}-modif-${jeton}-${v.id}` });
      if (error) return res.status(500).json({ error: `Stock non remis (${v.id}) : ${error.message}` });
    }
  }
  const { data: catalogue } = await supabase.from('catalog').select('items').eq('type', 'medicaments').maybeSingle();
  items = (catalogue && catalogue.items) || items || [];
  const lignesAvecNoms = lignes.map(l => ({ id: l.id, nom: (items.find(i => i.id === l.id) || {}).nom || l.nom || l.id, quantite: Number(l.qte) }));
  const { data: misAJour, error: erreurMaj } = await supabase.from('requisitions')
    .update({ service_demandeur: String(service_demandeur).trim(), lignes: lignesAvecNoms, modifiee_par: req.user.email || req.user.id, modifiee_par_uid: req.user.id, modifiee_le: new Date().toISOString() })
    .eq('id', req.params.id).eq('annulee', false).select();
  if (erreurMaj || !misAJour || misAJour.length === 0) return res.status(500).json({ error: erreurMaj ? erreurMaj.message : "La réquisition n'a pas pu être mise à jour (elle vient peut-être d'être annulée) : vérifie le stock." });
  await enregistrerAuditServeur(req, 'requisition_modifiee', { id: requisition.id, avant: { service: requisition.service_demandeur, lignes: requisition.lignes }, apres: { service: String(service_demandeur).trim(), lignes: lignesAvecNoms } });
  res.json({ ...misAJour[0], items });
});

// 22/10 (Esdras) : un service n'a pas utilisé tout ce qu'il avait réquisitionné — la pharmacie en chef (requisition_modifier) le RETOURNE à la pharmacie.
// Le stock du service diminue, celui de la pharmacie remonte ; refusé si le service n'en a pas autant. Tracé dans le journal d'audit.
app.post('/api/requisitions/retour', async (req, res) => {
  if (!(await aPermission(req.user.id, 'requisition_modifier'))) return res.status(403).json({ error: "Permission 'requisition_modifier' requise." });
  const { service, lignes } = req.body;
  if (!service || !String(service).trim()) return res.status(400).json({ error: 'service est requis.' });
  if (!Array.isArray(lignes) || lignes.length === 0 || lignes.some(l => !l || !l.id || !(Number(l.qte) > 0))) return res.status(400).json({ error: 'lignes (non vides, quantités supérieures à 0) requises.' });
  const motif = typeof req.body.motif === 'string' ? req.body.motif.trim().slice(0, 300) : '';
  const local_id = req.body.local_id || req.body.localId || null;
  const { data, error } = await supabase.rpc('transferer_stock_service', {
    p_service: String(service).trim(), p_lignes: lignes.map(l => ({ id: l.id, qte: -Number(l.qte) })), p_local_id: local_id ? `${local_id}-retour` : null,
  });
  if (error) {
    if (error.code === '42883') return res.status(500).json({ error: "La fonction SQL transferer_stock_service n'existe pas encore dans Supabase — colle stock_par_service.sql dans le SQL Editor." });
    return res.status(500).json({ error: error.message });
  }
  if (data.deja_applique) return res.json({ success: true, deja_applique: true, items: data.items });
  if (!data.succes) {
    const detail = (data.manquants || []).map(m => `${m.nom || m.id} (il en reste ${m.disponible} dans le service)`).join(', ');
    return res.status(409).json({ error: `Retour impossible : le service n'en a pas autant — ${detail}`, manquants: data.manquants });
  }
  await enregistrerAuditServeur(req, 'stock_service_retourne', { service: String(service).trim(), lignes: lignes.map(l => ({ id: l.id, quantite: Number(l.qte) })), motif: motif || null });
  res.json({ success: true, items: data.items });
});

// Ajoute du stock à UN médicament de façon atomique (voir fonction_maj_stock_medicament.sql) —
// remplace le read-modify-write complet du catalogue fait depuis GestionStock.js (lecture d'un
// instantané frais du catalogue puis réécriture du tableau entier), qui pouvait perdre la
// modification d'un autre poste si 2 personnes modifiaient le stock de 2 médicaments différents
// presque au même moment.
app.post('/api/stock/ajouter', async (req, res) => {
  if (!(await aPermission(req.user.id, 'stock_gerer'))) {
    return res.status(403).json({ error: "Permission 'stock_gerer' requise." });
  }
  const { id, quantite } = req.body;
  if (!id || typeof quantite !== 'number' || quantite <= 0) {
    return res.status(400).json({ error: 'id et quantite (nombre positif) requis.' });
  }
  // Audit hors ligne du 03/09 (Esdras : "vérifie la solidité des transactions hors lignes") :
  // cette route était ADDITIVE et sans protection contre un rejeu — prouvé en exécutant le
  // mécanisme (tests/hors_ligne_bout_en_bout.test.js) : une réception de 50 boîtes dont la
  // confirmation se perd en route entrait DEUX fois (stock fantôme, invisible jusqu'à
  // l'inventaire physique). Même remède que les décréments le 01/09 : surcharge de la fonction
  // Postgres avec un p_local_id, trace posée dans la MÊME transaction que l'ajout.
  const local_id = req.body.local_id || req.body.localId || null;
  const { data, error } = await supabase.rpc('ajouter_stock_medicament', { p_id: id, p_quantite_ajoutee: quantite, p_local_id: local_id });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL ajouter_stock_medicament n'existe pas encore dans Supabase — colle fonction_maj_stock_medicament.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  if (data && data.deja_applique) {
    console.log(`↩️ Ajout de stock déjà appliqué (local_id=${local_id}) — rejeu ignoré.`);
    return res.json({ success: true, deja_applique: true, item: data.item });
  }
  res.json({ success: true, item: data });
});

// Ajoute du stock DONNÉ par un ONG à UN médicament (voir fonction_stock_dons.sql) — séparé du
// stock acheté (catalog.items[].quantite), pour que le don d'un ONG ne se mélange jamais avec le
// stock normal et reste réservé à ses propres patients (voir PLAN_DONS_ONG.md).
app.post('/api/stock/ajouter-don', async (req, res) => {
  if (!(await aPermission(req.user.id, 'stock_gerer'))) {
    return res.status(403).json({ error: "Permission 'stock_gerer' requise." });
  }
  const { id, ong, quantite } = req.body;
  if (!id || !ong || typeof quantite !== 'number' || quantite <= 0) {
    return res.status(400).json({ error: 'id, ong et quantite (nombre positif) requis.' });
  }
  // Même protection contre le rejeu que /api/stock/ajouter juste au-dessus (audit du 03/09) : un
  // don de partenaire compté deux fois fausse en plus la facturation à ce partenaire, pas
  // seulement l'inventaire.
  const local_id = req.body.local_id || req.body.localId || null;
  const { data, error } = await supabase.rpc('ajouter_stock_don_medicament', { p_id: id, p_ong: ong, p_quantite_ajoutee: quantite, p_local_id: local_id });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL ajouter_stock_don_medicament n'existe pas encore dans Supabase — colle fonction_stock_dons.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  if (data && data.deja_applique) {
    console.log(`↩️ Ajout de stock donné déjà appliqué (local_id=${local_id}) — rejeu ignoré.`);
    return res.json({ success: true, deja_applique: true, item: data.item });
  }
  res.json({ success: true, item: data });
});

// Décrémente le stock DONNÉ par un ou plusieurs ONG, de façon atomique (voir
// fonction_stock_dons.sql) — appelé à l'encaissement pour les lignes prises sur un stock donné
// (réservation normale au patient du même ONG, ou déblocage exceptionnel justifié pour un autre
// patient — cette route ne fait pas la distinction, c'est CalculateurPanel.js qui décide et
// journalise le motif si c'est un déblocage). Tout-ou-rien, même principe que
// POST /api/stock/decrementer pour le stock acheté.
app.post('/api/stock/decrementer-dons', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { decrements } = req.body; // [{ id, ong, qte }, ...]
  if (!Array.isArray(decrements) || decrements.length === 0) {
    return res.status(400).json({ error: 'decrements (tableau non vide) requis.' });
  }
  // Même protection que /api/stock/decrementer ci-dessus — le stock donné se décrémente par la
  // même vente, donc il court exactement le même risque de double décrément à un rejeu.
  const local_id = req.body.local_id || req.body.localId || null;
  const { data, error } = await supabase.rpc('decrementer_stock_dons', { p_decrements: decrements, p_local_id: local_id });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL decrementer_stock_dons n'existe pas encore dans Supabase — colle fonction_stock_dons.sql puis idempotence_decrement_stock.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  if (data.deja_applique) {
    console.log(`↩️ Décrément de stock donné déjà appliqué (local_id=${local_id}) — rejeu ignoré.`);
    return res.json({ success: true, deja_applique: true, items: data.items });
  }
  if (!data.succes) {
    const detail = (data.manquants || []).map(m => `${m.nom || m.id} — don ${m.ong} (${m.disponible} restant)`).join(', ');
    return res.status(409).json({ error: `Stock donné insuffisant : ${detail}`, manquants: data.manquants });
  }
  res.json({ success: true, items: data.items });
});

// Modifie stock + seuil d'alerte d'UN médicament de façon atomique (même fonction SQL, même
// raison que ci-dessus).
app.patch('/api/stock/:id', async (req, res) => {
  if (!(await aPermission(req.user.id, 'stock_gerer'))) {
    return res.status(403).json({ error: "Permission 'stock_gerer' requise." });
  }
  const { id } = req.params;
  const { quantite, seuilAlerte } = req.body;
  if (typeof quantite !== 'number' || typeof seuilAlerte !== 'number') {
    return res.status(400).json({ error: 'quantite et seuilAlerte (nombres) requis.' });
  }
  const { data, error } = await supabase.rpc('definir_stock_medicament', { p_id: id, p_quantite: quantite, p_seuil_alerte: seuilAlerte });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL definir_stock_medicament n'existe pas encore dans Supabase — colle fonction_maj_stock_medicament.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, item: data });
});
}; // @enveloppe
