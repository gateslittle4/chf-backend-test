// tests/renommer_partenaire.test.js — « je peux pas renommer un partenaire ? » (16/10) : route PATCH /api/ong-partenaires/:id/renommer, réservée à l'administrateur et à la direction.
// EXÉCUTE la vraie route (extraite de server.js) contre un faux Supabase. Le comportement SQL (historique + dons) est vérifié sur un Postgres jetable par scripts/test-renommer-partenaire-sql.py.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const serveurSrc = require('./serveurSource').lireServeur();

function monter({ role = 'administrateur', reponseRpc = { data: { episodes: 3, paiements: 2, dons: 1 }, error: null }, nomAvant = 'AVSI' } = {}) {
  const debut = serveurSrc.indexOf("app.patch('/api/ong-partenaires/:id/renommer'");
  const fin = serveurSrc.indexOf('// Décrémente le stock de façon atomique', debut);
  assert.ok(debut !== -1 && fin > debut, 'route introuvable');
  const appelsRpc = []; const audits = [];
  const supabase = {
    from(table) {
      const q = { select: () => q, eq: () => q, is: () => q, maybeSingle: async () => ({ data: table === 'users' ? (role ? { role } : null) : { nom: nomAvant }, error: null }) };
      return q;
    },
    rpc: async (nom, args) => { appelsRpc.push({ nom, args }); return reponseRpc; },
  };
  let gestionnaire;
  const app = { patch: (_c, fn) => { gestionnaire = fn; } };
  const enregistrerAuditServeur = async (_req, action, details) => { audits.push({ action, details }); };
  new Function('app', 'supabase', 'enregistrerAuditServeur', serveurSrc.slice(debut, fin))(app, supabase, enregistrerAuditServeur);
  const appeler = async (corps, id = 'p-avsi') => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    await gestionnaire({ user: { id: 'u1', email: 'a@b.c' }, params: { id }, body: corps }, res);
    return res;
  };
  return { appeler, appelsRpc, audits };
}

test('l\'administrateur et la direction peuvent renommer ; la route est derrière la vérification du jeton', async () => {
  assert.ok(serveurSrc.indexOf("app.patch('/api/ong-partenaires/:id/renommer'") > serveurSrc.indexOf("app.use('/api', verifyToken)"));
  for (const role of ['administrateur', 'direction']) {
    const { appeler, appelsRpc } = monter({ role });
    const res = await appeler({ nom: 'Avsi Haïti' });
    assert.strictEqual(res.code, 200, role);
    assert.deepStrictEqual(appelsRpc, [{ nom: 'renommer_partenaire', args: { p_id: 'p-avsi', p_nouveau_nom: 'Avsi Haïti' } }]);
    assert.deepStrictEqual(res.corps, { episodes: 3, paiements: 2, dons: 1, nom: 'Avsi Haïti' });
  }
});

test('tous les autres rôles sont refusés (403) et rien n\'est appelé', async () => {
  for (const role of ['comptable', 'pharmacien', 'pharmacien_chef', 'lecteur', 'auditeur', 'infirmier', 'medecin', 'visiteur', 'archiviste', null]) {
    const { appeler, appelsRpc, audits } = monter({ role });
    const res = await appeler({ nom: 'Autre' });
    assert.strictEqual(res.code, 403, String(role));
    assert.strictEqual(appelsRpc.length, 0);
    assert.strictEqual(audits.length, 0);
  }
});

test('le nom est nettoyé (espaces) ; vide, absent ou trop long = 400 sans appel', async () => {
  const { appeler, appelsRpc } = monter();
  await appeler({ nom: '  Avsi   Haïti  ' });
  assert.strictEqual(appelsRpc[0].args.p_nouveau_nom, 'Avsi Haïti');
  for (const corps of [{ nom: '   ' }, {}, { nom: 12 }, { nom: 'x'.repeat(101) }]) {
    const m = monter();
    const res = await m.appeler(corps);
    assert.strictEqual(res.code, 400, JSON.stringify(corps).slice(0, 30));
    assert.strictEqual(m.appelsRpc.length, 0);
  }
});

test('un renommage est tracé dans l\'audit avec l\'ancien nom, le nouveau et les comptes', async () => {
  const { appeler, audits } = monter({ nomAvant: 'AVSI' });
  await appeler({ nom: 'Avsi Haïti' });
  assert.deepStrictEqual(audits, [{ action: 'renommer_partenaire', details: { id: 'p-avsi', ancien_nom: 'AVSI', nouveau_nom: 'Avsi Haïti', episodes: 3, paiements: 2, dons: 1 } }]);
});

test('même nom : réponse OK, rien de tracé', async () => {
  const { appeler, audits } = monter({ reponseRpc: { data: { episodes: 0, paiements: 0, dons: 0, inchange: true }, error: null } });
  const res = await appeler({ nom: 'AVSI' });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(audits.length, 0);
});

test('les refus de la base sont traduits : nom vide 400, partenaire introuvable 404, nom déjà pris 409, le reste 500', async () => {
  const cas = [['CHF20', 400], ['CHF21', 404], ['CHF22', 409], ['XX000', 500]];
  for (const [code, attendu] of cas) {
    const { appeler, audits } = monter({ reponseRpc: { data: null, error: { code, message: 'message-' + code } } });
    const res = await appeler({ nom: 'Autre' });
    assert.strictEqual(res.code, attendu, code);
    assert.strictEqual(res.corps.error, 'message-' + code);
    assert.strictEqual(audits.length, 0);
  }
});

test('le script SQL qui suit aussi les dons est réservé au serveur et se rejoue', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'renommer_partenaire_avec_dons.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.renommer_partenaire/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.renommer_partenaire\(text, text\) FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.renommer_partenaire\(text, text\) TO service_role;/);
  assert.match(sql, /donsParOng/);
  assert.doesNotMatch(sql, /\bDELETE\b|\bTRUNCATE\b|DROP\s+(TABLE|COLUMN)/i);
});
