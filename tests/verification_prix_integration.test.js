// tests/verification_prix_integration.test.js — POST /api/fiches REJETTE vraiment un montant fabriqué (pas seulement le module pur) : base simulée complète,
// la vraie route extraite de server.js (audit de sécurité du 21/10).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const serverSrc = require('./serveurSource').lireServeur();
const { verifierTotalFiche } = require('../utils/verificationPrixFiche');
const { estRejeu: ESTREJEU } = require('../utils/heureServeur');

function baseSimulee({ episode, medicaments = [], actes = [], parametres = {}, ongPartenaires = [] } = {}) {
  const fiches = [];
  const tables = {
    episodes: [episode],
    catalog: [{ type: 'medicaments', items: medicaments }, { type: 'actes', items: actes }, { type: 'parametres', items: parametres }],
    ong_partenaires: ongPartenaires,
  };
  const from = (nom) => {
    const filtres = []; let action = 'select'; let payload = null;
    const lignes = () => (tables[nom] || []).filter(r => filtres.every(f => f(r)));
    const c = {
      select: () => c, eq: (k, v) => { filtres.push(r => r[k] === v); return c; },
      insert: (p) => { action = 'insert'; payload = p; return c; },
      maybeSingle: async () => ({ data: lignes()[0] || null, error: null }),
      single: async () => {
        if (nom === 'fiches' && action === 'insert') { const f = { id: 'f' + (fiches.length + 1), ...payload }; fiches.push(f); return { data: f, error: null }; }
        return { data: lignes()[0] || null, error: null };
      },
      order: () => c, limit: () => c, not: () => c,
      then: (resolve) => resolve({ data: lignes(), error: null }),
    };
    return c;
  };
  return { from, fiches };
}

function monter(supabase) {
  const debut = serverSrc.indexOf("app.post('/api/fiches', async");
  const fin = serverSrc.indexOf("app.get('/api/fiches/episode/:episodeId'");
  assert.ok(debut > 0 && fin > debut);
  let gestionnaire;
  const app = { post: (_c, fn) => { gestionnaire = fn; } };
  const audits = [];
  new Function('app', 'supabase', 'aPermission', 'estUnVraiUuid', 'enregistrerAuditServeur', 'reactiverEpisodeSuspendu', 'verifierTotalFiche', 'estRejeu', 'console', serverSrc.slice(debut, fin))(
    app, supabase, async () => true, () => true, async (_req, action, details) => audits.push({ action, details }), async () => {}, verifierTotalFiche, ESTREJEU, { ...console, warn() {} });
  const appeler = async (corps, headers = {}) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    await gestionnaire({ body: corps, headers, user: { id: 'u1', email: 'caisse@chf.test' } }, res);
    return res;
  };
  return { appeler, audits };
}

const MED = { id: 'm1', nom: 'Amoxicilline', prix: 100 };
const EPISODE = { id: 'ep1', dossier_id: 'd1', type_patient: 'prive', ong_partenaire: null };

test('POST /api/fiches accepte une fiche au vrai prix du catalogue', async () => {
  const supabase = baseSimulee({ episode: EPISODE, medicaments: [MED] });
  const m = monter(supabase);
  const r = await m.appeler({ episode_id: 'ep1', total_global: 200, raw_state: { lignesCalcul: [{ itemId: 'm1', type: 'med', nom: 'Amoxicilline', qte: 2, prix: 100 }] } });
  assert.strictEqual(r.code, 201);
});

test("POST /api/fiches REJETTE une fiche dont le montant est fabriqué plus bas que le vrai prix (la fraude visée par l'audit)", async () => {
  const supabase = baseSimulee({ episode: EPISODE, medicaments: [MED] });
  const m = monter(supabase);
  const r = await m.appeler({ episode_id: 'ep1', total_global: 10, raw_state: { lignesCalcul: [{ itemId: 'm1', type: 'med', nom: 'Amoxicilline', qte: 2, prix: 5 }] } });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(r.corps.code, 'MONTANT_FICHE_REFUSE');
  assert.match(r.corps.error, /Amoxicilline/);
  assert.strictEqual(supabase.fiches.length, 0, 'rien ne doit être créé');
  assert.strictEqual(m.audits[0].action, 'fiche_montant_refuse');
});

test('sans raw_state (appelant inconnu) : accepté, par prudence — ne bloque pas un appelant qui ne fournit pas de quoi vérifier', async () => {
  const supabase = baseSimulee({ episode: EPISODE, medicaments: [MED] });
  const m = monter(supabase);
  const r = await m.appeler({ episode_id: 'ep1', total_global: 999999 });
  assert.strictEqual(r.code, 201);
});

// ---- Même correctif sur POST /api/episodes (route de compatibilité utilisée par ⚡ Achat Express — fiches embarquées dans d.fiches) ----
function baseSimuleeEpisodes({ medicaments = [], actes = [], parametres = {} } = {}) {
  const dossiers = []; const episodes = []; const fiches = [];
  const tables = { catalog: [{ type: 'medicaments', items: medicaments }, { type: 'actes', items: actes }, { type: 'parametres', items: parametres }], ong_partenaires: [] };
  const from = (nom) => {
    const filtres = []; let action = 'select'; let payload = null;
    const lignes = () => (tables[nom] || []).filter(r => filtres.every(f => f(r)));
    const c = {
      select: () => c, eq: (k, v) => { filtres.push(r => r[k] === v); return c; },
      insert: (p) => { action = 'insert'; payload = Array.isArray(p) ? p : [p]; return c; },
      maybeSingle: async () => ({ data: lignes()[0] || null, error: null }),
      single: async () => {
        if (nom === 'dossiers' && action === 'insert') { const d = { id: 'd' + (dossiers.length + 1), ...payload[0] }; dossiers.push(d); return { data: d, error: null }; }
        if (nom === 'episodes' && action === 'insert') { const e = { id: 'ep' + (episodes.length + 1), ...payload[0] }; episodes.push(e); return { data: e, error: null }; }
        return { data: lignes()[0] || null, error: null };
      },
      then: (resolve) => {
        if (nom === 'fiches' && action === 'insert') { payload.forEach(p => fiches.push({ id: 'f' + (fiches.length + 1), ...p } )); return resolve({ data: fiches, error: null }); }
        resolve({ data: lignes(), error: null });
      },
    };
    return c;
  };
  return { from, dossiers, episodes, fiches };
}

function monterEpisodes(supabase) {
  const debut = serverSrc.indexOf("app.post('/api/episodes', async");
  const fin = serverSrc.indexOf("app.put('/api/episodes/:id'");
  assert.ok(debut > 0 && fin > debut);
  let gestionnaire;
  const app = { post: (_c, fn) => { gestionnaire = fn; } };
  const audits = [];
  new Function('app', 'supabase', 'aPermission', 'formaterNomPropre', 'erreurIdentiteDossier', 'numeroProvisoire', 'erreurNumeroDossier', 'ficheVersColonnes', 'episodeVersFlat', 'flatVersStatut', 'flatVersTypePatient', 'dateOuNull', 'enregistrerAuditServeur', 'verifierTotalFiche', 'estRejeu', 'console', serverSrc.slice(debut, fin))(
    app, supabase, async () => true,
    (n) => n, () => null, () => 'EN-ATTENTE-x', () => null,
    (f) => ({ numero_fiche: f.numeroFiche, cree_par: f.creePar, probleme: !!f.probleme, note_probleme: f.noteProbleme, total_global: f.totalGlobal || 0, breakdown: f.breakdown || {}, mode_paiement: f.modePaiement, raw_state: f.rawState || {} }),
    async (e) => e, (s) => s === 'archived' ? 'ferme' : 'ouvert', (t) => t === 'ONG' ? 'partenaire' : 'prive', (v) => v || null,
    async (_req, action, details) => audits.push({ action, details }), verifierTotalFiche, ESTREJEU, { ...console, warn() {} });
  const appeler = async (corps, headers = {}) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    await gestionnaire({ body: corps, headers, user: { id: 'u1', email: 'caisse@chf.test' } }, res);
    return res;
  };
  return { appeler, audits };
}

test('⚡ Achat Express (POST /api/episodes avec fiches embarquées) : une fiche au vrai prix est acceptée', async () => {
  const supabase = baseSimuleeEpisodes({ medicaments: [MED] });
  const m = monterEpisodes(supabase);
  const r = await m.appeler({ nom_patient: 'Client Comptoir', voie_entree: 'vente_comptoir', status: 'archived', type_patient: 'PRIVE',
    fiches: [{ totalGlobal: 200, breakdown: { med: 200 }, rawState: { lignesCalcul: [{ itemId: 'm1', type: 'med', nom: 'Amoxicilline', qte: 2, prix: 100 }] } }] });
  assert.strictEqual(r.code, 201);
  assert.strictEqual(supabase.fiches.length, 1);
});

test("⚡ Achat Express : une fiche à prix fabriqué est REJETÉE, et le dossier/épisode ne sont PAS créés (rien à moitié)", async () => {
  const supabase = baseSimuleeEpisodes({ medicaments: [MED] });
  const m = monterEpisodes(supabase);
  const r = await m.appeler({ nom_patient: 'Client Comptoir', voie_entree: 'vente_comptoir', status: 'archived', type_patient: 'PRIVE',
    fiches: [{ totalGlobal: 5, breakdown: { med: 5 }, rawState: { lignesCalcul: [{ itemId: 'm1', type: 'med', nom: 'Amoxicilline', qte: 2, prix: 2.5 }] } }] });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(r.corps.code, 'MONTANT_FICHE_REFUSE');
  assert.strictEqual(supabase.dossiers.length, 0, 'aucun dossier créé');
  assert.strictEqual(supabase.episodes.length, 0, 'aucun épisode créé');
  assert.strictEqual(m.audits[0].action, 'fiche_montant_refuse');
});

test("⚡ Achat Express : l'import d'une sauvegarde n'est JAMAIS bloqué par cette vérification (anciennes données, anciens tarifs)", async () => {
  const supabase = baseSimuleeEpisodes({ medicaments: [MED] });
  const m = monterEpisodes(supabase);
  const r = await m.appeler({ nom_patient: 'Ancien Patient', import_sauvegarde: true, type_patient: 'PRIVE',
    fiches: [{ totalGlobal: 999999, breakdown: {}, rawState: { lignesCalcul: [{ itemId: 'm1', type: 'med', nom: 'Amoxicilline', qte: 1, prix: 999999 }] } }] });
  assert.strictEqual(r.code, 201);
});

// ---- HORS LIGNE : un rejeu de la file d'attente n'est JAMAIS refusé (la vente a déjà eu lieu), seulement signalé ----
test("HORS LIGNE : une fiche rejouée depuis la file d'attente (X-CHF-Rejeu) dont le prix a changé entre-temps est ENREGISTRÉE et signalée, pas refusée", async () => {
  const supabase = baseSimulee({ episode: EPISODE, medicaments: [{ ...MED, prix: 120 }] }); // le prix est passé de 100 à 120 pendant la coupure
  const m = monter(supabase);
  const corps = { episode_id: 'ep1', total_global: 200, raw_state: { lignesCalcul: [{ itemId: 'm1', type: 'med', nom: 'Amoxicilline', qte: 2, prix: 100 }] } };
  const enLigne = await m.appeler(corps);
  assert.strictEqual(enLigne.code, 400, 'en ligne : refusé tout de suite');
  assert.strictEqual(supabase.fiches.length, 0);
  const rejeu = await m.appeler({ ...corps, local_id: 'queue-1' }, { 'x-chf-rejeu': '1' });
  assert.strictEqual(rejeu.code, 201, 'hors ligne rejoué : enregistré, la transaction n\'est pas perdue');
  assert.strictEqual(supabase.fiches.length, 1);
  assert.ok(m.audits.some(a => a.action === 'fiche_montant_suspect' && a.details.hors_ligne === true), 'signalé à la direction');
});

test("HORS LIGNE : Achat Express rejoué depuis la file d'attente, prix changé entre-temps : enregistré et signalé", async () => {
  const supabase = baseSimuleeEpisodes({ medicaments: [{ ...MED, prix: 120 }] });
  const m = monterEpisodes(supabase);
  const corps = { nom_patient: 'Client Comptoir', voie_entree: 'vente_comptoir', status: 'archived', type_patient: 'PRIVE',
    fiches: [{ totalGlobal: 200, breakdown: { med: 200 }, rawState: { lignesCalcul: [{ itemId: 'm1', type: 'med', nom: 'Amoxicilline', qte: 2, prix: 100 }] } }] };
  assert.strictEqual((await m.appeler(corps)).code, 400);
  const rejeu = await m.appeler({ ...corps, local_id: 'queue-2' }, { 'x-chf-rejeu': '1' });
  assert.strictEqual(rejeu.code, 201);
  assert.ok(m.audits.some(a => a.action === 'fiche_montant_suspect'));
});
