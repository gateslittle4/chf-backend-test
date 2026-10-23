// tests/qualite_donnees.test.js — contrôles de « Qualité des données » (14/10).
const { test } = require('node:test');
const assert = require('node:assert');
const { controlerQualite, MAX_EXEMPLES } = require('../utils/qualiteDonnees');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const il_y_a = (j) => new Date(NOW - j * 86400000).toISOString();
const d = (id, nom, extra = {}) => ({ id, numero_dossier: `N-${id}`, nom, nom_origine: nom, date_naissance: '1990-01-01', telephone: '34567890', sexe: 'F', ...extra });
const e = (id, dossier_id, extra = {}) => ({ id, dossier_id, statut: 'ouvert', est_hospitalisation: false, voie_entree: 'consultation', date_ouverture: il_y_a(0), type_patient: 'prive', ...extra });
const ctrl = (r, cle) => r.controles.find(c => c.cle === cle);

test('Dossiers sans date de naissance / sexe / téléphone : comptés, les dossiers « test » et fusionnés ignorés', () => {
  const r = controlerQualite({ maintenantMs: NOW, episodes: [], dossiers: [
    d('1', 'Marie Joseph', { date_naissance: null }), d('2', 'Paul Louis', { sexe: null, telephone: '' }), d('3', 'Jean Baptiste'),
    d('4', 'Test Essai', { date_naissance: null }), d('5', 'Vieux Fusionné', { date_naissance: null, fusionne_dans: '3' }),
  ] });
  assert.deepStrictEqual(ctrl(r, 'sans_naissance').exemples.map(x => x.id), ['1']);
  assert.deepStrictEqual(ctrl(r, 'sans_sexe').exemples.map(x => x.id), ['2']);
  assert.deepStrictEqual(ctrl(r, 'sans_telephone').exemples.map(x => x.id), ['2']);
  assert.strictEqual(r.dossiersAnalyses, 4, 'le dossier fusionné n\'est pas analysé');
});
test('Noms à vérifier : trop courts, avec chiffres, un seul mot ; « Bébé X » n\'est pas suspect', () => {
  const r = controlerQualite({ maintenantMs: NOW, episodes: [], dossiers: [d('1', 'Al'), d('2', 'Marie2 Joseph'), d('3', 'Marie'), d('4', 'Bébé Marie Joseph', { mere_dossier_id: 'x' }), d('5', 'Marie Joseph')] });
  assert.deepStrictEqual(ctrl(r, 'nom_suspect').exemples.map(x => x.id).sort(), ['1', '2', '3']);
});
test('Nouveau-nés sans mère liée : « Bébé / BB » sans mere_dossier_id', () => {
  const r = controlerQualite({ maintenantMs: NOW, episodes: [], dossiers: [d('1', 'Bébé Marie Joseph'), d('2', 'BB Rose Louis'), d('3', 'Bébé Lié Joseph', { mere_dossier_id: 'm' }), d('4', 'Bébéma Joseph')] });
  assert.deepStrictEqual(ctrl(r, 'bebe_sans_mere').exemples.map(x => x.id).sort(), ['1', '2']);
});
test('Épisodes : consultation ouverte trop longtemps, hospitalisation très longue, sortie sans motif, partenaire sans nom', () => {
  const dossiers = [d('1', 'Marie Joseph'), d('2', 'Paul Louis'), d('3', 'Rose Marie'), d('4', 'Jean Pierre')];
  const episodes = [
    e('e1', '1', { date_ouverture: il_y_a(5) }), e('e2', '1', { date_ouverture: il_y_a(1) }), e('e3', '2', { voie_entree: 'vente_comptoir', date_ouverture: il_y_a(9) }),
    e('e4', '2', { est_hospitalisation: true, date_ouverture: il_y_a(45), service: 'Maternité' }), e('e5', '3', { est_hospitalisation: true, date_ouverture: il_y_a(10) }),
    e('e6', '3', { statut: 'ferme', est_hospitalisation: true, motif_fermeture: null }), e('e7', '4', { statut: 'ferme', est_hospitalisation: true, motif_fermeture: 'deces' }),
    e('e8', '4', { type_patient: 'partenaire', ong_partenaire: '  ' }), e('e9', '4', { type_patient: 'partenaire', ong_partenaire: 'Alpha' }), e('e10', '4', { date_ouverture: il_y_a(8), supprime_le: il_y_a(1) }),
  ];
  const r = controlerQualite({ maintenantMs: NOW, dossiers, episodes, seuils: { joursConsultationOuverte: 2 } });
  assert.deepStrictEqual(ctrl(r, 'consultation_ouverte').exemples.map(x => [x.id, x.jours]), [['e1', 5]]);
  assert.deepStrictEqual(ctrl(r, 'hospitalisation_longue').exemples.map(x => [x.id, x.jours, x.service]), [['e4', 45, 'Maternité']]);
  assert.deepStrictEqual(ctrl(r, 'sortie_sans_motif').exemples.map(x => x.id), ['e6']);
  assert.deepStrictEqual(ctrl(r, 'partenaire_sans_nom').exemples.map(x => x.id), ['e8']);
  assert.strictEqual(ctrl(r, 'sortie_sans_motif').exemples[0].nom, 'Rose Marie', 'chaque exemple porte le nom du patient');
});
test('Tri : les contrôles qui ont des cas d\'abord (gravité haute avant moyenne), exemples plafonnés, total cohérent', () => {
  const dossiers = Array.from({ length: 80 }, (_, i) => d(String(i), `Prénom Nom${String.fromCharCode(97 + (i % 26))}`, { date_naissance: null }));
  const r = controlerQualite({ maintenantMs: NOW, dossiers, episodes: [e('x', '1', { type_patient: 'partenaire', ong_partenaire: null })] });
  assert.strictEqual(r.controles[0].cle, 'partenaire_sans_nom', 'gravité haute en premier');
  const sans = ctrl(r, 'sans_naissance');
  assert.strictEqual(sans.nombre, 80);
  assert.strictEqual(sans.exemples.length, MAX_EXEMPLES);
  assert.strictEqual(r.total, r.controles.reduce((s, c) => s + c.nombre, 0));
  assert.ok(r.controles.slice(-3).every(c => c.nombre === 0 || c.gravite !== 'haute'));
});
test('Rien à signaler : tout à zéro', () => {
  const r = controlerQualite({ maintenantMs: NOW, dossiers: [d('1', 'Marie Joseph')], episodes: [e('e1', '1')] });
  assert.strictEqual(r.total, 0);
});

test('contrôles paiements et fermeture : pas de faux positifs (dépôt, remboursement de crédit, annulé, couvert par dépôt/exonération)', () => {
  const dossiers = [{ id: 'd1', numero_dossier: '1', nom: 'Jean Pierre' }];
  const episodes = [
    { id: 'e1', dossier_id: 'd1', statut: 'ferme', date_fermeture: null, voie_entree: 'vente_comptoir' },
    { id: 'e2', dossier_id: 'd1', statut: 'ferme', date_fermeture: '2026-10-01T10:00:00Z' },
  ];
  const paiements = [
    { id: 'p1', episode_id: 'e1', fiche_id: null, mode: 'cash', montant: 100 },
    { id: 'p2', episode_id: 'e2', fiche_id: null, mode: 'depot', montant: 50 },
    { id: 'p3', episode_id: 'e2', fiche_id: null, mode: 'remboursement_credit', montant: 20 },
    { id: 'p4', episode_id: 'e2', fiche_id: null, mode: 'cash', montant: 30, annule: true },
    { id: 'p5', episode_id: 'e2', fiche_id: 'f1', mode: 'cash', montant: 0, details: { montant_depot_utilise: 4425 } },
    { id: 'p6', episode_id: 'e2', fiche_id: 'f1', mode: 'cash', montant: 0, exoneration: { motif: 'x' } },
    { id: 'p7', episode_id: 'e2', fiche_id: 'f1', mode: 'cash', montant: 0 },
  ];
  const r = controlerQualite({ dossiers, episodes, paiements, maintenantMs: Date.now() });
  const c = (cle) => r.controles.find(x => x.cle === cle);
  assert.equal(c('ferme_sans_date').nombre, 1);
  assert.deepEqual(c('paiement_sans_fiche').exemples.map(x => x.id), ['p1']);
  assert.deepEqual(c('paiement_zero').exemples.map(x => x.id), ['p7']);
  assert.equal(r.controles.some(x => x.cle === 'fiche_sans_paiement'), false);
});

test('POST /api/episodes écrit date_fermeture pour un épisode créé déjà clôturé (Achat Express)', () => {
  const src = require('./serveurSource').lireServeur();
  assert.match(src, /\.\.\.\(d\.status === 'archived' \? \{ date_fermeture: new Date\(\)\.toISOString\(\) \} : \{\}\)/);
});

test('consultation ouverte : seuil par défaut 30 jours (fermeture automatique à 1 mois) ; plusieurs épisodes ouverts pour un patient : signalé (hors vente comptoir, hors fermés/supprimés)', () => {
  const dossiers = [d('1', 'Marie Joseph'), d('2', 'Paul Louis')];
  const episodes = [
    e('a', '1', { date_ouverture: il_y_a(5) }), e('b', '1', { est_hospitalisation: true, date_ouverture: il_y_a(2) }),
    e('c', '2', { date_ouverture: il_y_a(40) }), e('d', '2', { voie_entree: 'vente_comptoir' }), e('f', '2', { statut: 'ferme' }),
  ];
  const r = controlerQualite({ maintenantMs: NOW, dossiers, episodes });
  assert.deepStrictEqual(ctrl(r, 'consultation_ouverte').exemples.map(x => x.id), ['c'], 'seuil 30 jours par défaut');
  assert.deepStrictEqual(ctrl(r, 'episodes_ouverts_multiples').exemples.map(x => [x.id, x.nombre]), [['1', 2]]);
});
