// tests/anomalies.test.js — rapport de contrôle des anomalies de caisse, réservé à l'administrateur (15/10).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { calculerAnomalies, moisDe, moisPrecedent } = require('../utils/anomalies');

const serveurSrc = require('./serveurSource').lireServeur();
const UTIL = [
  { id: 'u1', display_name: 'Marie', role: 'pharmacien' }, { id: 'u2', display_name: 'Paul', role: 'comptable' },
  { id: 'u3', display_name: 'Rose', role: 'pharmacien' }, { id: 'u4', display_name: 'Jean', role: 'comptable' }, { id: 'adm', display_name: 'Esdras', role: 'administrateur' },
];
// Octobre 2026, heure d'Haïti (UTC-4) : midi Haïti = 16h UTC.
const jour = (j) => `2026-10-${String(j).padStart(2, '0')}T16:00:00Z`;
let n = 0;
const paiement = (uid, extra = {}) => ({ id: ++n, mode: 'cash', montant: 100, date_paiement: jour(10), traite_par_uid: uid, encaisse_par: UTIL.find(u => u.id === uid)?.display_name, annule: false, ...extra });
const nPaiements = (uid, k, extra) => Array.from({ length: k }, () => paiement(uid, extra));

test("Mois : découpé en heure d'Haïti (le 1er à 1h du matin d'Haïti compte pour le nouveau mois, pas le précédent)", () => {
  assert.strictEqual(moisDe('2026-10-01T05:00:00Z'), '2026-10'); // 1h Haïti
  assert.strictEqual(moisDe('2026-10-01T03:00:00Z'), '2026-09'); // 23h la veille, Haïti
  assert.strictEqual(moisDe('pas une date'), null);
  assert.strictEqual(moisPrecedent('2026-01'), '2025-12');
  assert.strictEqual(moisPrecedent('2026-10'), '2026-09');
});

test("Totaux par personne : paiements, montants, crédits, exonérations, remboursements, sorties de caisse ; paiements supprimés et autres mois ignorés", () => {
  const paiements = [
    ...nPaiements('u1', 4), paiement('u1', { mode: 'credit', montant: 500 }), paiement('u1', { mode: 'exoneration', montant: 0, exoneration: { montantExonere: 300 } }),
    paiement('u1', { mode: 'remboursement_patient', montant: 200 }), paiement('u1', { mode: 'remboursement_credit', montant: 999 }),
    paiement('u1', { supprime_le: '2026-10-11T00:00:00Z' }), paiement('u1', { date_paiement: '2026-09-15T16:00:00Z' }),
  ];
  const depenses = [{ statut: 'accorde', montant: 1500, caissier_uid: 'u1', date_reponse: jour(12) }, { statut: 'refuse', montant: 9999, caissier_uid: 'u1', date_reponse: jour(12) }];
  const r = calculerAnomalies({ paiements, depenses, utilisateurs: UTIL, mois: '2026-10' });
  const marie = r.parUtilisateur.find(l => l.nom === 'Marie');
  assert.strictEqual(marie.nbPaiements, 6, '4 cash + 1 crédit + 1 exonération ; ni remboursements ni supprimé ni autre mois');
  assert.strictEqual(marie.montantEncaisse, 900);
  assert.deepStrictEqual([marie.nbCredits, marie.montantCredit], [1, 500]);
  assert.deepStrictEqual([marie.nbExonerations, marie.montantExonere], [1, 300]);
  assert.deepStrictEqual([marie.nbRemboursementsPatient, marie.montantRemboursementsPatient], [1, 200]);
  assert.deepStrictEqual([marie.nbSorties, marie.montantSorties], [1, 1500], 'seules les sorties accordées');
  assert.strictEqual(marie.role, 'pharmacien');
});

test("Une annulation est attribuée à CELLE QUI L'A FAITE, pas à l'encaisseuse d'origine", () => {
  const paiements = [...nPaiements('u1', 5), paiement('u1', { annule: true, annule_par_uid: 'u2', annule_par: 'Paul', montant: 250 })];
  const r = calculerAnomalies({ paiements, utilisateurs: UTIL, mois: '2026-10' });
  const paul = r.parUtilisateur.find(l => l.nom === 'Paul');
  assert.deepStrictEqual([paul.nbAnnulationsFaites, paul.montantAnnulations], [1, 250]);
  assert.strictEqual(r.parUtilisateur.find(l => l.nom === 'Marie').nbAnnulationsFaites, 0);
});

test("Signal « annulations » : une personne qui annule au moins 2 fois plus que l'équipe (et au moins 2 fois) est signalée ; une seule annulation ne l'est jamais", () => {
  const base = [...nPaiements('u1', 10), ...nPaiements('u2', 10), ...nPaiements('u3', 10), ...nPaiements('u4', 10)];
  const trop = [...base, ...Array.from({ length: 4 }, () => paiement('u4', { annule: true, annule_par_uid: 'u4', annule_par: 'Jean' }))];
  const r = calculerAnomalies({ paiements: trop, utilisateurs: UTIL, mois: '2026-10' });
  const jean = r.parUtilisateur.find(l => l.nom === 'Jean');
  assert.ok(jean.signaux.some(s => s.cle === 'annulations'), 'Jean est à regarder');
  assert.match(jean.signaux[0].texte, /annulation\(s\) pour 14 paiements/);
  assert.strictEqual(r.parUtilisateur[0].nom, 'Jean', 'les personnes à regarder viennent en premier');
  assert.ok(r.parUtilisateur.filter(l => l.nom !== 'Jean').every(l => l.signaux.length === 0));
  const une = [...base, paiement('u4', { annule: true, annule_par_uid: 'u4', annule_par: 'Jean' })];
  assert.strictEqual(calculerAnomalies({ paiements: une, utilisateurs: UTIL, mois: '2026-10' }).nbSignaux, 0, 'une seule annulation : aucun signal');
});

test("Pas de signal sans équipe à comparer (moins de 3 personnes actives) ni pour quelqu'un qui a peu d'activité", () => {
  const deux = [...nPaiements('u1', 10), ...nPaiements('u2', 10), ...Array.from({ length: 5 }, () => paiement('u2', { annule: true, annule_par_uid: 'u2' }))];
  assert.strictEqual(calculerAnomalies({ paiements: deux, utilisateurs: UTIL, mois: '2026-10' }).nbSignaux, 0, 'deux personnes ne font pas une équipe');
  const peu = [...nPaiements('u1', 10), ...nPaiements('u2', 10), ...nPaiements('u3', 10), ...nPaiements('u4', 2), ...Array.from({ length: 2 }, () => paiement('u4', { annule: true, annule_par_uid: 'u4' }))];
  const r = calculerAnomalies({ paiements: peu, utilisateurs: UTIL, mois: '2026-10' });
  assert.strictEqual(r.parUtilisateur.find(l => l.nom === 'Jean').tauxAnnulation, 0.5, '2 annulations pour 4 paiements : le taux est fort, mais…');
  assert.strictEqual(r.nbSignaux, 0, 'moins de 5 paiements : pas assez pour comparer');
});

test("Postes fermés automatiquement : signalés tout de suite (argent non compté)", () => {
  const sessions = [{ uid: 'u1', nom: 'Marie', fermetureAuto: true, ouvertureISO: jour(14) }, { uid: 'u1', nom: 'Marie', ouvertureISO: jour(15) }, { uid: 'u1', nom: 'Marie', fermetureAuto: true, ouvertureISO: '2026-09-02T16:00:00Z' }];
  const marie = calculerAnomalies({ paiements: nPaiements('u1', 1), sessions, utilisateurs: UTIL, mois: '2026-10' }).parUtilisateur.find(l => l.nom === 'Marie');
  assert.strictEqual(marie.nbFermeturesAuto, 1);
  assert.ok(marie.signaux.some(s => s.cle === 'fermetures_auto'));
});

test("Données manquantes ou étranges : jamais d'erreur (uid absent → regroupé par nom ; montants texte ; lignes nulles)", () => {
  const r = calculerAnomalies({ paiements: [null, { mode: 'cash', montant: '120.50', date_paiement: jour(3), encaisse_par: 'Ancien caissier' }, { mode: 'cash', montant: 'abc', date_paiement: jour(3) }], depenses: [null], sessions: [null], utilisateurs: [], mois: '2026-10' });
  assert.strictEqual(r.parUtilisateur.find(l => l.nom === 'Ancien caissier').montantEncaisse, 120.5);
  assert.deepStrictEqual(calculerAnomalies({ mois: '2026-10' }).parUtilisateur, []);
});

test("Route GET /api/admin/anomalies : RÉSERVÉE au rôle administrateur (pas une permission), 2 mois renvoyés, lecture paginée", () => {
  const i = serveurSrc.indexOf("app.get('/api/admin/anomalies'");
  assert.ok(i > serveurSrc.indexOf("app.use('/api', verifyToken)"), 'derrière la vérification du jeton');
  const bloc = serveurSrc.slice(i, serveurSrc.indexOf("app.post('/api/admin/invitations'", i));
  assert.match(bloc, /profil\.role !== 'administrateur'/);
  assert.doesNotMatch(bloc, /aPermission\(/, "pas de permission à attribuer à un autre rôle");
  assert.match(bloc, /calculerAnomalies\(\{ \.\.\.entree, mois \}\)/);
  assert.match(bloc, /calculerAnomalies\(\{ \.\.\.entree, mois: precedent \}\)/);
  assert.match(bloc, /\.range\(i \* 1000, i \* 1000 \+ 999\)/);
});

// La route EXÉCUTÉE (extraite de server.js) sur de fausses tables.
function appeler({ role, paiements = [], mois, echecPaiements = false }) {
  const debut = serveurSrc.indexOf("app.get('/api/admin/anomalies'");
  const fin = serveurSrc.indexOf("app.post('/api/admin/invitations'", debut);
  const tables = {
    users: [{ id: 'moi', role, display_name: 'Moi' }, ...UTIL],
    paiements, depenses_caisse: [], catalog: [{ type: 'sessions_caisse', items: [] }],
  };
  const supabase = { from(table) {
    let lignes = tables[table]; const filtres = [];
    const q = {
      select: () => q, eq: (c, v) => { filtres.push(l => l[c] === v); return q; }, gte: () => q, lt: () => q, order: () => q,
      range: async (a, b) => (echecPaiements && table === 'paiements' ? { data: null, error: { message: 'boum' } } : { data: lignes.filter(l => filtres.every(f => f(l))).slice(a, b + 1), error: null }),
      maybeSingle: async () => ({ data: lignes.filter(l => filtres.every(f => f(l)))[0] || null, error: null }),
      then: (ok, ko) => Promise.resolve({ data: lignes.filter(l => filtres.every(f => f(l))), error: null }).then(ok, ko),
    };
    return q;
  } };
  let gestionnaire; const app = { get: (_c, fn) => { gestionnaire = fn; } };
  new Function('app', 'supabase', 'calculerAnomalies', 'moisDe', 'moisPrecedent', serveurSrc.slice(debut, fin))(app, supabase, calculerAnomalies, moisDe, moisPrecedent);
  const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
  return gestionnaire({ user: { id: 'moi' }, query: mois ? { mois } : {} }, res).then(() => res);
}

test("Exécutée : un administrateur reçoit le rapport (mois demandé et précédent) ; tout autre rôle reçoit 403 sans aucune donnée", async () => {
  const paiements = [...nPaiements('u1', 6), paiement('u1', { date_paiement: '2026-09-20T16:00:00Z' })];
  const ok = await appeler({ role: 'administrateur', paiements, mois: '2026-10' });
  assert.strictEqual(ok.code, 200);
  assert.strictEqual(ok.corps.mois, '2026-10'); assert.strictEqual(ok.corps.precedent, '2026-09');
  assert.strictEqual(ok.corps.actuel.parUtilisateur.find(l => l.nom === 'Marie').nbPaiements, 6);
  assert.strictEqual(ok.corps.moisPrecedent.parUtilisateur.find(l => l.nom === 'Marie').nbPaiements, 1);
  for (const role of ['direction', 'comptable', 'pharmacien_chef', 'auditeur']) {
    const refus = await appeler({ role, paiements, mois: '2026-10' });
    assert.strictEqual(refus.code, 403, role); assert.strictEqual(refus.corps.actuel, undefined, role);
  }
});

test("Exécutée : mois invalide → mois courant ; lecture impossible → erreur claire sans planter", async () => {
  const ok = await appeler({ role: 'administrateur', mois: 'n-importe-quoi' });
  assert.match(ok.corps.mois, /^\d{4}-\d{2}$/);
  const panne = await appeler({ role: 'administrateur', mois: '2026-10', echecPaiements: true });
  assert.strictEqual(panne.code, 500); assert.match(panne.corps.error, /Lecture impossible/);
});

test("23/10 : la route importe vraiment ses trois fonctions (elles n'étaient jamais importées : la route plantait en production)", () => {
  const module_ = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'routes', 'administration.js'), 'utf8');
  assert.match(module_, /const \{ calculerAnomalies, moisDe, moisPrecedent \} = require\('\.\.\/utils\/anomalies'\);/);
});
