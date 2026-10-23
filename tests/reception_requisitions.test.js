// tests/reception_requisitions.test.js — réception de médicaments (achat / don + exonération 50 %) et réquisitions annulables / modifiables (20/10, Esdras). Routes extraites de server.js, base simulée.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = require('./serveurSource').lireServeur();
const debut = source.indexOf('const SOURCES_RECEPTION');
const fin = source.indexOf('// Ajoute du stock à UN médicament de façon atomique', debut);
assert.ok(debut > 0 && fin > debut, 'routes introuvables dans server.js');
const code = source.slice(debut, fin);

function monter({ droits = ['stock_reception', 'requisition_modifier'], stock = { m1: 10, m2: 5 }, requisitions = [] } = {}) {
  const routes = {}; const audit = []; const receptions = []; const appliques = new Set();
  const items = Object.entries(stock).map(([id, quantite]) => ({ id, nom: 'Médicament ' + id, quantite }));
  const app = { get: (c, f) => { routes['GET ' + c] = f; }, post: (c, f) => { routes['POST ' + c] = f; }, patch: (c, f) => { routes['PATCH ' + c] = f; }, put: (c, f) => { routes['PUT ' + c] = f; } };
  const supabase = {
    rpc: async (nom, a) => {
      if (nom === 'ajouter_stock_medicament') {
        if (a.p_local_id && appliques.has(a.p_local_id)) return { data: { deja_applique: true, item: items.find(i => i.id === a.p_id) }, error: null };
        const it = items.find(i => i.id === a.p_id); if (!it) return { data: null, error: { message: 'introuvable' } };
        it.quantite += a.p_quantite_ajoutee; if (a.p_local_id) appliques.add(a.p_local_id); return { data: { ...it }, error: null };
      }
      if (nom === 'decrementer_stock_medicaments') {
        if (a.p_local_id && appliques.has(a.p_local_id)) return { data: { succes: true, deja_applique: true, items }, error: null };
        const manquants = a.p_decrements.filter(d => (items.find(i => i.id === d.id) || { quantite: 0 }).quantite < d.qte).map(d => ({ id: d.id, nom: 'Médicament ' + d.id, disponible: (items.find(i => i.id === d.id) || { quantite: 0 }).quantite }));
        if (manquants.length) return { data: { succes: false, manquants }, error: null };
        a.p_decrements.forEach(d => { items.find(i => i.id === d.id).quantite -= d.qte; }); if (a.p_local_id) appliques.add(a.p_local_id);
        return { data: { succes: true, items }, error: null };
      }
      if (nom === 'marquer_exoneration_50_medicament') { items.find(i => i.id === a.p_id).exoneration50 = a.p_valeur; return { data: {}, error: null }; }
      return { data: null, error: { message: 'rpc inconnue ' + nom } };
    },
    from: (table) => {
      const f = []; let action = 'select'; let corps = null;
      const tableau = table === 'requisitions' ? requisitions : table === 'receptions_medicaments' ? receptions : [];
      const L = () => tableau.filter(r => f.every(g => g(r)));
      const c = {
        select: () => c, eq: (k, v) => { f.push(r => r[k] === v); return c; }, order: () => c,
        insert: (v) => { action = 'insert'; corps = v; return c; }, update: (v) => { action = 'update'; corps = v; return c; },
        maybeSingle: async () => (table === 'catalog' ? { data: { items }, error: null } : { data: L()[0] || null, error: null }),
        then: (resolve) => {
          if (action === 'update') { const l = L(); l.forEach(r => Object.assign(r, corps)); return resolve({ data: l, error: null }); }
          if (action === 'insert') { tableau.push({ id: 'r' + (tableau.length + 1), ...corps }); return resolve({ error: null }); }
          return resolve({ data: L(), error: null });
        },
      };
      return c;
    },
  };
  new Function('app', 'supabase', 'aPermission', 'lireToutesLesPages', 'enregistrerAuditServeur', 'console', code)(
    app, supabase, async (_u, p) => droits.includes(p), async (fn) => (await fn()).data, async (_r, a, d) => { audit.push({ a, d }); }, console);
  const appeler = async (cle, req) => { const res = { code: 200, corps: null, status(x) { this.code = x; return this; }, json(b) { this.corps = b; return this; } }; await routes[cle]({ user: { id: 'u1', email: 'chef@chf.com' }, params: {}, body: {}, ...req }, res); return res; };
  return { appeler, items, receptions, requisitions, audit };
}

test('réception : achat et don, la quantité entre, la trace est gardée, le don porte « exonération 50 % »', async () => {
  const m = monter();
  const r = await m.appeler('POST /api/stock/reception', { body: { local_id: 'L1', lignes: [{ id: 'm1', quantite: 20, source: 'achat' }, { id: 'm2', quantite: 7, source: 'don', exoneration_50: true }] } });
  assert.strictEqual(r.code, 201);
  assert.deepStrictEqual(m.items.map(i => i.quantite), [30, 12]);
  assert.strictEqual(m.items[1].exoneration50, true);
  assert.strictEqual(m.items[0].exoneration50, undefined, 'un achat ne touche pas à la marque');
  assert.deepStrictEqual(m.receptions.map(x => [x.source, x.exoneration_50, x.recu_par]), [['achat', null, 'chef@chf.com'], ['don', true, 'chef@chf.com']]);
  assert.strictEqual(m.audit[0].a, 'reception_medicaments');
});

test('réception : rejeu avec le même identifiant = jamais deux fois ; source et exonération obligatoires ; droit requis', async () => {
  const m = monter();
  const corps = { local_id: 'L2', lignes: [{ id: 'm1', quantite: 3, source: 'achat' }] };
  await m.appeler('POST /api/stock/reception', { body: corps });
  await m.appeler('POST /api/stock/reception', { body: corps });
  assert.strictEqual(m.items[0].quantite, 13); assert.strictEqual(m.receptions.length, 1);
  assert.strictEqual((await m.appeler('POST /api/stock/reception', { body: { lignes: [{ id: 'm1', quantite: 3 }] } })).code, 400, 'source obligatoire');
  assert.strictEqual((await m.appeler('POST /api/stock/reception', { body: { lignes: [{ id: 'm1', quantite: 3, source: 'don' }] } })).code, 400, 'don sans choix 50 %');
  assert.strictEqual((await m.appeler('POST /api/stock/reception', { body: { lignes: [{ id: 'm1', quantite: 0, source: 'achat' }] } })).code, 400);
  assert.strictEqual((await monter({ droits: ['stock_gerer'] }).appeler('POST /api/stock/reception', { body: corps })).code, 403, 'stock_gerer seul ne suffit plus');
});

const requisition = (extra = {}) => ({ id: 'q1', service_demandeur: 'Maternité', lignes: [{ id: 'm1', nom: 'Médicament m1', quantite: 4 }], annulee: false, ...extra });

test('annuler une réquisition : le stock revient une seule fois, motif obligatoire, trace gardée', async () => {
  const m = monter({ stock: { m1: 6 }, requisitions: [requisition()] });
  assert.strictEqual((await m.appeler('PATCH /api/requisitions/:id/annuler', { params: { id: 'q1' }, body: { motif: 'x' } })).code, 400);
  const r = await m.appeler('PATCH /api/requisitions/:id/annuler', { params: { id: 'q1' }, body: { motif: 'Erreur de service' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(m.items[0].quantite, 10); assert.strictEqual(m.requisitions[0].annulee, true);
  assert.strictEqual((await m.appeler('PATCH /api/requisitions/:id/annuler', { params: { id: 'q1' }, body: { motif: 'Erreur de service' } })).code, 400, 'déjà annulée');
  assert.strictEqual(m.items[0].quantite, 10, 'pas de second retour de stock');
  assert.strictEqual(m.audit.at(-1).a, 'requisition_annulee');
  assert.strictEqual((await monter({ droits: ['stock_gerer'], requisitions: [requisition()] }).appeler('PATCH /api/requisitions/:id/annuler', { params: { id: 'q1' }, body: { motif: 'Erreur de service' } })).code, 403);
});

test('modifier une réquisition : le stock suit la différence ; refusé (rien ne bouge) si le stock manque', async () => {
  const m = monter({ stock: { m1: 6, m2: 5 }, requisitions: [requisition()] });
  // 4 → 7 de m1 (+3 à sortir) et ajout de 2 de m2
  const ok = await m.appeler('PUT /api/requisitions/:id', { params: { id: 'q1' }, body: { local_id: 'M1', service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 7 }, { id: 'm2', qte: 2 }] } });
  assert.strictEqual(ok.code, 200);
  assert.deepStrictEqual(m.items.map(i => i.quantite), [3, 3]);
  assert.strictEqual(m.requisitions[0].service_demandeur, 'Pédiatrie');
  assert.deepStrictEqual(m.requisitions[0].lignes.map(l => [l.id, l.quantite]), [['m1', 7], ['m2', 2]]);
  // réduire m1 de 7 à 1 : 6 reviennent
  await m.appeler('PUT /api/requisitions/:id', { params: { id: 'q1' }, body: { local_id: 'M2', service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 1 }] } });
  assert.deepStrictEqual(m.items.map(i => i.quantite), [9, 5], 'm1 : 3 + 6 ; m2 : 3 + 2');
  // trop demander : 409, stock inchangé
  const refus = await m.appeler('PUT /api/requisitions/:id', { params: { id: 'q1' }, body: { local_id: 'M3', service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 50 }] } });
  assert.strictEqual(refus.code, 409); assert.match(refus.corps.error, /Stock insuffisant/);
  assert.deepStrictEqual(m.items.map(i => i.quantite), [9, 5]);
  assert.strictEqual(m.requisitions[0].lignes[0].quantite, 1);
});

test('une réquisition annulée ne se modifie plus', async () => {
  const m = monter({ requisitions: [requisition({ annulee: true })] });
  assert.strictEqual((await m.appeler('PUT /api/requisitions/:id', { params: { id: 'q1' }, body: { service_demandeur: 'X', lignes: [{ id: 'm1', qte: 1 }] } })).code, 400);
});

test('le script SQL est additif et les droits par défaut existent', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'reception_medicaments.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.doesNotMatch(sql, /DROP |DELETE |TRUNCATE/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.receptions_medicaments/);
  assert.match(source, /'pharmacien_chef', permissions: \[[^\]]*'stock_reception'[^\]]*'requisition_modifier'/);
});
