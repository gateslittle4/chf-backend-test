// tests/lien_reinitialisation.test.js — « Erreur : Domain not allowlisted by project » en générant un lien de mot de passe perdu (15/10).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { genererLienReinitialisation, domaineRefuse } = require('../utils/lienReinitialisation');

const refus = () => Object.assign(new Error('Domain not allowlisted by project'), { code: 'auth/unauthorized-continue-uri' });

test("Domaine autorisé : le lien est créé avec le retour vers le site", async () => {
  const appels = [];
  const auth = { generatePasswordResetLink: async (email, opts) => { appels.push([email, opts]); return 'https://lien/ok'; } };
  const r = await genererLienReinitialisation(auth, 'a@chf.com', 'https://app.chffontaine.org');
  assert.deepStrictEqual(r, { lien: 'https://lien/ok', retourAuSite: true });
  assert.deepStrictEqual(appels, [['a@chf.com', { url: 'https://app.chffontaine.org' }]]);
});

test("Domaine NON autorisé : on réessaie sans adresse de retour et le lien est quand même donné", async () => {
  const appels = [];
  const auth = { generatePasswordResetLink: async (email, opts) => { appels.push(opts); if (opts) throw refus(); return 'https://lien/sans-retour'; } };
  const r = await genererLienReinitialisation(auth, 'a@chf.com', 'https://app.chffontaine.org');
  assert.deepStrictEqual(r, { lien: 'https://lien/sans-retour', retourAuSite: false });
  assert.strictEqual(appels.length, 2);
  assert.strictEqual(appels[1], undefined);
  // reconnu aussi par le message seul (version du SDK sans code)
  assert.strictEqual(domaineRefuse(new Error('Domain not allowlisted by project')), true);
});

test("Les autres erreurs ne sont jamais avalées (compte introuvable → relancée telle quelle)", async () => {
  const introuvable = Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
  const auth = { generatePasswordResetLink: async () => { throw introuvable; } };
  await assert.rejects(genererLienReinitialisation(auth, 'x@chf.com', 'https://app.chffontaine.org'), (e) => e === introuvable);
});

test("La route utilise l'aide, garde la réponse 404 pour un compte introuvable et signale l'absence de retour au site", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const bloc = src.slice(src.indexOf("app.post('/api/admin/generer-lien-reinitialisation'"), src.indexOf("// Côté administrateur des liens d'invitation"));
  assert.match(bloc, /genererLienReinitialisation\(getAuth\(\)/);
  assert.match(bloc, /auth\/user-not-found/);
  assert.match(bloc, /avertissement/);
  assert.match(bloc, /aPermission\(req\.user\.id, 'utilisateurs_gerer'\)/);
});
