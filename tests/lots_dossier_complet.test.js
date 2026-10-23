// tests/lots_dossier_complet.test.js — onglet Lots, version chf-demo2 (14/10) : case « dossier complet » et « dernière modification par ».
// Ces tests EXÉCUTENT la vraie route PUT /api/episodes/:id et la vraie fonction signatureModification (extraites de server.js)
// contre un faux Supabase en mémoire.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { creerFauxSupabase } = require('./aides/fauxSupabase');

const serverSrc = require('./serveurSource').lireServeur();
const tranche = (debut, fin) => { const a = serverSrc.indexOf(debut); const b = serverSrc.indexOf(fin, a + 1); assert.ok(a !== -1 && b > a, `introuvable : ${debut}`); return serverSrc.slice(a, b); };

function monterRoute({ colonnesAbsentes, utilisateurs, permission = true, episodes } = {}) {
  const supabase = creerFauxSupabase({
    episodes: episodes || [{ id: 'e1', dossier_id: 'd1', statut: 'ouvert', numero_lot: null, dossier_complet: false }],
    users: utilisateurs || [{ id: 'u-marie', display_name: 'Marie Joseph', email: 'marie@chf.com' }],
    dossiers: [{ id: 'd1', nom: 'Patient Exemple' }], fiches: [],
  }, { colonnesAbsentes });
  const source = tranche('async function signatureModification', 'async function episodeVersFlat')
    + tranche("app.put('/api/episodes/:id'", "app.delete('/api/episodes/:id'")
      .replace("app.put('/api/episodes/:id', async (req, res) => {", 'gestionnaire = async (req, res) => {')
      .replace(/\}\);\s*$/, '};') + '\nreturn { signatureModification, gestionnaire };';
  let gestionnaire;
  const fabrique = new Function('supabase', 'aPermission', 'flatVersTypePatient', 'flatVersStatut', 'estUnVraiUuid', 'ficheVersColonnes', 'episodeVersFlat', 'console',
    'let gestionnaire;\n' + source);
  const { gestionnaire: g, signatureModification } = fabrique(supabase, async () => permission, (v) => v, (v) => v, () => false, (f) => f, async (ep) => ep, { warn() {}, log() {}, error() {} });
  gestionnaire = g;
  const appeler = async (corps, utilisateur = { id: 'u-marie', email: 'marie@chf.com' }) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    await gestionnaire({ params: { id: 'e1' }, body: corps, user: utilisateur }, res);
    return res;
  };
  return { appeler, supabase, signatureModification, episode: () => supabase.tables.episodes[0] };
}

test('PUT /api/episodes/:id : cocher « dossier complet » l\'enregistre, avec le NOM de la personne qui l\'a fait', async () => {
  const { appeler, episode } = monterRoute();
  const r = await appeler({ dossier_complet: true });
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.strictEqual(episode().dossier_complet, true);
  assert.strictEqual(episode().modifie_par, 'Marie Joseph');
  assert.strictEqual(episode().modifie_par_uid, 'u-marie');
});

test('PUT /api/episodes/:id : décocher fonctionne aussi', async () => {
  const { appeler, episode } = monterRoute({ episodes: [{ id: 'e1', dossier_id: 'd1', statut: 'ouvert', dossier_complet: true }] });
  assert.strictEqual((await appeler({ dossier_complet: false })).code, 200);
  assert.strictEqual(episode().dossier_complet, false);
});

test('PUT /api/episodes/:id : « dossier complet » n\'accepte que true ou false (400, rien d\'écrit)', async () => {
  for (const mauvais of ['true', 1, 0, null, 'oui', {}, []]) {
    const { appeler, episode } = monterRoute();
    const r = await appeler({ dossier_complet: mauvais });
    assert.strictEqual(r.code, 400, JSON.stringify(mauvais));
    assert.strictEqual(episode().dossier_complet, false);
    assert.strictEqual(episode().modifie_par, undefined);
  }
});

test('signature : sans nom enregistré, l\'e-mail ; sans e-mail, l\'identifiant ; jamais plus de 120 caractères', async () => {
  const { signatureModification } = monterRoute({ utilisateurs: [{ id: 'u-x', display_name: '' }, { id: 'u-long', display_name: 'N'.repeat(300) }] });
  assert.deepStrictEqual(await signatureModification({ id: 'u-x', email: 'x@chf.com' }), { modifie_par: 'x@chf.com', modifie_par_uid: 'u-x' });
  assert.deepStrictEqual(await signatureModification({ id: 'u-x' }), { modifie_par: 'u-x', modifie_par_uid: 'u-x' });
  assert.strictEqual((await signatureModification({ id: 'u-long' })).modifie_par.length, 120);
  assert.deepStrictEqual(await signatureModification(null), {});
});

test('la signature n\'est JAMAIS prise dans ce que le navigateur envoie (modifie_par du corps ignoré)', async () => {
  const { appeler, episode } = monterRoute();
  await appeler({ numero_lot: 3, modifie_par: 'Quelqu\'un d\'autre', modifie_par_uid: 'u-autre' });
  assert.strictEqual(episode().numero_lot, 3);
  assert.strictEqual(episode().modifie_par, 'Marie Joseph');
  assert.strictEqual(episode().modifie_par_uid, 'u-marie');
});

test('SQL pas encore collé : une modification ordinaire (numéro de lot) passe SANS signature, rien ne casse', async () => {
  const { appeler, episode } = monterRoute({ colonnesAbsentes: { episodes: ['dossier_complet', 'modifie_par', 'modifie_par_uid'] } });
  const r = await appeler({ numero_lot: 4 });
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.strictEqual(episode().numero_lot, 4);
  assert.strictEqual(episode().modifie_par, undefined);
});

test('SQL pas encore collé : « dossier complet » répond une erreur claire qui nomme le script à coller', async () => {
  const { appeler, episode } = monterRoute({ colonnesAbsentes: { episodes: ['dossier_complet', 'modifie_par', 'modifie_par_uid'] } });
  const r = await appeler({ dossier_complet: true });
  assert.strictEqual(r.code, 500);
  assert.match(r.corps.error, /ajoute_dossier_complet_modifie_par_episodes\.sql/);
  assert.strictEqual(episode().dossier_complet, false);
});

test('un dossier déjà archivé reste protégé : sans la permission facturation_modifier, 403 et aucune signature', async () => {
  const { appeler, episode } = monterRoute({ permission: false, episodes: [{ id: 'e1', dossier_id: 'd1', statut: 'ferme', dossier_complet: false }] });
  const r = await appeler({ dossier_complet: true });
  assert.strictEqual(r.code, 403);
  assert.strictEqual(episode().dossier_complet, false);
});

test('la forme « flat » envoyée au navigateur porte dossierComplet et modifiePar (faux/null quand les colonnes n\'existent pas encore)', () => {
  const source = tranche('function assemblerEpisodeFlat', '// ---------------------------------------------------------------------------------------------\n// Lecture GROUPÉE');
  const assembler = new Function('typePatientVersFlat', 'statutVersFlat', 'ficheVersFlat', 'FUSEAU_HAITI', source + '\nreturn assemblerEpisodeFlat;')((v) => v, () => 'archived', (f) => f, 'America/Port-au-Prince');
  const ep = { id: 'e1', dossier_id: 'd1', date_ouverture: '2026-10-01T10:00:00Z', type_patient: 'partenaire' };
  const avec = assembler({ ...ep, dossier_complet: true, modifie_par: 'Marie Joseph' }, { nom: 'X' }, [], new Set());
  assert.strictEqual(avec.dossierComplet, true);
  assert.strictEqual(avec.modifiePar, 'Marie Joseph');
  const sans = assembler(ep, { nom: 'X' }, [], new Set());
  assert.strictEqual(sans.dossierComplet, false);
  assert.strictEqual(sans.modifiePar, null);
});

test('le script SQL est additif et relançable (IF NOT EXISTS, aucun DROP ni REVOKE)', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'ajoute_dossier_complet_modifie_par_episodes.sql'), 'utf8');
  assert.strictEqual((sql.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 3);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /\bDROP\b|\bREVOKE\b|\bDELETE\b|\bTRUNCATE\b/i);
  assert.match(sql, /dossier_complet boolean NOT NULL DEFAULT false/);
});
