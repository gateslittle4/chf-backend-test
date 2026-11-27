const test = require('node:test');
const assert = require('node:assert');
const { bornesJourHaiti, creerSuiviActivite, classerConnectes, resumerCaisseDuJour } = require('../utils/presence');

test('bornes du jour en heure d\'Haïti', () => {
  assert.deepStrictEqual(bornesJourHaiti('2026-01-15'), { debut: '2026-01-15T05:00:00.000Z', fin: '2026-01-16T05:00:00.000Z' });
  assert.strictEqual(bornesJourHaiti('15/01/2026'), null);
});
test('le suivi écrit au plus une fois par minute et par compte', () => {
  let t = 0; const ecritures = [];
  const supabase = { from: () => ({ update: v => ({ eq: (c, id) => { ecritures.push(id); return Promise.resolve({}); } }) }) };
  const suivre = creerSuiviActivite(supabase, { maintenant: () => t });
  const next = () => {};
  suivre({ user: { id: 'a' } }, {}, next); suivre({ user: { id: 'a' } }, {}, next);
  t = 61000; suivre({ user: { id: 'a' } }, {}, next); suivre({ user: { id: 'b' } }, {}, next);
  assert.deepStrictEqual(ecritures, ['a', 'a', 'b']);
});
test('en ligne = actif depuis moins de 5 minutes, en ligne d\'abord', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const r = classerConnectes([
    { id: '1', display_name: 'Ancien', derniere_activite: '2026-10-19T10:00:00Z' },
    { id: '2', display_name: 'Jamais' },
    { id: '3', display_name: 'Actif', derniere_activite: '2026-10-19T11:57:00Z' },
  ], now);
  assert.deepStrictEqual(r.map(u => [u.nom, u.en_ligne]), [['Actif', true], ['Ancien', false], ['Jamais', false]]);
});
test('caisse du jour : par caissier, sans annulés ni transferts', () => {
  const r = resumerCaisseDuJour([
    { encaisse_par: 'Rose', montant: 500, date_paiement: '2026-10-19T14:00:00Z' },
    { encaisse_par: 'Rose', montant: 300, date_paiement: '2026-10-19T16:00:00Z' },
    { encaisse_par: 'Rose', montant: 900, date_paiement: '2026-10-19T16:00:00Z', annule: true },
    { encaisse_par: 'Jean', montant: 0, mode: 'transfert_hospitalisation', date_paiement: '2026-10-19T15:00:00Z' },
  ], [{ cloturee_par: 'Rose', statut: 'cloturee', date_cloture: 'x' }]);
  assert.deepStrictEqual(r.caissiers.map(c => [c.nom, c.paiements, c.total]), [['Rose', 2, 800]]);
  assert.strictEqual(r.clotures[0].par, 'Rose');
});

// ---- 27/11 : version de l'application de chaque compte ----
const { lireVersionApp } = require('../utils/presence');
const reqVersion = (id, version, build) => ({ user: { id }, headers: { 'x-app-version': version, 'x-app-build': build } });

test('lireVersionApp : en-têtes valides lus ; forme invalide, « dev » ou absente ignorée ; date illisible → null', () => {
  assert.deepStrictEqual(lireVersionApp(reqVersion('a', '51b7397e', '2026-11-27T13:54:47.000Z')), { version: '51b7397e', build: '2026-11-27T13:54:47.000Z' });
  assert.deepStrictEqual(lireVersionApp(reqVersion('a', '51b7397e', 'pas une date')), { version: '51b7397e', build: null });
  for (const mauvais of ['', 'dev', 'a b', '<script>', 'x'.repeat(65), undefined]) assert.strictEqual(lireVersionApp(reqVersion('a', mauvais, '2026-11-27T13:54:47.000Z')), null, String(mauvais));
  assert.strictEqual(lireVersionApp({ user: { id: 'a' } }), null); assert.strictEqual(lireVersionApp(null), null);
});

test('le suivi note la version quand elle change (une écriture à part), pas à chaque minute ; sans en-tête, aucune écriture en plus', async () => {
  let t = 0; const maj = [];
  const supabase = { from: () => ({ update: v => ({ eq: (c, id) => { maj.push({ id, ...v }); return Promise.resolve({}); } }) }) };
  const suivre = creerSuiviActivite(supabase, { maintenant: () => t });
  const next = () => {};
  suivre(reqVersion('a', 'v1', '2026-11-27T10:00:00Z'), {}, next);
  assert.deepStrictEqual(maj.map(m => Object.keys(m).filter(k => k !== 'id').join('+')), ['derniere_activite', 'version_app+version_build']);
  t = 61000; suivre(reqVersion('a', 'v1', '2026-11-27T10:00:00Z'), {}, next);
  assert.strictEqual(maj.filter(m => 'version_app' in m).length, 1, 'même version : pas de nouvelle écriture');
  t = 122000; suivre(reqVersion('a', 'v2', '2026-11-27T14:00:00Z'), {}, next);
  assert.deepStrictEqual(maj.filter(m => 'version_app' in m).map(m => m.version_app), ['v1', 'v2'], 'nouvelle version : notée');
  const avant = maj.length; t = 200000; suivre({ user: { id: 'b' } }, {}, next);
  assert.strictEqual(maj.length - avant, 1, 'compte sans en-tête de version : seule l\'activité est écrite');
});

test('colonnes absentes (SQL pas appliqué) : l\'écriture de la version échoue sans gêner l\'activité, nouvel essai après 10 minutes', async () => {
  let t = 0; const versions = [];
  const supabase = { from: () => ({ update: v => ({ eq: () => { if ('version_app' in v) { versions.push(t); return Promise.resolve({ error: { code: '42703', message: 'column does not exist' } }); } return Promise.resolve({}); } }) }) };
  const suivre = creerSuiviActivite(supabase, { maintenant: () => t });
  const next = () => {};
  suivre(reqVersion('a', 'v1', '2026-11-27T10:00:00Z'), {}, next); await new Promise(r => setImmediate(r));
  t = 61000; suivre(reqVersion('a', 'v1', '2026-11-27T10:00:00Z'), {}, next); await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(versions, [0], 'pas de nouvel essai avant 10 minutes');
  t = 11 * 60 * 1000; suivre(reqVersion('a', 'v1', '2026-11-27T10:00:00Z'), {}, next); await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(versions, [0, 11 * 60 * 1000], 'nouvel essai après 10 minutes');
});

test('classerConnectes expose version et date de construction (null = pas encore vue)', () => {
  const r = classerConnectes([{ id: '1', display_name: 'A', version_app: '51b7397e', version_build: '2026-11-27T13:54:47Z' }, { id: '2', display_name: 'B' }], Date.now());
  assert.deepStrictEqual(r.map(u => [u.nom, u.version, u.version_build]), [['A', '51b7397e', '2026-11-27T13:54:47Z'], ['B', null, null]]);
});

test('sql/version_app_utilisateurs.sql est additif : deux colonnes ajoutées à users, rien d\'autre', () => {
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'sql', 'version_app_utilisateurs.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.strictEqual((sql.match(/add column if not exists/gi) || []).length, 2);
  assert.doesNotMatch(sql, /\bdrop\b|\bdelete\b|\btruncate\b|\bupdate\b|\binsert\b/i);
});
