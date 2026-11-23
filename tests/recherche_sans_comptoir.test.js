// 19/11 (Esdras) : « je ne veux pas que les clients comptoir apparaissent là où l'on cherche les dossiers ».
const { test } = require('node:test');
const assert = require('node:assert');
const { estVenteComptoir, sansVentesComptoir } = require('../utils/numeroDossier');

const source = require('./serveurSource').lireServeur();
const debut = source.indexOf("app.get('/api/dossiers/recherche'");
const fin = source.indexOf('// Liste des patients pour la recherche HORS LIGNE', debut);
assert.ok(debut > 0 && fin > debut, 'route de recherche introuvable');
const code = source.slice(debut, fin);

const DOSSIERS = [
  { id: 'd1', numero_dossier: '5002', nom: 'Marie Joseph' },
  { id: 'd2', numero_dossier: 'AUTO-1794230734112', nom: 'Client Comptoir' },
  { id: 'd3', numero_dossier: 'EN-ATTENTE-AB12', nom: 'Marie Louis' },
  { id: 'd4', numero_dossier: 'AUTO-1794232594391', nom: 'Marie Comptoir' },
];

function appeler(requete, { rpcErreur = null } = {}) {
  let handler;
  const app = { get: (_c, f) => { if (!handler) handler = f; } };
  const supabase = {
    rpc: async () => (rpcErreur ? { data: null, error: rpcErreur } : { data: DOSSIERS, error: null }),
    from: () => {
      const c = { select: () => c, eq: (_k, v) => { c.v = v; return c; }, is: () => c, in: () => c, ilike: () => c, then: (ok) => Promise.resolve({ data: c.v ? DOSSIERS.filter(d => d.numero_dossier === c.v) : DOSSIERS, error: null }).then(ok) };
      return c;
    },
  };
  new Function('app', 'supabase', 'aPermission', 'sansVentesComptoir', code)(app, supabase, async () => true, sansVentesComptoir);
  return new Promise((resolve) => handler({ user: { id: 'u1' }, query: requete }, { json: (b) => resolve({ code: 200, corps: b }), status(x) { this.c = x; return { json: (b) => resolve({ code: x, corps: b }) }; } }));
}

test('estVenteComptoir : seulement les identifiants internes « AUTO-… »', () => {
  assert.strictEqual(estVenteComptoir('AUTO-1794230734112'), true);
  assert.strictEqual(estVenteComptoir('auto-1'), true);
  for (const n of ['5002', 'EN-ATTENTE-AB12', 'EXAMEN-1', '', null, undefined]) assert.strictEqual(estVenteComptoir(n), false, String(n));
  assert.deepStrictEqual(sansVentesComptoir(DOSSIERS).map(d => d.id), ['d1', 'd3']);
});

test('la recherche par nom ne renvoie jamais un client comptoir', async () => {
  const r = await appeler({ nom: 'Marie' });
  assert.deepStrictEqual(r.corps.map(d => d.id), ['d1', 'd3']);
});

test('la recherche par nom, repli sans fonction Postgres : jamais un client comptoir non plus', async () => {
  const r = await appeler({ nom: 'Marie' }, { rpcErreur: { code: '42883', message: 'function does not exist' } });
  assert.ok(!r.corps.some(d => /^AUTO-/.test(d.numero_dossier)));
});

test('la recherche par numéro ne renvoie pas un numéro « AUTO-… »', async () => {
  assert.deepStrictEqual((await appeler({ numero: 'AUTO-1794230734112' })).corps, []);
  assert.deepStrictEqual((await appeler({ numero: '5002' })).corps.map(d => d.id), ['d1']);
});
