// tests/naissance.test.js — dossier de naissance : nom définitif du bébé et lien bébé → mère (14/10).
const { test } = require('node:test');
const assert = require('node:assert');
const { creerFauxSupabase } = require('./aides/fauxSupabase');
const { anciensNomsApresRenommage, verifierMere } = require('../utils/naissance');

test('Renommage du bébé : l\'ancien nom est gardé avec la date et la personne ; plusieurs renommages s\'empilent ; même nom → rien', () => {
  const l1 = anciensNomsApresRenommage({ nom: 'Bébé Marie Joseph', anciens_noms: [] }, 'Rose Marie Joseph', 'Krystofia', '2026-10-14T10:00:00Z');
  assert.deepStrictEqual(l1, [{ nom: 'Bébé Marie Joseph', jusqu_au: '2026-10-14T10:00:00Z', origine: 'renommage', par: 'Krystofia' }]);
  const l2 = anciensNomsApresRenommage({ nom: 'Rose Marie Joseph', anciens_noms: l1 }, 'Rose-Marie Joseph', null, '2026-10-20T10:00:00Z');
  assert.strictEqual(l2.length, 2);
  assert.strictEqual(l2[1].nom, 'Rose Marie Joseph');
  assert.strictEqual(anciensNomsApresRenommage({ nom: 'Rose' }, '  Rose  ', 'x', 'd'), null);
  assert.strictEqual(anciensNomsApresRenommage({ nom: 'Rose' }, '', 'x', 'd'), null);
  assert.strictEqual(anciensNomsApresRenommage(null, 'Rose', 'x', 'd'), null);
  assert.deepStrictEqual(anciensNomsApresRenommage({ nom: 'A', anciens_noms: null }, 'B', 'x', 'd').map(n => n.nom), ['A'], 'colonne vide/absente tolérée');
});

const base = (dossiers, opts) => creerFauxSupabase({ dossiers }, opts);
test('verifierMere : mère valide acceptée ; introuvable 404 ; homme 400 ; fusionnée 409 ; soi-même 400 ; boucle 409 ; colonne absente 503', async () => {
  const d = [{ id: 'm', numero_dossier: 'N-1', nom: 'Marie', sexe: 'F' }, { id: 'h', nom: 'Paul', sexe: 'M' }, { id: 'f', nom: 'Fus', sexe: 'F', fusionne_dans: 'm' }, { id: 'b', nom: 'Bébé', mere_dossier_id: 'x' }, { id: 'x', nom: 'Y', sexe: 'F', mere_dossier_id: 'b' }];
  const s = base(d);
  assert.strictEqual((await verifierMere(s, 'm')).ok, true);
  assert.strictEqual((await verifierMere(s, 'm')).mere.numero_dossier, 'N-1');
  assert.strictEqual((await verifierMere(s, 'inconnue')).status, 404);
  assert.strictEqual((await verifierMere(s, 'h')).status, 400);
  assert.strictEqual((await verifierMere(s, 'f')).status, 409);
  assert.strictEqual((await verifierMere(s, 'b', 'b')).status, 400);
  assert.strictEqual((await verifierMere(s, 'x', 'b')).status, 409);
  assert.strictEqual((await verifierMere(s, '')).status, 400);
  const sansColonne = base(d, { colonnesAbsentes: { dossiers: ['mere_dossier_id', 'fusionne_dans'] } });
  const r = await verifierMere(sansColonne, 'm');
  assert.strictEqual(r.status, 503);
  assert.match(r.erreur, /dossiers_naissance_fusion\.sql/);
});
