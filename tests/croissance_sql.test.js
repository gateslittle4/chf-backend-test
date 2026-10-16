// tests/croissance_sql.test.js — garde de sql/croissance_index_et_postes_ouverts.sql (16/10). Le comportement réel est vérifié sur un Postgres jetable par scripts/test-croissance-sql.py.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'croissance_index_et_postes_ouverts.sql'), 'utf8').replace(/--.*$/gm, '');

test("Purement ajouté et rejouable : index IF NOT EXISTS, fonction OR REPLACE, aucune suppression ni modification de données", () => {
  assert.doesNotMatch(sql, /\bDELETE\b|\bTRUNCATE\b|\bUPDATE\b|\bINSERT\b|DROP\s+(TABLE|COLUMN)|ALTER\s+TABLE/i);
  assert.strictEqual((sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 3);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.sessions_caisse_ouvertes\(\)/);
});

test("Les index partiels correspondent à la requête du serveur (supprime_le IS NULL, même tri)", () => {
  assert.match(sql, /idx_episodes_date_ouverture ON public\.episodes \(date_ouverture DESC, id\) WHERE supprime_le IS NULL/);
  assert.match(sql, /idx_paiements_date_paiement ON public\.paiements \(date_paiement DESC, id\) WHERE supprime_le IS NULL/);
  assert.match(sql, /idx_audit_log_date ON public\.audit_log \(date DESC\)/);
  const serveur = fs.readFileSync(path.join(__dirname, '..', 'utils', 'synchroListes.js'), 'utf8');
  assert.match(serveur, /order\('date_ouverture', \{ ascending: false \}\)\.order\('id'\)/);
  assert.match(serveur, /order\('date_paiement', \{ ascending: false \}\)\.order\('id'\)/);
});

test("sessions_caisse_ouvertes est réservée au serveur", () => {
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.sessions_caisse_ouvertes\(\) FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.sessions_caisse_ouvertes\(\) TO service_role;/);
});

test("La fermeture automatique lit les postes ouverts par cette fonction, avec repli sur l'ancienne lecture", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'fermetureAutoPostes.js'), 'utf8');
  assert.match(src, /rpc\('sessions_caisse_ouvertes'\)/);
  assert.match(src, /from\('catalog'\)\.select\('items'\)\.eq\('type', 'sessions_caisse'\)/);
});
