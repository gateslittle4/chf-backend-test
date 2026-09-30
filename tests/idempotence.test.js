// tests/idempotence.test.js — audit hors ligne du 28/09 : même opération envoyée deux fois avec la
// même clé (Idempotency-Key) → la route ne s'exécute qu'UNE fois. Exécute le vrai middleware
// (utils/idempotence.js) dans un vrai serveur Express, contre une fausse table fidèle à Postgres
// (clé primaire → 23505 sur un doublon).
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { creerMiddlewareIdempotence, TABLE, DUREE_ABANDON_MS } = require('../utils/idempotence');

function fausseBase() {
  const lignes = new Map();
  const base = {
    lignes,
    from(table) {
      assert.strictEqual(table, TABLE);
      const filtre = {};
      const q = {
        _op: null, _val: null,
        insert(v) { q._op = 'insert'; q._val = v; return q; },
        select() { q._op = q._op || 'select'; return q; },
        update(v) { q._op = 'update'; q._val = v; return q; },
        delete() { q._op = 'delete'; return q; },
        eq(c, v) { filtre[c] = v; return q; },
        lt() { return q; },
        maybeSingle() { return q; },
        then(res, rej) {
          let r;
          if (q._op === 'insert') {
            r = lignes.has(q._val.cle) ? { error: { code: '23505', message: 'duplicate key' } }
              : (lignes.set(q._val.cle, { ...q._val, statut: null, reponse: null, cree_le: new Date().toISOString() }), { error: null });
          } else if (q._op === 'select') r = { data: lignes.get(filtre.cle) || null, error: null };
          else if (q._op === 'update') { Object.assign(lignes.get(filtre.cle) || {}, q._val); r = { error: null }; }
          else if (q._op === 'delete') { lignes.delete(filtre.cle); r = { error: null }; }
          return Promise.resolve(r).then(res, rej);
        },
      };
      return q;
    },
  };
  return base;
}

async function serveur(base, route) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: req.get('X-Uid') || 'uid-caisse' }; next(); });
  app.use('/api', creerMiddlewareIdempotence(base, { journal: { warn() {} } }));
  route(app);
  const s = http.createServer(app);
  await new Promise(r => s.listen(0, r));
  const url = `http://127.0.0.1:${s.address().port}`;
  return { url, fermer: () => new Promise(r => s.close(r)) };
}
const attendre = (ms) => new Promise(r => setTimeout(r, ms));

test("Même paiement envoyé deux fois avec la même clé → UN seul paiement créé, le 2e envoi reçoit la même réponse", async () => {
  const base = fausseBase();
  const paiements = [];
  const s = await serveur(base, app => app.post('/api/paiements', (req, res) => { paiements.push(req.body); res.status(201).json({ id: `p-${paiements.length}`, montant: req.body.montant }); }));
  try {
    const envoyer = () => fetch(`${s.url}/api/paiements`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'cle-A' }, body: JSON.stringify({ montant: 500 }) });
    const r1 = await envoyer();
    await attendre(20); // la réponse est enregistrée juste après son envoi
    const r2 = await envoyer();
    assert.strictEqual(r1.status, 201);
    assert.strictEqual(r2.status, 201);
    assert.deepStrictEqual(await r2.json(), { id: 'p-1', montant: 500 });
    assert.strictEqual(r2.headers.get('idempotent-replayed'), 'true');
    assert.strictEqual(paiements.length, 1, 'la route ne doit être exécutée qu\'une seule fois');
  } finally { await s.fermer(); }
});

test("Clés différentes → deux opérations ; même clé chez deux personnes différentes → jamais la réponse de l'autre", async () => {
  const base = fausseBase();
  let n = 0;
  const s = await serveur(base, app => app.post('/api/depenses-caisse', (req, res) => res.json({ id: ++n })));
  try {
    const envoyer = (cle, uid) => fetch(`${s.url}/api/depenses-caisse`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': cle, 'X-Uid': uid }, body: '{}' }).then(r => r.json());
    await envoyer('K1', 'u1'); await attendre(20);
    await envoyer('K2', 'u1'); await attendre(20);
    const autre = await envoyer('K1', 'u2');
    assert.strictEqual(n, 3);
    assert.deepStrictEqual(autre, { id: 3 });
  } finally { await s.fermer(); }
});

test("Rejeu pendant que la 1re exécution tourne encore → 503 OPERATION_EN_COURS (l'app remet en file), jamais une 2e exécution", async () => {
  const base = fausseBase();
  let executions = 0;
  const s = await serveur(base, app => app.patch('/api/episodes/e1/transferer', async (req, res) => { executions++; await attendre(150); res.json({ ok: true }); }));
  try {
    const envoyer = () => fetch(`${s.url}/api/episodes/e1/transferer`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'T1' }, body: '{}' });
    const p1 = envoyer();
    await attendre(30);
    const r2 = await envoyer();
    assert.strictEqual(r2.status, 503);
    assert.strictEqual((await r2.json()).error, 'OPERATION_EN_COURS');
    assert.strictEqual((await p1).status, 200);
    assert.strictEqual(executions, 1);
  } finally { await s.fermer(); }
});

test("Une réponse en ÉCHEC n'est pas gardée : le rejeu réexécute la route (une panne passagère a une nouvelle chance)", async () => {
  const base = fausseBase();
  let essais = 0;
  const s = await serveur(base, app => app.post('/api/fiches', (req, res) => { essais++; if (essais === 1) return res.status(500).json({ error: 'panne' }); res.json({ id: 'f1' }); }));
  try {
    const envoyer = () => fetch(`${s.url}/api/fiches`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'F1' }, body: '{}' });
    assert.strictEqual((await envoyer()).status, 500);
    await attendre(20);
    const r2 = await envoyer();
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(essais, 2);
  } finally { await s.fermer(); }
});

test("Réservation orpheline (serveur redémarré en pleine requête) : reprise après DUREE_ABANDON_MS, pas de blocage éternel", async () => {
  const base = fausseBase();
  base.lignes.set('uid-caisse:O1', { cle: 'uid-caisse:O1', statut: null, cree_le: new Date(Date.now() - DUREE_ABANDON_MS - 1000).toISOString() });
  let n = 0;
  const s = await serveur(base, app => app.post('/api/paiements', (req, res) => res.json({ id: ++n })));
  try {
    const r = await fetch(`${s.url}/api/paiements`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'O1' }, body: '{}' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(n, 1);
  } finally { await s.fermer(); }
});

test("Sans clé, en GET, ou table absente (script SQL pas encore appliqué) : la route s'exécute normalement", async () => {
  const base = fausseBase();
  const sansTable = { from: () => { const q = { insert: () => q, then: (r) => Promise.resolve({ error: { code: '42P01', message: 'relation does not exist' } }).then(r) }; return q; } };
  let n = 0;
  for (const b of [base, sansTable]) {
    const s = await serveur(b, app => app.post('/api/paiements', (req, res) => res.json({ id: ++n })));
    try {
      await fetch(`${s.url}/api/paiements`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await fetch(`${s.url}/api/paiements`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'Z' }, body: '{}' });
    } finally { await s.fermer(); }
  }
  assert.strictEqual(n, 4);
});

test("server.js monte le middleware APRÈS verifyToken (la clé est rangée par personne) et purge les vieilles clés chaque nuit", () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  const iJeton = src.indexOf("app.use('/api', verifyToken);");
  const iIdem = src.indexOf("app.use('/api', creerMiddlewareIdempotence(supabase));");
  assert.ok(iJeton !== -1 && iIdem > iJeton);
  assert.match(src, /await purgerClesIdempotence\(supabase\)/);
});
