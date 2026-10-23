// tests/retrait_fiche_caisse.test.js — la caisse retire une fiche déjà encaissée (21/10, Esdras) : limite paramétrable, jour même, motif, audit.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { evaluerRetraitCaisse, limiteRetrait, estRefusSolde } = require('../utils/retraitFicheCaisse');
const { estFonctionAbsente } = require('../utils/soldeAtomique');

const MIDI = Date.parse('2026-10-21T17:00:00Z'); // 13 h à Port-au-Prince
const AUJOURDHUI = '2026-10-21T15:30:00Z';
const HIER = '2026-10-20T15:30:00Z';
const fiche = (total = 3000, date_creation = AUJOURDHUI) => ({ id: 'f1', episode_id: 'e1', numero_fiche: 2, total_global: total, date_creation, cree_par: 'x' });
const cash = (montant = 3000, date_paiement = AUJOURDHUI) => ({ id: 'p1', mode: 'cash', montant, solde_restant: 0, details: {}, date_paiement });
const eval_ = (o) => evaluerRetraitCaisse({ fiche: fiche(), paiements: [cash()], episode: { id: 'e1' }, parametres: {}, motif: 'Le client ne veut plus', maintenantMs: MIDI, ...o });

test('limite : 7500 par défaut, paramétrable, une valeur absurde retombe sur le défaut', () => {
  assert.strictEqual(limiteRetrait({}), 7500);
  assert.strictEqual(limiteRetrait(null), 7500);
  assert.strictEqual(limiteRetrait({ montantRetraitFicheCaisse: 5000 }), 5000);
  assert.strictEqual(limiteRetrait({ montantRetraitFicheCaisse: '9000' }), 7500);
  assert.strictEqual(limiteRetrait({ montantRetraitFicheCaisse: -1 }), 7500);
});

test('une fiche sous la limite, encaissée aujourd\'hui, avec motif : acceptée', () => {
  const v = eval_({});
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.horsDelai, false);
});

test('23/10 : plus de plafond de montant pour la caisse — comme la direction, toute fiche de la même session', () => {
  assert.strictEqual(eval_({ fiche: fiche(7500), paiements: [cash(7500)] }).ok, true);
  assert.strictEqual(eval_({ fiche: fiche(250000), paiements: [cash(250000)], parametres: { montantRetraitFicheCaisse: 2000 } }).ok, true);
});

test('encaissée hier : refusée (jour d\'Haïti), sauf rejeu de la file hors ligne qui passe mais est signalé', () => {
  const hier = { paiements: [cash(3000, HIER)], fiche: fiche(3000, HIER) };
  assert.strictEqual(eval_(hier).code, 'HORS_DELAI');
  const rejeu = eval_({ ...hier, rejeu: true });
  assert.strictEqual(rejeu.ok, true);
  assert.strictEqual(rejeu.horsDelai, true);
});

test('le jour est celui d\'Haïti, pas celui d\'UTC : 22 h à Port-au-Prince compte encore pour le même jour', () => {
  const soir = Date.parse('2026-10-22T02:30:00Z'); // 21 oct, 22 h 30 en Haïti
  assert.strictEqual(eval_({ maintenantMs: soir, paiements: [cash(3000, '2026-10-21T14:00:00Z')] }).ok, true);
});

test('motif obligatoire (5 caractères au moins) et borné', () => {
  assert.strictEqual(eval_({ motif: '' }).code, 'MOTIF_REQUIS');
  assert.strictEqual(eval_({ motif: ' ab ' }).code, 'MOTIF_REQUIS');
  assert.strictEqual(eval_({ motif: 'x'.repeat(301) }).code, 'MOTIF_TROP_LONG');
});

test('22/10 : crédit, paiement partiel, partenaire, exonération, dépôt — tous les modes se corrigent (la dette est recalculée par la base)', () => {
  assert.strictEqual(eval_({ paiements: [{ ...cash(0), mode: 'credit', solde_restant: 3000 }] }).ok, true);
  assert.strictEqual(eval_({ paiements: [{ ...cash(1000), solde_restant: 2000, details: { paiement_partiel: true } }] }).ok, true);
  assert.strictEqual(eval_({ paiements: [{ ...cash(3000), mode: 'ong' }] }).ok, true);
  assert.strictEqual(eval_({ paiements: [{ ...cash(0), mode: 'exoneration' }] }).ok, true);
  assert.strictEqual(eval_({ paiements: [{ ...cash(3000), mode: 'depot' }] }).ok, true);
});

test('un remboursement de crédit ne se corrige jamais depuis une fiche', () => {
  assert.strictEqual(eval_({ paiements: [{ ...cash(500), mode: 'remboursement_credit' }] }).code, 'PAIEMENT_NON_CORRIGEABLE');
});

test('« même session » : encaissé hier mais APRÈS l\'ouverture du poste ouvert de la personne → accepté ; avant l\'ouverture → refusé', () => {
  const nuit = { paiements: [cash(3000, '2026-10-20T23:30:00Z')], fiche: fiche(3000, '2026-10-20T23:30:00Z') }; // hier 19 h 30 en Haïti
  assert.strictEqual(eval_(nuit).code, 'HORS_DELAI');
  assert.strictEqual(eval_({ ...nuit, debutSessionMs: Date.parse('2026-10-20T22:00:00Z') }).ok, true, 'poste ouvert avant l\'encaissement');
  assert.strictEqual(eval_({ ...nuit, debutSessionMs: Date.parse('2026-10-21T01:00:00Z') }).code, 'HORS_DELAI', 'poste ouvert après l\'encaissement : autre session');
  assert.strictEqual(eval_({ ...nuit, debutSessionMs: NaN }).code, 'HORS_DELAI', 'date de session illisible : on ne devine pas');
});

test('estRefusSolde : CHF11 (remboursement déjà passé après la dette) et CHF12 ; jamais une autre erreur', () => {
  assert.strictEqual(estRefusSolde({ code: 'CHF11' }), true);
  assert.strictEqual(estRefusSolde({ code: 'CHF12' }), true);
  for (const e of [null, {}, { code: 'CHF03' }, { code: 'PGRST202' }, { code: '23505' }]) assert.strictEqual(estRefusSolde(e), false);
});

test('dossier déjà facturé au partenaire (verrouillé ou avec numéro de lot) : refusé', () => {
  assert.strictEqual(eval_({ episode: { verrouille_facture: true } }).code, 'DOSSIER_VERROUILLE');
  assert.strictEqual(eval_({ episode: { numero_lot: 12 } }).code, 'DOSSIER_VERROUILLE');
});

test('fiche sans paiement : le jour de création sert de référence', () => {
  assert.strictEqual(eval_({ paiements: [] }).ok, true);
  assert.strictEqual(eval_({ paiements: [], fiche: fiche(3000, HIER) }).code, 'HORS_DELAI');
});

// ---- La route elle-même (extraite de server.js, base simulée) ----
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const debut = source.indexOf("app.post('/api/fiches/:id/retirer-caisse'");
const fin = source.indexOf("// Restauration d'une fiche mise à la corbeille", debut);
assert.ok(debut > 0 && fin > debut, 'route introuvable dans server.js');
const code = source.slice(debut, fin);

function monter({ droits = ['caisse_travailler'], fiches, paiements, episodes = [{ id: 'e1', local_id: 'ep-1' }], parametres = {}, sessions = [], fonctionSolde = 'presente' } = {}) {
  const routes = {}; const audit = []; const rpcs = [];
  const app = { post: (c, f) => { routes[c] = f; } };
  const tables = { fiches, paiements, episodes, catalog: [{ type: 'parametres', items: parametres }, { type: 'sessions_caisse', items: sessions }] };
  const supabase = {
    rpc: async (nom, a) => {
      rpcs.push({ nom, a });
      if (nom === 'retirer_fiche_ajuster_solde') {
        if (fonctionSolde === 'absente') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.retirer_fiche_ajuster_solde' } };
        if (typeof fonctionSolde === 'object') return { data: null, error: fonctionSolde };
        tables.paiements.filter(p => a.p_paiements.includes(p.id)).forEach(p => { p.supprime_le = a.p_horodatage; });
        tables.fiches.filter(f => f.id === a.p_fiche).forEach(f => { f.supprime_le = a.p_horodatage; });
        return { data: { deja_retiree: false, dette_retiree: 1200, paiements_ajustes: 2 }, error: null };
      }
      return { data: [{ id: 'f9', numero_fiche: 1 }], error: null };
    },
    from: (table) => {
      const f = []; let action = 'select'; let corps = null;
      const L = () => tables[table].filter(r => f.every(g => g(r)));
      const c = {
        select: () => c, eq: (k, v) => { f.push(r => r[k] === v); return c; },
        is: (k, v) => { f.push(r => (r[k] ?? null) === v); return c; },
        neq: (k, v) => { f.push(r => r[k] !== v); return c; },
        in: (k, v) => { f.push(r => v.includes(r[k])); return c; },
        update: (v) => { action = 'update'; corps = v; return c; },
        maybeSingle: async () => ({ data: L()[0] || null, error: null }),
        then: (resolve) => {
          if (action === 'update') { const l = L(); l.forEach(r => Object.assign(r, corps)); return resolve({ data: l, error: null }); }
          return resolve({ data: L(), error: null });
        },
      };
      return c;
    },
  };
  new Function('app', 'supabase', 'aPermission', 'estRejeu', 'evaluerRetraitCaisse', 'estRefusSolde', 'estFonctionAbsente', 'MOTIF_MIN', 'enregistrerAuditServeur', 'console', code)(
    app, supabase, async (_u, p) => droits.includes(p), (req) => !!(req.headers && req.headers['x-chf-rejeu']), evaluerRetraitCaisse, estRefusSolde, estFonctionAbsente, 5,
    (_r, a, d) => { audit.push({ a, d }); }, console);
  const appeler = async (req) => { const res = { code: 200, corps: null, status(x) { this.code = x; return this; }, json(b) { this.corps = b; return this; } }; await routes['/api/fiches/:id/retirer-caisse']({ user: { id: 'u1', email: 'caisse@chf.com' }, params: { id: 'f1' }, body: { motif: 'Le client ne veut plus' }, headers: {}, ...req }, res); return res; };
  return { appeler, tables, audit, rpcs };
}
const maintenantISO = () => new Date().toISOString();
const donnees = (surcharge = {}) => ({
  fiches: [{ id: 'f1', episode_id: 'e1', numero_fiche: 2, total_global: 3000, date_creation: maintenantISO(), cree_par: 'moi', supprime_le: null }],
  paiements: [{ id: 'p1', fiche_id: 'f1', mode: 'cash', montant: 3000, solde_restant: 0, details: {}, date_paiement: maintenantISO(), supprime_le: null, annule: false }],
  ...surcharge,
});

test('route : la caisse retire sa propre fiche du jour — fiche et paiement à la corbeille, renumérotation, audit complet', async () => {
  const m = monter(donnees());
  const r = await m.appeler({});
  assert.strictEqual(r.code, 200);
  assert.ok(m.tables.fiches[0].supprime_le && m.tables.paiements[0].supprime_le);
  assert.deepStrictEqual(m.rpcs.map(x => x.nom), ['retirer_fiche_ajuster_solde', 'renumeroter_fiches']);
  const a = m.audit.find(x => x.a === 'fiche_retiree_caisse');
  assert.ok(a);
  assert.strictEqual(a.d.montant_rembourse, 3000);
  assert.strictEqual(a.d.motif, 'Le client ne veut plus');
  assert.strictEqual(a.d.fiche_creee_par, 'moi');
});

test('route : sans aucun des deux droits → 403 et rien ne bouge', async () => {
  const m = monter({ ...donnees(), droits: [] });
  const r = await m.appeler({});
  assert.strictEqual(r.code, 403);
  assert.strictEqual(m.tables.fiches[0].supprime_le, null);
});

test('route : une grosse fiche de la session se retire quand même (plus de plafond)', async () => {
  const m = monter(donnees({ fiches: [{ id: 'f1', episode_id: 'e1', numero_fiche: 1, total_global: 90000, date_creation: maintenantISO(), supprime_le: null }] }));
  assert.strictEqual((await m.appeler({})).code, 200);
  assert.ok(m.tables.paiements[0].supprime_le);
});

test('route : la direction (dossier_annuler) n\'a ni plafond ni délai, mais le motif reste obligatoire', async () => {
  const gros = donnees({ fiches: [{ id: 'f1', episode_id: 'e1', numero_fiche: 1, total_global: 90000, date_creation: '2020-01-01T10:00:00Z', supprime_le: null }] });
  const sansMotif = monter({ ...gros, droits: ['dossier_annuler'] });
  assert.strictEqual((await sansMotif.appeler({ body: {} })).code, 400);
  const m = monter({ ...gros, droits: ['dossier_annuler'] });
  assert.strictEqual((await m.appeler({})).code, 200);
  assert.strictEqual(m.audit.find(x => x.a === 'fiche_retiree_caisse').d.avec_droit_direction, true);
});

test('route : fiche déjà retirée → succès sans rien refaire (rejeu idempotent)', async () => {
  const m = monter(donnees());
  m.tables.fiches[0].supprime_le = '2026-10-21T10:00:00Z';
  const r = await m.appeler({});
  assert.strictEqual(r.code, 200);
  assert.strictEqual(m.audit.length, 0);
});

test('route : Achat Express — paiement relié seulement par local_id, retiré avec la fiche (jamais orphelin)', async () => {
  const d = donnees();
  d.paiements = [{ id: 'p1', fiche_id: null, local_id: 'ep-1-paiement', mode: 'cash', montant: 3000, solde_restant: 0, details: {}, date_paiement: maintenantISO(), supprime_le: null, annule: false }];
  const m = monter(d);
  assert.strictEqual((await m.appeler({})).code, 200);
  assert.ok(m.tables.paiements[0].supprime_le);
});

test('route : rejeu hors ligne d\'une fiche d\'hier → acceptée (le client l\'a déjà retirée), signalée « hors délai »', async () => {
  const d = donnees();
  d.paiements[0].date_paiement = '2026-10-01T10:00:00Z';
  const m = monter(d);
  const r = await m.appeler({ headers: { 'x-chf-rejeu': '1' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(m.audit.find(x => x.a === 'fiche_retiree_caisse').d.hors_delai, true);
});

test('route : un paiement à crédit est maintenant corrigeable — la base retire la dette, l\'audit la mentionne', async () => {
  const d = donnees();
  d.paiements[0] = { ...d.paiements[0], mode: 'credit', montant: 0, solde_restant: 3000 };
  const m = monter(d);
  const r = await m.appeler({});
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.corps.dette_retiree, 1200);
  assert.ok(m.tables.fiches[0].supprime_le && m.tables.paiements[0].supprime_le);
  const appel = m.rpcs.find(x => x.nom === 'retirer_fiche_ajuster_solde');
  assert.deepStrictEqual(appel.a.p_paiements, ['p1']);
  assert.strictEqual(appel.a.p_fiche, 'f1');
  const a = m.audit.find(x => x.a === 'fiche_retiree_caisse');
  assert.strictEqual(a.d.dette_retiree, 1200);
  assert.strictEqual(a.d.paiements_ajustes, 2);
  assert.deepStrictEqual(a.d.modes, ['credit']);
});

test('route : « Corriger » (correction: true) est tracée sous une action à part', async () => {
  const m = monter(donnees());
  assert.strictEqual((await m.appeler({ body: { motif: 'Mauvais acte choisi', correction: true } })).code, 200);
  assert.ok(m.audit.find(x => x.a === 'fiche_corrigee_caisse'));
  assert.ok(!m.audit.find(x => x.a === 'fiche_retiree_caisse'));
});

test('route : hier mais pendant MA session de caisse ouverte → acceptée ; la session d\'un autre ne compte pas', async () => {
  const d = () => { const x = donnees(); x.paiements[0].date_paiement = '2026-10-01T10:00:00Z'; return x; };
  const maSession = { id: 's1', uid: 'u1', statut: 'ouverte', ouvertureISO: '2026-10-01T08:00:00Z', fermetureISO: null };
  assert.strictEqual((await monter({ ...d(), sessions: [maSession] }).appeler({})).code, 200);
  assert.strictEqual((await monter({ ...d(), sessions: [{ ...maSession, uid: 'autre' }] }).appeler({})).corps.code, 'HORS_DELAI');
  assert.strictEqual((await monter({ ...d(), sessions: [{ ...maSession, statut: 'fermee', fermetureISO: '2026-10-01T18:00:00Z' }] }).appeler({})).corps.code, 'HORS_DELAI');
});

test('route : remboursement de crédit déjà passé après la dette → 409 (CHF11), rien n\'est retiré', async () => {
  const m = monter({ ...donnees(), fonctionSolde: { code: 'CHF11', message: 'Un remboursement de crédit a été fait après cette dette' } });
  const r = await m.appeler({});
  assert.strictEqual(r.code, 409);
  assert.strictEqual(r.corps.code, 'CHF11');
  assert.strictEqual(m.tables.fiches[0].supprime_le, null);
  assert.strictEqual(m.audit.length, 0);
});

test('route : fonction SQL pas encore collée → ancien chemin (fiche et paiements retirés quand même), jamais une erreur', async () => {
  const m = monter({ ...donnees(), fonctionSolde: 'absente' });
  const r = await m.appeler({});
  assert.strictEqual(r.code, 200);
  assert.ok(m.tables.fiches[0].supprime_le && m.tables.paiements[0].supprime_le);
  assert.strictEqual(m.audit.find(x => x.a === 'fiche_retiree_caisse').d.dette_retiree, null, 'dette non recalculée : on le dit plutôt que d\'afficher 0');
});

test('route : autre erreur de la base → 500, rien d\'écrit côté serveur', async () => {
  const m = monter({ ...donnees(), fonctionSolde: { code: '08006', message: 'connection failure' } });
  assert.strictEqual((await m.appeler({})).code, 500);
  assert.strictEqual(m.tables.fiches[0].supprime_le, null);
});

test('23/10 : la croix de la direction (DELETE /api/fiches/:id) passe aussi par la fonction qui recalcule la dette, avec repli si elle manque', () => {
  const d = source.indexOf("app.delete('/api/fiches/:id'");
  const bloc = source.slice(d, source.indexOf("app.post('/api/fiches/:id/retirer-caisse'", d));
  assert.match(bloc, /rpc\('retirer_fiche_ajuster_solde', \{ p_fiche: req\.params\.id, p_paiements:/);
  assert.match(bloc, /estRefusSolde\(erreurSolde\)\) return res\.status\(409\)/);
  assert.match(bloc, /estFonctionAbsente\(erreurSolde\)\) return res\.status\(500\)/);
});
