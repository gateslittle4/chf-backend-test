// tests/archivage_fiche_deja_enregistree.test.js — 23/11 : « Problème temporaire côté serveur (archivage) — Nouvelle fiche : duplicate key value violates unique constraint "fiches_episode_id_numero_fiche_key" ».
// La vraie route PUT /api/episodes/:id (extraite de server.js) contre un faux Supabase qui applique la contrainte UNIQUE (episode_id, numero_fiche).
const { test } = require('node:test');
const assert = require('node:assert');
const { creerFauxSupabase } = require('./aides/fauxSupabase');

const serverSrc = require('./serveurSource').lireServeur();
const tranche = (debut, fin) => { const a = serverSrc.indexOf(debut); const b = serverSrc.indexOf(fin, a + 1); assert.ok(a !== -1 && b > a, `introuvable : ${debut}`); return serverSrc.slice(a, b); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ficheVersColonnes = (f) => ({ numero_fiche: f.numeroFiche, cree_par: f.creePar, probleme: !!f.probleme, note_probleme: f.noteProbleme, total_global: f.totalGlobal || 0, breakdown: f.breakdown || {}, mode_paiement: f.modePaiement, raw_state: f.rawState || {} });

function monter(fiches) {
  const supabase = creerFauxSupabase({
    episodes: [{ id: 'e1', dossier_id: 'd1', statut: 'ouvert' }], users: [{ id: 'u', display_name: 'Esdras' }], dossiers: [{ id: 'd1', nom: 'BB Test' }], fiches,
  }, { uniques: { fiches: [['episode_id', 'numero_fiche']] } });
  const source = tranche('async function signatureModification', 'async function episodeVersFlat')
    + tranche("app.put('/api/episodes/:id'", "app.delete('/api/episodes/:id'")
      .replace("app.put('/api/episodes/:id', async (req, res) => {", 'gestionnaire = async (req, res) => {')
      .replace(/\}\);\s*$/, '};') + '\nreturn { gestionnaire };';
  const fabrique = new Function('supabase', 'aPermission', 'flatVersTypePatient', 'flatVersStatut', 'estUnVraiUuid', 'ficheVersColonnes', 'episodeVersFlat', 'console', 'let gestionnaire;\n' + source);
  const { gestionnaire } = fabrique(supabase, async () => true, (v) => v, (v) => (v === 'archived' ? 'ferme' : v), (id) => typeof id === 'string' && UUID.test(id), ficheVersColonnes, async (ep) => ep, { warn() {}, log() {}, error() {} });
  const appeler = async (corps) => { const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } }; await gestionnaire({ params: { id: 'e1' }, body: corps, user: { id: 'u' } }, res); return res; };
  return { appeler, fiches: () => supabase.tables.fiches };
}
const dejaEnregistree = { id: '11111111-1111-4111-8111-111111111111', episode_id: 'e1', numero_fiche: 8, local_id: 'local-111', total_global: 16250, mode_paiement: 'ong' };

test('une fiche déjà enregistrée (même local_id) qui revient avec son identifiant local est mise à jour, jamais réinsérée', async () => {
  const { appeler, fiches } = monter([{ ...dejaEnregistree }]);
  const r = await appeler({ status: 'archived', fiches: [{ id: 'local-111', numeroFiche: 8, totalGlobal: 16250, modePaiement: 'ong', noteProbleme: 'mise à jour' }] });
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.strictEqual(fiches().length, 1, 'aucun doublon');
  assert.strictEqual(fiches()[0].note_probleme, 'mise à jour');
  assert.strictEqual(fiches()[0].numero_fiche, 8, 'son numéro ne change pas');
});

test('même numéro déjà pris par une fiche identique (sans local_id connu) : c\'est la même fiche, aucune erreur ni doublon', async () => {
  const { appeler, fiches } = monter([{ ...dejaEnregistree, local_id: null }]);
  const r = await appeler({ status: 'archived', fiches: [{ id: 'fiche-autre', numeroFiche: 8, totalGlobal: 16250, modePaiement: 'ong' }] });
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.strictEqual(fiches().length, 1);
});

test('vrai conflit de numéro (autre fiche, autre total) : la nouvelle fiche prend le numéro libre suivant', async () => {
  const { appeler, fiches } = monter([{ ...dejaEnregistree, local_id: null }]);
  const r = await appeler({ status: 'archived', fiches: [{ id: 'fiche-nouvelle', numeroFiche: 8, totalGlobal: 500, modePaiement: 'cash' }] });
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.deepStrictEqual(fiches().map(f => f.numero_fiche).sort(), [8, 9]);
  assert.strictEqual(fiches().find(f => f.numero_fiche === 9).local_id, 'fiche-nouvelle', 'son identifiant local est conservé : un rejeu ne la réinsère pas');
});

test('une vraie nouvelle fiche s\'insère normalement, avec son identifiant local ; un rejeu du même envoi ne crée pas de doublon', async () => {
  const { appeler, fiches } = monter([]);
  const corps = { status: 'archived', fiches: [{ id: 'fiche-777', numeroFiche: 1, totalGlobal: 9000, modePaiement: 'ong' }] };
  assert.strictEqual((await appeler(corps)).code, 200);
  assert.strictEqual((await appeler(corps)).code, 200);
  assert.strictEqual(fiches().length, 1);
  assert.strictEqual(fiches()[0].local_id, 'fiche-777');
});
