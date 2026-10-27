// tests/rendre_depot.test.js — « Rendre le dépôt » (27/10, Esdras) : un patient n'a pas dépensé tout son dépôt, la caisse lui rend le reste.
// 1. La vraie fonction SQL (sql/rendre_depot.sql) sur un vrai Postgres embarqué (pglite), avec la VRAIE règle du dépôt disponible (calculerSoldeDepot, extraite de server.js) : le dépôt baisse du montant rendu.
// 2. La route POST /api/episodes/:id/rendre-depot avec de faux services : droits, motif, « autorisé par », montant, erreurs, audit.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let PGlite = null;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { /* dépendance de test absente : tests SQL ignorés */ }
const sauf = PGlite ? {} : { skip: 'Postgres embarqué (@electric-sql/pglite) non installé' };
const sqlFonction = fs.readFileSync(path.join(__dirname, '..', 'sql', 'rendre_depot.sql'), 'utf8');
const EP = '11111111-1111-1111-1111-111111111111';

// La VRAIE règle du dépôt disponible, extraite de server.js (comme tests/hospitalisation.test.js) : si elle change là-bas, ce test doit le voir.
const serveur = require('./serveurSource').lireServeur();
const debutFn = serveur.indexOf('function calculerSoldeDepot');
const calculerSoldeDepot = new Function(`${serveur.slice(debutFn, serveur.indexOf('\n}\n', debutFn) + 3)}; return calculerSoldeDepot;`)();

async function base() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE paiements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), episode_id uuid, fiche_id uuid, mode text, montant numeric DEFAULT 0, solde_restant numeric DEFAULT 0,
    date_paiement timestamptz NOT NULL DEFAULT now(), numero_paiement bigserial, annule boolean DEFAULT false, supprime_le timestamptz, patient_nom text, encaisse_par text, traite_par_uid text,
    local_id text UNIQUE, details jsonb, exoneration jsonb);`);
  await db.exec(sqlFonction);
  let minute = 0;
  const payer = async ({ mode, montant = 0, solde = 0, details = null, annule = false }) => { minute += 1; await db.query(`insert into paiements (episode_id, mode, montant, solde_restant, details, annule, date_paiement) values ($1,$2,$3,$4,$5::jsonb,$6, timestamptz '2026-10-20 08:00:00+00' + ($7 || ' minutes')::interval)`, [EP, mode, montant, solde, details ? JSON.stringify(details) : null, annule, String(minute)]); };
  const lignes = async () => (await db.query(`select * from paiements where episode_id=$1 and (annule=false or annule is null) and supprime_le is null order by date_paiement, numero_paiement`, [EP])).rows;
  const dispo = async () => calculerSoldeDepot(await lignes()).soldeDepot; // la vraie règle du serveur
  const rendre = async (montant, corps = {}) => (await db.query('select rendre_depot_atomique($1::uuid, $2::numeric, $3::jsonb) r', [EP, montant, JSON.stringify({ patient_nom: 'Test', ...corps })])).rows[0].r;
  return { db, payer, dispo, lignes, rendre };
}

test('SQL : rendre une partie du dépôt — ligne « remboursement_patient », le dépôt disponible baisse du montant rendu, la dette n\'est pas touchée', sauf, async () => {
  const b = await base();
  try {
    await b.payer({ mode: 'depot', montant: 5000 });
    await b.payer({ mode: 'cash', montant: 0, solde: 800, details: { montant_depot_utilise: 1500 } }); // une fiche a déjà consommé 1500 et laissé 800 de dette
    assert.strictEqual(await b.dispo(), 3500);
    const r = await b.rendre(2000, { details: { motif: 'Patient sorti', autorise_par: 'Direction' } });
    assert.strictEqual(r.mode, 'remboursement_patient');
    assert.strictEqual(Number(r.montant), 2000);
    assert.strictEqual(Number(r.solde_restant), 800, 'la dette est recopiée telle quelle');
    assert.strictEqual(r.details.depot_rendu, true);
    assert.strictEqual(r.details.autorise_par, 'Direction', 'les détails envoyés sont gardés');
    assert.strictEqual(await b.dispo(), 1500, 'dépôt disponible : 3500 − 2000');
    await b.rendre(1500);
    assert.strictEqual(await b.dispo(), 0, 'tout le dépôt rendu');
  } finally { await b.db.close(); }
});

test('SQL : refus — aucun dépôt (CHF01), montant nul ou négatif (CHF02), plus que le dépôt disponible (CHF03) ; rien n\'est écrit', sauf, async () => {
  const b = await base();
  try {
    await assert.rejects(b.rendre(100), (e) => e.code === 'CHF01' || /Aucun dépôt/.test(e.message));
    await b.payer({ mode: 'depot', montant: 1000 });
    for (const m of [0, -5]) await assert.rejects(b.rendre(m), (e) => e.code === 'CHF02' || /supérieur à 0/.test(e.message), String(m));
    await assert.rejects(b.rendre(1001), (e) => e.code === 'CHF03' || /dépasse le dépôt/.test(e.message));
    assert.strictEqual(await b.dispo(), 1000);
    assert.strictEqual((await b.lignes()).length, 1, 'aucune ligne ajoutée');
  } finally { await b.db.close(); }
});

test('SQL : un dépôt déjà entièrement rendu ne peut pas l\'être deux fois ; un dépôt transféré (hospitalisation) se rend aussi ; un paiement annulé ne compte pas', sauf, async () => {
  const b = await base();
  try {
    await b.payer({ mode: 'transfert_hospitalisation', montant: 0, details: { depot_transfere: 700 } });
    await b.rendre(700);
    await assert.rejects(b.rendre(1), (e) => e.code === 'CHF01' || /Aucun dépôt/.test(e.message));
    await b.db.query(`update paiements set annule = true where mode = 'remboursement_patient'`);
    assert.strictEqual(await b.dispo(), 700, 'remboursement annulé : le dépôt est de nouveau là');
  } finally { await b.db.close(); }
});

// ---------------- la route, avec de faux services ----------------
function monterRoute({ droits = ['caisse_travailler'], rpc, existant = null } = {}) {
  const routes = {};
  const app = new Proxy({}, { get: (_, m) => (chemin, ...h) => { routes[`${String(m).toUpperCase()} ${chemin}`] = h[h.length - 1]; } });
  const audits = []; const appelsRpc = [];
  const table = (donnees) => { const q = { select: () => q, eq: () => q, is: () => q, maybeSingle: async () => ({ data: donnees, error: null }) }; return q; };
  const supabase = {
    from: (nom) => table(nom === 'episodes' ? { id: EP, dossier_id: 'd1', type_patient: 'prive', ong_partenaire: null } : nom === 'dossiers' ? { nom: 'Marie Test' } : existant),
    rpc: async (nomFonction, args) => { appelsRpc.push({ nomFonction, args }); return rpc ? rpc(args) : { data: { id: 'p1', mode: 'remboursement_patient', montant: args.p_montant }, error: null }; },
  };
  require('../routes/caisse.js')(app, { aPermission: async (_, d) => droits.includes(d), calculerSoldeDepot: () => ({}), enregistrerAuditServeur: (_, a, d) => audits.push({ a, d }), estUnVraiUuid: (x) => /^[0-9a-f-]{36}$/.test(String(x || '')), lireToutesLesPages: async () => [], supabase, synchroListes: {} });
  const appeler = async (corps, id = EP) => { let statut = 200; let json; const res = { status(s) { statut = s; return this; }, json(j) { json = j; return this; } }; await routes['POST /api/episodes/:id/rendre-depot']({ params: { id }, body: corps, user: { id: 'u1', email: 'caisse@chf.ht' } }, res); return { statut, json }; };
  return { appeler, audits, appelsRpc };
}
const valide = { montant: 2000.004, motif: 'Patient sorti, dépôt non dépensé', autorise_par: 'Madame Dioumitrie' };

test('route : la caisse rend le dépôt — montant arrondi, motif et « autorisé par » gardés dans les détails, audit, 201', async () => {
  const m = monterRoute();
  const r = await m.appeler(valide);
  assert.strictEqual(r.statut, 201);
  const { nomFonction, args } = m.appelsRpc[0];
  assert.strictEqual(nomFonction, 'rendre_depot_atomique');
  assert.strictEqual(args.p_montant, 2000);
  assert.deepStrictEqual(args.p_corps.details, { motif: 'Patient sorti, dépôt non dépensé', autorise_par: 'Madame Dioumitrie' });
  assert.strictEqual(args.p_corps.patient_nom, 'Marie Test');
  assert.strictEqual(m.audits[0].a, 'depot_rendu');
  assert.strictEqual(m.audits[0].d.montant, 2000);
});

test('route : refus sans le droit, sans motif, sans « autorisé par », montant invalide, épisode invalide ; la base n\'est jamais appelée', async () => {
  assert.strictEqual((await monterRoute({ droits: [] }).appeler(valide)).statut, 403);
  const m = monterRoute();
  assert.strictEqual((await m.appeler({ ...valide, motif: ' a ' })).json.code, 'MOTIF_REQUIS');
  assert.strictEqual((await m.appeler({ ...valide, autorise_par: ' ' })).json.code, 'AUTORISE_PAR_REQUIS');
  for (const montant of [undefined, '', 'abc', -3]) assert.strictEqual((await m.appeler({ ...valide, montant })).statut, 400, String(montant));
  assert.strictEqual((await m.appeler(valide, 'pas-un-uuid')).statut, 400);
  assert.strictEqual(m.appelsRpc.length, 0);
});

test("seuls Jean Jacques et Madame Dioumitrie peuvent autoriser de rendre un dépôt — tout autre nom est refusé par le serveur", async () => {
  for (const ok of ['Jean Jacques', 'Madame Dioumitrie']) assert.strictEqual((await monterRoute().appeler({ ...valide, autorise_par: ok })).statut, 201, ok);
  const m = monterRoute();
  for (const mauvais of ['Dr Esdras', 'jean jacques', 'Jean', 'Direction', 'Moi-même']) {
    const r = await m.appeler({ ...valide, autorise_par: mauvais });
    assert.strictEqual(r.statut, 400, mauvais);
    assert.strictEqual(r.json.code, 'AUTORISE_PAR_INVALIDE', mauvais);
  }
  assert.strictEqual(m.appelsRpc.length, 0, 'la base n\'est jamais appelée');
});

test('route : refus de la base → 400 avec le montant en Gdes ; fonction absente → 503 ; rejeu → la ligne existante ; autre erreur → 500', async () => {
  const refus = monterRoute({ rpc: () => ({ data: null, error: { code: 'CHF03', message: 'Le montant à rendre (900) dépasse le dépôt disponible (500).' } }) });
  const r = await refus.appeler(valide);
  assert.strictEqual(r.statut, 400);
  assert.match(r.json.error, /\(900 Gdes\).*\(500 Gdes\)/);
  assert.strictEqual(refus.audits.length, 0);
  assert.strictEqual((await monterRoute({ rpc: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) }).appeler(valide)).statut, 503);
  const rejeu = monterRoute({ existant: { id: 'p0', montant: 2000 } });
  const rr = await rejeu.appeler({ ...valide, local_id: 'loc-9' });
  assert.strictEqual(rr.statut, 200);
  assert.strictEqual(rejeu.appelsRpc.length, 0, 'pas de 2e remboursement');
  assert.strictEqual((await monterRoute({ rpc: () => ({ data: null, error: { code: 'XX000', message: 'boum' } }) }).appeler(valide)).statut, 500);
});
