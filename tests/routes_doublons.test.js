// tests/routes_doublons.test.js — routes des doublons d'identité et de la fusion (14/10), contre un faux Supabase en mémoire.
const { test } = require('node:test');
const assert = require('node:assert');
const { creerFauxSupabase } = require('./aides/fauxSupabase');
const { creerAppFausse } = require('./aides/appFausse');
const { creerRoutesDoublons } = require('../utils/routesDoublons');

const lireToutesLesPages = async (construire) => { const { data, error } = await construire().range(0, 99999); if (error) throw error; return data; };
function monter({ dossiers, episodes = [], permission = true, rpcs = {}, colonnesAbsentes, tablesAbsentes } = {}) {
  const supabase = creerFauxSupabase({ dossiers, episodes, audit_log: [], doublons_ignores: [] }, { rpcs, colonnesAbsentes, tablesAbsentes });
  const { app, appeler } = creerAppFausse();
  const routes = creerRoutesDoublons({ supabase, aPermission: async () => permission, lireToutesLesPages });
  routes.monter(app);
  return { supabase, appeler, routes };
}
const D = (id, nom, extra = {}) => ({ id, numero_dossier: `N-${id}`, nom, nom_origine: nom, ...extra });
const DOSSIERS = () => [
  D('a', 'Marie Joseph', { date_naissance: '1995-03-02', telephone: '34567890', sexe: 'F' }),
  D('b', 'Joseph Marie', { date_naissance: '1995-03-02', telephone: '+509 34567890', sexe: 'F' }),
  D('c', 'Paul Louis', { date_naissance: '1980-01-01' }),
  D('e', 'Bébé Marie Joseph', { mere_dossier_id: 'a', telephone: '34567890' }),
];

test("similaires : propose le dossier qui ressemble, jamais le bébé de la même mère ; 3 lettres minimum", async () => {
  const { appeler } = monter({ dossiers: DOSSIERS() });
  const r = await appeler('GET', '/api/dossiers/similaires?nom=Marie%20Josef&date_naissance=1995-03-02');
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.corps.map(x => x.id).sort(), ['a', 'b']);
  assert.ok(r.corps[0].raisons.length > 0 && r.corps[0].niveau.label);
  assert.deepStrictEqual((await appeler('GET', '/api/dossiers/similaires?nom=Ma')).corps, []);
});
test("similaires : sans permission → 403 ; base pas encore migrée (colonnes absentes) → fonctionne quand même", async () => {
  assert.strictEqual((await monter({ dossiers: DOSSIERS(), permission: false }).appeler('GET', '/api/dossiers/similaires?nom=Marie%20Joseph')).code, 403);
  const ancienne = monter({ dossiers: DOSSIERS().map(({ mere_dossier_id, ...d }) => d), colonnesAbsentes: { dossiers: ['anciens_noms', 'mere_dossier_id', 'fusionne_dans'] } });
  const r = await ancienne.appeler('GET', '/api/dossiers/similaires?nom=Marie%20Joseph&date_naissance=1995-03-02');
  assert.strictEqual(r.code, 200);
  assert.ok(r.corps.length >= 1);
});
test("doublons-possibles : paires avec nombre d'épisodes ; niveau filtrable ; paires ignorées disparaissent", async () => {
  const { appeler, supabase } = monter({ dossiers: DOSSIERS(), episodes: [{ dossier_id: 'a' }, { dossier_id: 'a' }, { dossier_id: 'b' }] });
  const r = await appeler('GET', '/api/dossiers/doublons-possibles');
  assert.strictEqual(r.corps.total, 1);
  const p = r.corps.paires[0];
  assert.deepStrictEqual([p.a.id, p.b.id].sort(), ['a', 'b']);
  assert.deepStrictEqual({ [p.a.id]: p.a.nb_episodes, [p.b.id]: p.b.nb_episodes }, { a: 2, b: 1 });
  assert.strictEqual((await appeler('GET', '/api/dossiers/doublons-possibles?niveau=forte')).corps.total, 1);
  const ign = await appeler('POST', '/api/dossiers/doublons-ignores', { body: { a: 'b', b: 'a' } });
  assert.strictEqual(ign.code, 201);
  assert.deepStrictEqual(supabase.tables.doublons_ignores[0].dossier_a < supabase.tables.doublons_ignores[0].dossier_b, true, 'paire stockée dans l\'ordre');
  assert.strictEqual((await appeler('GET', '/api/dossiers/doublons-possibles')).corps.total, 0, 'plus proposée (le cache est invalidé)');
  assert.strictEqual(supabase.tables.audit_log[0].action, 'doublons_ignores');
});
test("doublons-ignores : refus sans permission, avec le même dossier deux fois, ou sans la table (503 explicite)", async () => {
  assert.strictEqual((await monter({ dossiers: DOSSIERS(), permission: false }).appeler('POST', '/api/dossiers/doublons-ignores', { body: { a: 'a', b: 'b' } })).code, 403);
  assert.strictEqual((await monter({ dossiers: DOSSIERS() }).appeler('POST', '/api/dossiers/doublons-ignores', { body: { a: 'a', b: 'a' } })).code, 400);
  const sansTable = await monter({ dossiers: DOSSIERS(), tablesAbsentes: ['doublons_ignores'] }).appeler('POST', '/api/dossiers/doublons-ignores', { body: { a: 'a', b: 'b' } });
  assert.strictEqual(sansTable.code, 503);
  assert.match(sansTable.corps.error, /dossiers_naissance_fusion\.sql/);
});
test("fusionner : appelle la fonction SQL avec source/cible/qui, journalise (noms inclus), renvoie le résultat", async () => {
  let appel;
  const { appeler, supabase } = monter({ dossiers: DOSSIERS(), rpcs: { fusionner_dossiers: async (args) => { appel = args; return { data: { episodes_deplaces: 2, episodes_ouverts_apres: 1 }, error: null }; } } });
  const r = await appeler('POST', '/api/dossiers/b/fusionner', { body: { cible_id: 'a' } });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(appel, { p_source: 'b', p_cible: 'a', p_par: 'admin@chf.com' });
  assert.strictEqual(r.corps.episodes_deplaces, 2);
  const a = supabase.tables.audit_log[0];
  assert.strictEqual(a.action, 'fusion_dossiers');
  assert.strictEqual(a.details.source_nom, 'Joseph Marie');
  assert.strictEqual(a.details.cible_nom, 'Marie Joseph');
});
test("fusionner : chaque code d'erreur SQL devient un statut HTTP et un message clair ; fonction absente → 503 ; sans cible → 400 ; sans permission → 403", async () => {
  for (const [code, statut] of [['CHF11', 404], ['CHF12', 400], ['CHF13', 409], ['CHF14', 409], ['CHF15', 409]]) {
    const { appeler } = monter({ dossiers: DOSSIERS(), rpcs: { fusionner_dossiers: async () => ({ data: null, error: { code, message: 'x' } }) } });
    const r = await appeler('POST', '/api/dossiers/b/fusionner', { body: { cible_id: 'a' } });
    assert.strictEqual(r.code, statut, code);
    assert.strictEqual(r.corps.code, code);
  }
  assert.strictEqual((await monter({ dossiers: DOSSIERS() }).appeler('POST', '/api/dossiers/b/fusionner', { body: { cible_id: 'a' } })).code, 503);
  assert.strictEqual((await monter({ dossiers: DOSSIERS() }).appeler('POST', '/api/dossiers/b/fusionner', { body: {} })).code, 400);
  assert.strictEqual((await monter({ dossiers: DOSSIERS(), permission: false }).appeler('POST', '/api/dossiers/b/fusionner', { body: { cible_id: 'a' } })).code, 403);
});
test("defusionner : annule, journalise ; « pas fusionné » → 409", async () => {
  const { appeler, supabase } = monter({ dossiers: DOSSIERS(), rpcs: { defusionner_dossiers: async () => ({ data: { episodes_remis: 2 }, error: null }) } });
  assert.strictEqual((await appeler('POST', '/api/dossiers/b/defusionner')).corps.episodes_remis, 2);
  assert.strictEqual(supabase.tables.audit_log[0].action, 'fusion_dossiers_annulee');
  const refus = monter({ dossiers: DOSSIERS(), rpcs: { defusionner_dossiers: async () => ({ data: null, error: { code: 'CHF16', message: 'x' } }) } });
  assert.strictEqual((await refus.appeler('POST', '/api/dossiers/b/defusionner')).code, 409);
});
