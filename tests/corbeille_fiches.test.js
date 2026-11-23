// tests/corbeille_fiches.test.js — 17/11 (Esdras) : « une petite corbeille en bas à droite des fiches validées pour récupérer une fiche qu'on a supprimée par erreur ».
// Les vraies routes (liste de la corbeille d'un dossier, restauration) sont extraites de server.js et exécutées contre une base simulée.
const { test } = require('node:test');
const assert = require('node:assert');
const { evaluerRestaurationCaisse } = require('../utils/retraitFicheCaisse');

const source = require('./serveurSource').lireServeur();
const debut = source.indexOf("// Restauration d'une fiche mise à la corbeille");
const finRoute = 'res.json(resultat);\n});';
const fin = source.indexOf(finRoute, debut) + finRoute.length;
assert.ok(debut > 0 && fin > debut, 'routes introuvables dans server.js');
const code = source.slice(debut, fin);

const HIER = '2026-11-16T15:00:00.000Z';
const MAINTENANT = new Date().toISOString();

function monter({ droits = ['caisse_travailler'], fiches = [], paiements = [], episode = { id: 'ep1', verrouille_facture: false, numero_lot: null } } = {}) {
  const routes = {}; const audits = [];
  const app = { get: (c, f) => { routes['GET ' + c] = f; }, post: (c, f) => { routes['POST ' + c] = f; } };
  const tables = { fiches, paiements, episodes: [episode] };
  const construire = (nom) => {
    const e = { op: 'select', filtres: [], payload: null };
    const executer = () => {
      const lignes = tables[nom].filter(l => e.filtres.every(f => f(l)));
      if (e.op === 'update') { lignes.forEach(l => Object.assign(l, e.payload)); return { data: lignes, error: null }; }
      return { data: lignes, error: null };
    };
    const c = {
      select: () => c, update: (p) => { e.op = 'update'; e.payload = p; return c; },
      eq: (k, v) => { e.filtres.push(l => l[k] === v); return c; },
      is: (k, v) => { e.filtres.push(l => (l[k] ?? null) === v); return c; },
      not: (k, _o, v) => { e.filtres.push(l => (l[k] ?? null) !== v); return c; },
      order: () => c, limit: () => c,
      maybeSingle: async () => { const r = executer(); return { data: r.data[0] ? { ...r.data[0] } : null, error: null }; },
      then: (ok) => Promise.resolve(executer()).then(ok),
    };
    return c;
  };
  const supabase = { from: construire };
  new Function('app', 'supabase', 'aPermission', 'enregistrerAuditServeur', 'evaluerRestaurationCaisse', code)(
    app, supabase, async (_u, p) => droits.includes(p), async (_r, a, d) => { audits.push({ a, d }); }, evaluerRestaurationCaisse);
  const appeler = async (cle, req) => { const res = { code: 200, corps: null, status(x) { this.code = x; return this; }, json(b) { this.corps = b; return this; } }; await routes[cle]({ user: { id: 'u1' }, params: {}, ...req }, res); return res; };
  return { appeler, fiches, paiements, audits };
}

const fiche = (id, extra = {}) => ({ id, episode_id: 'ep1', numero_fiche: 1, total_global: 3000, supprime_le: MAINTENANT, ...extra });
const paiement = (id, ficheId, extra = {}) => ({ id, fiche_id: ficheId, mode: 'cash', solde_restant: 0, supprime_le: MAINTENANT, ...extra });

test("la caisse voit la corbeille du dossier : fiches retirées seulement, récupérables ou non avec la raison", async () => {
  const m = monter({ fiches: [fiche('f1'), fiche('f2', { supprime_le: null }), fiche('f3', { supprime_le: HIER })], paiements: [paiement('p1', 'f1'), paiement('p3', 'f3', { supprime_le: HIER })] });
  const r = await m.appeler('GET /api/fiches/episode/:episodeId/corbeille', { params: { episodeId: 'ep1' } });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.corps.map(f => f.id).sort(), ['f1', 'f3'], 'la fiche f2 n\'est pas à la corbeille');
  assert.strictEqual(r.corps.find(f => f.id === 'f1').restaurable, true);
  const hier = r.corps.find(f => f.id === 'f3');
  assert.strictEqual(hier.restaurable, false);
  assert.match(hier.raison_non_restaurable, /jour même|direction/i);
});

test("sans droit de caisse ni de direction : 403 sur la liste et sur la restauration", async () => {
  const m = monter({ droits: [], fiches: [fiche('f1')] });
  assert.strictEqual((await m.appeler('GET /api/fiches/episode/:episodeId/corbeille', { params: { episodeId: 'ep1' } })).code, 403);
  assert.strictEqual((await m.appeler('POST /api/fiches/:id/restaurer', { params: { id: 'f1' } })).code, 403);
  assert.ok(m.fiches[0].supprime_le, 'rien n\'a bougé');
});

test("la caisse récupère une fiche retirée aujourd'hui : fiche ET paiement reviennent, trace au journal", async () => {
  const m = monter({ fiches: [fiche('f1')], paiements: [paiement('p1', 'f1')] });
  const r = await m.appeler('POST /api/fiches/:id/restaurer', { params: { id: 'f1' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(m.fiches[0].supprime_le, null);
  assert.strictEqual(m.paiements[0].supprime_le, null);
  assert.strictEqual(m.audits.at(-1).a, 'fiche_restauree');
  assert.strictEqual(m.audits.at(-1).d.avec_droit_direction, false);
});

test("la caisse ne récupère pas : une fiche retirée un autre jour, une fiche à crédit ou à paiement partiel, un dossier déjà facturé", async () => {
  const hier = monter({ fiches: [fiche('f1', { supprime_le: HIER })], paiements: [paiement('p1', 'f1', { supprime_le: HIER })] });
  assert.strictEqual((await hier.appeler('POST /api/fiches/:id/restaurer', { params: { id: 'f1' } })).code, 403);
  const credit = monter({ fiches: [fiche('f1')], paiements: [paiement('p1', 'f1', { mode: 'credit', solde_restant: 3000 })] });
  const rc = await credit.appeler('POST /api/fiches/:id/restaurer', { params: { id: 'f1' } });
  assert.strictEqual(rc.code, 403); assert.strictEqual(rc.corps.code, 'FICHE_A_CREDIT');
  const partiel = monter({ fiches: [fiche('f1')], paiements: [paiement('p1', 'f1', { mode: 'cash', solde_restant: 1000 })] });
  assert.strictEqual((await partiel.appeler('POST /api/fiches/:id/restaurer', { params: { id: 'f1' } })).corps.code, 'FICHE_A_CREDIT');
  const facture = monter({ fiches: [fiche('f1')], paiements: [paiement('p1', 'f1')], episode: { id: 'ep1', verrouille_facture: true } });
  assert.strictEqual((await facture.appeler('POST /api/fiches/:id/restaurer', { params: { id: 'f1' } })).corps.code, 'DOSSIER_VERROUILLE');
  for (const m of [hier, credit, partiel, facture]) assert.ok(m.fiches[0].supprime_le, 'la fiche reste à la corbeille');
});

test("la direction récupère toute fiche, même d'un autre jour ou à crédit (comportement d'avant inchangé)", async () => {
  const m = monter({ droits: ['dossier_annuler'], fiches: [fiche('f1', { supprime_le: HIER })], paiements: [paiement('p1', 'f1', { mode: 'credit', solde_restant: 3000, supprime_le: HIER })] });
  const liste = await m.appeler('GET /api/fiches/episode/:episodeId/corbeille', { params: { episodeId: 'ep1' } });
  assert.strictEqual(liste.corps[0].restaurable, true);
  const r = await m.appeler('POST /api/fiches/:id/restaurer', { params: { id: 'f1' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(m.fiches[0].supprime_le, null);
  assert.strictEqual(m.audits.at(-1).d.avec_droit_direction, true);
});

test("evaluerRestaurationCaisse : fiche pas à la corbeille, remboursement de crédit", () => {
  assert.strictEqual(evaluerRestaurationCaisse({ fiche: { supprime_le: null }, paiements: [] }).code, 'PAS_A_LA_CORBEILLE');
  assert.strictEqual(evaluerRestaurationCaisse({ fiche: { supprime_le: MAINTENANT }, paiements: [{ mode: 'remboursement_credit' }] }).code, 'PAIEMENT_NON_RESTAURABLE');
  assert.strictEqual(evaluerRestaurationCaisse({ fiche: { supprime_le: MAINTENANT }, paiements: [{ mode: 'cash', solde_restant: 0 }] }).ok, true);
});
