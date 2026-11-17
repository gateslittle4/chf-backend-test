// 17/11 (Esdras) : « met tous les stocks de façon infinie pour l'instant » — réglage « Stock illimité ».
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { avecStockIllimite, estUnMouvementDeStock } = require('../utils/stockIllimite');
const { stockIllimiteActif } = require('../utils/reglagesDirection');

function baseSimulee(parametres) {
  const appels = [];
  const items = [{ id: 'm1', nom: 'Paracétamol', quantite: 0 }];
  const supabase = {
    rpc: async (nom, params) => { appels.push({ nom, params }); return { data: { succes: false, manquants: [{ id: 'm1', nom: 'Paracétamol', disponible: 0 }] }, error: null }; },
    from: (table) => ({ select: () => ({ eq: (_c, type) => ({ maybeSingle: async () => ({ data: { items: type === 'parametres' ? parametres : items }, error: null }) }) }) }),
    auth: { nom: 'auth' },
  };
  return { supabase, appels, items };
}

test('le réglage est inactif par défaut et seulement actif sur true', () => {
  assert.strictEqual(stockIllimiteActif({}), false);
  assert.strictEqual(stockIllimiteActif(null), false);
  assert.strictEqual(stockIllimiteActif({ stockIllimite: 'true' }), false);
  assert.strictEqual(stockIllimiteActif({ stockIllimite: false }), false);
  assert.strictEqual(stockIllimiteActif({ stockIllimite: true }), true);
});

test('réglage coupé : la base reçoit l\'appel tel quel (le stock insuffisant reste refusé)', async () => {
  const { supabase, appels } = baseSimulee({ stockIllimite: false });
  const r = await avecStockIllimite(supabase).rpc('decrementer_stock_medicaments', { p_decrements: [{ id: 'm1', qte: 5 }], p_local_id: 'L1' });
  assert.strictEqual(appels.length, 1);
  assert.strictEqual(r.data.succes, false);
});

test('réglage actif : vente, don, restitution, réquisition passent sans appeler la base et renvoient le catalogue actuel', async () => {
  const { supabase, appels, items } = baseSimulee({ stockIllimite: true });
  const s = avecStockIllimite(supabase);
  for (const nom of ['decrementer_stock_medicaments', 'decrementer_stock_service', 'decrementer_stock_dons', 'restituer_stock_ventes', 'transferer_stock_service']) {
    const r = await s.rpc(nom, { p_local_id: 'L' });
    assert.strictEqual(r.error, null, nom);
    assert.strictEqual(r.data.succes, true, nom);
    assert.strictEqual(r.data.stock_illimite, true);
    assert.deepStrictEqual(r.data.items, items, nom);
  }
  assert.strictEqual(appels.length, 0, 'aucune quantité réelle ne bouge');
});

test('réglage actif : les vraies entrées de stock (réception, ajout, don, correction manuelle) continuent de s\'appliquer', async () => {
  const { supabase, appels } = baseSimulee({ stockIllimite: true });
  const s = avecStockIllimite(supabase);
  await s.rpc('ajouter_stock_medicament', { p_id: 'm1', p_quantite_ajoutee: 20, p_local_id: 'RECEP-1-stock' });
  await s.rpc('ajouter_stock_medicament', { p_id: 'm1', p_quantite_ajoutee: 5, p_local_id: 'local-123' });
  await s.rpc('ajouter_stock_don_medicament', { p_id: 'm1', p_ong: 'MSF', p_quantite_ajoutee: 5, p_local_id: 'x' });
  await s.rpc('definir_stock_medicament', { p_id: 'm1', p_quantite: 9, p_seuil_alerte: 2 });
  assert.deepStrictEqual(appels.map(a => a.nom), ['ajouter_stock_medicament', 'ajouter_stock_medicament', 'ajouter_stock_don_medicament', 'definir_stock_medicament']);
});

test('réglage actif : annuler ou modifier une réquisition sans stock de service ne remet rien en pharmacie', async () => {
  const { supabase, appels } = baseSimulee({ stockIllimite: true });
  const s = avecStockIllimite(supabase);
  const r1 = await s.rpc('ajouter_stock_medicament', { p_id: 'm1', p_quantite_ajoutee: 4, p_local_id: 'q1-annulation-m1' });
  const r2 = await s.rpc('ajouter_stock_medicament', { p_id: 'm1', p_quantite_ajoutee: 3, p_local_id: 'q1-modif-abc-m1' });
  assert.strictEqual(r1.data.succes, true); assert.strictEqual(r2.data.succes, true);
  assert.strictEqual(appels.length, 0);
  assert.strictEqual(estUnMouvementDeStock('ajouter_stock_medicament', { p_local_id: 'RECEP-1-stock' }), false);
});

test('les autres propriétés du client (from, auth) restent utilisables', () => {
  const { supabase } = baseSimulee({});
  const s = avecStockIllimite(supabase);
  assert.deepStrictEqual(s.auth, { nom: 'auth' });
  assert.strictEqual(typeof s.from, 'function');
});

test('routes/stock.js enveloppe son client de base avec le réglage, sur une ligne « @enveloppe » (les routes gardent leur texte)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'stock.js'), 'utf8');
  assert.match(src, /^supabase = avecStockIllimite\(supabase\); \/\/ @enveloppe$/m);
  assert.match(src, /const \{ avecStockIllimite \} = require\('\.\.\/utils\/stockIllimite'\);/);
});
