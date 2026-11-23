// tests/retirer_don.test.js — 23/11 (Esdras) : « ajoute le bouton Supprimer et la quantité à supprimer » dans le stock donné par un partenaire.
const { test } = require('node:test');
const assert = require('node:assert');
const { avecStockIllimite, estUnMouvementDeStock } = require('../utils/stockIllimite');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'stock.js'), 'utf8');
const bloc = src.slice(src.indexOf("app.post('/api/stock/retirer-don'"), src.indexOf("app.patch('/api/stock/:id'"));

test('la route exige stock_gerer, une quantité positive, et passe par la fonction atomique du stock donné', () => {
  assert.match(bloc, /aPermission\(req\.user\.id, 'stock_gerer'\)/);
  assert.match(bloc, /typeof quantite !== 'number' \|\| !\(quantite > 0\)/);
  assert.match(bloc, /supabase\.rpc\('decrementer_stock_dons', \{ p_decrements: \[\{ id, ong, qte: quantite \}\], p_local_id: local_id \}\)/);
  assert.match(bloc, /status\(409\)/, 'stock donné insuffisant refusé');
  assert.match(bloc, /enregistrerAuditServeur\(req, 'suppression_stock_don'/, 'tracé dans le journal d\'audit');
});

test('l\'identifiant du retrait porte toujours la marque -retrait-don (rejeu sûr, et jamais avalé par « Stock illimité »)', () => {
  assert.match(bloc, /-retrait-don/);
  assert.ok(!estUnMouvementDeStock('decrementer_stock_dons', { p_local_id: 'abc-retrait-don' }), 'un retrait voulu n\'est pas un mouvement de vente');
  assert.ok(estUnMouvementDeStock('decrementer_stock_dons', { p_local_id: 'abc' }), 'une vente de stock donné reste un mouvement');
});

test('« Stock illimité » actif : la vente de stock donné est ignorée, mais le retrait voulu atteint la base', async () => {
  const appels = [];
  const supabase = {
    rpc: async (nom, params) => { appels.push({ nom, params }); return { data: { succes: true, items: [] }, error: null }; },
    from: () => ({ select: () => ({ eq: (_c, type) => ({ maybeSingle: async () => ({ data: { items: type === 'parametres' ? { stockIllimite: true } : [] }, error: null }) }) }) }),
  };
  const s = avecStockIllimite(supabase);
  await s.rpc('decrementer_stock_dons', { p_decrements: [], p_local_id: 'vente-1' });
  assert.strictEqual(appels.length, 0, 'la vente ne touche pas la base');
  await s.rpc('decrementer_stock_dons', { p_decrements: [], p_local_id: 'x-retrait-don' });
  assert.strictEqual(appels.length, 1, 'le retrait voulu atteint la base');
});
