// tests/journal_sql.test.js — journal des scripts SQL appliqués (15/10) : préparé, pas appliqué.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { empreinte, comparerJournal, sqlPourNoter } = require('../utils/journalSql');

const F = (nom, contenu) => ({ nom, contenu });

test("empreinte : stable, insensible aux fins de ligne Windows, change si le contenu change", () => {
  assert.strictEqual(empreinte('a\nb'), empreinte('a\r\nb'));
  assert.notStrictEqual(empreinte('a'), empreinte('b'));
  assert.match(empreinte('x'), /^[0-9a-f]{64}$/);
});

test("comparerJournal : noté, modifié depuis, jamais noté, inconnu du dépôt", () => {
  const fichiers = [F('a.sql', 'A'), F('b.sql', 'B'), F('c.sql', 'C')];
  const lignes = [{ nom: 'a.sql', somme_controle: empreinte('A') }, { nom: 'b.sql', somme_controle: empreinte('B-ancien') }, { nom: 'vieux.sql', somme_controle: 'x' }];
  assert.deepStrictEqual(comparerJournal(fichiers, lignes), { notes: ['a.sql'], modifies: ['b.sql'], absents: ['c.sql'], inconnus: ['vieux.sql'] });
  assert.deepStrictEqual(comparerJournal(fichiers, [{ nom: 'a.sql', somme_controle: null }]).notes, ['a.sql'], 'sans empreinte notée : accepté');
  assert.deepStrictEqual(comparerJournal([], undefined), { notes: [], modifies: [], absents: [], inconnus: [] });
});

test("sqlPourNoter : INSERT rejouables, apostrophes protégées, rien si rien à noter", () => {
  const sql = sqlPourNoter([F('a.sql', 'A'), F("l'ancien.sql", 'B')], ['a.sql', "l'ancien.sql"], { par: 'esdras', remarque: "à confirmer" });
  assert.match(sql, /INSERT INTO public\.migrations_appliquees/);
  assert.match(sql, /'a\.sql', '[0-9a-f]{64}', 'esdras', 'à confirmer'/);
  assert.match(sql, /'l''ancien\.sql'/);
  assert.match(sql, /ON CONFLICT \(nom\) DO UPDATE/);
  assert.strictEqual(sqlPourNoter([F('a.sql', 'A')], []), '');
});

test("Le script de journal ne contient aucune commande destructrice et n'est lu par aucun écran ni route (préparé, non activé)", () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'journal_migrations.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bREVOKE\b/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.migrations_appliquees/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /migrations_appliquees/, 'le serveur ne lit pas ce journal');
});
