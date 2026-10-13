// tests/paiement_partiel.test.js — utils/paiementPartiel.js : le paiement partiel (acompte puis reste à payer plus
// tard), côté serveur. La logique pure est testée ici ; le branchement dans POST /api/paiements l'est dans
// tests/regressions.test.js (lecture du code, comme les autres routes).
const { test } = require('node:test');
const assert = require('node:assert');
const { validerPaiementPartiel, soldeAjouteParPaiement, estPaiementPartiel, MODES_PAIEMENT_PARTIEL } = require('../utils/paiementPartiel');

const partiel = (extra = {}) => ({ episode_id: 'e1', mode: 'cash', montant: 5000, solde_restant: 5000, details: { paiement_partiel: true }, ...extra });

test("un paiement partiel valide : espèces, MonCash, virement et chèque", () => {
  for (const mode of MODES_PAIEMENT_PARTIEL) assert.strictEqual(validerPaiementPartiel(partiel({ mode })), null, mode);
  assert.deepStrictEqual(MODES_PAIEMENT_PARTIEL, ['cash', 'moncash', 'virement', 'cheque']);
});

test("un paiement ordinaire n'est jamais touché par la validation (même avec un solde_restant)", () => {
  assert.strictEqual(validerPaiementPartiel({ mode: 'cash', montant: 100, episode_id: 'e1' }), null);
  assert.strictEqual(validerPaiementPartiel({ mode: 'credit', montant: 0, solde_restant: 300, episode_id: 'e1' }), null);
  assert.strictEqual(validerPaiementPartiel({ mode: 'ong', montant: 100, details: { reference: 'X' } }), null);
  assert.strictEqual(validerPaiementPartiel({ mode: 'cash', details: { paiement_partiel: false } }), null);
  assert.strictEqual(validerPaiementPartiel({ mode: 'cash', details: 'paiement_partiel' }), null, 'un texte n\'est pas le marqueur');
  assert.strictEqual(validerPaiementPartiel(undefined), null);
  assert.strictEqual(estPaiementPartiel({ details: { paiement_partiel: 'true' } }), false, 'seul le booléen true compte');
});

test("refus : mode non permis, épisode manquant, montant versé nul, reste nul ou négatif", () => {
  for (const mode of ['credit', 'ong', 'depot', 'exoneration', 'remboursement_credit', 'remboursement_patient']) {
    assert.match(validerPaiementPartiel(partiel({ mode })), /espèces, MonCash, virement ou chèque/, mode);
  }
  assert.match(validerPaiementPartiel(partiel({ episode_id: undefined })), /episode_id requis/);
  for (const montant of [0, -5, '', 'abc', undefined]) assert.match(validerPaiementPartiel(partiel({ montant })), /montant versé supérieur à 0/, String(montant));
  for (const reste of [0, -1, '', 'abc', undefined]) assert.match(validerPaiementPartiel(partiel({ solde_restant: reste })), /reste à payer supérieur à 0/, String(reste));
});

test("le solde ajouté : un crédit ajoute sa dette, un paiement partiel son reste, tout le reste rien", () => {
  assert.strictEqual(soldeAjouteParPaiement({ mode: 'credit', solde_restant: 800 }), 800);
  assert.strictEqual(soldeAjouteParPaiement(partiel({ solde_restant: '2500.50' })), 2500.5);
  assert.strictEqual(soldeAjouteParPaiement({ mode: 'cash', montant: 100, solde_restant: 0 }), 0);
  // Un client qui enverrait un solde_restant sur un paiement ordinaire ne crée aucune dette.
  assert.strictEqual(soldeAjouteParPaiement({ mode: 'cash', montant: 100, solde_restant: 999 }), 0);
  assert.strictEqual(soldeAjouteParPaiement({ mode: 'depot', montant: 100, solde_restant: 999 }), 0);
  assert.strictEqual(soldeAjouteParPaiement({ mode: 'credit', solde_restant: 'abc' }), 0);
});

test("scénario de la césarienne : 50 % versés, reste en créance, puis deux versements jusqu'à zéro (même règle que le serveur)", () => {
  // Reproduit la règle de POST /api/paiements : solde = solde de l'épisode avant + ce que ce paiement ajoute ;
  // un remboursement de crédit le diminue (jamais en dessous de 0, jamais plus que le solde).
  let solde = 0;
  const total = 40000;
  const acompte = partiel({ montant: 20000, solde_restant: total - 20000 });
  assert.strictEqual(validerPaiementPartiel(acompte), null);
  solde = solde + soldeAjouteParPaiement(acompte);
  assert.strictEqual(solde, 20000, 'il reste 20 000 Gdes à payer');
  const rembourser = (montant) => { assert.ok(montant > 0 && montant <= solde); solde -= montant; };
  rembourser(5000); assert.strictEqual(solde, 15000);
  rembourser(15000); assert.strictEqual(solde, 0);
  // Un 2e paiement partiel sur le même épisode s'ajoute à ce qui était déjà dû.
  solde = 3000;
  solde = solde + soldeAjouteParPaiement(partiel({ solde_restant: 700 }));
  assert.strictEqual(solde, 3700);
});
