// tests/verificationPrixFiche.test.js — le serveur revérifie le montant d'une fiche plutôt que de faire confiance au téléphone (audit de sécurité du 21/10).
const { test } = require('node:test');
const assert = require('node:assert');
const { verifierTotalFiche, prixAutorises, configLits } = require('../utils/verificationPrixFiche');

const MED = { id: 'm1', nom: 'Amoxicilline', prix: 100, prixAchat: 40 };
const MED_NOUVEAU = { id: 'm2', nom: 'Paracétamol', prix: 50, nouveauPrix: 80 };
const MED_CONTRAT = { id: 'm3', nom: 'Sérum', prix: 20, nouveauPrix: 40, tarifParContrat: true };
const MED_PRIX_ONG = { id: 'm4', nom: 'Vaccin', prix: 100, prixContratOng: 60 };
const ACTE = { id: 'a1', nom: 'Consultation', prix: 500, sub: 'service' };
const CATALOGUE = { med: [MED, MED_NOUVEAU, MED_CONTRAT, MED_PRIX_ONG], actes: [ACTE] };
const PRIVE = { type_patient: 'prive', ong_partenaire: null };
const PARTENAIRE = { type_patient: 'partenaire', ong_partenaire: 'AVSI' };

function ligne(item, qte, prix, extra = {}) { return { itemId: item.id, type: item.sub ? 'acte' : 'med', sub: item.sub, nom: item.nom, qte, prix, ...extra }; }

test('prixAutorises : article simple (1 seul prix), nouveau prix (les 2 choix restent légitimes), tarif par contrat (1 seul selon le patient)', () => {
  assert.deepStrictEqual(prixAutorises(MED, { estONG: false, ongSousContratBool: false }), [100]);
  assert.deepStrictEqual(prixAutorises(MED_NOUVEAU, { estONG: false, ongSousContratBool: false }).sort((a,b)=>a-b), [50, 80]);
  assert.deepStrictEqual(prixAutorises(MED_CONTRAT, { estONG: false, ongSousContratBool: false }), [40], 'pas sous contrat : seul le nouveau prix (forcé)');
  assert.deepStrictEqual(prixAutorises(MED_CONTRAT, { estONG: true, ongSousContratBool: true }), [20], 'sous contrat : ancien prix gelé');
  assert.deepStrictEqual(prixAutorises(MED_PRIX_ONG, { estONG: true, ongSousContratBool: true }), [60]);
  assert.deepStrictEqual(prixAutorises(MED_PRIX_ONG, { estONG: false, ongSousContratBool: false }), [100], 'un privé ne profite jamais du prix contrat ONG');
});

test('une fiche honnête (prix réel du catalogue) est acceptée', () => {
  const r = verifierTotalFiche({
    raw_state: { lignesCalcul: [ligne(MED, 2, 100), ligne(ACTE, 1, 500)] },
    total_global: 700, breakdown: { med: 200, service: 500 },
    episode: PRIVE, catalogue: CATALOGUE, parametres: {}, ongDoc: null,
  });
  assert.deepStrictEqual(r, { ok: true });
});

test("le caissier qui facture MOINS que le prix réel (la fraude visée par l'audit) est refusé", () => {
  const r = verifierTotalFiche({
    raw_state: { lignesCalcul: [ligne(MED, 2, 10)] }, // vrai prix 100, fiche à 10
    total_global: 20, breakdown: { med: 20 },
    episode: PRIVE, catalogue: CATALOGUE, parametres: {}, ongDoc: null,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /Amoxicilline/);
});

test('les 2 choix du bouton « Tarif Actuel / Nouveau prix » restent acceptés, mais rien en dehors des 2', () => {
  const base = { episode: PRIVE, catalogue: CATALOGUE, parametres: {}, ongDoc: null };
  assert.strictEqual(verifierTotalFiche({ ...base, raw_state: { lignesCalcul: [ligne(MED_NOUVEAU, 1, 50)] }, total_global: 50, breakdown: { med: 50 } }).ok, true);
  assert.strictEqual(verifierTotalFiche({ ...base, raw_state: { lignesCalcul: [ligne(MED_NOUVEAU, 1, 80)] }, total_global: 80, breakdown: { med: 80 } }).ok, true);
  assert.strictEqual(verifierTotalFiche({ ...base, raw_state: { lignesCalcul: [ligne(MED_NOUVEAU, 1, 65)] }, total_global: 65, breakdown: { med: 65 } }).ok, false);
});

test('tarif par contrat : un privé qui se fait passer pour « sous contrat » (en gardant le vieux prix) est refusé', () => {
  const r = verifierTotalFiche({
    raw_state: { lignesCalcul: [ligne(MED_CONTRAT, 1, 20)] }, total_global: 20, breakdown: { med: 20 },
    episode: PRIVE, catalogue: CATALOGUE, parametres: {}, ongDoc: null,
  });
  assert.strictEqual(r.ok, false);
});

test("un don gratuit n'est accepté QUE si sourceDon est le partenaire RÉEL de cet épisode — sinon tout le monde pourrait se déclarer « don » pour ne rien payer", () => {
  const base = { episode: PARTENAIRE, catalogue: CATALOGUE, parametres: {}, ongDoc: null };
  const legitime = verifierTotalFiche({ ...base, raw_state: { lignesCalcul: [ligne(MED, 3, 0, { sourceDon: 'AVSI' })] }, total_global: 0, breakdown: { med: 0 } });
  assert.strictEqual(legitime.ok, true);
  const usurpe = verifierTotalFiche({ ...base, raw_state: { lignesCalcul: [ligne(MED, 3, 0, { sourceDon: 'UN AUTRE PARTENAIRE' })] }, total_global: 0, breakdown: { med: 0 } });
  assert.strictEqual(usurpe.ok, false);
  const sansDonDeclare = verifierTotalFiche({ ...base, raw_state: { lignesCalcul: [ligne(MED, 3, 0)] }, total_global: 0, breakdown: { med: 0 } });
  assert.strictEqual(sansDonDeclare.ok, false, 'prix 0 sans déclarer de don légitime : refusé (100 Gdes attendu)');
});

test('hébergement : jours × prix du lit (réglé par la direction), 2 périodes possibles, le patient ONG sous contrat paie le tarif contrat', () => {
  const parametres = { prixLitNormal: 300, prixLitPartenaireNormal: 150 };
  const base = { raw_state: { dateEntree1: '2026-10-01', dateSortie1: '2026-10-04', typeLit1: 'normal' }, breakdown: { hospit: 900 } };
  assert.strictEqual(verifierTotalFiche({ ...base, total_global: 900, episode: PRIVE, catalogue: CATALOGUE, parametres, ongDoc: null }).ok, true);
  assert.strictEqual(verifierTotalFiche({ ...base, total_global: 900, episode: PARTENAIRE, catalogue: CATALOGUE, parametres, ongDoc: null, breakdown: { hospit: 450 } }).ok, false, 'sous contrat : devrait être 450 (150/j), pas 900');
  assert.strictEqual(verifierTotalFiche({ raw_state: base.raw_state, total_global: 450, breakdown: { hospit: 450 }, episode: PARTENAIRE, catalogue: CATALOGUE, parametres, ongDoc: null }).ok, true);
  // 2 périodes, lits différents
  const deuxPeriodes = { dateEntree1: '2026-10-01', dateSortie1: '2026-10-03', typeLit1: 'normal', multiPeriode: true, dateEntree2: '2026-10-03', dateSortie2: '2026-10-05', typeLit2: 'prive' };
  const attendu = 2 * 300 + 2 * 750; // normal 300/j par défaut non réglé ici -> utilise réglage ; prive = défaut 750
  assert.strictEqual(verifierTotalFiche({ raw_state: deuxPeriodes, total_global: attendu, breakdown: { hospit: attendu }, episode: PRIVE, catalogue: CATALOGUE, parametres, ongDoc: null }).ok, true);
});

test("un partenaire sous contrat (date de fin dans le futur) paie le tarif contrat ; contrat expiré = tarif normal", () => {
  const parametres = { prixLitNormal: 300, prixLitPartenaireNormal: 150 };
  const raw_state = { dateEntree1: '2026-10-01', dateSortie1: '2026-10-02', typeLit1: 'normal' };
  const sousContrat = verifierTotalFiche({ raw_state, total_global: 150, breakdown: { hospit: 150 }, episode: PARTENAIRE, catalogue: CATALOGUE, parametres, ongDoc: { dateFinContrat: '2099-01-01' } });
  assert.strictEqual(sousContrat.ok, true);
  const expire = verifierTotalFiche({ raw_state, total_global: 300, breakdown: { hospit: 300 }, episode: PARTENAIRE, catalogue: CATALOGUE, parametres, ongDoc: { dateFinContrat: '2020-01-01' } });
  assert.strictEqual(expire.ok, true);
  const expireQuiGardeLeRabais = verifierTotalFiche({ raw_state, total_global: 150, breakdown: { hospit: 150 }, episode: PARTENAIRE, catalogue: CATALOGUE, parametres, ongDoc: { dateFinContrat: '2020-01-01' } });
  assert.strictEqual(expireQuiGardeLeRabais.ok, false);
});

test('chirurgie hors-catalogue : montant libre accepté (invérifiable par nature), mais borné à un montant raisonnable', () => {
  const ok = verifierTotalFiche({ raw_state: { hasChirSpec: true, prixChirSpec: '15000', nomChirSpec: 'Appendicectomie' }, total_global: 15000, breakdown: { chirurgie: 15000 }, episode: PRIVE, catalogue: CATALOGUE, parametres: {}, ongDoc: null });
  assert.strictEqual(ok.ok, true);
  const trop = verifierTotalFiche({ raw_state: { hasChirSpec: true, prixChirSpec: '999999999999' }, total_global: 999999999999, breakdown: {}, episode: PRIVE, catalogue: CATALOGUE, parametres: {}, ongDoc: null });
  assert.strictEqual(trop.ok, false);
});

test('un article supprimé/renommé depuis (introuvable dans le catalogue actuel) ne bloque pas une fiche déjà valide à sa création — limite connue, documentée', () => {
  const r = verifierTotalFiche({ raw_state: { lignesCalcul: [{ itemId: 'disparu', type: 'med', nom: 'Vieux médicament', qte: 1, prix: 123 }] }, total_global: 123, breakdown: { med: 123 }, episode: PRIVE, catalogue: CATALOGUE, parametres: {}, ongDoc: null });
  assert.strictEqual(r.ok, true);
});

test('un sous-total manipulé dans la ventilation (bon total global, mais service trafiqué) est refusé', () => {
  const r = verifierTotalFiche({
    raw_state: { lignesCalcul: [ligne(ACTE, 1, 500)] }, total_global: 500, breakdown: { service: 0, chirurgie: 500 }, // total juste, mais la catégorie est fausse
    episode: PRIVE, catalogue: CATALOGUE, parametres: {}, ongDoc: null,
  });
  assert.strictEqual(r.ok, false);
});

test('sans raw_state du tout (appelant inconnu) : on ne bloque pas, par prudence', () => {
  assert.deepStrictEqual(verifierTotalFiche({ raw_state: undefined, total_global: 999999, episode: PRIVE, catalogue: CATALOGUE, parametres: {}, ongDoc: null }), { ok: true, ignore: true });
});

test('une fiche vide (raw_state: {}) doit valoir 0 — un montant inventé est refusé', () => {
  assert.strictEqual(verifierTotalFiche({ raw_state: {}, total_global: 0, episode: PRIVE, catalogue: CATALOGUE, parametres: {}, ongDoc: null }).ok, true);
  assert.strictEqual(verifierTotalFiche({ raw_state: {}, total_global: 5000, episode: PRIVE, catalogue: CATALOGUE, parametres: {}, ongDoc: null }).ok, false);
});

test('arrondi au centime : une différence de 1 centime (flottants) ne déclenche pas un refus', () => {
  const r = verifierTotalFiche({ raw_state: { lignesCalcul: [ligne(MED, 3, 33.33)] }, total_global: 99.99, breakdown: { med: 99.99 }, episode: PRIVE, catalogue: { med: [{ ...MED, prix: 33.33 }], actes: [] }, parametres: {}, ongDoc: null });
  assert.strictEqual(r.ok, true);
});
