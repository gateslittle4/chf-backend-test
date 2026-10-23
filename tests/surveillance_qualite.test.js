// tests/surveillance_qualite.test.js — surveillance de la qualité des données (18/10) : corrections de forme tracées, instantané, alerte avec les noms, historique.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { creerSurveillance, corrections, nomCorrige, composerAlerte, ACTION_INSTANTANE, ACTION_CORRECTION } = require('../utils/surveillanceQualite');
const { controlerQualite } = require('../utils/qualiteDonnees');

const serveur = require('./serveurSource').lireServeur();
const MAINTENANT = new Date('2026-10-18T12:00:00Z'); // 8h à Haïti

function fauxSupabase(tables) {
  const q = (nom) => {
    let filtres = [], ordre = null, limite = null, mode = 'select', maj = null, lignes = null;
    const builder = {
      select() { return builder; }, order(c, o) { ordre = [c, o && o.ascending === false]; return builder; }, limit(n) { limite = n; return builder; },
      eq(c, v) { filtres.push([c, v]); return builder; },
      update(m) { mode = 'update'; maj = m; return builder; }, insert(l) { mode = 'insert'; lignes = Array.isArray(l) ? l : [l]; return builder; },
      then(ok, ko) { return Promise.resolve(executer()).then(ok, ko); },
    };
    const executer = () => {
      const table = tables[nom] || (tables[nom] = []);
      if (mode === 'insert') { table.push(...lignes.map(l => ({ ...l }))); return { data: null, error: null }; }
      const cibles = table.filter(l => filtres.every(([c, v]) => l[c] === v));
      if (mode === 'update') { cibles.forEach(l => Object.assign(l, maj)); return { data: cibles.map(l => ({ id: l.id })), error: null }; }
      let r = cibles.map(l => ({ ...l }));
      if (ordre) r.sort((a, b) => (String(a[ordre[0]]) < String(b[ordre[0]]) ? -1 : 1) * (ordre[1] ? -1 : 1));
      if (limite) r = r.slice(0, limite);
      return { data: r, error: null };
    };
    return builder;
  };
  return { from: q };
}
const lireToutesLesPages = async (construire) => (await construire()).data;
const calmes = { log() {}, warn() {}, error() {} };
const dossier = (id, nom, plus = {}) => ({ id, numero_dossier: `N${id}`, nom, date_naissance: '1990-01-01', telephone: '34567890', adresse: 'Rue 1', sexe: 'F', mere_dossier_id: null, fusionne_dans: null, ...plus });

test("corrections de forme : espaces en trop, nom tout en minuscules ou tout en MAJUSCULES ; un nom aux majuscules mêlées n'est JAMAIS touché", () => {
  assert.strictEqual(nomCorrige('marie  joseph'), 'Marie Joseph');
  assert.strictEqual(nomCorrige('JEAN PIERRE'), 'Jean Pierre');
  assert.strictEqual(nomCorrige('  Marie Joseph '), 'Marie Joseph');
  assert.strictEqual(nomCorrige('Marie Joseph'), null);
  assert.strictEqual(nomCorrige('McDonald de la Cruz'), null, 'majuscules mêlées : on ne touche pas');
  assert.strictEqual(nomCorrige('A'), null);
  const c = corrections([dossier('1', 'jean  paul', { telephone: ' 3456  7890 ', adresse: 'Rue  du   Port ' }), dossier('2', 'Marie Joseph'), dossier('3', 'x y', { fusionne_dans: 'z' })]);
  assert.deepStrictEqual(c.map(x => [x.id, x.champ, x.apres]), [['1', 'nom', 'Jean Paul'], ['1', 'telephone', '3456 7890'], ['1', 'adresse', 'Rue du Port']]);
  assert.strictEqual(corrections(Array.from({ length: 900 }, (_, i) => dossier(String(i), 'jean  paul'))).length, 500, 'au plus 500 corrections par nuit');
});

test("un passage : corrections appliquées ET écrites au journal (avant → après), instantané enregistré, alerte avec les NOMS", async () => {
  const tables = {
    dossiers: [dossier('1', 'jean  paul'), dossier('2', 'Marie Joseph', { date_naissance: null }), dossier('3', 'Esther Pierre', { sexe: null })],
    episodes: [{ id: 'e1', dossier_id: '1', statut: 'ferme', date_ouverture: '2026-10-01T00:00:00Z' }], audit_log: [], doublons_ignores: [],
  };
  const alertes = [];
  const s = creerSurveillance({ supabase: fauxSupabase(tables), lireToutesLesPages, envoyerAlerte: async (m) => alertes.push(m), maintenant: () => MAINTENANT, journal: calmes });
  const r = await s.executer({ origine: 'minuteur' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.corrections, 1);
  assert.strictEqual(tables.dossiers[0].nom, 'Jean Paul');
  const corr = tables.audit_log.filter(l => l.action === ACTION_CORRECTION);
  assert.deepStrictEqual(corr.map(l => [l.details.champ, l.details.avant, l.details.apres]), [['nom', 'jean  paul', 'Jean Paul']]);
  const snap = tables.audit_log.filter(l => l.action === ACTION_INSTANTANE);
  assert.strictEqual(snap.length, 1); assert.strictEqual(snap[0].details.date_jour, '2026-10-18'); assert.strictEqual(snap[0].details.total, r.total);
  assert.strictEqual(snap[0].details.par_controle.sans_naissance.nombre, 1);
  const texte = alertes.join('\n');
  assert.match(texte, /Marie Joseph/); assert.match(texte, /Esther Pierre/); assert.match(texte, /1 correction\(s\) de forme/);
  assert.doesNotMatch(texte, /1990|34567890/, "jamais de date ni de téléphone dans l'alerte : seulement les noms");
  assert.strictEqual(await s.surveillanceDuJourFaite(), true);
  const apres = creerSurveillance({ supabase: fauxSupabase(tables), lireToutesLesPages, maintenant: () => new Date('2026-10-19T12:00:00Z'), journal: calmes });
  assert.strictEqual(await apres.surveillanceDuJourFaite(), false, 'le lendemain, un nouveau passage est dû');
});

test("rien à signaler : aucune alerte (mais l'instantané est quand même écrit) ; sans alerte demandée (bouton manuel) : aucune alerte non plus", async () => {
  const propre = { dossiers: [dossier('1', 'Marie Joseph')], episodes: [], audit_log: [], doublons_ignores: [] };
  const alertes = [];
  const s = creerSurveillance({ supabase: fauxSupabase(propre), lireToutesLesPages, envoyerAlerte: async (m) => alertes.push(m), maintenant: () => MAINTENANT, journal: calmes });
  const r = await s.executer();
  assert.strictEqual(r.alerte, false); assert.strictEqual(alertes.length, 0); assert.strictEqual(propre.audit_log.length, 1);
  const sale = { dossiers: [dossier('1', 'Marie Joseph', { sexe: null })], episodes: [], audit_log: [], doublons_ignores: [] };
  const s2 = creerSurveillance({ supabase: fauxSupabase(sale), lireToutesLesPages, envoyerAlerte: async (m) => alertes.push(m), maintenant: () => MAINTENANT, journal: calmes });
  await s2.executer({ origine: 'manuel', alerter: false });
  assert.strictEqual(alertes.length, 0);
});

test("doublons possibles : comptés dans l'instantané et nommés dans l'alerte ; une paire déclarée « pas les mêmes » n'est plus comptée", async () => {
  const A = dossier('a', 'Marie Joseph Pierre'), B = dossier('b', 'Marie Joseph Pierre', { numero_dossier: 'N-b' });
  const tables = { dossiers: [A, B], episodes: [], audit_log: [], doublons_ignores: [] };
  const alertes = [];
  const s = creerSurveillance({ supabase: fauxSupabase(tables), lireToutesLesPages, envoyerAlerte: async (m) => alertes.push(m), maintenant: () => MAINTENANT, journal: calmes });
  const r = await s.executer();
  assert.strictEqual(r.doublons, 1); assert.match(alertes.join('\n'), /Doublons possibles \(1\) : Marie Joseph Pierre ↔ Marie Joseph Pierre/);
  tables.doublons_ignores.push({ dossier_a: 'a', dossier_b: 'b' });
  const r2 = await s.executer();
  assert.strictEqual(r2.doublons, 0);
});

test("alerte : coupée en messages courts (800 caractères), au plus 3, « … et N autre(s) » après 8 noms par contrôle", () => {
  const dossiers = Array.from({ length: 60 }, (_, i) => dossier(String(i), `Patient Numéro ${i} Avec Un Nom Assez Long`, { sexe: null, date_naissance: null, telephone: '' }));
  const q = controlerQualite({ dossiers, episodes: [], maintenantMs: MAINTENANT.getTime() });
  const messages = composerAlerte({ controles: q.controles, doublons: { total: 0, paires: [] }, nbCorrections: 0, date: '2026-10-18' });
  assert.ok(messages.length >= 2 && messages.length <= 3);
  for (const m of messages) assert.ok(m.length <= 880, `message trop long : ${m.length}`);
  assert.match(messages.join('\n'), /… et 52 autre\(s\)/);
});

test("historique et corrections récentes : les plus récents d'abord", async () => {
  const tables = { dossiers: [dossier('1', 'jean  paul')], episodes: [], audit_log: [], doublons_ignores: [] };
  let t = Date.parse('2026-10-16T12:00:00Z');
  const s = creerSurveillance({ supabase: fauxSupabase(tables), lireToutesLesPages, maintenant: () => new Date(t), journal: calmes });
  await s.executer(); t += 86400000; tables.dossiers[0].nom = 'marie  anne'; await s.executer();
  const h = await s.historique(30);
  assert.deepStrictEqual(h.map(x => x.date_jour), ['2026-10-17', '2026-10-16']);
  const c = await s.correctionsRecentes();
  assert.deepStrictEqual(c.map(x => x.apres), ['Marie Anne', 'Jean Paul']);
  assert.strictEqual((await s.dernierInstantane()).date_jour, '2026-10-17');
});

test("un passage qui échoue ne lève jamais : { ok: false } (le serveur n'est pas gêné)", async () => {
  const s = creerSurveillance({ supabase: { from() { throw new Error('base injoignable'); } }, lireToutesLesPages, maintenant: () => MAINTENANT, journal: calmes });
  const r = await s.executer();
  assert.deepStrictEqual([r.ok, r.erreur], [false, 'base injoignable']);
});

test("le nouveau contrôle « dossiers avec épisode mais sans numéro » ignore les dossiers « examens seulement »", () => {
  const q = controlerQualite({
    dossiers: [dossier('1', 'Marie Joseph', { numero_dossier: 'EN-ATTENTE-AAAAAAAAAA' }), dossier('2', 'Jean Paul', { numero_dossier: 'EXAMEN-BBBBBBBBBB' }), dossier('3', 'Anne Marie', { numero_dossier: 'EN-ATTENTE-CCCCCCCCCC' })],
    episodes: [{ id: 'e1', dossier_id: '1', statut: 'ferme' }, { id: 'e2', dossier_id: '2', statut: 'ferme' }], maintenantMs: MAINTENANT.getTime(),
  });
  const c = q.controles.find(x => x.cle === 'sans_numero');
  assert.deepStrictEqual(c.exemples.map(x => x.nom), ['Marie Joseph'], 'sans épisode (Anne Marie) ou examens seulement (Jean Paul) : pas signalé');
});

test("câblage : minuteur à 7h d'Haïti, rattrapage au réveil, un seul passage à la fois, routes protégées", () => {
  assert.match(serveur, /cron\.schedule\('0 11 \* \* \*', \(\) => \{ lancerSurveillanceQualite\(\{ origine: 'minuteur' \}\); \}\);/);
  assert.match(serveur, /surveillanceDuJourFaite\(\)\)\) await lancerSurveillanceQualite\(\{ origine: 'rattrapage au réveil' \}\)/);
  assert.match(serveur, /if \(surveillanceEnCours\) return surveillanceEnCours;/);
  for (const route of ["app.get('/api/qualite-donnees'", "app.get('/api/qualite-donnees/resume'", "app.get('/api/qualite-donnees/surveillance'", "app.post('/api/qualite-donnees/surveillance/lancer'"]) {
    const i = serveur.indexOf(route); assert.ok(i !== -1, route);
    assert.match(serveur.slice(i, i + 260), /exigerAdministrateur\(req, res\)/, route);
  }
  assert.match(serveur.slice(serveur.indexOf("app.post('/api/qualite-donnees/surveillance/lancer'")), /origine: 'manuel', alerter: false/);
});

test("Qualité des données : toutes les routes sont réservées à l'administrateur (ni direction_voir ni fiche_patient_modifier ne suffisent) — rôle PDG sans accès", () => {
  const src = require('./serveurSource').lireServeur();
  assert.doesNotMatch(src, /peutSurveillerQualite/);
  const i = src.indexOf("app.get('/api/qualite-donnees'");
  const bloc = src.slice(i, src.indexOf("app.get('/api/qualite-donnees/surveillance'", i) + 600);
  assert.strictEqual((bloc.match(/exigerAdministrateur\(req, res\)/g) || []).length, 3);
  const lancer = src.slice(src.indexOf("app.post('/api/qualite-donnees/surveillance/lancer'"));
  assert.match(lancer.slice(0, 300), /exigerAdministrateur\(req, res\)/);
});
