// tests/supprimer_credit.test.js — 24/11 (Esdras) : « permets à l'administrateur de supprimer un crédit, sans entrer de fonds dans la caisse ».
const { test } = require('node:test');
const assert = require('node:assert');
const { creerFauxSupabase } = require('./aides/fauxSupabase');

const E = '11111111-1111-4111-8111-111111111111', E2 = '22222222-2222-4222-8222-222222222222';
function monter({ role = 'administrateur', active = true, paiements } = {}) {
  const routes = {};
  const app = new Proxy({}, { get: (_, m) => (chemin, ...h) => { routes[`${String(m).toUpperCase()} ${chemin}`] = h[h.length - 1]; } });
  const audits = [];
  const supabase = creerFauxSupabase({
    users: [{ id: 'moi', role, active }],
    dossiers: [{ id: 'd1', nom: 'Marie Test' }],
    episodes: [{ id: E, dossier_id: 'd1', type_consultation: 'Crédit antérieur', supprime_le: null }, { id: E2, dossier_id: 'd1', type_consultation: null, supprime_le: null }],
    paiements: paiements || [{ id: 'p1', episode_id: E, mode: 'credit', montant: 0, solde_restant: 12500, annule: false, numero_paiement: 5 },
      { id: 'p9', episode_id: E2, mode: 'credit', montant: 0, solde_restant: 800, annule: false, numero_paiement: 6 }],
  });
  require('../routes/caisse.js')(app, { aPermission: async () => true, calculerSoldeDepot: () => ({}), enregistrerAuditServeur: async (_, a, d) => { audits.push({ a, d }); }, estUnVraiUuid: (x) => /^[0-9a-f-]{36}$/.test(String(x || '')), lireToutesLesPages: async () => [], supabase, synchroListes: {} });
  const appeler = async (id, corps) => { let statut = 200; let json; const res = { status(s) { statut = s; return this; }, json(j) { json = j; return this; } }; await routes['POST /api/credits-anterieurs/:id/supprimer']({ params: { id }, body: corps, user: { id: 'moi', email: 'moi@chf.com' } }, res); return { statut, json }; };
  return { appeler, audits, tables: supabase.tables };
}

test('l\'administrateur supprime un crédit existant : son paiement à crédit est annulé (trace gardée), l\'épisode part à la corbeille, AUCUN paiement créé, audit', async () => {
  const m = monter();
  const avant = m.tables.paiements.length;
  const r = await m.appeler(E, { motif: 'Déjà payé avant le système' });
  assert.strictEqual(r.statut, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.montant_supprime, 12500);
  const p = m.tables.paiements.find(x => x.id === 'p1');
  assert.strictEqual(p.annule, true); assert.match(p.motif_annulation, /Crédit supprimé — Déjà payé avant le système/); assert.strictEqual(p.annule_par_uid, 'moi');
  assert.strictEqual(m.tables.paiements.length, avant, 'aucune nouvelle ligne : pas un gourde dans la caisse');
  assert.ok(m.tables.episodes.find(e => e.id === E).supprime_le, 'épisode à la corbeille');
  const a = m.audits.find(x => x.a === 'credit_anterieur_supprime');
  assert.ok(a); assert.strictEqual(a.d.montant, 12500); assert.strictEqual(a.d.patient, 'Marie Test'); assert.strictEqual(a.d.motif, 'Déjà payé avant le système');
});

test('réservé à l\'administrateur (403 pour direction, comptable… et pour un administrateur désactivé) ; rien n\'est modifié', async () => {
  for (const [role, active] of [['direction', true], ['comptable', true], ['administrateur', false]]) {
    const m = monter({ role, active });
    assert.strictEqual((await m.appeler(E, { motif: 'Déjà payé avant le système' })).statut, 403, `${role}/${active}`);
    assert.strictEqual(m.tables.paiements.find(x => x.id === 'p1').annule, false);
  }
});

test('refus : motif trop court (400), épisode invalide/inconnu, dette de soins (pas un crédit existant), déjà supprimé', async () => {
  const m = monter();
  assert.strictEqual((await m.appeler(E, { motif: 'ok' })).json.code, 'MOTIF_REQUIS');
  assert.strictEqual((await m.appeler('pas-un-uuid', { motif: 'Déjà payé avant le système' })).json.code, 'EPISODE_INVALIDE');
  assert.strictEqual((await m.appeler('33333333-3333-4333-8333-333333333333', { motif: 'Déjà payé avant le système' })).statut, 404);
  const soins = await m.appeler(E2, { motif: 'Déjà payé avant le système' });
  assert.strictEqual(soins.json.code, 'PAS_UN_CREDIT_ANTERIEUR');
  assert.strictEqual(m.tables.paiements.find(x => x.id === 'p9').annule, false, 'la dette de soins n\'est jamais touchée');
  assert.strictEqual((await m.appeler(E, { motif: 'Déjà payé avant le système' })).statut, 200);
  assert.strictEqual((await m.appeler(E, { motif: 'Déjà payé avant le système' })).json.code, 'DEJA_SUPPRIME');
});

test('un versement déjà enregistré sur ce crédit (argent dans la caisse) bloque la suppression : il faut l\'annuler d\'abord', async () => {
  const m = monter({ paiements: [
    { id: 'p1', episode_id: E, mode: 'credit', montant: 0, solde_restant: 12500, annule: false, numero_paiement: 5 },
    { id: 'p2', episode_id: E, mode: 'remboursement_credit', montant: 2500, solde_restant: 10000, annule: false, numero_paiement: 6 }] });
  const r = await m.appeler(E, { motif: 'Déjà payé avant le système' });
  assert.strictEqual(r.statut, 409); assert.strictEqual(r.json.code, 'VERSEMENT_EXISTANT'); assert.match(r.json.error, /n° 6/);
  assert.ok(m.tables.paiements.every(x => x.annule === false));
});
