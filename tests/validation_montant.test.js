// tests/validation_montant.test.js — 13/10 : « Test ₦0, negative values, absurdly large values and malformed amounts » (liste de contrôle fintech d'Esdras).
// Le serveur refuse un montant négatif, illisible, infini ou démesuré AVANT tout calcul de solde ; la base le refuse aussi (sql/controles_montants.sql).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { MONTANT_MAX, lireMontant, validerMontantPaiement, normaliserMontant } = require('../utils/validationMontant');

test("Montants valides : entiers, centimes, texte numérique, zéro pour crédit / exonération / fiche payée par dépôt", () => {
  for (const montant of [0, 1, 60, 1250.5, 99999999.99, MONTANT_MAX, '1250', '1250.50', ' 300 ', '0']) {
    assert.strictEqual(validerMontantPaiement({ montant, mode: 'cash' }), null, JSON.stringify(montant));
  }
  for (const mode of ['credit', 'exoneration', 'cash', 'moncash', 'virement', 'cheque', 'ong']) {
    assert.strictEqual(validerMontantPaiement({ montant: 0, mode }), null, `0 Gdes accepté en ${mode}`);
  }
});

test("Montants refusés : négatif, texte, infini, NaN, absent, vide, objet, notation exponentielle, démesuré", () => {
  const cas = [-1, -0.01, '-5', 'abc', '12abc', '', '  ', 'NaN', 'Infinity', '1e3', '0x10', '1,5', NaN, Infinity, -Infinity, null, undefined, {}, [], [5], true, MONTANT_MAX + 1, 1e15, '1000000000000'];
  for (const montant of cas) {
    const e = validerMontantPaiement({ montant, mode: 'cash' });
    assert.ok(typeof e === 'string' && e.length > 5, `refusé : ${JSON.stringify(montant)} (${String(montant)})`);
  }
  assert.match(validerMontantPaiement({ montant: -50, mode: 'cash' }), /négatif/);
  assert.match(validerMontantPaiement({ montant: 'abc', mode: 'cash' }), /doit être un nombre/);
  assert.match(validerMontantPaiement({ montant: undefined, mode: 'cash' }), /requis/);
  assert.match(validerMontantPaiement({ montant: MONTANT_MAX + 1, mode: 'cash' }), /dépasse la limite/);
  assert.strictEqual(validerMontantPaiement(null), 'Paiement illisible.');
  assert.strictEqual(validerMontantPaiement('texte'), 'Paiement illisible.');
});

test("Dépôt et remboursements : strictement positifs (un dépôt de 0 n'a aucun sens)", () => {
  for (const mode of ['depot', 'remboursement_credit', 'remboursement_patient']) {
    assert.match(validerMontantPaiement({ montant: 0, mode }), /supérieur à 0/, mode);
    assert.strictEqual(validerMontantPaiement({ montant: 0.01, mode }), null, `${mode} : 0,01 accepté`);
    assert.match(validerMontantPaiement({ montant: -5, mode }), /négatif/);
  }
});

test("solde_restant : s'il est fourni, il doit être un nombre raisonnable (négatif possible : trop-perçu)", () => {
  assert.strictEqual(validerMontantPaiement({ montant: 10, mode: 'cash', solde_restant: 500 }), null);
  assert.strictEqual(validerMontantPaiement({ montant: 10, mode: 'cash', solde_restant: -20 }), null);
  assert.strictEqual(validerMontantPaiement({ montant: 10, mode: 'cash', solde_restant: null }), null);
  assert.strictEqual(validerMontantPaiement({ montant: 10, mode: 'cash', solde_restant: '' }), null);
  for (const solde of ['abc', NaN, Infinity, MONTANT_MAX + 1, -(MONTANT_MAX + 1), {}]) {
    assert.match(validerMontantPaiement({ montant: 10, mode: 'cash', solde_restant: solde }), /solde restant/, String(solde));
  }
});

test("lireMontant et normaliserMontant : texte → nombre, arrondi au centime", () => {
  assert.strictEqual(lireMontant('12.5'), 12.5);
  assert.strictEqual(lireMontant(7), 7);
  assert.strictEqual(lireMontant('1e3'), null);
  assert.strictEqual(lireMontant(''), null);
  assert.strictEqual(normaliserMontant({ montant: '1250.505' }).montant, 1250.51, 'arrondi au centime (colonne numeric(12,2))');
  assert.strictEqual(normaliserMontant({ montant: 33.333333 }).montant, 33.33);
  assert.strictEqual(normaliserMontant({ montant: '100' }).montant, 100, 'le texte devient un nombre');
  assert.strictEqual(normaliserMontant({ montant: 0.1 + 0.2 }).montant, 0.3, 'pas de 0,30000000000000004 en base');
});

test("server.js : le montant est contrôlé AVANT le contrôle du paiement partiel et le calcul du solde, sur la copie du corps", () => {
  const src = require('./serveurSource').lireServeur();
  const debut = src.indexOf("app.post('/api/paiements'");
  const route = src.slice(debut, src.indexOf('\napp.', debut + 10));
  const iCopie = route.indexOf('const corps = { ...req.body };');
  const iHeure = route.indexOf('appliquerHeureAuPaiement(corps, req);');
  const iValide = route.indexOf('validerMontantPaiement(corps)');
  const i400 = route.indexOf('return res.status(400).json({ error: erreurMontant })');
  const iNormalise = route.indexOf('normaliserMontant(corps)');
  const iPartiel = route.indexOf('validerPaiementPartiel(corps)');
  const iSolde = route.indexOf("supabase.rpc('enregistrer_paiement_atomique'"); // le solde est calculé par la base, sous verrou (13/10)
  const iInsert = route.indexOf(".insert({ ...corps, local_id: local_id || null })");
  assert.ok(iCopie > 0 && iCopie < iHeure && iHeure < iValide && iValide < i400 && i400 < iNormalise, 'copie, heure, validation, refus 400, arrondi');
  assert.ok(iNormalise < iPartiel && iPartiel < iSolde && iSolde < iInsert, 'puis paiement partiel, solde, insertion');
  assert.match(src, /const \{ validerMontantPaiement, normaliserMontant \} = require\('\.\/utils\/validationMontant'\);/);
});

test("sql/controles_montants.sql : contrainte montant entre 0 et 100 000 000, relançable, sans DROP ni REVOKE", () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'controles_montants.sql'), 'utf8');
  assert.match(sql, /check \(montant >= 0 and montant <= 100000000\)/i);
  assert.match(sql, /if not exists \(select 1 from pg_constraint where conname = 'paiements_montant_borne'/);
  assert.doesNotMatch(sql, /^\s*(drop|revoke)\b/im);
  assert.strictEqual(MONTANT_MAX, 100000000, 'même plafond que le contrôle du serveur');
});
