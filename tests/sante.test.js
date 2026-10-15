// tests/sante.test.js — pages de contrôle pour la surveillance externe (15/10).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { verifierSante } = require('../utils/sante');

const base = (reponse) => ({ from: () => ({ select: () => ({ limit: () => reponse }) }) });

test("Base qui répond → ok", async () => {
  const r = await verifierSante({ supabase: base(Promise.resolve({ data: [{ type: 'x' }], error: null })) });
  assert.strictEqual(r.statut, 'ok'); assert.strictEqual(r.base, 'ok');
});
test("Base qui renvoie une erreur, qui lève, ou qui ne répond pas dans le délai → dégradé, sans jamais lever", async () => {
  assert.strictEqual((await verifierSante({ supabase: base(Promise.resolve({ error: { message: 'boum' } })) })).statut, 'degrade');
  assert.strictEqual((await verifierSante({ supabase: base(Promise.reject(new Error('réseau'))) })).statut, 'degrade');
  const lente = new Promise(() => {}); // ne répond jamais
  const t0 = Date.now();
  const r = await verifierSante({ supabase: base(lente), delaiMs: 60 });
  assert.strictEqual(r.statut, 'degrade'); assert.strictEqual(r.base, 'indisponible');
  assert.ok(Date.now() - t0 < 2000, 'le délai coupe l\'attente');
});
test("Ne renvoie aucune donnée de la base : seulement l'état, l'heure et la durée", async () => {
  const r = await verifierSante({ supabase: base(Promise.resolve({ data: [{ type: 'secret' }], error: null })) });
  assert.deepStrictEqual(Object.keys(r).sort(), ['base', 'duree_ms', 'statut']);
});
test("server.js : /sante et /sante/complet sont publiques (avant verifyToken) ; /sante/complet renvoie 503 si la base est dégradée", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const iSante = src.indexOf("app.get('/sante'");
  assert.ok(iSante !== -1 && iSante < src.indexOf("app.use('/api', verifyToken)"));
  assert.match(src, /app\.get\('\/sante\/complet', limitePublique, async/);
  assert.match(src, /res\.status\(etat\.statut === 'ok' \? 200 : 503\)/);
});
