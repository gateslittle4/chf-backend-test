// tests/numero_dossier_caisse.test.js — « seule la caisse donne le numéro de dossier, quand la personne a payé » (Esdras, 16/10).
// EXÉCUTE les vraies routes (extraites de server.js) contre un faux Supabase : création sans numéro, droit de la caisse, attribution automatique ou modifiée,
// réglage du numéro de départ réservé à l'administrateur. Les règles pures sont dans utils/numeroDossier.js ; le SQL est testé par scripts/test-numero-dossier-sql.py.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const N = require('../utils/numeroDossier');
const { memePatient, formaterNomPropre, erreurIdentiteDossier } = require('../utils/dossiers');

const serveur = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ---------------------------------------------------------------------------------------------------------------------------------
// Règles pures
// ---------------------------------------------------------------------------------------------------------------------------------
test("numéro provisoire : préfixe réservé, 10 caractères au hasard, jamais deux fois le même ; reconnu comme « en attente »", () => {
  const a = N.numeroProvisoire(), b = N.numeroProvisoire();
  assert.match(a, /^EN-ATTENTE-[0-9A-F]{10}$/);
  assert.notStrictEqual(a, b);
  assert.strictEqual(N.estEnAttente(a), true);
  for (const x of ['1234', 'AUTO-1760000000000', '', null, undefined, 12, 'en-attente-x']) assert.strictEqual(N.estEnAttente(x), false, String(x));
});

test("numéro donné par la caisse : non vide, 30 caractères au plus, jamais un numéro réservé par le site (EN-ATTENTE-, AUTO-)", () => {
  for (const ok of ['1', '5002', 'A-12/b', 'HGF 2026-17', 'x'.repeat(30), ' 42 ']) assert.strictEqual(N.erreurNumeroDossier(ok), null, ok);
  for (const mauvais of ['', '   ', null, undefined, {}, [], 'x'.repeat(31)]) assert.ok(N.erreurNumeroDossier(mauvais), JSON.stringify(mauvais));
  assert.match(N.erreurNumeroDossier('EN-ATTENTE-123'), /réservé/);
  assert.match(N.erreurNumeroDossier('en-attente-123'), /réservé/, 'majuscules ou non');
  assert.match(N.erreurNumeroDossier('AUTO-55'), /réservé/);
});

test("numéro de départ : entier de 1 à 999 999 999 (nombre ou texte de chiffres), rien d'autre", () => {
  for (const ok of [1, 5000, '5000', ' 12 ', 999999999]) assert.strictEqual(N.erreurNumeroDepart(ok), null, String(ok));
  for (const mauvais of [0, -3, 1.5, '1.5', '0', '', 'abc', null, undefined, 1000000000, NaN, {}]) assert.ok(N.erreurNumeroDepart(mauvais), String(mauvais));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// POST /api/dossiers : qui peut donner un numéro
// ---------------------------------------------------------------------------------------------------------------------------------
function fauxBase() {
  const dossiers = [], audits = [];
  return {
    dossiers, audits,
    from(table) {
      if (table === 'dossiers') return {
        insert: (ligne) => ({ select: () => ({ single: async () => {
          if (dossiers.some(d => d.numero_dossier === ligne.numero_dossier)) return { data: null, error: { code: '23505', message: 'duplicate' } };
          const d = { id: `d-${dossiers.length + 1}`, ...ligne }; dossiers.push(d); return { data: d, error: null };
        } }) }),
        select: () => ({ eq: (col, val) => ({ maybeSingle: async () => ({ data: dossiers.find(d => d[col] === val) || null, error: null }) }) }),
      };
      if (table === 'audit_log') return { insert: async (l) => { audits.push(l); return { error: null }; } };
      throw new Error('table inattendue : ' + table);
    },
  };
}
function routeCreation({ droits = ['dossier_creer', 'caisse_travailler'] } = {}) {
  const debut = serveur.indexOf("app.post('/api/dossiers', async (req, res) => {");
  const fin = serveur.indexOf("app.get('/api/dossiers/:id'", debut);
  const supabase = fauxBase();
  let gestionnaire; const app = { post: (_c, fn) => { gestionnaire = fn; } };
  const aPermission = async (_u, cle) => droits.includes(cle);
  new Function('app', 'supabase', 'aPermission', 'dateOuNull', 'memePatient', 'formaterNomPropre', 'crypto', 'console', 'verifierMere', 'erreurIdentiteDossier', 'numeroProvisoire', 'erreurNumeroDossier', serveur.slice(debut, fin))(
    app, supabase, aPermission, (v) => (v ? v : null), memePatient, formaterNomPropre, crypto, { warn() {}, log() {}, error() {} }, require('../utils/naissance').verifierMere, erreurIdentiteDossier, N.numeroProvisoire, N.erreurNumeroDossier);
  return { supabase, appeler: async (corps) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    await gestionnaire({ body: { sexe: 'F', date_naissance: '1990-05-05', nom: 'Marie Joseph', ...corps }, user: { id: 'u1', email: 'a@b.c' } }, res);
    return res;
  } };
}

test("infirmier / archiviste : créer un dossier SANS numéro marche — il est « en attente » sous un numéro provisoire", async () => {
  const { appeler, supabase } = routeCreation({ droits: ['dossier_creer'] });
  const r = await appeler({ local_id: 'l-1' });
  assert.strictEqual(r.code, 201);
  assert.ok(N.estEnAttente(r.corps.numero_dossier));
  assert.strictEqual(supabase.dossiers.length, 1);
  const r2 = await appeler({ nom: 'Jean Paul', numero_dossier: '   ', local_id: 'l-2' });
  assert.strictEqual(r2.code, 201, 'un numéro vide ou fait d\'espaces = pas de numéro');
  assert.ok(N.estEnAttente(r2.corps.numero_dossier));
  assert.notStrictEqual(r.corps.numero_dossier, r2.corps.numero_dossier, 'deux dossiers en attente ne partagent jamais le même numéro provisoire');
});

test("infirmier / archiviste : donner un numéro à la création est REFUSÉ (403, rien n'est créé) — jamais ignoré en silence", async () => {
  const { appeler, supabase } = routeCreation({ droits: ['dossier_creer'] });
  const r = await appeler({ numero_dossier: '1234' });
  assert.strictEqual(r.code, 403);
  assert.strictEqual(r.corps.code, 'NUMERO_RESERVE_CAISSE');
  assert.match(r.corps.error, /Seule la caisse peut donner un numéro/);
  assert.strictEqual(supabase.dossiers.length, 0);
});

test("la caisse : peut créer un dossier avec un numéro, ou sans (en attente) ; un numéro réservé ou trop long est refusé (400)", async () => {
  const { appeler, supabase } = routeCreation({ droits: ['caisse_travailler'] });
  const avec = await appeler({ numero_dossier: ' 5002 ', local_id: 'l-1' });
  assert.strictEqual(avec.code, 201); assert.strictEqual(avec.corps.numero_dossier, '5002', 'espaces retirés');
  const sans = await appeler({ nom: 'Jean Paul', local_id: 'l-2' });
  assert.strictEqual(sans.code, 201); assert.ok(N.estEnAttente(sans.corps.numero_dossier));
  for (const mauvais of ['EN-ATTENTE-1', 'AUTO-9', 'x'.repeat(31)]) {
    const r = await appeler({ nom: 'Autre ' + mauvais.length, numero_dossier: mauvais });
    assert.strictEqual(r.code, 400, mauvais);
  }
  assert.strictEqual(supabase.dossiers.length, 2);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// POST /api/dossiers/:id/numero, GET /api/dossiers/numero-propose, réglage du départ
// ---------------------------------------------------------------------------------------------------------------------------------
function routesNumero({ droits = ['caisse_travailler'], role = 'administrateur', rpc = {} } = {}) {
  const debut = serveur.indexOf("app.get('/api/dossiers/numero-propose'");
  const fin = serveur.indexOf('// ⚠️ Déclarée AVANT /api/dossiers/:id, sinon Express y verrait un dossier nommé "liste-hors-ligne".', debut);
  assert.ok(debut !== -1 && fin > debut, 'routes introuvables');
  const routes = {}; const audits = []; const appelsRpc = [];
  const app = { get: (c, fn) => { routes['GET ' + c] = fn; }, post: (c, fn) => { routes['POST ' + c] = fn; }, put: (c, fn) => { routes['PUT ' + c] = fn; } };
  const supabase = {
    from(table) { assert.strictEqual(table, 'users'); const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: role ? { role } : null, error: null }) }; return q; },
    rpc: async (nom, args) => { appelsRpc.push([nom, args]); const r = rpc[nom]; return typeof r === 'function' ? r(args) : (r || { data: null, error: null }); },
  };
  new Function('app', 'supabase', 'aPermission', 'erreurNumeroDossier', 'erreurNumeroDepart', 'enregistrerAuditServeur', serveur.slice(debut, fin))(
    app, supabase, async (_u, cle) => droits.includes(cle), N.erreurNumeroDossier, N.erreurNumeroDepart, async (_req, action, details) => { audits.push({ action, details }); });
  const appeler = async (cle, req = {}) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    await routes[cle]({ user: { id: 'u1', email: 'a@b.c' }, params: {}, body: {}, ...req }, res); return res;
  };
  return { appeler, audits, appelsRpc };
}

test("GET numero-propose : la caisse reçoit le prochain numéro libre ; infirmier et archiviste, 403", async () => {
  const caisse = routesNumero({ rpc: { numero_dossier_propose: { data: '5002', error: null } } });
  const r = await caisse.appeler('GET /api/dossiers/numero-propose');
  assert.deepStrictEqual([r.code, r.corps], [200, { numero: '5002' }]);
  const infirmier = routesNumero({ droits: [], rpc: { numero_dossier_propose: { data: '5002', error: null } } });
  const r2 = await infirmier.appeler('GET /api/dossiers/numero-propose');
  assert.strictEqual(r2.code, 403); assert.strictEqual(r2.corps.code, 'NUMERO_RESERVE_CAISSE');
  assert.strictEqual(infirmier.appelsRpc.length, 0, 'rien n\'est demandé à la base');
  const sansSql = routesNumero({ rpc: { numero_dossier_propose: { data: null, error: { code: '42883', message: 'x' } } } });
  assert.strictEqual((await sansSql.appeler('GET /api/dossiers/numero-propose')).code, 503, 'script SQL pas encore collé : message clair, pas une panne');
});

test("POST /:id/numero : la caisse donne le numéro, c'est écrit au journal (ancien, nouveau, automatique ou non) ; refusé aux autres rôles et pour un numéro invalide", async () => {
  const ok = routesNumero({ rpc: { attribuer_numero_dossier: { data: { numero: '5002', ancien: 'EN-ATTENTE-AAAAAAAAAA', automatique: true }, error: null } } });
  const r = await ok.appeler('POST /api/dossiers/:id/numero', { params: { id: 'd-1' }, body: { numero: ' 5002 ' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.corps.numero, '5002');
  assert.deepStrictEqual(ok.appelsRpc, [['attribuer_numero_dossier', { p_dossier: 'd-1', p_numero: '5002' }]]);
  assert.deepStrictEqual(ok.audits, [{ action: 'numero_dossier_donne', details: { dossier_id: 'd-1', ancien_numero: 'EN-ATTENTE-AAAAAAAAAA', nouveau_numero: '5002', automatique: true } }]);

  const refus = routesNumero({ droits: ['dossier_creer'] });
  const r2 = await refus.appeler('POST /api/dossiers/:id/numero', { params: { id: 'd-1' }, body: { numero: '5002' } });
  assert.strictEqual(r2.code, 403); assert.strictEqual(refus.appelsRpc.length, 0); assert.strictEqual(refus.audits.length, 0);

  for (const mauvais of ['', '  ', 'EN-ATTENTE-1', 'AUTO-1', 'x'.repeat(31), undefined]) {
    const x = routesNumero();
    assert.strictEqual((await x.appeler('POST /api/dossiers/:id/numero', { params: { id: 'd-1' }, body: { numero: mauvais } })).code, 400, String(mauvais));
    assert.strictEqual(x.appelsRpc.length, 0);
  }
});

test("POST /:id/numero : numéro déjà pris → 409, dossier inconnu → 404, numéro inchangé → 200 sans rien tracer", async () => {
  const cas = [['CHF32', 409, 'Ce numéro est déjà utilisé'], ['CHF31', 404, 'Dossier introuvable'], ['CHF30', 400, 'requis'], ['22P02', 404, 'invalid input'], ['XX000', 500, 'boum']];
  for (const [code, statut, message] of cas) {
    const x = routesNumero({ rpc: { attribuer_numero_dossier: { data: null, error: { code, message } } } });
    const r = await x.appeler('POST /api/dossiers/:id/numero', { params: { id: 'd-1' }, body: { numero: '12' } });
    assert.strictEqual(r.code, statut, code); assert.match(r.corps.error, new RegExp(message)); assert.strictEqual(x.audits.length, 0);
  }
  const inchange = routesNumero({ rpc: { attribuer_numero_dossier: { data: { numero: '12', ancien: '12', inchange: true }, error: null } } });
  const r = await inchange.appeler('POST /api/dossiers/:id/numero', { params: { id: 'd-1' }, body: { numero: '12' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(inchange.audits.length, 0);
});

test("réglage du numéro de départ : RÉSERVÉ à l'administrateur (même la direction est refusée) ; valeur contrôlée ; modification tracée", async () => {
  for (const role of ['direction', 'comptable', 'pharmacien', 'infirmier', null]) {
    const x = routesNumero({ role });
    assert.strictEqual((await x.appeler('GET /api/admin/numero-dossier-depart')).code, 403, String(role));
    assert.strictEqual((await x.appeler('PUT /api/admin/numero-dossier-depart', { body: { prochain: 5000 } })).code, 403, String(role));
    assert.strictEqual(x.appelsRpc.length, 0);
  }
  const admin = routesNumero({ rpc: { numero_dossier_depart: { data: 120, error: null }, definir_numero_dossier_depart: (a) => ({ data: a.p_prochain, error: null }) } });
  assert.deepStrictEqual((await admin.appeler('GET /api/admin/numero-dossier-depart')).corps, { prochain: 120 });
  const r = await admin.appeler('PUT /api/admin/numero-dossier-depart', { body: { prochain: '5000' } });
  assert.deepStrictEqual([r.code, r.corps], [200, { prochain: 5000 }]);
  assert.deepStrictEqual(admin.audits, [{ action: 'numero_dossier_depart_modifie', details: { ancien: 120, nouveau: 5000 } }]);
  for (const mauvais of [0, -1, 'abc', 1.5, null, 1e10]) {
    const x = routesNumero();
    assert.strictEqual((await x.appeler('PUT /api/admin/numero-dossier-depart', { body: { prochain: mauvais } })).code, 400, String(mauvais));
    assert.ok(!x.appelsRpc.some(([n]) => n === 'definir_numero_dossier_depart'));
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Câblage
// ---------------------------------------------------------------------------------------------------------------------------------
test("câblage : les routes de numéro sont déclarées AVANT /api/dossiers/:id (sinon « numero-propose » serait pris pour un dossier) et derrière la vérification du jeton", () => {
  const iJeton = serveur.indexOf("app.use('/api', verifyToken)");
  const iPropose = serveur.indexOf("app.get('/api/dossiers/numero-propose'");
  const iId = serveur.indexOf("app.get('/api/dossiers/:id', async");
  assert.ok(iJeton > 0 && iPropose > iJeton && iId > iPropose);
});

test("PUT /api/dossiers/:id : un numéro INCHANGÉ passe pour tout le monde, un numéro DIFFÉRENT exige la caisse", () => {
  const i = serveur.indexOf("app.put('/api/dossiers/:id'");
  const bloc = serveur.slice(i, i + 4000);
  assert.match(bloc, /String\(actuel\.numero_dossier\) !== String\(numero_dossier\)\.trim\(\)/);
  assert.match(bloc, /aPermission\(req\.user\.id, 'caisse_travailler'\)/);
  assert.match(bloc, /NUMERO_RESERVE_CAISSE/);
});

test("le compteur des numéros est sauvegardé ET restauré (table compteurs)", () => {
  assert.match(serveur, /'invitations', 'compteurs',\n\];/);
  assert.match(serveur, /\['compteurs', 'id'\]/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// PUT /api/dossiers/:id exécuté pour de vrai : qui peut changer un numéro
// ---------------------------------------------------------------------------------------------------------------------------------
function routeModification({ droits, numeroActuel = 'EN-ATTENTE-AAAAAAAAAA' }) {
  const debut = serveur.indexOf("app.put('/api/dossiers/:id', async");
  const fin = serveur.indexOf("app.get('/api/dossiers/:id/historique'", debut);
  assert.ok(debut !== -1 && fin > debut);
  const maj = []; let gestionnaire;
  const supabase = { from(table) {
    assert.strictEqual(table, 'dossiers');
    let patch = null;
    const q = {
      select: () => q, eq: () => q, update: (p) => { patch = p; maj.push(p); return q; },
      maybeSingle: async () => ({ data: { numero_dossier: numeroActuel, nom: 'Marie Joseph', anciens_noms: [], sexe: 'F', date_naissance: '1990-05-05' }, error: null }),
      then: (ok, ko) => Promise.resolve({ data: patch ? [{ id: 'd-1', ...patch }] : [], error: null }).then(ok, ko),
    };
    return q;
  } };
  new Function('app', 'supabase', 'aPermission', 'formaterNomPropre', 'dateOuNull', 'anciensNomsApresRenommage', 'verifierMere', 'erreurNumeroDossier', serveur.slice(debut, fin))(
    { put: (_c, fn) => { gestionnaire = fn; } }, supabase, async (_u, cle) => droits.includes(cle), formaterNomPropre, (v) => (v ? v : null), () => null, async () => ({ ok: true }), N.erreurNumeroDossier);
  return { maj, appeler: async (corps) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    await gestionnaire({ params: { id: 'd-1' }, body: { nom: 'Marie Joseph', sexe: 'F', date_naissance: '1990-05-05', ...corps }, user: { id: 'u1' } }, res); return res;
  } };
}

test("PUT : l'infirmier corrige un téléphone — le numéro renvoyé tel quel (inchangé) ne bloque pas, et n'est pas réécrit", async () => {
  const x = routeModification({ droits: ['fiche_patient_modifier'] });
  const r = await x.appeler({ telephone: '34567890', numero_dossier: 'EN-ATTENTE-AAAAAAAAAA' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(x.maj.length, 1); assert.strictEqual('numero_dossier' in x.maj[0], false, 'le numéro n\'est pas touché');
});

test("PUT : l'infirmier ou l'archiviste qui veut CHANGER le numéro est refusé (403) — rien n'est écrit", async () => {
  const x = routeModification({ droits: ['fiche_patient_modifier'] });
  const r = await x.appeler({ numero_dossier: '9999' });
  assert.strictEqual(r.code, 403); assert.strictEqual(r.corps.code, 'NUMERO_RESERVE_CAISSE'); assert.strictEqual(x.maj.length, 0);
});

test("PUT : la caisse peut changer le numéro ; un numéro réservé ou vide est refusé", async () => {
  const x = routeModification({ droits: ['fiche_patient_modifier', 'caisse_travailler'] });
  const r = await x.appeler({ numero_dossier: ' 9999 ' });
  assert.strictEqual(r.code, 200); assert.strictEqual(x.maj[0].numero_dossier, '9999');
  assert.strictEqual((await x.appeler({ numero_dossier: 'EN-ATTENTE-ZZZ' })).code, 400);
  assert.strictEqual((await x.appeler({ numero_dossier: '  ' })).code, 400);
  assert.strictEqual(x.maj.length, 1);
});
