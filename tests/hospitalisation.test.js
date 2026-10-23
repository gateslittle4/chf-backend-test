// tests/hospitalisation.test.js — consultation → hospitalisation : nouvel épisode lié, dépôt et dette transférés sans argent encaissé (19/10).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { hospitaliserEpisode, validerDemande, MODE_TRANSFERT } = require('../utils/hospitalisation');
const { fermerConsultationsAnciennes } = require('../utils/fermetureConsultations');

const serveur = require('./serveurSource').lireServeur();
const debutFn = serveur.indexOf('function calculerSoldeDepot');
const calculerSoldeDepot = new Function(`${serveur.slice(debutFn, serveur.indexOf('\n}\n', debutFn) + 3)}; return calculerSoldeDepot;`)();

// Base simulée : tables episodes / paiements / dossiers / audit_log ; chaînes select/update/insert/delete avec filtres eq/is/in/order.
function baseSimulee({ episodes = [], paiements = [], echecInsertPaiementNumero = null } = {}) {
  const tables = { episodes, paiements, dossiers: [{ id: 'd1', nom: 'Marie Joseph' }], audit_log: [] };
  let seq = 0; let nbInsertPaiement = 0;
  const from = (nom) => {
    const filtres = []; let action = 'select'; let corps = null; let tri = null; let limite = null;
    const lignes = () => {
      let l = tables[nom].filter(r => filtres.every(f => f(r)));
      if (tri) l = [...l].sort((a, b) => (a[tri.c] > b[tri.c] ? 1 : a[tri.c] < b[tri.c] ? -1 : 0) * (tri.asc ? 1 : -1));
      return limite ? l.slice(0, limite) : l;
    };
    const chaine = {
      select: () => chaine,
      eq: (c, v) => { filtres.push(r => r[c] === v); return chaine; },
      neq: (c, v) => { filtres.push(r => r[c] !== v); return chaine; },
      is: (c, v) => { filtres.push(r => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return chaine; },
      in: (c, v) => { filtres.push(r => v.includes(r[c])); return chaine; },
      lt: (c, v) => { filtres.push(r => String(r[c]) < String(v)); return chaine; },
      order: (c, o) => { tri = { c, asc: o ? o.ascending !== false : true }; return chaine; },
      limit: (n) => { limite = n; return chaine; },
      update: (maj) => { action = 'update'; corps = maj; return chaine; },
      insert: (ligne) => { action = 'insert'; corps = ligne; return chaine; },
      delete: () => { action = 'delete'; return chaine; },
      maybeSingle: async () => ({ data: lignes()[0] || null, error: null }),
      single: async () => {
        if (action === 'insert') return inserer();
        const l = lignes()[0]; return l ? { data: l, error: null } : { data: null, error: { message: 'introuvable' } };
      },
      then: (resolve) => {
        if (action === 'update') { const l = lignes(); l.forEach(r => Object.assign(r, corps)); return resolve({ data: l, error: null }); }
        if (action === 'insert') { inserer().then(resolve); return; }
        if (action === 'delete') { const l = lignes(); tables[nom] = tables[nom].filter(r => !l.includes(r)); return resolve({ data: null, error: null }); }
        return resolve({ data: lignes(), error: null });
      },
    };
    const inserer = async () => {
      if (nom === 'paiements') { nbInsertPaiement++; if (echecInsertPaiementNumero === nbInsertPaiement) return { data: null, error: { message: 'échec simulé' } }; }
      const ligne = { id: `${nom}-${++seq}`, annule: false, supprime_le: null, ...corps };
      tables[nom].push(ligne); return { data: ligne, error: null };
    };
    return chaine;
  };
  return { from, tables };
}

const consultation = (extra = {}) => ({ id: 'c1', dossier_id: 'd1', voie_entree: 'consultation', service: null, type_consultation: 'Général', type_patient: 'prive', ong_partenaire: null, statut: 'ouvert', est_hospitalisation: false, supprime_le: null, date_ouverture: '2026-10-19T10:00:00Z', ...extra });
const util = { id: 'u1', email: 'caisse@chf.com' };
const lancer = (base, extra = {}) => hospitaliserEpisode({ supabase: base, episodeId: 'c1', service: 'Maternité', typeLit: 'semi_prive', utilisateur: util, calculerSoldeDepot, maintenant: () => new Date('2026-10-19T15:00:00Z'), ...extra });
const soldes = (base, episodeId) => { const p = base.tables.paiements.filter(x => x.episode_id === episodeId && !x.annule); const { soldeDepot } = calculerSoldeDepot(p); const d = [...p].sort((a, b) => String(a.date_paiement).localeCompare(String(b.date_paiement))).pop(); return { depot: soldeDepot, dette: d ? Number(d.solde_restant) || 0 : 0 }; };

test('demande : service et type de lit obligatoires', () => {
  assert.match(validerDemande({ service: '', typeLit: 'normal' }), /service/i);
  assert.match(validerDemande({ service: 'Maternité', typeLit: 'palace' }), /lit/i);
  assert.strictEqual(validerDemande({ service: 'Maternité', typeLit: 'incubateur' }), null);
});

test('sans dépôt ni dette : la consultation se ferme (motif hospitalise), un nouvel épisode lié s\'ouvre, aucun paiement créé', async () => {
  const base = baseSimulee({ episodes: [consultation({ type_patient: 'partenaire', ong_partenaire: 'AVSI' })] });
  const r = await lancer(base);
  const [ancienne, nouvelle] = base.tables.episodes;
  assert.strictEqual(ancienne.statut, 'ferme'); assert.strictEqual(ancienne.motif_fermeture, 'hospitalise'); assert.strictEqual(ancienne.date_fermeture, '2026-10-19T15:00:00.000Z');
  assert.strictEqual(nouvelle.est_hospitalisation, true); assert.strictEqual(nouvelle.statut, 'ouvert'); assert.strictEqual(nouvelle.service, 'Maternité'); assert.strictEqual(nouvelle.type_lit, 'semi_prive');
  assert.strictEqual(nouvelle.episode_origine_id, 'c1'); assert.strictEqual(nouvelle.dossier_id, 'd1'); assert.strictEqual(nouvelle.voie_entree, 'urgence');
  assert.strictEqual(nouvelle.type_patient, 'partenaire'); assert.strictEqual(nouvelle.ong_partenaire, 'AVSI');
  assert.strictEqual(base.tables.paiements.length, 0); assert.deepStrictEqual(r.transfere, { depot: 0, dette: 0 });
});

test('dépôt restant : transféré (la consultation tombe à 0, l\'hospitalisation reçoit le solde) ; les lignes valent 0 Gdes — aucun argent encaissé', async () => {
  const paiements = [
    { id: 'p1', episode_id: 'c1', mode: 'depot', montant: 5000, solde_restant: 0, date_paiement: '2026-10-19T08:00:00Z' },
    { id: 'p2', episode_id: 'c1', mode: 'cash', montant: 0, solde_restant: 0, date_paiement: '2026-10-19T09:00:00Z', details: { montant_depot_utilise: 500 } },
  ];
  const base = baseSimulee({ episodes: [consultation()], paiements });
  assert.deepStrictEqual(soldes(base, 'c1'), { depot: 4500, dette: 0 });
  const r = await lancer(base);
  const nouveauId = r.nouvelEpisode.id;
  assert.deepStrictEqual(r.transfere, { depot: 4500, dette: 0 });
  assert.deepStrictEqual(soldes(base, 'c1'), { depot: 0, dette: 0 }, 'la consultation n\'a plus de dépôt');
  assert.deepStrictEqual(soldes(base, nouveauId), { depot: 4500, dette: 0 }, 'l\'hospitalisation l\'a');
  const lignes = base.tables.paiements.filter(p => p.mode === MODE_TRANSFERT);
  assert.strictEqual(lignes.length, 2); assert.ok(lignes.every(p => p.montant === 0), 'montant 0 : la caisse ne compte rien');
  const somme = base.tables.paiements.filter(p => p.mode !== 'depot').reduce((s, p) => s + p.montant, 0);
  assert.strictEqual(somme, 0, 'aucune recette ajoutée');
});

test('dette (crédit) restante : reprise par l\'hospitalisation (le dernier paiement fait foi), la consultation passe à 0 ; l\'ancienneté de la dette est gardée', async () => {
  const paiements = [
    { id: 'p1', episode_id: 'c1', mode: 'credit', montant: 0, solde_restant: 1000, date_paiement: '2026-10-10T08:00:00Z' },
    { id: 'p2', episode_id: 'c1', mode: 'remboursement_credit', montant: 200, solde_restant: 800, date_paiement: '2026-10-15T08:00:00Z' },
  ];
  const base = baseSimulee({ episodes: [consultation()], paiements });
  const r = await lancer(base);
  assert.deepStrictEqual(r.transfere, { depot: 0, dette: 800 });
  assert.deepStrictEqual(soldes(base, 'c1'), { depot: 0, dette: 0 });
  assert.deepStrictEqual(soldes(base, r.nouvelEpisode.id), { depot: 0, dette: 800 });
  const entrante = base.tables.paiements.find(p => p.episode_id === r.nouvelEpisode.id);
  assert.strictEqual(entrante.details.dette_depuis, '2026-10-10T08:00:00Z');
});

test('dépôt ET dette ensemble ; les paiements annulés ne comptent pas', async () => {
  const paiements = [
    { id: 'p1', episode_id: 'c1', mode: 'depot', montant: 3000, solde_restant: 0, date_paiement: '2026-10-19T08:00:00Z' },
    { id: 'p2', episode_id: 'c1', mode: 'depot', montant: 9999, solde_restant: 0, date_paiement: '2026-10-19T08:30:00Z', annule: true },
    { id: 'p3', episode_id: 'c1', mode: 'credit', montant: 0, solde_restant: 600, date_paiement: '2026-10-19T09:00:00Z' },
  ];
  const base = baseSimulee({ episodes: [consultation()], paiements });
  const r = await lancer(base);
  assert.deepStrictEqual(r.transfere, { depot: 3000, dette: 600 });
  assert.deepStrictEqual(soldes(base, r.nouvelEpisode.id), { depot: 3000, dette: 600 });
  assert.deepStrictEqual(soldes(base, 'c1'), { depot: 0, dette: 0 });
});

test('refus : déjà hospitalisation, épisode fermé, vente comptoir, introuvable ; un 2e clic ne recommence rien', async () => {
  for (const [ep, code] of [[consultation({ est_hospitalisation: true }), 'DEJA_HOSPITALISE'], [consultation({ statut: 'ferme' }), 'EPISODE_FERME'], [consultation({ voie_entree: 'vente_comptoir' }), 'VENTE_COMPTOIR']]) {
    await assert.rejects(lancer(baseSimulee({ episodes: [ep] })), (e) => e.code === code && e.statut === 400);
  }
  await assert.rejects(lancer(baseSimulee({ episodes: [] })), (e) => e.statut === 404);
  const base = baseSimulee({ episodes: [consultation()] });
  await lancer(base);
  await assert.rejects(lancer(base), (e) => e.statut === 400, 'la consultation est déjà fermée');
  assert.strictEqual(base.tables.episodes.filter(e => e.est_hospitalisation).length, 1, 'une seule hospitalisation');
});

test('si un transfert échoue, tout est défait : consultation rouverte, aucun épisode ni ligne laissés', async () => {
  for (const echec of [1, 2]) {
    const paiements = [{ id: 'p1', episode_id: 'c1', mode: 'depot', montant: 5000, solde_restant: 0, date_paiement: '2026-10-19T08:00:00Z' }];
    const base = baseSimulee({ episodes: [consultation()], paiements, echecInsertPaiementNumero: echec });
    await assert.rejects(lancer(base), (e) => e.statut === 500);
    assert.strictEqual(base.tables.episodes.length, 1, 'pas de 2e épisode');
    assert.strictEqual(base.tables.episodes[0].statut, 'ouvert'); assert.strictEqual(base.tables.episodes[0].date_fermeture, null); assert.strictEqual(base.tables.episodes[0].motif_fermeture, null);
    assert.strictEqual(base.tables.paiements.length, 1, 'aucune ligne de transfert restante');
    assert.deepStrictEqual(soldes(base, 'c1'), { depot: 5000, dette: 0 });
  }
});

test('calculerSoldeDepot : le dépôt transféré s\'ajoute, sans compter comme dépôt encaissé', () => {
  assert.deepStrictEqual(calculerSoldeDepot([{ mode: MODE_TRANSFERT, montant: 0, details: { depot_transfere: 700 } }]), { totalDepots: 700, totalDepotUtilise: 0, soldeDepot: 700 });
  assert.strictEqual(calculerSoldeDepot([{ mode: 'depot', montant: 1000 }, { mode: 'cash', details: { montant_depot_utilise: 400 } }]).soldeDepot, 600);
});

test('fermeture automatique : seules les consultations ouvertes de plus de 30 jours (ni hospitalisation, ni vente comptoir, ni suspendue/reportée) ; journal écrit', async () => {
  const il = (j) => new Date(Date.parse('2026-10-19T12:00:00Z') - j * 86400000).toISOString();
  const eps = [
    consultation({ id: 'vieille', date_ouverture: il(31) }), consultation({ id: 'recente', date_ouverture: il(29) }),
    consultation({ id: 'hosp', est_hospitalisation: true, date_ouverture: il(60) }), consultation({ id: 'comptoir', voie_entree: 'vente_comptoir', date_ouverture: il(60) }),
    consultation({ id: 'suspendue', date_suspension: il(40), date_ouverture: il(60) }), consultation({ id: 'reportee', mois_report: '2026-11', date_ouverture: il(60) }),
    consultation({ id: 'fermee', statut: 'ferme', date_ouverture: il(60) }), consultation({ id: 'corbeille', supprime_le: il(1), date_ouverture: il(60) }),
  ].map(e => ({ date_suspension: null, mois_report: null, ...e }));
  const base = baseSimulee({ episodes: eps });
  const r = await fermerConsultationsAnciennes({ supabase: base, maintenant: () => new Date('2026-10-19T12:00:00Z'), journal: { log() {}, warn() {} } });
  assert.deepStrictEqual(r, { ok: true, fermees: 1 });
  const ferme = base.tables.episodes.find(e => e.id === 'vieille');
  assert.strictEqual(ferme.statut, 'ferme'); assert.strictEqual(ferme.motif_fermeture, 'fermeture_automatique');
  assert.deepStrictEqual(base.tables.episodes.filter(e => e.statut === 'ferme' && e.motif_fermeture === 'fermeture_automatique').map(e => e.id), ['vieille']);
  assert.strictEqual(base.tables.audit_log.length, 1); assert.strictEqual(base.tables.audit_log[0].action, 'fermeture_auto_consultations'); assert.strictEqual(base.tables.audit_log[0].details.nombre, 1);
  const encore = await fermerConsultationsAnciennes({ supabase: base, maintenant: () => new Date('2026-10-19T12:00:00Z'), journal: { log() {}, warn() {} } });
  assert.strictEqual(encore.fermees, 0, 'idempotent');
});

test('serveur : route Hospitaliser branchée (droit episode_creer, audit), cron de fermeture, script SQL complet', () => {
  assert.match(serveur, /app\.post\('\/api\/episodes\/:id\/hospitaliser-nouvel-episode'/);
  assert.match(serveur, /enregistrerAuditServeur\(req, 'consultation_vers_hospitalisation'/);
  assert.match(serveur, /cron\.schedule\('20 10 \* \* \*', \(\) => \{ fermerConsultationsAnciennes/);
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'hospitaliser_depuis_consultation.sql'), 'utf8');
  for (const x of ['episode_origine_id', 'type_lit', "'hospitalise'", "'fermeture_automatique'", "'transfert_hospitalisation'", "'cheque'", 'begin;', 'commit;']) assert.ok(sql.includes(x), x);
  assert.doesNotMatch(sql, /delete from|drop table|truncate/i);
});
