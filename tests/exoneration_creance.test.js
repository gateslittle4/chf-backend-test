// tests/exoneration_creance.test.js — « Exonérer cette créance » (24/10, Esdras) : la direction pardonne sur papier tout ou partie d'une dette, la caisse passe l'écriture.
// 1. La vraie fonction SQL (sql/exoneration_creance.sql) sur un vrai Postgres embarqué (pglite) : la dette baisse, aucun argent n'entre, refus quand il faut.
// 2. La route POST /api/episodes/:id/exonerer-creance avec de faux services : droits, motif, montant, réponses d'erreur, trace d'audit.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let PGlite = null;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { /* dépendance de test absente : tests SQL ignorés */ }
const sauf = PGlite ? {} : { skip: 'Postgres embarqué (@electric-sql/pglite) non installé' };
const sqlFonction = fs.readFileSync(path.join(__dirname, '..', 'sql', 'exoneration_creance.sql'), 'utf8');
const EP = '11111111-1111-1111-1111-111111111111';

async function base() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE paiements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), episode_id uuid, fiche_id uuid, mode text, montant numeric DEFAULT 0, solde_restant numeric DEFAULT 0,
    date_paiement timestamptz NOT NULL DEFAULT now(), numero_paiement bigserial, annule boolean DEFAULT false, supprime_le timestamptz, patient_nom text, encaisse_par text, traite_par_uid text,
    local_id text UNIQUE, details jsonb, exoneration jsonb);`);
  await db.exec(sqlFonction);
  let minute = 0;
  const payer = async ({ mode, montant = 0, solde }) => { minute += 1; await db.query(`insert into paiements (episode_id, mode, montant, solde_restant, date_paiement) values ($1,$2,$3,$4, timestamptz '2026-10-20 08:00:00+00' + ($5 || ' minutes')::interval)`, [EP, mode, montant, solde, String(minute)]); };
  const dette = async () => Number(((await db.query(`select coalesce(solde_restant,0) s from paiements where episode_id=$1 and (annule=false or annule is null) and supprime_le is null order by date_paiement desc, numero_paiement desc limit 1`, [EP])).rows[0] || { s: 0 }).s);
  const exonerer = async (montant, corps = {}) => (await db.query('select exonerer_creance_atomique($1::uuid, $2::numeric, $3::jsonb) r', [EP, montant, JSON.stringify({ patient_nom: 'Test', ...corps })])).rows[0].r;
  return { db, payer, dette, exonerer };
}

test('SQL : exonérer une partie de la dette — la dette baisse, la ligne est une exonération de 0 Gdes (aucun argent dans le tiroir)', sauf, async () => {
  const b = await base();
  try {
    await b.payer({ mode: 'credit', solde: 3000 });
    const r = await b.exonerer(1000, { details: { exoneration_creance: true, montant_exonere: 1000 }, exoneration: { montantExonere: 1000, motif: 'Exonération de créance — décision direction' } });
    assert.strictEqual(r.mode, 'exoneration');
    assert.strictEqual(Number(r.montant), 0, 'aucun argent');
    assert.strictEqual(Number(r.solde_restant), 2000);
    assert.strictEqual(r.details.exoneration_creance, true);
    assert.strictEqual(await b.dette(), 2000);
    await b.exonerer(2000);
    assert.strictEqual(await b.dette(), 0, 'toute la dette pardonnée');
  } finally { await b.db.close(); }
});

test('SQL : refus — aucune dette (CHF01), montant nul ou négatif (CHF02), montant supérieur à la dette (CHF03) ; rien n\'est écrit', sauf, async () => {
  const b = await base();
  try {
    await assert.rejects(b.exonerer(100), (e) => e.code === 'CHF01' || /Aucune dette/.test(e.message));
    await b.payer({ mode: 'credit', solde: 500 });
    for (const m of [0, -5]) await assert.rejects(b.exonerer(m), (e) => e.code === 'CHF02' || /supérieur à 0/.test(e.message), String(m));
    await assert.rejects(b.exonerer(501), (e) => e.code === 'CHF03' || /dépasse la dette/.test(e.message));
    assert.strictEqual(await b.dette(), 500, 'la dette n\'a pas bougé');
    assert.strictEqual(Number((await b.db.query('select count(*) n from paiements')).rows[0].n), 1, 'aucune ligne ajoutée');
  } finally { await b.db.close(); }
});

test('SQL : une dette déjà exonérée ne peut pas l\'être deux fois, et un paiement annulé ne compte pas comme solde', sauf, async () => {
  const b = await base();
  try {
    await b.payer({ mode: 'credit', solde: 800 });
    await b.exonerer(800);
    await assert.rejects(b.exonerer(1), (e) => e.code === 'CHF01' || /Aucune dette/.test(e.message));
    await b.db.query(`update paiements set annule = true where mode = 'exoneration'`);
    assert.strictEqual(await b.dette(), 800, 'exonération annulée : la dette est de nouveau due');
  } finally { await b.db.close(); }
});

// ---------------- la route, avec de faux services ----------------
function monterRoute({ droits = ['caisse_travailler', 'exoneration_accorder'], rpc } = {}) {
  const routes = {};
  const app = new Proxy({}, { get: (_, m) => (chemin, ...h) => { routes[`${String(m).toUpperCase()} ${chemin}`] = h[h.length - 1]; } });
  const audits = []; const appelsRpc = [];
  const table = (donnees) => { const q = { select: () => q, eq: () => q, is: () => q, maybeSingle: async () => ({ data: donnees, error: null }) }; return q; };
  const supabase = {
    from: (nom) => table(nom === 'episodes' ? { id: EP, dossier_id: 'd1', type_patient: 'prive', ong_partenaire: null } : nom === 'dossiers' ? { nom: 'Marie Test' } : null),
    rpc: async (nomFonction, args) => { appelsRpc.push({ nomFonction, args }); return rpc ? rpc(args) : { data: { id: 'p1', mode: 'exoneration', montant: 0, solde_restant: 2000 }, error: null }; },
  };
  require('../routes/caisse.js')(app, { aPermission: async (_, d) => droits.includes(d), calculerSoldeDepot: () => ({}), enregistrerAuditServeur: (_, a, d) => audits.push({ a, d }), estUnVraiUuid: (x) => /^[0-9a-f-]{36}$/.test(String(x || '')), lireToutesLesPages: async () => [], supabase, synchroListes: {} });
  const appeler = async (corps, id = EP) => { let statut = 200; let json; const res = { status(s) { statut = s; return this; }, json(j) { json = j; return this; } }; await routes['POST /api/episodes/:id/exonerer-creance']({ params: { id }, body: corps, user: { id: 'u1', email: 'caisse@chf.ht' } }, res); return { statut, json }; };
  return { appeler, audits, appelsRpc };
}

test('route : la caisse (exoneration_accorder) passe l\'exonération — motif gardé, montant arrondi, trace d\'audit, 201', async () => {
  const m = monterRoute();
  const r = await m.appeler({ montant: 1000.004, motif: 'Papier de la direction du 24/10' });
  assert.strictEqual(r.statut, 201);
  assert.strictEqual(m.appelsRpc.length, 1);
  const { nomFonction, args } = m.appelsRpc[0];
  assert.strictEqual(nomFonction, 'exonerer_creance_atomique');
  assert.strictEqual(args.p_montant, 1000);
  assert.strictEqual(args.p_corps.exoneration.motif, 'Exonération de créance — Papier de la direction du 24/10');
  assert.strictEqual(args.p_corps.patient_nom, 'Marie Test');
  assert.strictEqual(args.p_corps.details.exoneration_creance, true);
  assert.strictEqual(m.audits[0].a, 'exoneration_creance_accordee');
  assert.strictEqual(m.audits[0].d.montant_exonere, 1000);
});

test('route : refus sans le droit d\'accorder une exonération, sans motif, avec un montant invalide ; la base n\'est jamais appelée', async () => {
  const sansDroit = monterRoute({ droits: ['caisse_travailler'] });
  assert.strictEqual((await sansDroit.appeler({ montant: 100, motif: 'Décision direction' })).statut, 403);
  const m = monterRoute();
  assert.strictEqual((await m.appeler({ montant: 100, motif: ' ab ' })).json.code, 'MOTIF_EXONERATION_REQUIS');
  for (const montant of [undefined, '', 'abc', -3]) assert.strictEqual((await m.appeler({ montant, motif: 'Décision direction' })).statut, 400, String(montant));
  assert.strictEqual((await m.appeler({ montant: 100, motif: 'Décision direction' }, 'pas-un-uuid')).statut, 400);
  assert.strictEqual(m.appelsRpc.length, 0);
  const direction = monterRoute({ droits: ['demandes_repondre'] });
  assert.strictEqual((await direction.appeler({ montant: 100, motif: 'Décision direction' })).statut, 201, 'la direction peut aussi');
  const sansCaisse = monterRoute({ droits: ['exoneration_accorder'] });
  assert.strictEqual((await sansCaisse.appeler({ montant: 100, motif: 'Décision direction' })).statut, 403, 'il faut aussi travailler à la caisse');
});

test('route : refus de la base (pas de dette, trop grand) → 400 avec le montant en Gdes ; fonction absente → 503 ; autre erreur → 500', async () => {
  const refus = monterRoute({ rpc: () => ({ data: null, error: { code: 'CHF03', message: 'Le montant à exonérer (900) dépasse la dette restante (500).' } }) });
  const r = await refus.appeler({ montant: 900, motif: 'Décision direction' });
  assert.strictEqual(r.statut, 400);
  assert.match(r.json.error, /\(900 Gdes\).*\(500 Gdes\)/);
  assert.strictEqual(refus.audits.length, 0, 'rien à tracer quand rien n\'est écrit');
  const absente = monterRoute({ rpc: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) });
  assert.strictEqual((await absente.appeler({ montant: 100, motif: 'Décision direction' })).statut, 503);
  const autre = monterRoute({ rpc: () => ({ data: null, error: { code: 'XX000', message: 'boum' } }) });
  assert.strictEqual((await autre.appeler({ montant: 100, motif: 'Décision direction' })).statut, 500);
});
