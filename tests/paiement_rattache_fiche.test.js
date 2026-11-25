// tests/paiement_rattache_fiche.test.js — 25/11 (Esdras) : « il y a encore des non répartis dans l'entrée de fonds ». Un paiement Achat Express envoyé sans fiche_id (hors ligne) est maintenant rattaché à sa fiche.
const { test } = require('node:test');
const assert = require('node:assert');
const { creerFauxSupabase } = require('./aides/fauxSupabase');

const EP = '11111111-1111-4111-8111-111111111111', FI = '22222222-2222-4222-8222-222222222222', FI_SUPPR = '33333333-3333-4333-8333-333333333333';
function monter({ fiches } = {}) {
  const handlers = {};
  const app = new Proxy({}, { get: (_, m) => (chemin, ...h) => { handlers[`${String(m).toUpperCase()} ${typeof chemin === 'string' ? chemin : ''}`] = h[h.length - 1]; } });
  const supabase = creerFauxSupabase({
    episodes: [{ id: EP, local_id: 'local-777' }], fiches: fiches || [{ id: FI, episode_id: EP, total_global: 1000, supprime_le: null, local_id: 'local-777-fiche' }], paiements: [],
  });
  require('../routes/caisse.js')(app, { aPermission: async () => true, calculerSoldeDepot: () => ({ soldeDepot: 0 }), enregistrerAuditServeur: async () => {}, estUnVraiUuid: (x) => /^[0-9a-f-]{36}$/.test(String(x || '')), lireToutesLesPages: async () => [], supabase, synchroListes: {} });
  const verifier = async (corps) => {
    const req = { method: 'POST', path: '/', body: corps, headers: {}, user: { id: 'u1' } };
    let reponse = null; let passe = false;
    const res = { status(c) { this.code = c; return this; }, json(b) { reponse = { code: this.code, corps: b }; return this; } };
    await handlers['USE /api/paiements'](req, res, () => { passe = true; });
    return { passe, reponse, corps: req.body };
  };
  return { verifier };
}

test('Achat Express hors ligne : un paiement sans fiche_id est rattaché à la fiche unique de son épisode (identifiant local « …-paiement »)', async () => {
  const m = monter();
  const r = await m.verifier({ mode: 'cash', montant: 1000, episode_id: EP, local_id: 'local-777-paiement' });
  assert.ok(r.passe, JSON.stringify(r.reponse));
  assert.strictEqual(r.corps.fiche_id, FI, 'fiche_id posé : la caisse pourra l\'attribuer à sa catégorie');
});

test('un fiche_id déjà fourni n\'est jamais remplacé ; une fiche supprimée n\'est jamais rattachée', async () => {
  const m = monter();
  const r = await m.verifier({ mode: 'cash', montant: 1000, episode_id: EP, fiche_id: FI, local_id: 'local-777-paiement' });
  assert.strictEqual(r.corps.fiche_id, FI);
  const supprimee = monter({ fiches: [{ id: FI_SUPPR, episode_id: EP, total_global: 1000, supprime_le: '2026-11-24T00:00:00Z', local_id: 'local-777-fiche' }] });
  const r2 = await supprimee.verifier({ mode: 'cash', montant: 1000, episode_id: EP, local_id: 'local-777-paiement' });
  assert.notStrictEqual(r2.corps.fiche_id, FI_SUPPR);
});

test('un paiement qui ne vise aucune fiche connue (ex. dépôt) reste sans fiche_id', async () => {
  const m = monter();
  const r = await m.verifier({ mode: 'depot', montant: 500, episode_id: EP, local_id: 'local-dep' });
  assert.ok(r.passe);
  assert.strictEqual(r.corps.fiche_id, undefined);
});
