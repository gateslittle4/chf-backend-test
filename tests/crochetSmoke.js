// tests/crochetSmoke.js — préchargé par tests/routes_cablage.test.js : démarre le VRAI server.js avec un faux Firebase et une fausse base (qui répond « rien, sans erreur »),
// puis appelle une route de chaque module routes/*.js. Un nom de dépendance mal câblé (supabase, aPermission…) fait planter la route : Express répond alors
// par un 500 (la fausse base ne renvoie jamais d'erreur : un 500 ne peut venir que d'un plantage).
const Module = require('module');
const charge = Module._load;
const chaine = () => {
  const p = new Proxy(function () {}, {
    get: (_, k) => (k === 'then' ? (res) => res({ data: [], error: null }) : (k === 'maybeSingle' || k === 'single') ? async () => ({ data: { role: 'direction', active: true }, error: null }) : () => p),
    apply: () => p,
  });
  return p;
};
Module._load = function (req, ...reste) {
  if (req === 'firebase-admin/app') return { initializeApp() {}, cert: () => ({}) };
  if (req === 'firebase-admin/auth') return { getAuth: () => ({ verifyIdToken: async () => ({ uid: 'u1', email: 'a@chf.com' }), getUser: async () => ({}) }) };
  if (req === '@supabase/supabase-js') return { createClient: () => ({ from: () => chaine(), rpc: () => chaine(), storage: { from: () => chaine(), listBuckets: async () => ({ data: [] }) } }) };
  return charge.call(this, req, ...reste);
};
const ROUTES = [
  ['publiques', '/sante/complet'], ['episodes', '/api/episodes'], ['rechercheDossiers', '/api/dossiers/recherche?nom=x'], ['exploitation', '/api/dossiers/liste-hors-ligne'],
  ['dossiers', '/api/dossiers/abc/historique'], ['parcoursEpisode', '/api/episodes/abc/transferts'], ['fiches', '/api/fiches/episode/abc'], ['catalogue', '/api/catalog/types_consultation'],
  ['caisse', '/api/paiements'], ['stock', '/api/requisitions'], ['administration', '/api/admin/anomalies'], ['sauvegarde', '/api/admin/derniere-sauvegarde'],
];
setTimeout(async () => {
  const resultats = [];
  for (const [module_, url] of ROUTES) {
    try {
      const r = await fetch('http://127.0.0.1:' + process.env.PORT + url, { headers: { Authorization: 'Bearer x' }, signal: AbortSignal.timeout(4000) });
      const corps = await r.text();
      resultats.push({ module: module_, url, statut: r.status, plante: r.status >= 500 || /Internal Server Error/i.test(corps) });
    } catch (e) { resultats.push({ module: module_, url, statut: 'ERREUR ' + e.message, plante: true }); }
  }
  require('fs').writeFileSync(process.env.SORTIE_JOURNAL, JSON.stringify(resultats));
  process.exit(0);
}, 2500);
