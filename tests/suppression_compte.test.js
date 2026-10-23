// tests/suppression_compte.test.js — « permets à l'administrateur de supprimer totalement un compte » (15/10).
// EXÉCUTE la vraie route DELETE /api/admin/users/:uid (extraite de server.js) contre un faux Supabase et un faux Firebase.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function monter({ users, permission = true, firebaseAbsent = false, firebaseEchoue = false }) {
  const debut = serverSrc.indexOf("app.delete('/api/admin/users/:uid'");
  const fin = serverSrc.indexOf("// Génère un lien de réinitialisation SANS envoyer d'email", debut);
  assert.ok(debut !== -1 && fin > debut, 'route introuvable');
  const audits = [];
  const supprimesFirebase = [];
  const lignes = users.map(u => ({ active: true, ...u }));
  const supabase = {
    from(table) {
      if (table === 'audit_log') return { insert: async (l) => { audits.push(l); return { error: null }; } };
      assert.strictEqual(table, 'users');
      let filtres = [];
      const construire = (mode) => {
        const q = {
          eq: (c, v) => { filtres.push((u) => u[c] === v); return q; },
          neq: (c, v) => { filtres.push((u) => u[c] !== v); return q; },
          select: () => q,
          maybeSingle: async () => ({ data: lignes.filter(u => filtres.every(f => f(u)))[0] || null, error: null }),
          then: (ok, ko) => {
            const cibles = lignes.filter(u => filtres.every(f => f(u)));
            if (mode === 'delete') cibles.forEach(c => lignes.splice(lignes.indexOf(c), 1));
            return Promise.resolve({ data: cibles, error: null }).then(ok, ko);
          },
        };
        return q;
      };
      return { select: () => construire('select'), delete: () => construire('delete') };
    },
  };
  const getAuth = () => ({ deleteUser: async (uid) => {
    if (firebaseEchoue) throw Object.assign(new Error('boum'), { code: 'auth/internal-error' });
    if (firebaseAbsent) throw Object.assign(new Error('absent'), { code: 'auth/user-not-found' });
    supprimesFirebase.push(uid);
  } });
  let gestionnaire;
  const app = { delete: (_c, fn) => { gestionnaire = fn; } };
  const aPermission = async () => permission;
  new Function('app', 'supabase', 'aPermission', 'getAuth', 'crypto', 'console', serverSrc.slice(debut, fin))(app, supabase, aPermission, getAuth, crypto, { warn() {}, log() {}, error() {} });
  const appeler = async (uid, utilisateur) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    await gestionnaire({ params: { uid }, user: utilisateur }, res);
    return res;
  };
  return { appeler, lignes, audits, supprimesFirebase };
}

const ADMIN = { id: 'adm1', email: 'adm1@chf.com', role: 'administrateur', display_name: 'Esdras' };

test("Un compte ACTIF (non désactivé) est supprimé directement : Firebase, ligne users, journal", async () => {
  const { appeler, lignes, audits, supprimesFirebase } = monter({ users: [ADMIN, { id: 'c1', email: 'marie@chf.com', role: 'caissier', display_name: 'Marie' }] });
  const r = await appeler('c1', { id: 'adm1', email: 'adm1@chf.com' });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(supprimesFirebase, ['c1']);
  assert.deepStrictEqual(lignes.map(u => u.id), ['adm1']);
  assert.strictEqual(audits.length, 1);
  assert.strictEqual(audits[0].action, 'suppression_utilisateur');
  assert.strictEqual(audits[0].details.email, 'marie@chf.com');
});

test("Un compte déjà désactivé se supprime toujours ; un compte déjà absent de Firebase aussi (la ligne users part quand même)", async () => {
  const a = monter({ users: [ADMIN, { id: 'c1', role: 'caissier', active: false }] });
  assert.strictEqual((await a.appeler('c1', { id: 'adm1' })).code, 200);
  const b = monter({ users: [ADMIN, { id: 'c2', role: 'caissier' }], firebaseAbsent: true });
  assert.strictEqual((await b.appeler('c2', { id: 'adm1' })).code, 200);
  assert.deepStrictEqual(b.lignes.map(u => u.id), ['adm1']);
});

test("Jamais son propre compte ; compte introuvable → 404 ; sans permission → 403 ; échec Firebase → 500 et la fiche reste", async () => {
  const m = monter({ users: [ADMIN, { id: 'c1', role: 'caissier' }] });
  assert.strictEqual((await m.appeler('adm1', { id: 'adm1' })).code, 400);
  assert.strictEqual((await m.appeler('zzz', { id: 'adm1' })).code, 404);
  assert.strictEqual((await monter({ users: [ADMIN, { id: 'c1', role: 'caissier' }], permission: false }).appeler('c1', { id: 'x' })).code, 403);
  const e = monter({ users: [ADMIN, { id: 'c1', role: 'caissier' }], firebaseEchoue: true });
  assert.strictEqual((await e.appeler('c1', { id: 'adm1' })).code, 500);
  assert.strictEqual(e.lignes.length, 2, 'rien supprimé si la connexion Firebase n\'a pas pu l\'être');
});

test("Un administrateur peut en supprimer un autre tant qu'il en reste un actif ; jamais le dernier ; un non-administrateur ne peut pas", async () => {
  const ADMIN2 = { id: 'adm2', email: 'adm2@chf.com', role: 'administrateur' };
  const ok = monter({ users: [ADMIN, ADMIN2] });
  assert.strictEqual((await ok.appeler('adm2', { id: 'adm1' })).code, 200);
  assert.deepStrictEqual(ok.lignes.map(u => u.id), ['adm1']);

  // Garde-fou : si le seul administrateur ACTIF est la cible, la suppression est refusée (l'appelant ici est un administrateur désactivé).
  const dernier = monter({ users: [{ ...ADMIN, active: false }, ADMIN2] });
  const r = await dernier.appeler('adm2', { id: 'adm1' });
  assert.strictEqual(r.code, 400);
  assert.match(r.corps.error, /dernier administrateur actif/);
  assert.strictEqual(dernier.lignes.length, 2);

  const gestionnaire = { id: 'g1', role: 'direction' };
  const refus = monter({ users: [ADMIN, ADMIN2, gestionnaire] });
  const r2 = await refus.appeler('adm2', { id: 'g1' });
  assert.strictEqual(r2.code, 403);
  assert.match(r2.corps.error, /administrateur/);
  assert.strictEqual(refus.lignes.length, 3);
});
