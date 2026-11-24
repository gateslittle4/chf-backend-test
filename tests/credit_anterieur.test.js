// tests/credit_anterieur.test.js — 24/11 (Esdras) : « un endroit où mettre un montant que la personne doit à l'hôpital, genre crédit ; certains ont un crédit pas encore passé dans le système ».
// La vraie route POST /api/credits-anterieurs (routes/caisse.js) contre un faux Supabase en mémoire.
const { test } = require('node:test');
const assert = require('node:assert');
const { creerFauxSupabase } = require('./aides/fauxSupabase');

const D = '11111111-1111-4111-8111-111111111111';
function monter({ droits = ['facturation_modifier'], dossiers } = {}) {
  const routes = {};
  const app = new Proxy({}, { get: (_, m) => (chemin, ...h) => { routes[`${String(m).toUpperCase()} ${chemin}`] = h[h.length - 1]; } });
  const audits = [];
  const supabase = creerFauxSupabase({
    dossiers: dossiers || [{ id: D, nom: 'Marie Test' }, { id: '22222222-2222-4222-8222-222222222222', nom: 'Fusionnée', fusionne_dans: D }],
    episodes: [], paiements: [], users: [{ id: 'u1', display_name: 'Esdras' }],
  });
  require('../routes/caisse.js')(app, { aPermission: async (_, d) => droits.includes(d), calculerSoldeDepot: () => ({}), enregistrerAuditServeur: (_, a, d) => audits.push({ a, d }), estUnVraiUuid: (x) => /^[0-9a-f-]{36}$/.test(String(x || '')), lireToutesLesPages: async () => [], supabase, synchroListes: {} });
  const appeler = async (corps) => { let statut = 200; let json; const res = { status(s) { statut = s; return this; }, json(j) { json = j; return this; } }; await routes['POST /api/credits-anterieurs']({ body: corps, user: { id: 'u1', email: 'e@chf.com' } }, res); return { statut, json }; };
  return { appeler, audits, tables: supabase.tables };
}

test('un crédit antérieur crée un épisode fermé « Crédit antérieur » et un paiement à crédit de 0 Gdes dont le reste dû est le montant ; audit ; 201', async () => {
  const m = monter();
  const r = await m.appeler({ dossier_id: D, montant: 12500.004, note: 'Dette de septembre', local_id: 'c1' });
  assert.strictEqual(r.statut, 201, JSON.stringify(r.json));
  const ep = m.tables.episodes[0], p = m.tables.paiements[0];
  assert.deepStrictEqual({ d: ep.dossier_id, s: ep.statut, t: ep.type_consultation, h: ep.est_hospitalisation, v: ep.voie_entree }, { d: D, s: 'ferme', t: 'Crédit antérieur', h: false, v: 'consultation' });
  assert.deepStrictEqual({ e: p.episode_id, mode: p.mode, montant: p.montant, reste: p.solde_restant, nom: p.patient_nom, par: p.encaisse_par }, { e: ep.id, mode: 'credit', montant: 0, reste: 12500, nom: 'Marie Test', par: 'Esdras' });
  assert.deepStrictEqual(p.details, { credit_anterieur: true, note: 'Dette de septembre' });
  assert.strictEqual(m.audits[0].a, 'credit_anterieur_enregistre');
  assert.strictEqual(m.audits[0].d.montant, 12500);
});

test('la date du crédit (date_credit) fixe depuis quand la personne doit ; une date future ou illisible est refusée', async () => {
  const m = monter();
  const r = await m.appeler({ dossier_id: D, montant: 500, date_credit: '2026-09-15' });
  assert.strictEqual(r.statut, 201);
  assert.strictEqual(new Date(m.tables.paiements[0].date_paiement).toISOString().slice(0, 10), '2026-09-15');
  assert.strictEqual(new Date(m.tables.episodes[0].date_ouverture).toISOString().slice(0, 10), '2026-09-15');
  assert.strictEqual((await m.appeler({ dossier_id: D, montant: 500, date_credit: '2999-01-01' })).json.code, 'DATE_INVALIDE');
  assert.strictEqual((await m.appeler({ dossier_id: D, montant: 500, date_credit: 'hier' })).json.code, 'DATE_INVALIDE');
});

test('rejeu (même local_id) : la dette n\'est jamais comptée deux fois', async () => {
  const m = monter();
  assert.strictEqual((await m.appeler({ dossier_id: D, montant: 700, local_id: 'c9' })).statut, 201);
  const r2 = await m.appeler({ dossier_id: D, montant: 700, local_id: 'c9' });
  assert.strictEqual(r2.statut, 200); assert.strictEqual(r2.json.deja_applique, true);
  assert.strictEqual(m.tables.paiements.length, 1); assert.strictEqual(m.tables.episodes.length, 1);
});

test('refus : sans droit (403), montant vide/zéro/négatif/texte (400), dossier invalide, inconnu ou fusionné ; rien n\'est écrit', async () => {
  assert.strictEqual((await monter({ droits: ['caisse_travailler'] }).appeler({ dossier_id: D, montant: 500 })).statut, 403, 'la caisse seule ne peut pas');
  assert.strictEqual((await monter({ droits: ['demandes_repondre'] }).appeler({ dossier_id: D, montant: 500 })).statut, 201, 'la direction (demandes_repondre) peut');
  const m = monter();
  for (const montant of [undefined, '', 0, -5, 'abc', 1e12]) assert.strictEqual((await m.appeler({ dossier_id: D, montant })).statut, 400, String(montant));
  assert.strictEqual((await m.appeler({ dossier_id: 'pas-un-uuid', montant: 5 })).json.code, 'DOSSIER_INVALIDE');
  assert.strictEqual((await m.appeler({ dossier_id: '33333333-3333-4333-8333-333333333333', montant: 5 })).statut, 404);
  assert.strictEqual((await m.appeler({ dossier_id: '22222222-2222-4222-8222-222222222222', montant: 5 })).json.code, 'DOSSIER_FUSIONNE');
  assert.strictEqual((await m.appeler({ dossier_id: D, montant: 5, note: 'x'.repeat(301) })).json.code, 'NOTE_TROP_LONGUE');
  assert.strictEqual(m.tables.paiements.length, 0); assert.strictEqual(m.tables.episodes.length, 0);
});
