// tests/partenaire_2.test.js — script SQL de « Partenaire 2 » (20/10) : additif, valeur par défaut, contrôle des deux valeurs permises.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'partenaire_2.sql'), 'utf8').replace(/--.*$/gm, '');
test('Partenaire 2 : colonne additive avec défaut « partenaire » et deux valeurs permises', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS categorie text NOT NULL DEFAULT 'partenaire'/);
  assert.match(sql, /CHECK \(categorie IN \('partenaire', 'partenaire2'\)\)/);
  assert.doesNotMatch(sql, /DROP|DELETE|UPDATE|TRUNCATE/i, 'script purement additif');
});
