// routes/catalogue.js — Catalogue (médicaments, actes, listes, permissions, paramètres, sessions de caisse).
// Découpé de server.js le 23/10 sans changer une ligne de logique : le texte des routes est celui d'avant. Ce module reçoit de server.js
// l'application Express et ses dépendances partagées (base, droits, journal d'audit, lecteurs communs) ; voir « montage des routes » dans server.js.
const crypto = require('crypto');
const {
  appliquerMiseAJourPermissions, lireTablePermissions, verifierRoleInvitation, verifierRoleDuLienOuvert, libelleRolePersonnalise,
  refusDeRoleParLaBase, etatBasePourRolesPersonnalises, MESSAGE_ROLE_NON_ACTIVE_INVITE,
} = require('../utils/roles');

module.exports = function monterCatalogue(app, { PERMISSIONS_PAR_DEFAUT, aPermission, supabase }) { // @enveloppe
// Route : récupération du catalogue (médicaments ou actes)
app.get('/api/catalog/:type', async (req, res) => {
  const { type } = req.params;
  const { data, error } = await supabase
    .from('catalog')
    .select('items')
    .eq('type', type)
    .single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  const items = data?.items || [];
  // Audit du 12/10 : les sessions de caisse étaient lisibles EN ENTIER par tout compte connecté
  // (infirmier, visiteur...) — fond d'ouverture, comptant remis, fond conservé, justification d'écart.
  // La liste reste lisible par tous (la cloche et la vérification « poste ouvert ? » en ont besoin
  // pour chaque rôle), mais les montants ne vont qu'aux mêmes permissions que GET /api/paiements.
  if (type === 'sessions_caisse' && !(await peutVoirMontantsCaisse(req.user.id))) {
    return res.json(items.map(({ soldeOuverture, comptantRemis, fondConserve, justification, ...reste }) => reste));
  }
  res.json(items);
});

async function peutVoirMontantsCaisse(uid) {
  for (const permission of ['fiche_patient_voir_finances', 'caisse_travailler', 'demandes_repondre', 'caisse_voir']) {
    if (await aPermission(uid, permission)) return true;
  }
  return false;
}

// Route : mise à jour du catalogue
app.put('/api/catalog/:type', async (req, res) => {
  const { type } = req.params;
  // medicaments/actes n'acceptent PLUS de réécriture complète du tableau ici — cette route
  // réécrivait TOUT le catalogue à chaque appel (lecture d'un instantané côté navigateur, puis
  // ré-enregistrement du tableau entier), ce qui pouvait silencieusement ANNULER un stock ou des
  // dons ONG décrémentés entre-temps par une vente. Voir POST /api/catalog/:type/item,
  // PATCH /api/catalog/:type/champs, DELETE /api/catalog/:type/item/:id ci-dessous (fonctions
  // Postgres atomiques, fonction_champs_catalogue.sql) — seules voies désormais pour ces 2 types.
  if (type === 'medicaments' || type === 'actes') {
    return res.status(410).json({
      error: `PUT /api/catalog/${type} n'accepte plus de réécriture complète du tableau — utilise POST /api/catalog/${type}/item (créer), PATCH /api/catalog/${type}/champs (modifier), ou DELETE /api/catalog/${type}/item/:id (supprimer).`,
    });
  }
  // 'permissions' : réservé à permissions_gerer (écran Rôles & permissions).
  // 'parametres' : réservé à parametres_gerer (écran Paramètres — retour d'Esdras du 24/08,
  // "il me faut un onglet paramètres pour ce genre de truc").
  // 'sessions_caisse' (01/09) : caisse_travailler — voir POST /api/catalog/:type/item plus bas.
  // Tout le reste (types_consultation, services_hospitalisation...) : catalogue_gerer.
  let permissionOk;
  if (type === 'permissions') {
    permissionOk = await aPermission(req.user.id, 'permissions_gerer');
  } else if (type === 'parametres') {
    permissionOk = await aPermission(req.user.id, 'parametres_gerer');
  } else if (type === 'sessions_caisse') {
    permissionOk = await aPermission(req.user.id, 'caisse_travailler');
  } else {
    permissionOk = await aPermission(req.user.id, 'catalogue_gerer');
  }
  if (!permissionOk) return res.status(403).json({ error: `Permission requise pour modifier le catalogue "${type}".` });
  // 'permissions' (09/10, rôles personnalisés) : cette table contient maintenant les rôles créés depuis
  // l'écran Rôles & permissions. Elle ne s'écrit QUE par utils/roles.js : rôle du code non usurpable, nouvelle
  // clé obligatoirement déclarée personnalisée et validée, aucun champ libre, suppression d'un rôle encore
  // attribué refusée (409), changements consignés dans audit_log.
  if (type === 'permissions') {
    const resultat = await appliquerMiseAJourPermissions({
      items: (req.body || {}).items, supabase, utilisateur: req.user,
      clesIntegrees: new Set(['administrateur', ...PERMISSIONS_PAR_DEFAUT.map(r => r.role)]),
      defauts: PERMISSIONS_PAR_DEFAUT, genererId: () => crypto.randomUUID(),
    });
    return res.status(resultat.status).json(resultat.body);
  }
  const { items } = req.body;
  // upsert (pas update) : la toute première écriture doit pouvoir CRÉER la ligne si elle
  // n'existe pas encore — un simple update ne peut jamais créer une ligne absente.
  const { data, error } = await supabase
    .from('catalog')
    .upsert({ type, items, updated_at: new Date().toISOString() }, { onConflict: 'type' })
    .select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) {
    return res.status(500).json({ error: `Échec inattendu de l'enregistrement du catalogue "${type}".` });
  }
  res.json({ success: true });
});

// Ajoute UN article au catalogue (medicaments ou actes) de façon atomique (voir
// fonction_champs_catalogue.sql) — remplace l'ancien read-modify-write complet de
// GrilleEdition.js ("Tarifs Pharma"/"Tarifs Actes"). Pour "medicaments", le stock démarre
// TOUJOURS à 0 (aucun don) quoi que le navigateur envoie — le stock initial se règle ensuite
// depuis "Gestion des stocks", jamais depuis Tarifs Pharma (voir aussi le 410 ci-dessus).
app.post('/api/catalog/:type/item', async (req, res) => {
  const { type } = req.params;
  // 'sessions_caisse' (01/09) : voir le même aparté sur PUT /api/catalog/:type juste au-dessus —
  // un caissier doit pouvoir ouvrir SA session sans avoir catalogue_gerer.
  const permissionOk = type === 'sessions_caisse'
    ? await aPermission(req.user.id, 'caisse_travailler')
    : await aPermission(req.user.id, 'catalogue_gerer');
  if (!permissionOk) {
    return res.status(403).json({ error: "Permission 'catalogue_gerer' requise." });
  }
  const { item } = req.body;
  if (!item || typeof item !== 'object') return res.status(400).json({ error: 'item (objet) requis.' });
  // Rejeu idempotent (28/09) : un poste de caisse ouvert HORS LIGNE part dans la file d'attente de
  // l'app avec l'id de la session, et la file peut le renvoyer plus d'une fois (réponse perdue sur
  // une connexion instable, synchronisation interrompue puis reprise). ajouter_article_catalogue
  // ajoute sans regarder : chaque rejeu créait un poste de plus, en double. Un id déjà présent
  // veut dire "déjà enregistré" — on renvoie l'article existant, sans rien écrire.
  if (item.id !== undefined && item.id !== null && item.id !== '') {
    const { data: ligne, error: erreurLecture } = await supabase.from('catalog').select('items').eq('type', type).maybeSingle();
    if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
    const existant = (ligne?.items || []).find(a => a && a.id === item.id);
    if (existant) return res.status(200).json({ success: true, item: existant, dejaEnregistre: true });
  }
  const { data, error } = await supabase.rpc('ajouter_article_catalogue', { p_type: type, p_item: item });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL ajouter_article_catalogue n'existe pas encore dans Supabase — colle fonction_champs_catalogue.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ success: true, item: data });
});

// Modifie des champs (nom, prix, prixAchat, sub, ordre, nouveauPrix, nbUtilisations...) sur un ou
// plusieurs articles existants, de façon atomique — jamais quantite/seuilAlerte/donsParOng (la
// fonction Postgres retire elle-même ces clés, quoi que req.body contienne). Utilisée par
// GrilleEdition.js (édition, application des nouveaux prix, tri du bon de labo) ET par
// CalculateurPanel.js (compteur de fréquence d'usage) — d'où catalogue_gerer OU
// caisse_travailler, comme avant sur l'ancienne route.
app.patch('/api/catalog/:type/champs', async (req, res) => {
  const { type } = req.params;
  if (!(await aPermission(req.user.id, 'catalogue_gerer')) && !(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'catalogue_gerer' ou 'caisse_travailler' requise." });
  }
  const { maj } = req.body; // [{ id, champs }, ...]
  if (!Array.isArray(maj) || maj.length === 0) return res.status(400).json({ error: 'maj (tableau non vide) requis.' });
  // 'sessions_caisse' (01/09) : cette route est générique et ignore d'ordinaire QUI possède
  // l'article visé — correct pour un tarif (n'importe quel caissier peut incrémenter un compteur
  // d'usage), mais dangereux ici : sans ce contrôle, un simple caisse_travailler (sans
  // catalogue_gerer) pourrait fermer la session ouverte d'un AUTRE caissier par un appel API brut
  // (hors interface), avec un comptant/écart fabriqués — jamais possible depuis l'écran, qui ne
  // cible que sessionActive.id. direction/administrateur (catalogue_gerer) gardent le droit de
  // corriger la session de n'importe qui, comme pour toute autre correction comptable.
  if (type === 'sessions_caisse' && !(await aPermission(req.user.id, 'catalogue_gerer'))) {
    const { data: ligne, error: erreurLecture } = await supabase.from('catalog').select('items').eq('type', 'sessions_caisse').single();
    if (erreurLecture && erreurLecture.code !== 'PGRST116') return res.status(500).json({ error: erreurLecture.message });
    const sessions = ligne?.items || [];
    const idsEtrangers = maj.filter(m => {
      const session = sessions.find(s => s.id === m.id);
      return session && session.uid !== req.user.id;
    });
    if (idsEtrangers.length > 0) {
      return res.status(403).json({ error: "Tu ne peux modifier que ta propre session de caisse." });
    }
  }
  const { data, error } = await supabase.rpc('definir_champs_catalogue_lot', { p_type: type, p_maj: maj });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL definir_champs_catalogue_lot n'existe pas encore dans Supabase — colle fonction_champs_catalogue.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, items: data });
});

// Supprime UN article du catalogue par id, de façon atomique.
app.delete('/api/catalog/:type/item/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!(await aPermission(req.user.id, 'catalogue_gerer'))) {
    return res.status(403).json({ error: "Permission 'catalogue_gerer' requise." });
  }
  const { data, error } = await supabase.rpc('supprimer_article_catalogue', { p_type: type, p_id: id });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL supprimer_article_catalogue n'existe pas encore dans Supabase — colle fonction_champs_catalogue.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, items: data });
});
}; // @enveloppe
