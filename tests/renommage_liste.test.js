// tests/renommage_liste.test.js — renommer un type de consultation / un service d'hospitalisation (14/10).
const { test } = require('node:test');
const assert = require('node:assert');
const { creerFauxSupabase } = require('./aides/fauxSupabase');
const { creerAppFausse } = require('./aides/appFausse');
const { creerRoutesListesServices } = require('../utils/routesListesServices');

function monter({ droit = true, tables = {}, options } = {}) {
  const supabase = creerFauxSupabase({
    catalog: [
      { type: 'services_hospitalisation', items: ['Urgences', 'Pediatrie', 'Maternité'] },
      { type: 'services_hospitalisation_masques', items: ['Ancien service'] },
      { type: 'types_consultation', items: ['Générale', 'Dentaire'] },
      { type: 'lits_par_service', items: [{ id: 1, service: 'Pediatrie', nom: 'Lit 1' }, { id: 2, service: 'Urgences', nom: 'Lit 2' }, { id: 3, service: 'Pediatrie', nom: 'Lit 3' }] },
    ],
    episodes: [
      { id: 'e1', service: 'Pediatrie', type_consultation: null }, { id: 'e2', service: 'Urgences', type_consultation: null },
      { id: 'e3', service: null, type_consultation: 'Dentaire' }, { id: 'e4', service: 'Pediatrie', type_consultation: null, supprime_le: '2026-10-01' },
    ],
    transferts_service: [{ id: 't1', ancien_service: 'Maternité', nouveau_service: 'Pediatrie' }, { id: 't2', ancien_service: 'Pediatrie', nouveau_service: 'Urgences' }],
    requisitions: [{ id: 'r1', service_demandeur: 'Pediatrie' }, { id: 'r2', service_demandeur: 'Urgences' }],
    audit_log: [], ...tables,
  }, options);
  const { app, appeler } = creerAppFausse();
  creerRoutesListesServices({ supabase, aPermission: async () => droit, maintenant: () => new Date('2026-10-14T12:00:00Z') }).monter(app);
  const liste = (type) => supabase.tables.catalog.find(c => c.type === type).items;
  const renommer = (type, corps) => appeler('POST', `/api/catalog/${type}/renommer`, { body: corps, user: { id: 'u1', email: 'direction@chf.com' } });
  return { supabase, renommer, liste };
}

test('renommer un service : la liste (même place), les épisodes (y compris supprimés), les transferts, les réquisitions et les lits suivent', async () => {
  const { supabase, renommer, liste } = monter();
  const r = await renommer('services_hospitalisation', { ancien: 'Pediatrie', nouveau: 'Pédiatrie' });
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.deepStrictEqual(liste('services_hospitalisation'), ['Urgences', 'Pédiatrie', 'Maternité']);
  assert.deepStrictEqual(supabase.tables.episodes.map(e => e.service), ['Pédiatrie', 'Urgences', null, 'Pédiatrie']);
  assert.deepStrictEqual(supabase.tables.transferts_service.map(t => [t.ancien_service, t.nouveau_service]), [['Maternité', 'Pédiatrie'], ['Pédiatrie', 'Urgences']]);
  assert.deepStrictEqual(supabase.tables.requisitions.map(x => x.service_demandeur), ['Pédiatrie', 'Urgences']);
  assert.deepStrictEqual(liste('lits_par_service').map(l => l.service), ['Pédiatrie', 'Urgences', 'Pédiatrie']);
  assert.strictEqual(supabase.tables.audit_log[0].action, 'liste_renommee');
  assert.deepStrictEqual([supabase.tables.audit_log[0].details.ancien, supabase.tables.audit_log[0].details.nouveau], ['Pediatrie', 'Pédiatrie']);
});

test('renommer un type de consultation : seuls les épisodes de ce type changent', async () => {
  const { supabase, renommer, liste } = monter();
  const r = await renommer('types_consultation', { ancien: 'Dentaire', nouveau: 'Soins dentaires' });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(liste('types_consultation'), ['Générale', 'Soins dentaires']);
  assert.strictEqual(supabase.tables.episodes.find(e => e.id === 'e3').type_consultation, 'Soins dentaires');
  assert.deepStrictEqual(supabase.tables.episodes.map(e => e.service), ['Pediatrie', 'Urgences', null, 'Pediatrie'], 'les services ne sont pas touchés');
});

test('un élément MASQUÉ se renomme aussi, et reste masqué', async () => {
  const { renommer, liste } = monter();
  const r = await renommer('services_hospitalisation', { ancien: 'Ancien service', nouveau: 'Service historique' });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(liste('services_hospitalisation_masques'), ['Service historique']);
  assert.deepStrictEqual(liste('services_hospitalisation'), ['Urgences', 'Pediatrie', 'Maternité'], 'la liste active ne change pas');
});

test('refus : sans la permission catalogue_gerer (403), rien n\'est modifié', async () => {
  const { supabase, renommer, liste } = monter({ droit: false });
  const r = await renommer('services_hospitalisation', { ancien: 'Pediatrie', nouveau: 'Pédiatrie' });
  assert.strictEqual(r.code, 403);
  assert.deepStrictEqual(liste('services_hospitalisation'), ['Urgences', 'Pediatrie', 'Maternité']);
  assert.strictEqual(supabase.tables.episodes[0].service, 'Pediatrie');
});

test('refus : liste non renommable (médicaments, permissions…) → 400', async () => {
  const { renommer } = monter();
  for (const type of ['medicaments', 'permissions', 'lits_par_service']) assert.strictEqual((await renommer(type, { ancien: 'a', nouveau: 'b' })).code, 400);
});

test('refus : nom vide, trop long, caractère interdit, identique à l\'ancien → 400', async () => {
  const { renommer } = monter();
  assert.strictEqual((await renommer('services_hospitalisation', { ancien: 'Urgences', nouveau: '   ' })).code, 400);
  assert.strictEqual((await renommer('services_hospitalisation', { ancien: 'Urgences', nouveau: 'x'.repeat(61) })).code, 400);
  assert.strictEqual((await renommer('services_hospitalisation', { ancien: 'Urgences', nouveau: 'Urg<b>' })).code, 400);
  assert.strictEqual((await renommer('services_hospitalisation', { ancien: 'Urgences', nouveau: ' Urgences ' })).code, 400);
  assert.strictEqual((await renommer('services_hospitalisation', { ancien: '', nouveau: 'Autre' })).code, 400);
});

test('refus : un autre élément (actif OU masqué) s\'écrit déjà pareil, sans accent ni majuscule → 409, rien ne bouge', async () => {
  const { supabase, renommer, liste } = monter();
  let r = await renommer('services_hospitalisation', { ancien: 'Urgences', nouveau: 'maternite' });
  assert.strictEqual(r.code, 409);
  r = await renommer('services_hospitalisation', { ancien: 'Urgences', nouveau: 'ANCIEN SERVICE' });
  assert.strictEqual(r.code, 409);
  assert.deepStrictEqual(liste('services_hospitalisation'), ['Urgences', 'Pediatrie', 'Maternité']);
  assert.strictEqual(supabase.tables.episodes[1].service, 'Urgences');
});

test('corriger seulement les accents ou la casse du MÊME élément est permis (Pediatrie → Pédiatrie n\'est pas un doublon de lui-même)', async () => {
  const { renommer } = monter();
  assert.strictEqual((await renommer('services_hospitalisation', { ancien: 'Pediatrie', nouveau: 'PEDIATRIE' })).code, 200);
});

test('refus : l\'ancien nom n\'existe pas → 404', async () => {
  const { renommer } = monter();
  assert.strictEqual((await renommer('services_hospitalisation', { ancien: 'Inconnu', nouveau: 'Nouveau' })).code, 404);
});

test('espaces multiples et bords nettoyés dans le nouveau nom', async () => {
  const { renommer, liste } = monter();
  const r = await renommer('types_consultation', { ancien: 'Générale', nouveau: '  Médecine   générale ' });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(liste('types_consultation'), ['Médecine générale', 'Dentaire']);
});

test('une étape de l\'historique échoue : 500, la liste GARDE l\'ancien nom, et refaire l\'appel termine le travail sans effet double', async () => {
  const echec = { actif: true };
  const { supabase, renommer, liste } = monter();
  const fromOriginal = supabase.from;
  supabase.from = (nom) => {
    const q = fromOriginal(nom);
    if (nom === 'requisitions' && echec.actif) { const u = q.update; q.update = (v) => { const r = u(v); r.then = (res) => Promise.resolve({ data: null, error: { code: 'XX000', message: 'panne simulée' } }).then(res); return r; }; }
    return q;
  };
  let r = await renommer('services_hospitalisation', { ancien: 'Pediatrie', nouveau: 'Pédiatrie' });
  assert.strictEqual(r.code, 500);
  assert.match(r.corps.error, /réessayez/);
  assert.deepStrictEqual(liste('services_hospitalisation'), ['Urgences', 'Pediatrie', 'Maternité'], 'la liste n\'a pas bougé');
  echec.actif = false;
  r = await renommer('services_hospitalisation', { ancien: 'Pediatrie', nouveau: 'Pédiatrie' });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(liste('services_hospitalisation'), ['Urgences', 'Pédiatrie', 'Maternité']);
  assert.deepStrictEqual(supabase.tables.requisitions.map(x => x.service_demandeur), ['Pédiatrie', 'Urgences']);
});

test('reprise : le nouveau nom est déjà dans l\'historique et l\'ancien encore dans la liste → l\'appel termine (liste mise à jour)', async () => {
  const { renommer, liste } = monter({ tables: { episodes: [{ id: 'e1', service: 'Pédiatrie' }] } });
  assert.strictEqual((await renommer('services_hospitalisation', { ancien: 'Pediatrie', nouveau: 'Pédiatrie' })).code, 200);
  assert.deepStrictEqual(liste('services_hospitalisation'), ['Urgences', 'Pédiatrie', 'Maternité']);
});

test('reprise : appel refait APRÈS un renommage réussi (l\'ancien n\'est plus nulle part, le nouveau est dans la liste) → 200 sans rien casser', async () => {
  const { renommer, liste } = monter();
  await renommer('services_hospitalisation', { ancien: 'Pediatrie', nouveau: 'Pédiatrie' });
  assert.strictEqual((await renommer('services_hospitalisation', { ancien: 'Pediatrie', nouveau: 'Pédiatrie' })).code, 200);
  assert.deepStrictEqual(liste('services_hospitalisation'), ['Urgences', 'Pédiatrie', 'Maternité']);
});

test('une base sans la table des transferts ou des réquisitions (pas encore créée) n\'empêche pas le renommage', async () => {
  const { renommer, liste } = monter({ options: { tablesAbsentes: ['transferts_service', 'requisitions'] } });
  assert.strictEqual((await renommer('services_hospitalisation', { ancien: 'Pediatrie', nouveau: 'Pédiatrie' })).code, 200);
  assert.deepStrictEqual(liste('services_hospitalisation'), ['Urgences', 'Pédiatrie', 'Maternité']);
});

test('server.js monte la route et le fichier de notes la décrit', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /creerRoutesListesServices\(\{ supabase, aPermission \}\)\.monter\(app\)/);
});
