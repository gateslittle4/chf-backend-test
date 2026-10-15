// tests/partenaires_identifiant_prepare.test.js — partenaires rattachés à un identifiant stable (15/10) : préparé, NON appliqué, rien dans le serveur ne le lit.
// Le comportement SQL est vérifié sur un Postgres jetable par scripts/test-partenaires-identifiant-sql.py.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'partenaires_identifiant_stable.sql'), 'utf8');
const sansCommentaires = sql.replace(/--.*$/gm, '');

test("Le script est purement AJOUTÉ : aucune suppression ni modification destructrice des colonnes ou des données existantes", () => {
  assert.doesNotMatch(sansCommentaires, /\bDELETE\b|\bTRUNCATE\b|DROP\s+(TABLE|COLUMN)|ALTER\s+COLUMN|\bRENAME\b/i);
  assert.match(sansCommentaires, /ADD COLUMN IF NOT EXISTS ong_partenaire_id text/g);
  // les seuls UPDATE de l'historique ne remplissent que la NOUVELLE colonne, et seulement là où elle est vide
  const updates = sansCommentaires.match(/UPDATE public\.\w+\s+SET [^;]+;/g) || [];
  assert.strictEqual(updates.length, 2);
  for (const u of updates) assert.match(u, /SET ong_partenaire_id = .* WHERE ong_partenaire_id IS NULL/s);
});

test("Rejouable : colonnes et index IF NOT EXISTS, fonctions OR REPLACE, déclencheurs recréés proprement", () => {
  assert.match(sansCommentaires, /CREATE INDEX IF NOT EXISTS idx_episodes_ong_partenaire_id/);
  assert.match(sansCommentaires, /CREATE INDEX IF NOT EXISTS idx_paiements_ong_partenaire_id/);
  assert.match(sansCommentaires, /CREATE OR REPLACE FUNCTION public\.renommer_partenaire/);
  assert.strictEqual((sansCommentaires.match(/DROP TRIGGER IF EXISTS rattacher_partenaire_id/g) || []).length, 2);
});

test("renommer_partenaire est réservée au serveur ; un nom ambigu n'est jamais deviné", () => {
  assert.match(sansCommentaires, /REVOKE EXECUTE ON FUNCTION public\.renommer_partenaire\(text, text\) FROM PUBLIC, anon, authenticated;/);
  assert.match(sansCommentaires, /GRANT EXECUTE ON FUNCTION public\.renommer_partenaire\(text, text\) TO service_role;/);
  assert.match(sansCommentaires, /CASE WHEN count\(\*\) = 1 THEN min\(id\) END/);
});

test("Préparé, pas activé : le serveur ne lit ni n'écrit ong_partenaire_id", () => {
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /ong_partenaire_id|renommer_partenaire/);
});
