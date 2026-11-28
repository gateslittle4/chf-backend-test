// tests/dossiers_papier.test.js — onglet « Archiviste » (28/11, Esdras) : suivi des dossiers papier, « entré » / « sorti » avec qui et quand. Routes extraites de routes/dossiersPapier.js et exécutées sur une fausse base.
const { test } = require('node:test');
const assert = require('node:assert');
const source = require('./serveurSource').lireServeur();
const debut = source.indexOf('const tableDossiersPapierAbsente');
const marqueFin = "res.json({ success: true, mouvement: data });\n});\n";
const fin = source.lastIndexOf(marqueFin);
assert.ok(debut > 0 && fin > debut, 'routes introuvables dans le serveur');
const code = source.slice(debut, fin + marqueFin.length);

function monter({ droits = ['dossier_numero_saisir'], mouvements = [], dossiers = [{ id: 'd1', nom: 'Marie Joseph' }], tableAbsente = false } = {}) {
  const routes = {}; const audit = [];
  const app = { get: (c, f) => { routes['GET ' + c] = f; }, post: (c, f) => { routes['POST ' + c] = f; }, patch: (c, f) => { routes['PATCH ' + c] = f; } };
  const erreurAbsente = { message: 'relation "public.mouvements_dossier_papier" does not exist', code: '42P01' };
  const supabase = {
    from: (table) => {
      const lignes = table === 'dossiers' ? dossiers : mouvements;
      const f = []; let action = 'select'; let corps = null;
      const sansTable = () => table === 'mouvements_dossier_papier' && tableAbsente;
      const c = {
        select: () => c, order: () => c, or: () => c, eq: (k, v) => { f.push(r => r[k] === v); return c; },
        insert: (v) => { action = 'insert'; corps = v; return c; }, update: (v) => { action = 'update'; corps = v; return c; },
        maybeSingle: async () => {
          if (sansTable()) return { data: null, error: erreurAbsente };
          const r = lignes.filter(x => f.every(g => g(x)));
          if (action === 'update') { r.forEach(x => Object.assign(x, corps)); return { data: r[0] || null, error: null }; }
          return { data: r[0] || null, error: null };
        },
        single: async () => {
          if (sansTable()) return { data: null, error: erreurAbsente };
          if (corps.local_id && mouvements.some(m => m.local_id === corps.local_id)) return { data: null, error: { code: '23505', message: 'doublon' } };
          const ligne = { id: 'm' + (mouvements.length + 1), date: '2026-11-28T14:00:00.000Z', annule: false, ...corps }; mouvements.push(ligne); return { data: ligne, error: null };
        },
        then: (ok) => { if (sansTable()) return ok({ data: null, error: erreurAbsente }); return ok({ data: lignes.filter(x => f.every(g => g(x)) && !x.annule), error: null }); },
      };
      return c;
    },
  };
  const aPermission = async (_uid, cle) => droits.includes(cle);
  const lireToutesLesPages = async (fabrique) => { const r = await fabrique(); if (r.error) throw new Error(r.error.message); return r.data; };
  const enregistrerAuditServeur = async (_req, action, d) => { audit.push({ action, d }); };
  new Function('app', 'supabase', 'aPermission', 'lireToutesLesPages', 'enregistrerAuditServeur', code)(app, supabase, aPermission, lireToutesLesPages, enregistrerAuditServeur);
  return { routes, mouvements, audit };
}
const reponse = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.corps = b; return r; }; return r; };
const requete = (corps = {}, params = {}) => ({ user: { id: 'u1', email: 'archive@chf.com' }, body: corps, params });

test('Entrée d\'un dossier : une ligne est écrite avec qui et quand (heure du serveur), l\'audit est posé', async () => {
  const { routes, mouvements, audit } = monter();
  const res = reponse();
  await routes['POST /api/dossiers-papier/mouvements'](requete({ dossier_id: 'd1', type: 'entree', note: '  classé  ', local_id: 'x1' }), res);
  assert.strictEqual(res.code, 201);
  assert.strictEqual(mouvements.length, 1);
  assert.deepStrictEqual([mouvements[0].dossier_id, mouvements[0].type, mouvements[0].par, mouvements[0].par_uid, mouvements[0].note], ['d1', 'entree', 'archive@chf.com', 'u1', 'classé']);
  assert.strictEqual(audit[0].action, 'dossier_papier_entree');
  assert.strictEqual(audit[0].d.nom, 'Marie Joseph');
});

test('Sortie manuelle : même chose, type sortie ; un rejeu hors ligne (même local_id) ne crée pas de doublon', async () => {
  const { routes, mouvements, audit } = monter();
  const r1 = reponse(); await routes['POST /api/dossiers-papier/mouvements'](requete({ dossier_id: 'd1', type: 'sortie', local_id: 'x2' }), r1);
  assert.strictEqual(r1.code, 201);
  const r2 = reponse(); await routes['POST /api/dossiers-papier/mouvements'](requete({ dossier_id: 'd1', type: 'sortie', local_id: 'x2' }), r2);
  assert.strictEqual(r2.code, 200); assert.strictEqual(r2.corps.deja_enregistre, true);
  assert.strictEqual(mouvements.length, 1);
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].action, 'dossier_papier_sortie');
});

test('Refus : sans droit (403), type invalide, dossier absent ou inconnu', async () => {
  const sans = monter({ droits: ['caisse_travailler'] });
  for (const [cle, req] of [['POST /api/dossiers-papier/mouvements', requete({ dossier_id: 'd1', type: 'entree' })], ['GET /api/dossiers-papier/mouvements', requete()], ['PATCH /api/dossiers-papier/mouvements/:id/annuler', requete({}, { id: 'm1' })]]) {
    const res = reponse(); await sans.routes[cle](req, res); assert.strictEqual(res.code, 403, cle);
  }
  const { routes, mouvements } = monter();
  let res = reponse(); await routes['POST /api/dossiers-papier/mouvements'](requete({ dossier_id: 'd1', type: 'autre' }), res); assert.strictEqual(res.code, 400);
  res = reponse(); await routes['POST /api/dossiers-papier/mouvements'](requete({ type: 'entree' }), res); assert.strictEqual(res.code, 400);
  res = reponse(); await routes['POST /api/dossiers-papier/mouvements'](requete({ dossier_id: 'inconnu', type: 'entree' }), res); assert.strictEqual(res.code, 404);
  assert.strictEqual(mouvements.length, 0);
});

test('La direction (direction_voir) a aussi le droit ; la lecture ne renvoie pas les mouvements annulés', async () => {
  const { routes } = monter({ droits: ['direction_voir'], mouvements: [{ id: 'a', dossier_id: 'd1', type: 'entree', annule: false }, { id: 'b', dossier_id: 'd1', type: 'sortie', annule: true }] });
  const res = reponse(); await routes['GET /api/dossiers-papier/mouvements'](requete(), res);
  assert.deepStrictEqual(res.corps.map(m => m.id), ['a']);
});

test('Annulation : le mouvement est marqué annulé (qui, quand), jamais effacé ; une 2e annulation répond 404', async () => {
  const { routes, mouvements, audit } = monter({ mouvements: [{ id: 'm1', dossier_id: 'd1', type: 'entree', annule: false }] });
  let res = reponse(); await routes['PATCH /api/dossiers-papier/mouvements/:id/annuler'](requete({}, { id: 'm1' }), res);
  assert.strictEqual(res.code, 200);
  assert.strictEqual(mouvements.length, 1);
  assert.deepStrictEqual([mouvements[0].annule, mouvements[0].annule_par, mouvements[0].annule_par_uid], [true, 'archive@chf.com', 'u1']);
  assert.ok(mouvements[0].annule_le);
  assert.strictEqual(audit[0].action, 'dossier_papier_annule');
  res = reponse(); await routes['PATCH /api/dossiers-papier/mouvements/:id/annuler'](requete({}, { id: 'm1' }), res);
  assert.strictEqual(res.code, 404);
});

test('Tant que le SQL n\'est pas appliqué : la lecture renvoie une liste vide, l\'écriture répond 503 avec la consigne', async () => {
  const { routes } = monter({ tableAbsente: true });
  let res = reponse(); await routes['GET /api/dossiers-papier/mouvements'](requete(), res); assert.deepStrictEqual(res.corps, []);
  res = reponse(); await routes['POST /api/dossiers-papier/mouvements'](requete({ dossier_id: 'd1', type: 'entree' }), res);
  assert.strictEqual(res.code, 503); assert.match(res.corps.error, /mouvements_dossier_papier\.sql/);
});

test('Le chemin de l\'argent n\'est pas touché : POST /api/paiements ne mentionne pas les dossiers papier', () => {
  const debutPaiements = source.indexOf("app.post('/api/paiements'");
  const finPaiements = source.indexOf("app.get('/api/depenses-caisse'");
  assert.ok(debutPaiements > 0 && finPaiements > debutPaiements);
  assert.ok(!/dossiers?_papier|dossiers-papier/.test(source.slice(debutPaiements, finPaiements)));
});

test('Le fichier SQL est additif : une table, RLS activée, annulation par marque (pas de suppression)', () => {
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'sql', 'mouvements_dossier_papier.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.mouvements_dossier_papier/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.ok(!/DROP |DELETE |ALTER TABLE public\.(dossiers|paiements|episodes|fiches)/i.test(sql), 'rien d\'existant n\'est modifié ni supprimé');
  assert.match(sql, /annule boolean NOT NULL DEFAULT false/);
});

// ===== GET /api/dossiers-papier/suivi : la liste de l'onglet, sur une fausse base à 5 tables =====
const { construireSuivi, fenetreJourHaiti } = require('../utils/suiviDossiersPapier');
const debutSuivi = source.indexOf('const tableDossiersPapierAbsente');
const codeComplet = source.slice(debutSuivi, source.lastIndexOf("res.json({ success: true, mouvement: data });\n});\n") + "res.json({ success: true, mouvement: data });\n});\n".length);

function monterSuivi({ droits = ['dossier_numero_saisir'], base }) {
  const routes = {};
  const app = { get: (c, f) => { routes['GET ' + c] = f; }, post: () => {}, patch: () => {} };
  const supabase = {
    from: (table) => {
      let lignes = [...(base[table] || [])]; let limite = Infinity;
      const c = {
        select: () => c, order: () => c, or: () => c, limit: (n) => { limite = n; return c; },
        eq: (k, v) => { lignes = lignes.filter(r => r[k] === v); return c; },
        in: (k, vs) => { lignes = lignes.filter(r => vs.includes(r[k])); return c; },
        is: (k, v) => { lignes = lignes.filter(r => (r[k] == null) === (v === null)); return c; },
        gte: (k, v) => { lignes = lignes.filter(r => Date.parse(r[k]) >= Date.parse(v)); return c; },
        lt: (k, v) => { lignes = lignes.filter(r => Date.parse(r[k]) < Date.parse(v)); return c; },
        ilike: (k, motif) => { const re = new RegExp('^' + motif.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); lignes = lignes.filter(r => re.test(String(r[k] || ''))); return c; },
        then: (ok) => ok({ data: lignes.filter(r => !('annule' in r) || r.annule === false || r.annule == null || table === 'mouvements_dossier_papier').slice(0, limite), error: null }),
      };
      return c;
    },
  };
  const aPermission = async (_u, cle) => droits.includes(cle);
  const lireToutesLesPages = async (fabrique) => { const r = await fabrique(); if (r.error) throw new Error(r.error.message); return r.data; };
  const lireParLotsDIds = async (ids, fabrique) => (ids.length ? lireToutesLesPages(() => fabrique(ids)) : []);
  new Function('app', 'supabase', 'aPermission', 'lireToutesLesPages', 'lireParLotsDIds', 'enregistrerAuditServeur', 'construireSuivi', 'fenetreJourHaiti', codeComplet)(app, supabase, aPermission, lireToutesLesPages, lireParLotsDIds, async () => {}, construireSuivi, fenetreJourHaiti);
  return routes;
}
const BASE = () => ({
  dossiers: [{ id: 'd1', nom: 'Marie Joseph', numero_dossier: '120', fusionne_dans: null }, { id: 'd2', nom: 'Jean Pierre', numero_dossier: '121', fusionne_dans: null }, { id: 'd9', nom: 'Marie Ancienne', numero_dossier: '5', fusionne_dans: 'd1' }],
  episodes: [{ id: 'e1', dossier_id: 'd1', supprime_le: null }, { id: 'e2', dossier_id: 'd2', supprime_le: null }],
  fiches: [{ id: 'f1', breakdown: { med: 300 } }, { id: 'f2', breakdown: { labo: 900 } }],
  paiements: [
    { id: 'p1', numero_paiement: 516, episode_id: 'e1', fiche_id: 'f1', mode: 'cash', date_paiement: '2026-11-28T15:30:00Z', annule: false, supprime_le: null },
    { id: 'p2', numero_paiement: 515, episode_id: 'e2', fiche_id: 'f2', mode: 'cash', date_paiement: '2026-11-28T16:00:00Z', annule: false, supprime_le: null },
    { id: 'p3', numero_paiement: 300, episode_id: 'e2', fiche_id: 'f2', mode: 'cash', date_paiement: '2026-11-20T16:00:00Z', annule: false, supprime_le: null },
  ],
  mouvements_dossier_papier: [{ id: 'm1', dossier_id: 'd1', type: 'entree', date: '2026-11-28T14:00:00Z', par: 'archive@chf.com', annule: false }],
});

test('Suivi du jour : les patients qui ont payé ce jour d\'Haïti ; la sortie automatique vient du médicament acheté après l\'entrée', async () => {
  const routes = monterSuivi({ base: BASE() });
  const res = reponse(); await routes['GET /api/dossiers-papier/suivi']({ user: { id: 'u1' }, query: { jour: '2026-11-28' } }, res);
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(res.corps.lignes.map(l => [l.nom, l.etat]), [['Jean Pierre', 'pas_entre'], ['Marie Joseph', 'sorti']]);
  const marie = res.corps.lignes.find(l => l.nom === 'Marie Joseph');
  assert.deepStrictEqual([marie.sortie.origine, marie.sortie.numero_paiement, marie.entree.date], ['automatique', 516, '2026-11-28T14:00:00Z']);
});

test('Suivi : un autre jour montre les patients de CE jour ; un jour sans paiement donne une liste vide', async () => {
  const routes = monterSuivi({ base: BASE() });
  let res = reponse(); await routes['GET /api/dossiers-papier/suivi']({ user: { id: 'u1' }, query: { jour: '2026-11-20' } }, res);
  assert.deepStrictEqual(res.corps.lignes.map(l => l.nom), ['Jean Pierre']);
  res = reponse(); await routes['GET /api/dossiers-papier/suivi']({ user: { id: 'u1' }, query: { jour: '2026-11-01' } }, res);
  assert.deepStrictEqual(res.corps.lignes, []);
});

test('Suivi : recherche par nom (ou numéro) sur toutes les dates, sans les dossiers fusionnés ; 2 lettres au moins', async () => {
  const routes = monterSuivi({ base: BASE() });
  let res = reponse(); await routes['GET /api/dossiers-papier/suivi']({ user: { id: 'u1' }, query: { q: 'mari' } }, res);
  assert.deepStrictEqual(res.corps.lignes.map(l => l.nom), ['Marie Joseph'], 'le dossier fusionné n\'apparaît pas');
  res = reponse(); await routes['GET /api/dossiers-papier/suivi']({ user: { id: 'u1' }, query: { q: '121' } }, res);
  assert.deepStrictEqual(res.corps.lignes.map(l => l.nom), ['Jean Pierre']);
  assert.strictEqual(res.corps.lignes[0].nb_transactions, 2, 'toutes les dates comptent dans une recherche');
  res = reponse(); await routes['GET /api/dossiers-papier/suivi']({ user: { id: 'u1' }, query: { q: 'm' } }, res); assert.strictEqual(res.code, 400);
});

test('Suivi : refusé sans droit ; l\'archiviste n\'a pas besoin de lire les paiements ; jour illisible = 400', async () => {
  let routes = monterSuivi({ droits: ['caisse_travailler'], base: BASE() });
  let res = reponse(); await routes['GET /api/dossiers-papier/suivi']({ user: { id: 'u1' }, query: { jour: '2026-11-28' } }, res); assert.strictEqual(res.code, 403);
  routes = monterSuivi({ droits: ['dossier_numero_saisir'], base: BASE() }); // l'archiviste : pas de fiche_patient_voir_finances, mais il voit l'état et la date de sortie
  res = reponse(); await routes['GET /api/dossiers-papier/suivi']({ user: { id: 'u1' }, query: { jour: 'hier' } }, res); assert.strictEqual(res.code, 400);
  res = reponse(); await routes['GET /api/dossiers-papier/suivi']({ user: { id: 'u1' }, query: { jour: '2026-11-28' } }, res);
  assert.strictEqual(res.code, 200);
  assert.ok(!JSON.stringify(res.corps).includes('"montant"'), 'aucun montant d\'argent dans la réponse');
});
