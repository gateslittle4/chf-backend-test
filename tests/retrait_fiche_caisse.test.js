// tests/retrait_fiche_caisse.test.js — la caisse retire une fiche déjà encaissée (21/10, Esdras) : limite paramétrable, jour même, motif, audit.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { evaluerRetraitCaisse, limiteRetrait } = require('../utils/retraitFicheCaisse');

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

test('« inférieur à 7500 » : 7499 passe, 7500 pile est refusé', () => {
  assert.strictEqual(eval_({ fiche: fiche(7499), paiements: [cash(7499)] }).ok, true);
  const v = eval_({ fiche: fiche(7500), paiements: [cash(7500)] });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'MONTANT_AU_DESSUS_LIMITE');
});

test('le plafond suit le paramètre', () => {
  assert.strictEqual(eval_({ parametres: { montantRetraitFicheCaisse: 2000 } }).code, 'MONTANT_AU_DESSUS_LIMITE');
  assert.strictEqual(eval_({ fiche: fiche(10000), paiements: [cash(10000)], parametres: { montantRetraitFicheCaisse: 15000 } }).ok, true);
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

test('crédit, paiement partiel, partenaire, exonération : réservés à la direction', () => {
  assert.strictEqual(eval_({ paiements: [{ ...cash(0), mode: 'credit', solde_restant: 3000 }] }).code, 'PAIEMENT_A_CREDIT');
  assert.strictEqual(eval_({ paiements: [{ ...cash(1000), solde_restant: 2000, details: { paiement_partiel: true } }] }).code, 'PAIEMENT_A_CREDIT');
  assert.strictEqual(eval_({ paiements: [{ ...cash(3000), mode: 'ong' }] }).code, 'MODE_RESERVE');
  assert.strictEqual(eval_({ paiements: [{ ...cash(0), mode: 'exoneration' }] }).code, 'MODE_RESERVE');
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

function monter({ droits = ['caisse_travailler'], fiches, paiements, episodes = [{ id: 'e1', local_id: 'ep-1' }], parametres = {} } = {}) {
  const routes = {}; const audit = []; const rpcs = [];
  const app = { post: (c, f) => { routes[c] = f; } };
  const tables = { fiches, paiements, episodes, catalog: [{ type: 'parametres', items: parametres }] };
  const supabase = {
    rpc: async (nom, a) => { rpcs.push({ nom, a }); return { data: [{ id: 'f9', numero_fiche: 1 }], error: null }; },
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
  new Function('app', 'supabase', 'aPermission', 'estRejeu', 'evaluerRetraitCaisse', 'MOTIF_MIN', 'enregistrerAuditServeur', 'console', code)(
    app, supabase, async (_u, p) => droits.includes(p), (req) => !!(req.headers && req.headers['x-chf-rejeu']), evaluerRetraitCaisse, 5,
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
  assert.strictEqual(m.rpcs[0].nom, 'renumeroter_fiches');
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

test('route : au-dessus de la limite → 403 MONTANT_AU_DESSUS_LIMITE, rien supprimé, tentative tracée', async () => {
  const m = monter(donnees({ fiches: [{ id: 'f1', episode_id: 'e1', numero_fiche: 1, total_global: 9000, date_creation: maintenantISO(), supprime_le: null }] }));
  const r = await m.appeler({});
  assert.strictEqual(r.code, 403);
  assert.strictEqual(r.corps.code, 'MONTANT_AU_DESSUS_LIMITE');
  assert.strictEqual(m.tables.paiements[0].supprime_le, null);
  assert.ok(m.audit.some(x => x.a === 'fiche_retrait_caisse_refuse'));
});

test('route : le plafond lu est celui des Paramètres', async () => {
  const m = monter({ ...donnees(), parametres: { montantRetraitFicheCaisse: 2000 } });
  assert.strictEqual((await m.appeler({})).code, 403);
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

test('route : un paiement à crédit refuse le retrait par la caisse', async () => {
  const d = donnees();
  d.paiements[0] = { ...d.paiements[0], mode: 'credit', montant: 0, solde_restant: 3000 };
  const m = monter(d);
  assert.strictEqual((await m.appeler({})).corps.code, 'PAIEMENT_A_CREDIT');
  assert.strictEqual(m.tables.fiches[0].supprime_le, null);
});
