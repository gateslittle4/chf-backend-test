// tests/suivi_dossiers_papier.test.js — règles pures du suivi des dossiers papier (28/11, Esdras : « je ne sais pas quand un dossier sort de l'archive »).
const { test } = require('node:test');
const assert = require('node:assert');
const { etatDossierPapier, estAchatMedicament, fenetreJourHaiti, construireSuivi } = require('../utils/suiviDossiersPapier');

const E = (date, id = 'e', par = 'archive@chf.com') => ({ id, type: 'entree', date, par });
const S = (date, id = 's', par = 'archive@chf.com') => ({ id, type: 'sortie', date, par });

test('Jamais entré : « pas entré », pas de sortie, même si un médicament a été acheté', () => {
  assert.deepStrictEqual(etatDossierPapier([], [{ date: '2026-11-28T15:00:00Z', numero_paiement: 9 }]), { etat: 'pas_entre', entree: null, sortie: null });
});

test('Entré puis rien : « dans l\'archive » avec la date et le nom de celui qui a coché', () => {
  const r = etatDossierPapier([E('2026-11-28T14:00:00Z')], []);
  assert.strictEqual(r.etat, 'dans_archive'); assert.strictEqual(r.entree.date, '2026-11-28T14:00:00Z'); assert.strictEqual(r.entree.par, 'archive@chf.com'); assert.strictEqual(r.sortie, null);
});

test('SORTIE AUTOMATIQUE : un médicament acheté à la caisse APRÈS l\'entrée fait sortir le dossier, avec la date et le n° du paiement', () => {
  const r = etatDossierPapier([E('2026-11-28T14:00:00Z')], [{ date: '2026-11-28T15:30:00Z', numero_paiement: 516 }]);
  assert.strictEqual(r.etat, 'sorti');
  assert.deepStrictEqual(r.sortie, { id: null, date: '2026-11-28T15:30:00Z', origine: 'automatique', par: null, numero_paiement: 516 });
});

test('Un médicament acheté AVANT l\'entrée ne fait pas sortir le dossier (il vient d\'être rangé)', () => {
  const r = etatDossierPapier([E('2026-11-28T18:00:00Z')], [{ date: '2026-11-28T15:30:00Z', numero_paiement: 516 }]);
  assert.strictEqual(r.etat, 'dans_archive');
});

test('Sortie à la main : prise en compte ; la plus tôt des deux (main ou automatique) fait foi ; à égalité, la main l\'emporte', () => {
  const achat = [{ date: '2026-11-28T16:00:00Z', numero_paiement: 7 }];
  assert.strictEqual(etatDossierPapier([E('2026-11-28T14:00:00Z'), S('2026-11-28T15:00:00Z')], achat).sortie.origine, 'manuel');
  assert.strictEqual(etatDossierPapier([E('2026-11-28T14:00:00Z'), S('2026-11-28T17:00:00Z')], achat).sortie.origine, 'automatique');
  assert.strictEqual(etatDossierPapier([E('2026-11-28T14:00:00Z'), S('2026-11-28T16:00:00Z')], achat).sortie.origine, 'manuel');
  assert.strictEqual(etatDossierPapier([E('2026-11-28T14:00:00Z'), S('2026-11-28T15:00:00Z', 's1', 'dir@chf.com')], []).sortie.par, 'dir@chf.com');
});

test('Un dossier qui revient : le DERNIER cycle fait foi (nouvelle entrée → de nouveau « dans l\'archive »)', () => {
  const m = [E('2026-11-27T10:00:00Z', 'e1'), S('2026-11-27T12:00:00Z', 's1'), E('2026-11-28T09:00:00Z', 'e2')];
  assert.strictEqual(etatDossierPapier(m, [{ date: '2026-11-27T11:00:00Z' }]).etat, 'dans_archive', 'ni la sortie ni l\'achat de la veille ne comptent');
  assert.strictEqual(etatDossierPapier(m, [{ date: '2026-11-28T11:00:00Z', numero_paiement: 3 }]).sortie.date, '2026-11-28T11:00:00Z');
});

test('Les mouvements annulés sont ignorés', () => {
  assert.strictEqual(etatDossierPapier([{ ...E('2026-11-28T14:00:00Z'), annule: true }], []).etat, 'pas_entre');
  assert.strictEqual(etatDossierPapier([E('2026-11-28T14:00:00Z'), { ...S('2026-11-28T15:00:00Z'), annule: true }], []).etat, 'dans_archive');
});

test('Achat de médicament : il faut une part pharmacie ; ni dépôt, ni remboursement, ni annulé, ni corbeille', () => {
  const fiche = { breakdown: { med: 500 } };
  assert.strictEqual(estAchatMedicament({ mode: 'cash' }, fiche), true);
  assert.strictEqual(estAchatMedicament({ mode: 'ong' }, fiche), true, 'un médicament donné à un patient partenaire est aussi donné');
  assert.strictEqual(estAchatMedicament({ mode: 'cash' }, { breakdown: { labo: 500 } }), false, 'pas de pharmacie dans la fiche');
  assert.strictEqual(estAchatMedicament({ mode: 'cash' }, { breakdown: { med: 0 } }), false);
  assert.strictEqual(estAchatMedicament({ mode: 'cash' }, null), false);
  for (const mode of ['depot', 'remboursement_credit', 'remboursement_patient', 'transfert_hospitalisation']) assert.strictEqual(estAchatMedicament({ mode }, fiche), false, mode);
  assert.strictEqual(estAchatMedicament({ mode: 'cash', annule: true }, fiche), false);
  assert.strictEqual(estAchatMedicament({ mode: 'cash', supprime_le: '2026-11-28T00:00:00Z' }, fiche), false);
});

test('Jour d\'Haïti : minuit à minuit, heure d\'été comprise ; jour illisible = null', () => {
  assert.deepStrictEqual(fenetreJourHaiti('2026-11-27'), { debut: '2026-11-27T05:00:00.000Z', fin: '2026-11-28T05:00:00.000Z' });
  assert.deepStrictEqual(fenetreJourHaiti('2026-07-15'), { debut: '2026-07-15T04:00:00.000Z', fin: '2026-07-16T04:00:00.000Z' });
  assert.deepStrictEqual(fenetreJourHaiti('2026-03-08'), { debut: '2026-03-08T05:00:00.000Z', fin: '2026-03-09T04:00:00.000Z' }, 'changement d\'heure : journée de 23 h');
  for (const mauvais of ['', 'hier', '2026-13-40', null, undefined, '27/11/2026']) assert.strictEqual(fenetreJourHaiti(mauvais), null, String(mauvais));
});

test('Lignes de l\'écran : seuls les patients qui ont fait une transaction (dans la fenêtre) ; état et dates ; tri par dernière transaction', () => {
  const dossiers = [{ id: 'd1', nom: 'Marie Joseph', numero_dossier: '120' }, { id: 'd2', nom: 'Jean Pierre', numero_dossier: '121' }, { id: 'd3', nom: 'Sans paiement', numero_dossier: '122' }];
  const episodes = [{ id: 'e1', dossier_id: 'd1' }, { id: 'e2', dossier_id: 'd2' }, { id: 'e3', dossier_id: 'd3' }];
  const fiches = [{ id: 'f1', breakdown: { med: 300 } }, { id: 'f2', breakdown: { labo: 900 } }];
  const paiements = [
    { id: 'p1', numero_paiement: 516, episode_id: 'e1', fiche_id: 'f1', mode: 'cash', date_paiement: '2026-11-28T15:30:00Z' },
    { id: 'p2', numero_paiement: 515, episode_id: 'e2', fiche_id: 'f2', mode: 'cash', date_paiement: '2026-11-28T16:00:00Z' },
    { id: 'p3', numero_paiement: 400, episode_id: 'e3', fiche_id: 'f2', mode: 'cash', date_paiement: '2026-11-20T10:00:00Z' },
    { id: 'p4', numero_paiement: 401, episode_id: 'e2', fiche_id: 'f2', mode: 'cash', date_paiement: '2026-11-28T17:00:00Z', annule: true },
  ];
  const mouvements = [{ id: 'm1', dossier_id: 'd1', type: 'entree', date: '2026-11-28T14:00:00Z', par: 'archive@chf.com' }, { id: 'm2', dossier_id: 'd2', type: 'entree', date: '2026-11-28T14:30:00Z', par: 'archive@chf.com' }];
  const fenetre = fenetreJourHaiti('2026-11-28');
  const l = construireSuivi({ dossiers, episodes, paiements, fiches, mouvements, fenetre });
  assert.deepStrictEqual(l.map(x => x.dossier_id), ['d2', 'd1'], 'd3 : aucune transaction ce jour-là ; tri : dernière transaction d\'abord');
  assert.strictEqual(l[1].etat, 'sorti'); assert.strictEqual(l[1].sortie.origine, 'automatique'); assert.strictEqual(l[1].sortie.numero_paiement, 516);
  assert.strictEqual(l[0].etat, 'dans_archive', 'Jean Pierre n\'a pas acheté de médicament : toujours dans l\'archive');
  assert.strictEqual(l[0].nb_transactions, 1, 'le paiement annulé ne compte pas');
  // Sans fenêtre (recherche par nom) : toutes les dates comptent.
  assert.deepStrictEqual(construireSuivi({ dossiers, episodes, paiements, fiches, mouvements }).map(x => x.dossier_id).sort(), ['d1', 'd2', 'd3']);
});
