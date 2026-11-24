// tests/admin_annule_ses_operations.test.js — 24/11 (Esdras) : « permets à l'administrateur de supprimer n'importe ce qu'il a fait lui-même ».
// La règle « on n'annule pas sa propre opération » (anti-fraude : encaisser en cash puis annuler pour empocher) reste pour tous les autres rôles, direction comprise.
// Les VRAIES routes (routes/caisse.js) contre un faux Supabase en mémoire.
const { test } = require('node:test');
const assert = require('node:assert');
const { creerFauxSupabase } = require('./aides/fauxSupabase');

function monter({ role, active = true, droits = ['paiement_annuler'] } = {}) {
  const routes = {};
  const app = new Proxy({}, { get: (_, m) => (chemin, ...h) => { routes[`${String(m).toUpperCase()} ${chemin}`] = h[h.length - 1]; } });
  const audits = [];
  const supabase = creerFauxSupabase({
    users: [{ id: 'moi', role, active }],
    paiements: [
      { id: 'p-moi', traite_par_uid: 'moi', annule: false, montant: 500, mode: 'cash', numero_paiement: 7 },
      { id: 'p-autre', traite_par_uid: 'autre', annule: false, montant: 300, mode: 'cash', numero_paiement: 8 },
      { id: 'p-sans', traite_par_uid: null, annule: false, montant: 100, mode: 'exoneration', numero_paiement: 9 },
    ],
    autres_revenus: [
      { id: 'r-moi', caissier_uid: 'moi', annule: false, montant: 200, motif: 'Certificat' },
      { id: 'r-autre', caissier_uid: 'autre', annule: false, montant: 400, motif: 'Location' },
    ],
  });
  require('../routes/caisse.js')(app, { aPermission: async (_, d) => droits.includes(d), calculerSoldeDepot: () => ({}), enregistrerAuditServeur: async (_, a, d) => { audits.push({ a, d }); }, estUnVraiUuid: () => true, lireToutesLesPages: async () => [], supabase, synchroListes: {} });
  const appeler = async (cle, id, corps) => { let statut = 200; let json; const res = { status(s) { statut = s; return this; }, json(j) { json = j; return this; } }; await routes[cle]({ params: { id }, body: corps, user: { id: 'moi', email: 'moi@chf.com' } }, res); return { statut, json }; };
  return { appeler, audits, tables: supabase.tables };
}
const ANNULER_PAIEMENT = 'PATCH /api/paiements/:id/annuler';
const ANNULER_REVENU = 'PATCH /api/autres-revenus/:id/annuler';

test('administrateur : peut annuler le paiement qu\'il a lui-même encaissé (motif obligatoire) ; ligne d\'audit dédiée', async () => {
  const m = monter({ role: 'administrateur' });
  assert.strictEqual((await m.appeler(ANNULER_PAIEMENT, 'p-moi', {})).statut, 400, 'le motif reste obligatoire');
  const r = await m.appeler(ANNULER_PAIEMENT, 'p-moi', { motif: 'Erreur de saisie' });
  assert.strictEqual(r.statut, 200, JSON.stringify(r.json));
  assert.strictEqual(m.tables.paiements.find(p => p.id === 'p-moi').annule, true);
  const a = m.audits.find(x => x.a === 'paiement_annule_par_son_auteur_administrateur');
  assert.ok(a, 'audit dédié'); assert.strictEqual(a.d.montant, 500); assert.strictEqual(a.d.motif, 'Erreur de saisie');
});

test('administrateur : peut annuler l\'autre revenu qu\'il a lui-même enregistré ; audit marqué', async () => {
  const m = monter({ role: 'administrateur' });
  assert.strictEqual((await m.appeler(ANNULER_REVENU, 'r-moi', { motif: 'x' })).statut, 400, 'motif de 5 caractères au moins');
  const r = await m.appeler(ANNULER_REVENU, 'r-moi', { motif: 'Erreur de saisie' });
  assert.strictEqual(r.statut, 200, JSON.stringify(r.json));
  assert.strictEqual(m.tables.autres_revenus.find(x => x.id === 'r-moi').annule, true);
  assert.strictEqual(m.audits.find(x => x.a === 'autre_revenu_annule').d.par_son_auteur_administrateur, true);
});

test('direction, comptable ou tout autre rôle : la règle reste — on n\'annule PAS sa propre opération (403), rien n\'est modifié', async () => {
  for (const role of ['direction', 'comptable', 'pharmacien', 'auditeur']) {
    const m = monter({ role });
    assert.strictEqual((await m.appeler(ANNULER_PAIEMENT, 'p-moi', { motif: 'Erreur de saisie' })).statut, 403, `${role} : paiement`);
    assert.strictEqual((await m.appeler(ANNULER_REVENU, 'r-moi', { motif: 'Erreur de saisie' })).statut, 403, `${role} : revenu`);
    assert.strictEqual(m.tables.paiements.find(p => p.id === 'p-moi').annule, false);
    assert.strictEqual(m.tables.autres_revenus.find(x => x.id === 'r-moi').annule, false);
  }
});

test('un administrateur DÉSACTIVÉ n\'a pas ce droit ; sans le droit paiement_annuler, personne ne peut', async () => {
  const desactive = monter({ role: 'administrateur', active: false });
  assert.strictEqual((await desactive.appeler(ANNULER_PAIEMENT, 'p-moi', { motif: 'Erreur de saisie' })).statut, 403);
  const sans = monter({ role: 'administrateur', droits: [] });
  assert.strictEqual((await sans.appeler(ANNULER_PAIEMENT, 'p-moi', { motif: 'Erreur de saisie' })).statut, 403);
  assert.strictEqual((await sans.appeler(ANNULER_REVENU, 'r-moi', { motif: 'Erreur de saisie' })).statut, 403);
});

test('rien ne change pour les opérations des AUTRES (tout rôle autorisé) : annulation normale, sans ligne « par son auteur »', async () => {
  const m = monter({ role: 'direction' });
  assert.strictEqual((await m.appeler(ANNULER_PAIEMENT, 'p-autre', { motif: 'Erreur de saisie' })).statut, 200);
  assert.strictEqual((await m.appeler(ANNULER_REVENU, 'r-autre', { motif: 'Erreur de saisie' })).statut, 200);
  assert.strictEqual((await m.appeler(ANNULER_PAIEMENT, 'p-sans', { motif: 'Erreur de saisie' })).statut, 200, 'sans traite_par_uid : comme avant');
  assert.ok(!m.audits.some(x => x.a === 'paiement_annule_par_son_auteur_administrateur'));
});
