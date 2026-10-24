// tests/verification_paiement_fiche.test.js — le PAIEMENT doit correspondre à sa FICHE (audit du 21/10, rappel d'Esdras : exonération et paiement partiel ne doivent pas être oubliés).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { verifierPaiementContreFiche } = require('../utils/verificationPrixFiche');

const FICHE = { id: 'f1', episode_id: 'ep1', total_global: 5000 };
const verif = (corps, extra = {}) => verifierPaiementContreFiche({ corps, fiche: FICHE, soldeDepotDisponible: 0, ...extra });

test('paiement complet (espèces, MonCash, virement, chèque, partenaire) = le total exact de la fiche ; en dessous, refusé', () => {
  for (const mode of ['cash', 'moncash', 'virement', 'cheque', 'ong']) assert.strictEqual(verif({ mode, montant: 5000 }).ok, true, mode);
  const r = verif({ mode: 'cash', montant: 500 }); // la fraude : 500 enregistrés pour 5000
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /ne correspond pas à la fiche/);
});

test('exonération : montant payé + montant exonéré = total, et le montant exonéré doit être cohérent avec son pourcentage', () => {
  assert.strictEqual(verif({ mode: 'exoneration', montant: 2500, exoneration: { pourcentage: 50, montantExonere: 2500 } }).ok, true);
  assert.strictEqual(verif({ mode: 'exoneration', montant: 0, exoneration: { pourcentage: 100, montantExonere: 5000 } }).ok, true, 'exonération totale');
  // 50 % annoncé mais 4500 « exonérés » : refusé
  assert.strictEqual(verif({ mode: 'exoneration', montant: 500, exoneration: { pourcentage: 50, montantExonere: 4500 } }).ok, false);
  // exonération déclarée mais rien d'exonéré, payé 500 : refusé
  assert.strictEqual(verif({ mode: 'exoneration', montant: 500, exoneration: { pourcentage: 0, montantExonere: 0 } }).ok, false);
  assert.strictEqual(verif({ mode: 'exoneration', montant: 0, exoneration: { pourcentage: 150, montantExonere: 7500 } }).ok, false, 'pourcentage au-delà de 100');
});

test('paiement partiel : montant versé + reste à payer = total', () => {
  assert.strictEqual(verif({ mode: 'cash', montant: 2000, solde_restant: 3000, details: { paiement_partiel: true } }).ok, true);
  assert.strictEqual(verif({ mode: 'cash', montant: 2000, solde_restant: 1000, details: { paiement_partiel: true } }).ok, false, 'le reste a été minimisé');
});

test('crédit : rien versé, tout en reste dû (ou après dépôt) ; un crédit qui « oublie » une partie est refusé', () => {
  assert.strictEqual(verif({ mode: 'credit', montant: 0, solde_restant: 5000 }).ok, true);
  assert.strictEqual(verif({ mode: 'credit', montant: 0, solde_restant: 1000 }).ok, false);
});

test('dépôt déduit : permis seulement jusqu\'au dépôt réellement disponible ; un faux « dépôt utilisé » est refusé', () => {
  assert.strictEqual(verif({ mode: 'cash', montant: 3000, details: { montant_depot_utilise: 2000 } }, { soldeDepotDisponible: 2000 }).ok, true);
  const r = verif({ mode: 'cash', montant: 500, details: { montant_depot_utilise: 4500 } }, { soldeDepotDisponible: 0 });
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /dépôt/);
});

test('combinaisons : dépôt + partiel, dépôt + exonération', () => {
  assert.strictEqual(verif({ mode: 'cash', montant: 1000, solde_restant: 2000, details: { paiement_partiel: true, montant_depot_utilise: 2000 } }, { soldeDepotDisponible: 2000 }).ok, true);
  assert.strictEqual(verif({ mode: 'exoneration', montant: 1500, details: { montant_depot_utilise: 1000 }, exoneration: { pourcentage: 50, montantExonere: 2500 } }, { soldeDepotDisponible: 1000 }).ok, true);
});

test('une vente sans fiche retrouvable est refusée ; dépôts et remboursements ne sont pas concernés', () => {
  assert.strictEqual(verifierPaiementContreFiche({ corps: { mode: 'cash', montant: 100 }, fiche: null, soldeDepotDisponible: 0 }).ok, false);
  for (const mode of ['depot', 'remboursement_credit', 'remboursement_patient', 'transfert_hospitalisation']) {
    assert.strictEqual(verifierPaiementContreFiche({ corps: { mode, montant: 100 }, fiche: null, soldeDepotDisponible: 0 }).ok, true, mode);
  }
});

// ---- le branchement dans server.js (middleware placé avant la route) ----
const serverSrc = require('./serveurSource').lireServeur();
const VRAI_SOLDE = (() => { const d = serverSrc.indexOf('function calculerSoldeDepot'); return new Function(`${serverSrc.slice(d, serverSrc.indexOf('\n}\n', d) + 3)}; return calculerSoldeDepot;`)(); })();
function monter({ fiches = [], paiements = [], episodes = [], vraiSolde = false } = {}) {
  const tables = { fiches, paiements, episodes };
  const from = (nom) => {
    const filtres = [];
    const lignes = () => (tables[nom] || []).filter(r => filtres.every(f => f(r)));
    const c = {
      select: () => c, eq: (k, v) => { filtres.push(r => r[k] === v); return c; },
      is: (k, v) => { filtres.push(r => (r[k] ?? null) === v); return c; }, or: () => c,
      maybeSingle: async () => ({ data: lignes()[0] || null, error: null }),
      then: (resolve) => resolve({ data: lignes(), error: null }),
    };
    return c;
  };
  const debut = serverSrc.indexOf("app.use('/api/paiements', async (req, res, next) => {");
  const fin = serverSrc.indexOf("// Route : création d'un paiement — idempotente via local_id");
  assert.ok(debut > 0 && fin > debut, 'middleware introuvable');
  let mw; const app = { use: (_c, fn) => { mw = fn; } };
  const audits = [];
  const { verifierPaiementContreFiche: v, MODES_VENTE } = require('../utils/verificationPrixFiche');
  new Function('app', 'supabase', 'aPermission', 'estUnVraiUuid', 'enregistrerAuditServeur', 'calculerSoldeDepot', 'verifierPaiementContreFiche', 'MODES_VENTE', 'estRejeu', serverSrc.slice(debut, fin))(
    app, { from }, async () => true, (x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x),
    async (_r, action, details) => audits.push({ action, details }),
    vraiSolde ? VRAI_SOLDE : (liste) => ({ soldeDepot: liste.filter(p => p.mode === 'depot').reduce((s, p) => s + p.montant, 0) }), v, MODES_VENTE, require('../utils/heureServeur').estRejeu);
  const appeler = async (body, headers = {}) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    let suite = false;
    await mw({ method: 'POST', path: '/', body, headers, user: { id: 'u1' } }, res, () => { suite = true; });
    return { res, suite };
  };
  return { appeler, audits };
}
const UUID = '11111111-1111-1111-1111-111111111111';

test('middleware : un paiement cohérent passe, un paiement trop bas est refusé (400) et tracé', async () => {
  const m = monter({ fiches: [{ id: UUID, episode_id: 'ep1', total_global: 5000, supprime_le: null, local_id: 'L1' }] });
  const bon = await m.appeler({ mode: 'cash', montant: 5000, episode_id: 'ep1', fiche_id: UUID, local_id: 'L1' });
  assert.strictEqual(bon.suite, true);
  const mauvais = await m.appeler({ mode: 'cash', montant: 500, episode_id: 'ep1', fiche_id: UUID, local_id: 'L1' });
  assert.strictEqual(mauvais.suite, false);
  assert.strictEqual(mauvais.res.code, 400);
  assert.strictEqual(mauvais.res.corps.code, 'PAIEMENT_FICHE_INCOHERENT');
  assert.strictEqual(m.audits[0].action, 'paiement_refuse');
});

test('middleware : la fiche se retrouve aussi par le local_id (file hors ligne) ; sans aucune fiche retrouvable, une vente est refusée', async () => {
  const m = monter({ fiches: [{ id: UUID, episode_id: 'ep1', total_global: 5000, supprime_le: null, local_id: 'L1' }] });
  assert.strictEqual((await m.appeler({ mode: 'cash', montant: 5000, episode_id: 'ep1', fiche_id: 'fiche-locale-123', local_id: 'L1' })).suite, true);
  const sans = await m.appeler({ mode: 'cash', montant: 100, episode_id: 'ep1' });
  assert.strictEqual(sans.suite, false);
  assert.strictEqual(sans.res.code, 400);
});

test("middleware : ⚡ Achat Express (local_id « …-paiement », fiche créée avec l'épisode) est retrouvé", async () => {
  const m = monter({ episodes: [{ id: 'epX', local_id: 'V1' }], fiches: [{ id: UUID, episode_id: 'epX', total_global: 700, supprime_le: null, local_id: null }] });
  assert.strictEqual((await m.appeler({ mode: 'cash', montant: 700, episode_id: 'epX', local_id: 'V1-paiement' })).suite, true);
  assert.strictEqual((await m.appeler({ mode: 'cash', montant: 70, episode_id: 'epX', local_id: 'V1-paiement' })).suite, false);
});

test("middleware : fiche d'un autre dossier refusée ; dépôts et remboursements ne sont pas touchés ; un rejeu est laissé passer", async () => {
  const m = monter({ fiches: [{ id: UUID, episode_id: 'ep1', total_global: 5000, supprime_le: null, local_id: 'L1' }], paiements: [{ id: 'p1', local_id: 'DEJA', episode_id: 'ep1' }] });
  assert.strictEqual((await m.appeler({ mode: 'cash', montant: 5000, episode_id: 'ep2', fiche_id: UUID })).suite, false);
  assert.strictEqual((await m.appeler({ mode: 'depot', montant: 100, episode_id: 'ep1' })).suite, true);
  assert.strictEqual((await m.appeler({ mode: 'remboursement_credit', montant: 100, episode_id: 'ep1' })).suite, true);
  assert.strictEqual((await m.appeler({ mode: 'cash', montant: 1, episode_id: 'ep1', local_id: 'DEJA' })).suite, true, 'rejeu déjà enregistré');
});

test("HORS LIGNE : un paiement rejoué depuis la file d'attente (X-CHF-Rejeu) n'est JAMAIS refusé — enregistré et signalé à la direction (la transaction n'est pas perdue)", async () => {
  const m = monter({ fiches: [{ id: UUID, episode_id: 'ep1', total_global: 5000, supprime_le: null, local_id: 'L1' }] });
  const trop_bas = { mode: 'cash', montant: 500, episode_id: 'ep1', fiche_id: UUID, local_id: 'L9' };
  assert.strictEqual((await m.appeler(trop_bas)).suite, false, 'en ligne : refusé');
  const rejeu = await m.appeler(trop_bas, { 'x-chf-rejeu': '1' });
  assert.strictEqual(rejeu.suite, true, 'hors ligne rejoué : passe');
  assert.ok(m.audits.some(a => a.action === 'paiement_suspect' && a.details.hors_ligne === true));
  // sans fiche retrouvable (ex. la fiche n'a pas encore été rejouée) : pareil, jamais perdu
  const sansFiche = await m.appeler({ mode: 'cash', montant: 100, episode_id: 'ep1', local_id: 'L10' }, { 'x-chf-rejeu': '1' });
  assert.strictEqual(sansFiche.suite, true);
});

// ---- Trouvé en testant hors ligne sur le vrai site : le même dépôt déduit deux fois par deux ventes hors ligne de suite ----
const REJEU = { 'x-chf-rejeu': '1' };
function episodeAvecDepotEpuise() { // 1 000 déposés, 1 000 déjà utilisés par des fiches précédentes
  return monter({ vraiSolde: true, fiches: [{ id: UUID, episode_id: 'ep1', total_global: 300, supprime_le: null, local_id: 'L1' }],
    paiements: [{ id: 'd1', episode_id: 'ep1', mode: 'depot', montant: 1000, annule: false, supprime_le: null }, { id: 'u1', episode_id: 'ep1', mode: 'cash', montant: 0, annule: false, supprime_le: null, details: { montant_depot_utilise: 1000 } }] });
}

test("HORS LIGNE : un paiement partiel rejoué qui redéduit un dépôt déjà épuisé — le dépôt est ramené à 0 et l'excédent passe en dette (rien n'est perdu)", async () => {
  const m = episodeAvecDepotEpuise();
  const corps = { mode: 'cash', montant: 100, solde_restant: 100, episode_id: 'ep1', fiche_id: UUID, local_id: 'B1', details: { paiement_partiel: true, reste: 100, total_fiche: 300, montant_paye: 100, montant_depot_utilise: 100 } };
  const r = await m.appeler(corps, REJEU);
  assert.strictEqual(r.suite, true, 'enregistré');
  assert.strictEqual(corps.details.montant_depot_utilise, undefined, 'plus de dépôt déduit');
  assert.strictEqual(corps.solde_restant, 200, 'le patient doit 200 (100 + les 100 de dépôt qui n\'existaient plus)');
  assert.strictEqual(corps.details.reste, 200);
  assert.strictEqual(corps.montant + corps.solde_restant, 300, 'total de la fiche exact');
  assert.ok(m.audits.some(a => a.action === 'paiement_depot_corrige' && a.details.mis_en_dette === 100));
});

test("HORS LIGNE : un paiement complet rejoué qui redéduit un dépôt épuisé devient un paiement partiel (payé + reste dû = total)", async () => {
  const m = episodeAvecDepotEpuise();
  const corps = { mode: 'cash', montant: 200, episode_id: 'ep1', fiche_id: UUID, local_id: 'B2', details: { montant_depot_utilise: 100 } };
  assert.strictEqual((await m.appeler(corps, REJEU)).suite, true);
  assert.strictEqual(corps.details.paiement_partiel, true);
  assert.strictEqual(corps.solde_restant, 100);
  assert.strictEqual(corps.montant + corps.solde_restant, 300);
});

test("HORS LIGNE : une fiche payée ENTIÈREMENT par un dépôt qui n'existe plus devient un crédit du même montant", async () => {
  const m = episodeAvecDepotEpuise();
  const corps = { mode: 'cash', montant: 0, episode_id: 'ep1', fiche_id: UUID, local_id: 'B3', details: { montant_depot_utilise: 300 } };
  assert.strictEqual((await m.appeler(corps, REJEU)).suite, true);
  assert.strictEqual(corps.mode, 'credit');
  assert.strictEqual(corps.solde_restant, 300);
});

test("HORS LIGNE : dépôt seulement en partie disponible (40 sur 100 demandés) — 40 gardés, 60 en dette", async () => {
  const m = monter({ vraiSolde: true, fiches: [{ id: UUID, episode_id: 'ep1', total_global: 300, supprime_le: null, local_id: 'L1' }],
    paiements: [{ id: 'd1', episode_id: 'ep1', mode: 'depot', montant: 40, annule: false, supprime_le: null }] });
  const corps = { mode: 'cash', montant: 200, episode_id: 'ep1', fiche_id: UUID, local_id: 'B4', details: { montant_depot_utilise: 100 } };
  assert.strictEqual((await m.appeler(corps, REJEU)).suite, true);
  assert.strictEqual(corps.details.montant_depot_utilise, 40);
  assert.strictEqual(corps.solde_restant, 60);
  assert.strictEqual(corps.montant + 40 + corps.solde_restant, 300);
});

test("EN LIGNE : le même dépôt dépassé reste REFUSÉ (la caissière corrige tout de suite), jamais corrigé en silence", async () => {
  const m = episodeAvecDepotEpuise();
  const corps = { mode: 'cash', montant: 200, episode_id: 'ep1', fiche_id: UUID, local_id: 'B5', details: { montant_depot_utilise: 100 } };
  const r = await m.appeler(corps);
  assert.strictEqual(r.suite, false);
  assert.strictEqual(r.res.code, 400);
  assert.strictEqual(corps.details.montant_depot_utilise, 100, 'rien modifié');
});

test('exonération + reste à crédit (24/10) : total = exonéré + payé + reste ; un reste minimisé ou un exonéré gonflé est refusé', () => {
  const exo = (pct, montantExonere) => ({ pourcentage: pct, montantExonere, motif: 'Indigent' });
  const base = { mode: 'exoneration', details: { paiement_partiel: true } };
  // FICHE : 5000 → 50 % = 2500 exonérés ; rien payé, 2500 à crédit
  assert.strictEqual(verif({ ...base, montant: 0, solde_restant: 2500, exoneration: exo(50, 2500) }).ok, true);
  assert.strictEqual(verif({ ...base, montant: 1000, solde_restant: 1500, exoneration: exo(50, 2500) }).ok, true, 'payé 1000 + reste 1500');
  assert.strictEqual(verif({ ...base, montant: 0, solde_restant: 1000, exoneration: exo(50, 2500) }).ok, false, 'reste minimisé');
  assert.strictEqual(verif({ ...base, montant: 0, solde_restant: 2000, exoneration: exo(60, 3000) }).ok, true, '60 % = 3000, reste 2000');
  assert.strictEqual(verif({ ...base, montant: 0, solde_restant: 2000, exoneration: exo(50, 3000) }).ok, false, 'montant exonéré ≠ pourcentage');
});
