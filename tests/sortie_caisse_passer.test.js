// tests/sortie_caisse_passer.test.js — « Passer » une sortie de caisse sans demande (27/10, Esdras) : la direction décide sur papier, la caisse saisit motif + montant + « autorisé par »
// et clique sur Passer : la sortie est enregistrée tout de suite comme ACCORDÉE, au nom de la personne, avec la mention de qui a autorisé. Route testée avec de faux services.
const { test } = require('node:test');
const assert = require('node:assert');

function monter({ droits = ['caisse_travailler'], erreurInsert = null, existant = null } = {}) {
  const routes = {};
  const app = new Proxy({}, { get: (_, m) => (chemin, ...h) => { routes[`${String(m).toUpperCase()} ${chemin}`] = h[h.length - 1]; } });
  const audits = []; const insertions = [];
  const supabase = {
    from: (nom) => {
      assert.strictEqual(nom, 'depenses_caisse');
      const q = {
        select: () => q, eq: () => q, maybeSingle: async () => ({ data: existant, error: null }),
        insert: (ligne) => { insertions.push(ligne); return { select: () => ({ single: async () => (erreurInsert ? { data: null, error: erreurInsert } : { data: { id: 'd1', ...ligne }, error: null }) }) }; },
      };
      return q;
    },
  };
  require('../routes/caisse.js')(app, { aPermission: async (_, d) => droits.includes(d), calculerSoldeDepot: () => ({}), enregistrerAuditServeur: (_, a, d) => audits.push({ a, d }), estUnVraiUuid: () => true, lireToutesLesPages: async () => [], supabase, synchroListes: {} });
  const appeler = async (corps) => { let statut = 200; let json; const res = { status(s) { statut = s; return this; }, json(j) { json = j; return this; } }; await routes['POST /api/depenses-caisse/passer']({ body: corps, user: { id: 'u1', email: 'caisse@chf.ht' } }, res); return { statut, json }; };
  return { appeler, audits, insertions };
}
const valide = { motif: 'Achat de gaz pour la cuisine', montant: 1500, autorise_par: 'Jean Jacques', local_id: 'loc-1' };

test('passer une sortie : enregistrée tout de suite comme ACCORDÉE, au nom de la caisse, avec « autorisé par », trace d\'audit, 201', async () => {
  const m = monter();
  const r = await m.appeler(valide);
  assert.strictEqual(r.statut, 201);
  const l = m.insertions[0];
  assert.strictEqual(l.statut, 'accorde', 'aucune étape « en attente »');
  assert.strictEqual(l.montant, 1500);
  assert.strictEqual(l.autorise_par, 'Jean Jacques');
  assert.strictEqual(l.caissier_uid, 'u1', 'compte pour la session de cette personne (théorique attendu)');
  assert.strictEqual(l.demandeur_uid, 'u1');
  assert.ok(l.date_reponse && !Number.isNaN(Date.parse(l.date_reponse)), 'date de passage');
  assert.strictEqual(l.local_id, 'loc-1');
  assert.strictEqual(m.audits[0].a, 'sortie_caisse_passee');
  assert.strictEqual(m.audits[0].d.autorise_par, 'Jean Jacques');
});

test('refus : sans le droit de travailler à la caisse, sans motif, sans « autorisé par », montant nul / négatif / illisible — rien n\'est écrit', async () => {
  assert.strictEqual((await monter({ droits: ['sortie_caisse_demander'] }).appeler(valide)).statut, 403);
  const m = monter();
  assert.strictEqual((await m.appeler({ ...valide, motif: ' a ' })).json.code, 'MOTIF_REQUIS');
  assert.strictEqual((await m.appeler({ ...valide, autorise_par: '  ' })).json.code, 'AUTORISE_PAR_REQUIS');
  assert.strictEqual((await m.appeler({ ...valide, autorise_par: undefined })).statut, 400);
  for (const montant of [0, -10, '', 'abc', undefined, null]) assert.strictEqual((await m.appeler({ ...valide, montant })).statut, 400, String(montant));
  assert.strictEqual((await m.appeler({ ...valide, motif: 'x'.repeat(301) })).statut, 400);
  assert.strictEqual((await m.appeler({ ...valide, autorise_par: 'x'.repeat(101) })).statut, 400);
  assert.strictEqual(m.insertions.length, 0);
});

test("seuls Jean Jacques et Madame Dioumitrie peuvent autoriser une sortie de fonds — tout autre nom est refusé par le serveur, même si l'écran est contourné", async () => {
  for (const ok of ['Jean Jacques', 'Madame Dioumitrie', '  Jean Jacques  ']) {
    const m = monter();
    assert.strictEqual((await m.appeler({ ...valide, autorise_par: ok })).statut, 201, ok);
    assert.strictEqual(m.insertions[0].autorise_par, ok.trim(), 'le nom est gardé sans espaces autour');
  }
  const m = monter();
  for (const mauvais of ['Dr Esdras', 'jean jacques', 'Jean', 'Madame Dioumitrie ET moi', 'Moi-même', 'Direction']) {
    const r = await m.appeler({ ...valide, autorise_par: mauvais });
    assert.strictEqual(r.statut, 400, mauvais);
    assert.strictEqual(r.json.code, 'AUTORISE_PAR_INVALIDE', mauvais);
    assert.match(r.json.error, /Jean Jacques et Madame Dioumitrie/);
  }
  assert.strictEqual(m.insertions.length, 0, 'rien n\'est enregistré');
});

test('rejeu (même local_id) : la sortie déjà enregistrée est renvoyée, jamais une 2e ; erreur de la base → 500', async () => {
  const dejaLa = monter({ existant: { id: 'd0', montant: 1500, statut: 'accorde' } });
  const r = await dejaLa.appeler(valide);
  assert.strictEqual(r.statut, 200);
  assert.strictEqual(r.json.id, 'd0');
  assert.strictEqual(dejaLa.insertions.length, 0, 'pas de doublon');
  const panne = monter({ erreurInsert: { code: 'XX000', message: 'boum' } });
  assert.strictEqual((await panne.appeler({ ...valide, local_id: undefined })).statut, 500);
});

test('le montant est arrondi au centime comme les autres montants de la caisse', async () => {
  const m = monter();
  await m.appeler({ ...valide, montant: 100.004 });
  assert.strictEqual(m.insertions[0].montant, 100);
});
