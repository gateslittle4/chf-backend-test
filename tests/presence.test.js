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
