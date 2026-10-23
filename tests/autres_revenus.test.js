// tests/autres_revenus.test.js — « autre revenu » à la caisse (20/10, Esdras) : routes extraites de server.js, base simulée.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const debut = source.indexOf("const MESSAGE_AUTRE_REVENU_MOTIF");
const fin = source.indexOf("// Annulation d'un paiement — réservée", debut);
assert.ok(debut > 0 && fin > debut, 'routes introuvables dans server.js');
const code = source.slice(debut, fin);

function monter({ droits = ['caisse_travailler'], lignes = [] } = {}) {
  const routes = {}; const audit = [];
  const app = { get: (c, f) => { routes['GET ' + c] = f; }, post: (c, f) => { routes['POST ' + c] = f; }, patch: (c, f) => { routes['PATCH ' + c] = f; } };
  let seq = 0;
  const supabase = { from: () => {
    const f = []; let action = 'select'; let corps = null;
    const L = () => lignes.filter(r => f.every(g => g(r)));
    const c = {
      select: () => c, eq: (k, v) => { f.push(r => r[k] === v); return c; },
      insert: (v) => { action = 'insert'; corps = v; return c; }, update: (v) => { action = 'update'; corps = v; return c; },
      order: () => c,
      maybeSingle: async () => ({ data: L()[0] || null, error: null }),
      single: async () => { const l = { id: `r${++seq}`, annule: false, date_revenu: 'maintenant', ...corps }; lignes.push(l); return { data: l, error: null }; },
      then: (resolve) => { if (action === 'update') { const l = L(); l.forEach(r => Object.assign(r, corps)); return resolve({ data: l, error: null }); } return resolve({ data: L(), error: null }); },
    };
    return c;
  } };
  new Function('app', 'supabase', 'aPermission', 'lireToutesLesPages', 'enregistrerAuditServeur', 'console', code)(
    app, supabase, async (_uid, p) => droits.includes(p), async (fn) => (await fn()).data, async (_req, a, d) => { audit.push({ a, d }); }, console);
  const appeler = async (cle, req) => { const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } }; await routes[cle]({ user: { id: 'u1', email: 'caisse@chf.com' }, params: {}, body: {}, ...req }, res); return res; };
  return { appeler, lignes, audit };
}

test('enregistrer un autre revenu : montant, motif, caissier, audit ; motif et montant obligatoires', async () => {
  const m = monter();
  assert.strictEqual((await m.appeler('POST /api/autres-revenus', { body: { montant: 500, motif: '' } })).code, 400);
  assert.strictEqual((await m.appeler('POST /api/autres-revenus', { body: { montant: 0, motif: 'Certificat' } })).code, 400);
  assert.strictEqual((await m.appeler('POST /api/autres-revenus', { body: { montant: -5, motif: 'Certificat' } })).code, 400);
  const r = await m.appeler('POST /api/autres-revenus', { body: { montant: '750.5', motif: '  Certificat   médical ', payeur: ' Jean ', local_id: 'x1' } });
  assert.strictEqual(r.code, 201);
  assert.deepStrictEqual([r.corps.montant, r.corps.motif, r.corps.payeur, r.corps.caissier_uid], [750.5, 'Certificat médical', 'Jean', 'u1']);
  assert.strictEqual(m.audit[0].a, 'autre_revenu_enregistre');
});

test('rejeu avec le même local_id : renvoie la ligne existante, jamais un doublon', async () => {
  const m = monter();
  await m.appeler('POST /api/autres-revenus', { body: { montant: 100, motif: 'Photocopies', local_id: 'x1' } });
  const r = await m.appeler('POST /api/autres-revenus', { body: { montant: 100, motif: 'Photocopies', local_id: 'x1' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(m.lignes.length, 1);
});

test('sans la permission de caisse : refusé', async () => {
  const m = monter({ droits: [] });
  assert.strictEqual((await m.appeler('POST /api/autres-revenus', { body: { montant: 100, motif: 'Photocopies' } })).code, 403);
  assert.strictEqual((await m.appeler('GET /api/autres-revenus', {})).code, 403);
});

test("annulation : permission, motif, jamais son propre revenu, une seule fois, tracée", async () => {
  const lignes = [{ id: 'a', montant: 100, motif: 'Location salle', annule: false, caissier_uid: 'autre' }, { id: 'b', montant: 50, motif: 'Photocopies', annule: false, caissier_uid: 'u1' }];
  const m = monter({ droits: ['paiement_annuler'], lignes });
  assert.strictEqual((await m.appeler('PATCH /api/autres-revenus/:id/annuler', { params: { id: 'a' }, body: { motif: 'x' } })).code, 400, 'motif trop court');
  assert.strictEqual((await m.appeler('PATCH /api/autres-revenus/:id/annuler', { params: { id: 'b' }, body: { motif: 'Erreur de saisie' } })).code, 403, 'pas son propre revenu');
  const ok = await m.appeler('PATCH /api/autres-revenus/:id/annuler', { params: { id: 'a' }, body: { motif: 'Erreur de saisie' } });
  assert.strictEqual(ok.code, 200); assert.strictEqual(lignes[0].annule, true); assert.strictEqual(m.audit.at(-1).a, 'autre_revenu_annule');
  assert.strictEqual((await m.appeler('PATCH /api/autres-revenus/:id/annuler', { params: { id: 'a' }, body: { motif: 'Erreur de saisie' } })).code, 400, 'déjà annulé');
  const sans = monter({ droits: [], lignes: [{ id: 'z', annule: false, caissier_uid: 'autre' }] });
  assert.strictEqual((await sans.appeler('PATCH /api/autres-revenus/:id/annuler', { params: { id: 'z' }, body: { motif: 'Erreur de saisie' } })).code, 403);
});

test('la table est dans les sauvegardes et le script SQL existe', () => {
  assert.match(source, /TABLES_A_SAUVEGARDER[\s\S]*'autres_revenus'/);
  assert.match(source, /\['autres_revenus', 'id'\]/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'sql', 'autres_revenus.sql'), 'utf8'), /CREATE TABLE IF NOT EXISTS public\.autres_revenus/);
});
