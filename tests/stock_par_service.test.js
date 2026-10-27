// tests/stock_par_service.test.js — stock PAR SERVICE (22/10, Esdras : « quand un service fait une réquisition, le stock devient à lui ; tout épisode créé dans ce service
// puise dans ce stock quand on achète des médicaments »). Les VRAIES routes de server.js tournent sur le VRAI SQL (sql/stock_par_service.sql, Postgres embarqué).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let PGlite = null;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { /* dépendance de test absente : les tests SQL sont ignorés */ }
const sauf = PGlite ? {} : { skip: 'Postgres embarqué (@electric-sql/pglite) non installé' };

const serveur = require('./serveurSource').lireServeur();
const sqlStock = fs.readFileSync(path.join(__dirname, '..', 'sql', 'stock_par_service.sql'), 'utf8');
// 28/10 : la pharmacie seule (réquisition d'un service sans stock propre, SOP) passe par les VRAIES fonctions de décrément des ventes.
const sqlDecrementBase = fs.readFileSync(path.join(__dirname, '..', 'sql', 'fonction_decrementer_stock_et_numerotation_lots.sql'), 'utf8');
const sqlDecrementIdempotent = fs.readFileSync(path.join(__dirname, '..', 'sql', 'idempotence_decrement_stock.sql'), 'utf8');
const sqlAjoutBase = fs.readFileSync(path.join(__dirname, '..', 'sql', 'fonction_maj_stock_medicament.sql'), 'utf8');
const { serviceSansStockPropre } = require('../utils/servicesSansStockPropre');
const tranche = (debut, fin) => { const d = serveur.indexOf(debut); const f = serveur.indexOf(fin, d + 1); assert.ok(d > 0 && f > d, `introuvable : ${debut}`); return serveur.slice(d, f); };
const codeDecrementer = tranche("app.post('/api/stock/decrementer'", "app.post('/api/stock/restituer'");
const codeRestituer = tranche("app.post('/api/stock/restituer'", '// ============================================================\n// RÉQUISITIONS');
const codeRequisitionPost = tranche("app.post('/api/requisitions'", "app.get('/api/requisitions'");
const codeRequisitionsFin = tranche('// Compare l\'ancienne et la nouvelle liste d\'une réquisition', '// Ajoute du stock à UN médicament de façon atomique');

async function monter({ items, droits = ['stock_gerer', 'requisition_modifier', 'caisse_travailler'], requisitions = [] } = {}) {
  const db = new PGlite();
  await db.exec(`CREATE TABLE catalog (type text PRIMARY KEY, items jsonb, updated_at timestamptz);
    CREATE TABLE decrements_stock_appliques (local_id text PRIMARY KEY, applique_le timestamptz NOT NULL DEFAULT now());
    CREATE TABLE requisitions (id text PRIMARY KEY);`);
  await db.exec(sqlStock);
  await db.exec(sqlDecrementBase); await db.exec(sqlDecrementIdempotent);
  // La surcharge à 2 arguments existe en production (idempotence_decrement_stock.sql n'en documente le corps qu'en commentaire) : on la recrée ici, mêmes 2 blocs d'idempotence.
  await db.exec(`CREATE OR REPLACE FUNCTION public.decrementer_stock_medicaments(p_decrements jsonb, p_local_id text) RETURNS jsonb LANGUAGE plpgsql AS $f$
    DECLARE v_items jsonb; v_res jsonb;
    BEGIN
      SELECT items INTO v_items FROM catalog WHERE type = 'medicaments' FOR UPDATE;
      IF p_local_id IS NOT NULL AND EXISTS (SELECT 1 FROM decrements_stock_appliques WHERE local_id = p_local_id) THEN
        RETURN jsonb_build_object('succes', true, 'deja_applique', true, 'items', v_items);
      END IF;
      v_res := public.decrementer_stock_medicaments(p_decrements);
      IF (v_res->>'succes')::boolean AND p_local_id IS NOT NULL THEN
        INSERT INTO decrements_stock_appliques (local_id) VALUES (p_local_id) ON CONFLICT DO NOTHING;
      END IF;
      RETURN v_res;
    END $f$;`);
  await db.exec(sqlAjoutBase);
  await db.exec(`CREATE OR REPLACE FUNCTION public.ajouter_stock_medicament(p_id text, p_quantite_ajoutee numeric, p_local_id text) RETURNS jsonb LANGUAGE plpgsql AS $f$
    DECLARE v_res jsonb;
    BEGIN
      PERFORM 1 FROM catalog WHERE type = 'medicaments' FOR UPDATE;
      IF p_local_id IS NOT NULL AND EXISTS (SELECT 1 FROM decrements_stock_appliques WHERE local_id = p_local_id) THEN RETURN NULL; END IF;
      v_res := public.ajouter_stock_medicament(p_id, p_quantite_ajoutee);
      IF p_local_id IS NOT NULL THEN INSERT INTO decrements_stock_appliques (local_id) VALUES (p_local_id) ON CONFLICT DO NOTHING; END IF;
      RETURN v_res;
    END $f$;`);
  await db.query(`INSERT INTO catalog VALUES ('medicaments', $1::jsonb, now())`, [JSON.stringify(items)]);
  const tableReq = requisitions;
  const audits = [];
  const supabase = {
    rpc: async (nom, args) => {
      const parametres = { transferer_stock_service: ['p_service', 'p_lignes', 'p_local_id'], decrementer_stock_service: ['p_service', 'p_decrements', 'p_local_id'], restituer_stock_ventes: ['p_entrees', 'p_local_id'], decrementer_stock_medicaments: ['p_decrements', 'p_local_id'], ajouter_stock_medicament: ['p_id', 'p_quantite_ajoutee', 'p_local_id'] }[nom];
      if (!parametres) return { data: null, error: { message: `rpc non simulée : ${nom}` } };
      try {
        const r = await db.query(`select ${nom}(${parametres.map((p, i) => `$${i + 1}${/lignes|decrements|entrees/.test(p) ? '::jsonb' : (p === 'p_quantite_ajoutee' ? '::numeric' : '::text')}`).join(', ')}) as r`, parametres.map(p => (/lignes|decrements|entrees/.test(p) ? JSON.stringify(args[p]) : (args[p] ?? null))));
        return { data: r.rows[0].r, error: null };
      } catch (e) { return { data: null, error: { message: e.message } }; }
    },
    from: (table) => {
      const f = []; let action = 'select'; let corps = null;
      const lignes = () => tableReq.filter(r => f.every(g => g(r)));
      const c = {
        select: () => c, eq: (k, v) => { f.push(r => r[k] === v); return c; }, order: () => c,
        insert: (v) => { action = 'insert'; corps = v; return c; }, update: (v) => { action = 'update'; corps = v; return c; },
        maybeSingle: async () => {
          if (table === 'catalog') { const r = await db.query(`select items from catalog where type='medicaments'`); return { data: { items: r.rows[0].items }, error: null }; }
          return { data: lignes()[0] || null, error: null };
        },
        single: async () => { if (action === 'insert') { const l = { id: `r${tableReq.length + 1}`, annulee: false, ...corps }; tableReq.push(l); return { data: l, error: null }; } return { data: lignes()[0] || null, error: null }; },
        then: (resolve) => {
          if (table === 'catalog') return resolve({ data: { items: items }, error: null });
          if (action === 'update') { const l = lignes(); l.forEach(r => Object.assign(r, corps)); return resolve({ data: l, error: null }); }
          if (action === 'insert') { const l = { id: `r${tableReq.length + 1}`, annulee: false, ...corps }; tableReq.push(l); return resolve({ data: [l], error: null }); }
          return resolve({ data: lignes(), error: null });
        },
      };
      return c;
    },
  };
  const routes = {};
  const app = { get: (c, f2) => { routes['GET ' + c] = f2; }, post: (c, f2) => { routes['POST ' + c] = f2; }, patch: (c, f2) => { routes['PATCH ' + c] = f2; }, put: (c, f2) => { routes['PUT ' + c] = f2; } };
  const aPermission = async (_u, cle) => droits.includes(cle);
  const audit = async (_r, a, d) => { audits.push({ a, d }); };
  new Function('app', 'supabase', 'aPermission', 'envoyerCallMeBot', 'console', codeDecrementer)(app, supabase, aPermission, () => {}, console);
  new Function('app', 'supabase', 'aPermission', 'console', codeRestituer)(app, supabase, aPermission, console);
  new Function('app', 'supabase', 'aPermission', 'enregistrerAuditServeur', 'console', 'serviceSansStockPropre', codeRequisitionPost)(app, supabase, aPermission, audit, console, serviceSansStockPropre);
  new Function('app', 'supabase', 'aPermission', 'lireToutesLesPages', 'enregistrerAuditServeur', 'console', codeRequisitionsFin)(app, supabase, aPermission, async (fn) => (await fn()).data, audit, console);
  const appeler = async (cle, req) => {
    const res = { code: 200, corps: null, status(x) { this.code = x; return this; }, json(b) { this.corps = b; return this; } };
    await routes[cle]({ user: { id: 'u1', email: 'chef@chf.com' }, params: {}, body: {}, headers: {}, ...req }, res);
    return res;
  };
  const stock = async (id) => { const it = (await db.query(`select items from catalog where type='medicaments'`)).rows[0].items.find(i => i.id === id); return { pharmacie: it.quantite, services: it.stockServices || {} }; };
  return { appeler, stock, requisitions: tableReq, audits, fermer: () => db.close() };
}
const ITEMS = () => [{ id: 'm1', nom: 'Amoxicilline', quantite: 20 }, { id: 'm2', nom: 'Sérum', quantite: 5 }];

test('réquisition : la pharmacie DONNE au service (le stock devient celui du service), la trace est gardée, un rejeu ne le fait pas deux fois', sauf, async () => {
  const m = await monter({ items: ITEMS() });
  try {
    const r = await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 8 }], local_id: 'rq-1' } });
    assert.strictEqual(r.code, 201);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 12, services: { 'Pédiatrie': 8 } });
    assert.strictEqual(m.requisitions[0].stock_par_service, true);
    const rejeu = await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 8 }], local_id: 'rq-1' } });
    assert.strictEqual(rejeu.code, 200);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 12, services: { 'Pédiatrie': 8 } });
  } finally { await m.fermer(); }
});

test('réquisition : la pharmacie n\'en a pas assez → 409, rien ne bouge ; une quantité nulle ou négative → 400', sauf, async () => {
  const m = await monter({ items: ITEMS() });
  try {
    const r = await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm2', qte: 50 }] } });
    assert.strictEqual(r.code, 409); assert.match(r.corps.error, /Stock insuffisant/);
    assert.deepStrictEqual(await m.stock('m2'), { pharmacie: 5, services: {} });
    for (const qte of [0, -3]) assert.strictEqual((await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm2', qte }] } })).code, 400, `qte ${qte}`);
    assert.deepStrictEqual(await m.stock('m2'), { pharmacie: 5, services: {} }, 'une quantité négative ne peut pas voler le stock d\'un service');
  } finally { await m.fermer(); }
});

test('vente d\'un épisode du service : le stock du service d\'abord, le reste vient de la pharmacie ; sans service : la pharmacie seule', sauf, async () => {
  const m = await monter({ items: ITEMS() });
  try {
    await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 5 }] } });
    const a = await m.appeler('POST /api/stock/decrementer', { body: { decrements: [{ id: 'm1', qte: 3 }], service: 'Pédiatrie', local_id: 'v1-stock' } });
    assert.strictEqual(a.code, 200);
    assert.deepStrictEqual(a.corps.repartition, [{ id: 'm1', service: 3, central: 0 }]);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 15, services: { 'Pédiatrie': 2 } });
    const b = await m.appeler('POST /api/stock/decrementer', { body: { decrements: [{ id: 'm1', qte: 6 }], service: 'Pédiatrie', local_id: 'v2-stock' } });
    assert.deepStrictEqual(b.corps.repartition, [{ id: 'm1', service: 2, central: 4 }], 'stock du service épuisé : le reste est pris à la pharmacie, la vente n\'est pas bloquée');
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 11, services: { 'Pédiatrie': 0 } });
    // rejeu de la file hors ligne : pas de double sortie
    const rejeu = await m.appeler('POST /api/stock/decrementer', { body: { decrements: [{ id: 'm1', qte: 6 }], service: 'Pédiatrie', local_id: 'v2-stock' } });
    assert.strictEqual(rejeu.corps.deja_applique, true);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 11, services: { 'Pédiatrie': 0 } });
    // épisode sans service (consultation, Achat Express) : pharmacie seule, comme avant — le stock d'un autre service n'est jamais touché
    await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Maternité', lignes: [{ id: 'm2', qte: 2 }] } });
    const c = await m.appeler('POST /api/stock/decrementer', { body: { decrements: [{ id: 'm2', qte: 1 }], service: 'Pédiatrie', local_id: 'v3-stock' } });
    assert.deepStrictEqual(c.corps.repartition, [{ id: 'm2', service: 0, central: 1 }], 'la Pédiatrie n\'utilise pas le stock de la Maternité');
    assert.deepStrictEqual(await m.stock('m2'), { pharmacie: 2, services: { 'Maternité': 2 } });
  } finally { await m.fermer(); }
});

test('vente impossible (service + pharmacie ne suffisent pas) : 409, rien ne bouge', sauf, async () => {
  const m = await monter({ items: ITEMS() });
  try {
    await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm2', qte: 2 }] } });
    const r = await m.appeler('POST /api/stock/decrementer', { body: { decrements: [{ id: 'm2', qte: 9 }], service: 'Pédiatrie', local_id: 'v9-stock' } });
    assert.strictEqual(r.code, 409);
    assert.deepStrictEqual(await m.stock('m2'), { pharmacie: 3, services: { 'Pédiatrie': 2 } });
  } finally { await m.fermer(); }
});

test('fiche supprimée : chaque article revient là où il avait été pris (service ou pharmacie), une seule fois', sauf, async () => {
  const m = await monter({ items: ITEMS() });
  try {
    await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 5 }] } });
    await m.appeler('POST /api/stock/decrementer', { body: { decrements: [{ id: 'm1', qte: 8 }], service: 'Pédiatrie', local_id: 'F1-stock' } }); // 5 du service + 3 de la pharmacie
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 12, services: { 'Pédiatrie': 0 } });
    const r = await m.appeler('POST /api/stock/restituer', { body: { entrees: [{ fiche: 'F1', lignes: [{ id: 'm1', qte: 8 }] }], local_id: 'restitution-F1' } });
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 15, services: { 'Pédiatrie': 5 } });
    const rejeu = await m.appeler('POST /api/stock/restituer', { body: { entrees: [{ fiche: 'F1', lignes: [{ id: 'm1', qte: 8 }] }], local_id: 'restitution-F1' } });
    assert.strictEqual(rejeu.corps.deja_applique, true);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 15, services: { 'Pédiatrie': 5 } });
    // une vente d'avant cette fonctionnalité (aucune répartition gardée) : tout à la pharmacie, comme l'ancienne restitution
    const ancienne = await m.appeler('POST /api/stock/restituer', { body: { entrees: [{ fiche: 'FANCIENNE', lignes: [{ id: 'm2', qte: 2 }] }], local_id: 'restitution-FA' } });
    assert.strictEqual(ancienne.code, 200);
    assert.deepStrictEqual(await m.stock('m2'), { pharmacie: 7, services: {} });
  } finally { await m.fermer(); }
});

test('restitution : entrées invalides refusées (400) ; droit caisse_travailler exigé (403)', sauf, async () => {
  const m = await monter({ items: ITEMS() });
  try {
    assert.strictEqual((await m.appeler('POST /api/stock/restituer', { body: { entrees: [] } })).code, 400);
    assert.strictEqual((await m.appeler('POST /api/stock/restituer', { body: { entrees: [{ fiche: 'x', lignes: [{ id: 'm1', qte: -4 }] }] } })).code, 400, 'une quantité négative ne gonfle pas le stock');
  } finally { await m.fermer(); }
  const sans = await monter({ items: ITEMS(), droits: [] });
  try { assert.strictEqual((await sans.appeler('POST /api/stock/restituer', { body: { entrees: [{ fiche: 'x', lignes: [{ id: 'm1', qte: 1 }] }] } })).code, 403); } finally { await sans.fermer(); }
});

test('annulation d\'une réquisition : le service rend à la pharmacie ; refusée (409, réquisition intacte) si le service a déjà utilisé le stock', sauf, async () => {
  const m = await monter({ items: ITEMS() });
  try {
    await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 6 }] } });
    // le service en utilise 4 → il en reste 2 sur 6 : annulation impossible
    await m.appeler('POST /api/stock/decrementer', { body: { decrements: [{ id: 'm1', qte: 4 }], service: 'Pédiatrie', local_id: 'u1-stock' } });
    const refus = await m.appeler('PATCH /api/requisitions/:id/annuler', { params: { id: 'r1' }, body: { motif: 'Erreur de service' } });
    assert.strictEqual(refus.code, 409); assert.match(refus.corps.error, /déjà utilisé/);
    assert.strictEqual(m.requisitions[0].annulee, false, 'la réquisition reste ouverte');
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 14, services: { 'Pédiatrie': 2 } });
    // une autre réquisition, jamais utilisée : l'annulation rend tout à la pharmacie
    await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Maternité', lignes: [{ id: 'm1', qte: 3 }] } });
    const ok = await m.appeler('PATCH /api/requisitions/:id/annuler', { params: { id: 'r2' }, body: { motif: 'Erreur de service' } });
    assert.strictEqual(ok.code, 200);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 14, services: { 'Pédiatrie': 2, 'Maternité': 0 } });
  } finally { await m.fermer(); }
});

test('modification d\'une réquisition : le stock suit la différence (service ↔ pharmacie) ; changer de service est refusé', sauf, async () => {
  const m = await monter({ items: ITEMS() });
  try {
    await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 6 }] } });
    const plus = await m.appeler('PUT /api/requisitions/:id', { params: { id: 'r1' }, body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 10 }] } });
    assert.strictEqual(plus.code, 200);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 10, services: { 'Pédiatrie': 10 } });
    const moins = await m.appeler('PUT /api/requisitions/:id', { params: { id: 'r1' }, body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 7 }] } });
    assert.strictEqual(moins.code, 200);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 13, services: { 'Pédiatrie': 7 } });
    const autre = await m.appeler('PUT /api/requisitions/:id', { params: { id: 'r1' }, body: { service_demandeur: 'Maternité', lignes: [{ id: 'm1', qte: 7 }] } });
    assert.strictEqual(autre.code, 400); assert.match(autre.corps.error, /changer de service/);
  } finally { await m.fermer(); }
});

test('retour à la pharmacie : réservé à requisition_modifier, limité à ce que le service a, tracé au journal', sauf, async () => {
  const m = await monter({ items: ITEMS() });
  try {
    await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 6 }] } });
    const trop = await m.appeler('POST /api/requisitions/retour', { body: { service: 'Pédiatrie', lignes: [{ id: 'm1', qte: 9 }] } });
    assert.strictEqual(trop.code, 409);
    const ok = await m.appeler('POST /api/requisitions/retour', { body: { service: 'Pédiatrie', lignes: [{ id: 'm1', qte: 4 }], motif: 'Jamais utilisé', local_id: 'ret-1' } });
    assert.strictEqual(ok.code, 200);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 18, services: { 'Pédiatrie': 2 } });
    assert.ok(m.audits.some(x => x.a === 'stock_service_retourne' && x.d.service === 'Pédiatrie'));
    const rejeu = await m.appeler('POST /api/requisitions/retour', { body: { service: 'Pédiatrie', lignes: [{ id: 'm1', qte: 4 }], local_id: 'ret-1' } });
    assert.strictEqual(rejeu.corps.deja_applique, true);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 18, services: { 'Pédiatrie': 2 } });
    for (const lignes of [[{ id: 'm1', qte: -2 }], [{ id: 'm1', qte: 0 }], []]) assert.strictEqual((await m.appeler('POST /api/requisitions/retour', { body: { service: 'Pédiatrie', lignes } })).code, 400);
  } finally { await m.fermer(); }
  const sans = await monter({ items: ITEMS(), droits: ['stock_gerer'] });
  try { assert.strictEqual((await sans.appeler('POST /api/requisitions/retour', { body: { service: 'Pédiatrie', lignes: [{ id: 'm1', qte: 1 }] } })).code, 403); } finally { await sans.fermer(); }
});

test('une ancienne réquisition (avant le stock par service) s\'annule comme avant : le stock revient à la pharmacie', sauf, async () => {
  const m = await monter({ items: ITEMS(), requisitions: [{ id: 'r1', service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', nom: 'Amoxicilline', quantite: 3 }], annulee: false }] });
  try {
    const r = await m.appeler('PATCH /api/requisitions/:id/annuler', { params: { id: 'r1' }, body: { motif: 'Ancienne réquisition' } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 23, services: {} }, 'chemin historique (ajouter_stock_medicament) : le stock revient à la pharmacie, pas de transfert par service');
  } finally { await m.fermer(); }
});

test('SQL : la répartition d\'une vente retrouve la fiche même avec un nouvel essai (-t2) et des caractères spéciaux dans son identifiant', sauf, async () => {
  const m = await monter({ items: ITEMS() });
  try {
    await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 4 }] } });
    await m.appeler('POST /api/stock/decrementer', { body: { decrements: [{ id: 'm1', qte: 2 }], service: 'Pédiatrie', local_id: 'a.b+c-t2-stock' } });
    await m.appeler('POST /api/stock/decrementer', { body: { decrements: [{ id: 'm1', qte: 1 }], service: 'Pédiatrie', local_id: 'aXbbc-stock' } });
    await m.appeler('POST /api/stock/restituer', { body: { entrees: [{ fiche: 'a.b+c', lignes: [{ id: 'm1', qte: 2 }] }], local_id: 'r-1' } });
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 16, services: { 'Pédiatrie': 3 } }, 'seule la fiche visée est rendue (2 au service) ; l\'autre garde sa sortie');
  } finally { await m.fermer(); }
});

test('server.js : la file hors ligne d\'une vente envoie le service ; l\'ancienne route reste valable sans service (compatibilité)', () => {
  assert.match(codeDecrementer, /const serviceVente = typeof req\.body\.service === 'string' \? req\.body\.service\.trim\(\) : '';/);
  assert.match(codeDecrementer, /serviceVente\s*\?\s*await supabase\.rpc\('decrementer_stock_service'[\s\S]*:\s*await supabase\.rpc\('decrementer_stock_medicaments'/);
});

test('renommer un service d\'hospitalisation : son stock de médicaments suit (fonction SQL appelée par la route de renommage)', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'routesListesServices.js'), 'utf8');
  assert.match(src, /type === 'services_hospitalisation' && typeof supabase\.rpc === 'function'[\s\S]*renommer_service_stock/);
  assert.match(sqlStock, /FUNCTION public\.renommer_service_stock/);
});

test('SOP (service sans stock propre) : la réquisition fait sortir le stock de la pharmacie et reste dans l\'historique, mais ne crée AUCUN stock de service ; annuler remet tout à la pharmacie ; un rejeu ne sort rien de plus', sauf, async () => {
  const m = await monter({ items: ITEMS() });
  try {
    const r = await m.appeler('POST /api/requisitions', { body: { service_demandeur: ' sop ', lignes: [{ id: 'm1', qte: 6 }], local_id: 'rq-sop' } });
    assert.strictEqual(r.code, 201, JSON.stringify(r.corps));
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 14, services: {} }, 'la pharmacie diminue, aucun stock « SOP » n\'apparaît');
    assert.strictEqual(m.requisitions.length, 1, 'la réquisition est dans l\'historique');
    assert.strictEqual(m.requisitions[0].service_demandeur, 'sop');
    assert.deepStrictEqual(m.requisitions[0].lignes.map(l => [l.id, l.quantite]), [['m1', 6]]);
    assert.strictEqual(m.requisitions[0].stock_par_service, false, 'marquée « sans stock de service » : annulation / modification remettent le stock à la pharmacie');
    const rejeu = await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'SOP', lignes: [{ id: 'm1', qte: 6 }], local_id: 'rq-sop' } });
    assert.strictEqual(rejeu.code, 200);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 14, services: {} }, 'le rejeu ne sort rien de plus');
    // Annulation : le stock revient à la pharmacie.
    const id = m.requisitions[0].id;
    const a = await m.appeler('PATCH /api/requisitions/:id/annuler', { params: { id }, body: { motif: 'Erreur de saisie' } });
    assert.strictEqual(a.code, 200, JSON.stringify(a.corps));
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 20, services: {} }, 'stock remis à la pharmacie');
    // Les autres services gardent leur stock propre.
    const p = await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'Pédiatrie', lignes: [{ id: 'm1', qte: 4 }], local_id: 'rq-ped' } });
    assert.strictEqual(p.code, 201);
    assert.deepStrictEqual(await m.stock('m1'), { pharmacie: 16, services: { 'Pédiatrie': 4 } });
    assert.strictEqual(m.requisitions[1].stock_par_service, true);
  } finally { await m.fermer(); }
});

test('SOP : pas assez à la pharmacie → 409, rien ne bouge, aucune réquisition écrite', sauf, async () => {
  const m = await monter({ items: ITEMS() });
  try {
    const r = await m.appeler('POST /api/requisitions', { body: { service_demandeur: 'SOP', lignes: [{ id: 'm2', qte: 50 }] } });
    assert.strictEqual(r.code, 409); assert.match(r.corps.error, /Stock insuffisant/);
    assert.deepStrictEqual(await m.stock('m2'), { pharmacie: 5, services: {} });
    assert.strictEqual(m.requisitions.length, 0);
  } finally { await m.fermer(); }
});
