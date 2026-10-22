// utils/routesListesServices.js — renommer un type de consultation ou un service d'hospitalisation (14/10, demande d'Esdras : « les services
// et types de consultation doivent être modifiables »). Ajouter, retirer, masquer et réordonner se font par PUT /api/catalog/:type (listes de
// libellés) ; RENOMMER est à part, parce que le nom est recopié tel quel dans les épisodes, les transferts, les réquisitions et les lits :
// changer seulement la liste couperait l'historique en deux (« Pédiatrie » d'un côté, « Pediatrie » de l'autre).
//
//   POST /api/catalog/:type/renommer   { ancien, nouveau }   permission catalogue_gerer ; type = types_consultation | services_hospitalisation
//
// Ordre : d'abord les tables d'historique, ENSUITE la liste. Si une étape échoue (500), la liste garde l'ancien nom et l'appel peut être
// REFAIT sans effet double ; si seule la liste n'a pas pu être écrite alors que l'historique l'est déjà, refaire l'appel termine le travail
// (le nouveau nom est déjà dans l'historique, l'ancien encore dans la liste).
const TYPES = {
  types_consultation: {
    libelle: 'type de consultation', masques: 'types_consultation_masques',
    colonnes: [['episodes', 'type_consultation']], catalogues: [],
  },
  services_hospitalisation: {
    libelle: "service d'hospitalisation", masques: 'services_hospitalisation_masques',
    colonnes: [['episodes', 'service'], ['transferts_service', 'ancien_service'], ['transferts_service', 'nouveau_service'], ['requisitions', 'service_demandeur']],
    catalogues: [{ type: 'lits_par_service', champ: 'service' }], // liste d'objets { id, service, nom } : les lits suivent leur service
  },
};
const LONGUEUR_MAX = 60;

const nettoyer = (v) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
const comparable = (v) => nettoyer(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tableAbsente = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205');
// eslint-disable-next-line no-control-regex
const caractereInterdit = /[\u0000-\u001f<>]/;

function creerRoutesListesServices({ supabase, aPermission, maintenant = () => new Date() }) {
  async function lireListe(type) {
    const { data, error } = await supabase.from('catalog').select('items').eq('type', type).maybeSingle();
    if (error && !tableAbsente(error)) throw new Error(error.message);
    return Array.isArray(data && data.items) ? data.items : [];
  }
  async function ecrireListe(type, items) {
    const { data, error } = await supabase.from('catalog').upsert({ type, items, updated_at: maintenant().toISOString() }, { onConflict: 'type' }).select();
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new Error(`La liste « ${type} » n'a pas pu être enregistrée.`);
  }

  async function renommer(req, res) {
    const { type } = req.params;
    const cfg = TYPES[type];
    if (!cfg) return res.status(400).json({ error: `La liste « ${type} » ne peut pas être renommée ici (seulement types_consultation et services_hospitalisation).` });
    if (!(await aPermission(req.user.id, 'catalogue_gerer'))) return res.status(403).json({ error: "Permission 'catalogue_gerer' requise." });
    const corps = req.body || {};
    const ancien = String(corps.ancien === undefined || corps.ancien === null ? '' : corps.ancien).trim();
    const nouveau = nettoyer(corps.nouveau);
    if (!ancien) return res.status(400).json({ error: `Quel ${cfg.libelle} faut-il renommer ? (ancien est requis)` });
    if (!nouveau) return res.status(400).json({ error: 'Le nouveau nom est requis.' });
    if (nouveau.length > LONGUEUR_MAX) return res.status(400).json({ error: `Le nouveau nom est trop long (${LONGUEUR_MAX} caractères au plus).` });
    if (caractereInterdit.test(nouveau)) return res.status(400).json({ error: 'Le nouveau nom contient un caractère non autorisé.' });
    if (ancien === nouveau) return res.status(400).json({ error: 'Le nouveau nom est identique à l\'ancien.' });

    try {
      const actifs = await lireListe(type);
      const masques = await lireListe(cfg.masques);
      const dansActifs = actifs.indexOf(ancien);
      const dansMasques = masques.indexOf(ancien);
      const reprise = dansActifs < 0 && dansMasques < 0;
      if (reprise && !actifs.includes(nouveau) && !masques.includes(nouveau)) {
        return res.status(404).json({ error: `« ${ancien} » n'est pas dans la liste (${cfg.libelle}).` });
      }
      // Un autre élément qui s'écrit pareil (sans accents ni majuscules) rendrait deux lignes indiscernables dans les rapports.
      const cible = comparable(nouveau);
      const doublon = [...actifs, ...masques].find(v => v !== ancien && comparable(v) === cible && !(reprise && v === nouveau));
      if (doublon) return res.status(409).json({ error: `« ${doublon} » existe déjà (${cfg.libelle}) : choisissez un autre nom.` });

      // 1) Historique : chaque table qui recopie le nom.
      for (const [table, colonne] of cfg.colonnes) {
        const { error } = await supabase.from(table).update({ [colonne]: nouveau }).eq(colonne, ancien);
        if (error && !tableAbsente(error)) return res.status(500).json({ error: `Renommage interrompu (${table}.${colonne}) : ${error.message}. Rien n'a été changé dans la liste : réessayez.` });
      }
      // 1 bis) 22/10 : le stock réquisitionné par ce service (médicaments) suit son nouveau nom — voir sql/stock_par_service.sql. Fonction absente = pas encore collée : on continue.
      if (type === 'services_hospitalisation' && typeof supabase.rpc === 'function') {
        const { error } = await supabase.rpc('renommer_service_stock', { p_ancien: ancien, p_nouveau: nouveau });
        if (error && !['42883', 'PGRST202'].includes(String(error.code))) return res.status(500).json({ error: `Renommage interrompu (stock du service) : ${error.message}. Rien n'a été changé dans la liste : réessayez.` });
      }
      // 2) Listes d'objets qui portent le nom (les lits d'un service).
      for (const { type: autre, champ } of cfg.catalogues) {
        const items = await lireListe(autre);
        if (items.some(i => i && i[champ] === ancien)) await ecrireListe(autre, items.map(i => (i && i[champ] === ancien ? { ...i, [champ]: nouveau } : i)));
      }
      // 3) La liste elle-même (active ou masquée), à la même place.
      if (dansActifs >= 0) await ecrireListe(type, actifs.map(v => (v === ancien ? nouveau : v)));
      if (dansMasques >= 0) await ecrireListe(cfg.masques, masques.map(v => (v === ancien ? nouveau : v)));
      // 4) Trace, sans bloquer si le journal refuse la ligne.
      try {
        await supabase.from('audit_log').insert({
          id: require('node:crypto').randomUUID(), action: 'liste_renommee',
          effectue_par: req.user.email || req.user.id || null, effectue_par_uid: req.user.id || null,
          details: { liste: type, ancien, nouveau, masque: dansMasques >= 0, reprise }, date: maintenant().toISOString(),
        });
      } catch (e) { console.warn('Audit « liste renommée » non enregistré :', e.message); }
      return res.json({ success: true, ancien, nouveau });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  function monter(app) { app.post('/api/catalog/:type/renommer', renommer); }
  return { monter, renommer };
}

module.exports = { creerRoutesListesServices, TYPES, LONGUEUR_MAX };
