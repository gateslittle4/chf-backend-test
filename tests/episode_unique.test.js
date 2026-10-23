// tests/episode_unique.test.js — UN SEUL épisode ouvert à la fois (19/10, Esdras) : la route de création le refuse, sauf exception de la direction avec motif (tracée).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { motifDerogationValide } = require('../utils/actesNaissance');

const serveur = require('./serveurSource').lireServeur();

function fabriquer({ ouverts = [], droits = ['episode_creer'] } = {}) {
  const etat = { crees: [], audits: [] };
  const supabase = {
    from(table) {
      if (table !== 'episodes') throw new Error('table inattendue : ' + table);
      const q = { select: () => q, eq: () => q, is: () => q, maybeSingle: async () => ({ data: null, error: null }), then: (ok) => ok({ data: ouverts, error: null }),
        insert: (ligne) => ({ select: () => ({ single: async () => { const e = { id: 'nouveau', ...ligne }; etat.crees.push(e); return { data: e, error: null }; } }) }) };
      return q;
    },
  };
  let gestionnaire;
  const app = { post: (_c, fn) => { gestionnaire = fn; }, get() {}, patch() {}, put() {}, delete() {}, use() {} };
  const debut = serveur.indexOf("app.post('/api/dossiers/:dossierId/episodes'");
  const fin = serveur.indexOf("app.patch('/api/episodes/:id/hospitaliser'", debut);
  new Function('app', 'supabase', 'aPermission', 'validerCreationEpisode', 'enregistrerAuditServeur', 'donnerNumeroAuPremierEpisode', 'marquerExamensSeulement', 'motifDerogationValide', serveur.slice(debut, fin))(
    app, supabase, async (_u, cle) => droits.includes(cle), () => null, async (_r, action, details) => { etat.audits.push({ action, details }); }, async () => null, async () => null, motifDerogationValide);
  etat.appeler = async (corps = {}) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    await gestionnaire({ params: { dossierId: 'd1' }, user: { id: 'u1' }, body: { voie_entree: 'consultation', type_consultation: 'Général', type_patient: 'prive', ...corps } }, res);
    return res;
  };
  return etat;
}
const ouvert = (extra = {}) => ({ id: 'o1', dossier_id: 'd1', statut: 'ouvert', est_hospitalisation: false, ...extra });
const MOTIF = 'Patient revu par le chirurgien, autorisé par la direction';

test('aucun épisode ouvert : la création passe, rien à signaler', async () => {
  const x = fabriquer();
  const r = await x.appeler();
  assert.strictEqual(r.code, 201); assert.strictEqual(x.audits.length, 0);
});

test('un épisode ouvert existe : 409 EPISODE_DEJA_OUVERT, « confirmer malgré l\'avertissement » ne suffit plus, rien n\'est créé', async () => {
  const x = fabriquer({ ouverts: [ouvert()] });
  for (const corps of [{}, { forcerMalgreAvertissement: true }, { derogation_episode: { motif: 'x' } }]) {
    const r = await x.appeler(corps);
    assert.strictEqual(r.code, 409); assert.strictEqual(r.corps.error, 'EPISODE_DEJA_OUVERT'); assert.match(r.corps.message, /Hospitaliser/); assert.strictEqual(r.corps.episodesExistants.length, 1);
  }
  assert.strictEqual(x.crees.length, 0);
});

test('exception : droit episode_ouvert_derogation + motif d\'au moins 5 caractères → créé et tracé ; sans le droit, refusé même avec un motif', async () => {
  const direction = fabriquer({ ouverts: [ouvert()], droits: ['episode_creer', 'episode_ouvert_derogation'] });
  const r = await direction.appeler({ derogation_episode: { motif: MOTIF } });
  assert.strictEqual(r.code, 201); assert.strictEqual(direction.audits[0].action, 'derogation_episode_ouvert'); assert.match(direction.audits[0].details.motif, /chirurgien/); assert.deepStrictEqual(direction.audits[0].details.episodes_ouverts, ['o1']);
  const caisse = fabriquer({ ouverts: [ouvert()] });
  assert.strictEqual((await caisse.appeler({ derogation_episode: { motif: MOTIF } })).code, 409);
});

test('deux hospitalisations restent impossibles, même avec l\'exception', async () => {
  const x = fabriquer({ ouverts: [ouvert({ est_hospitalisation: true })], droits: ['episode_creer', 'episode_ouvert_derogation'] });
  const r = await x.appeler({ voie_entree: 'urgence', service: 'Maternité', type_consultation: undefined, est_hospitalisation: true, derogation_episode: { motif: MOTIF } });
  assert.strictEqual(r.code, 409); assert.strictEqual(r.corps.error, 'BLOCAGE_HOSPITALISATION');
});

test('le droit existe côté serveur pour la direction', () => {
  assert.match(serveur.slice(serveur.indexOf("{ role: 'direction'"), serveur.indexOf("{ role: 'direction'") + 700), /'episode_ouvert_derogation'/);
});
