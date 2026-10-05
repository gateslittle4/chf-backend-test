// tests/origineCors.test.js — qui a le droit d'appeler l'API depuis un navigateur (CORS).
const { test } = require('node:test');
const assert = require('node:assert');
const { origineAutorisee } = require('../utils/origineCors');

const FRONT = 'https://app.chffontaine.org';
const base = { origineFrontend: FRONT };

test("Sans en-tête Origin (curl, health check) : autorisé", () => {
  assert.strictEqual(origineAutorisee(undefined, base), true);
});

test("Le frontend officiel et l'ancienne URL onrender.com restent autorisés", () => {
  assert.strictEqual(origineAutorisee(FRONT, base), true);
  assert.strictEqual(origineAutorisee('https://chf-app2.onrender.com', base), true);
});

test("Un site tiers est refusé", () => {
  assert.strictEqual(origineAutorisee('https://site-tiers.example.com', base), false);
});

test("Un aperçu de PR est refusé par défaut", () => {
  assert.strictEqual(origineAutorisee('https://chf-app2-pr-41.onrender.com', base), false);
});

test("Un aperçu de PR est accepté seulement si le drapeau est activé", () => {
  const on = { ...base, apercusAutorises: true };
  assert.strictEqual(origineAutorisee('https://chf-app2-pr-41.onrender.com', on), true);
});

test("Drapeau activé : seuls les vrais motifs d'aperçu passent (pas de joker)", () => {
  const on = { ...base, apercusAutorises: true };
  for (const o of [
    'https://chf-app2-pr-.onrender.com',
    'https://chf-app2-pr-41.onrender.com.site-tiers.example.com',
    'https://x-chf-app2-pr-41.onrender.com',
    'http://chf-app2-pr-41.onrender.com',
    'https://autre-service.onrender.com',
    'https://chf-app2-pr-41x.onrender.com',
  ]) assert.strictEqual(origineAutorisee(o, on), false, o);
});
