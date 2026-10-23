// tests/fermeture_auto_postes.test.js — fermeture automatique des postes de caisse (15/10).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { limiteHabituelle, limiteEffective, sessionsAFermer, fermerPostesExpires, instantHaiti, partiesHaiti } = require('../utils/fermetureAutoPostes');

const iso = (ms) => new Date(ms).toISOString();
// Octobre 2026 : Haïti est en UTC-4 ; décembre : UTC-5.
test("Heure habituelle de fin : jour → 16h d'Haïti ; nuit → 8h d'Haïti le lendemain (ou le même jour si ouverte après minuit) ; l'heure d'hiver est respectée", () => {
  assert.strictEqual(iso(limiteHabituelle({ poste: 'jour', ouvertureISO: '2026-10-14T17:27:50.306Z' })), '2026-10-14T20:00:00.000Z');
  assert.strictEqual(iso(limiteHabituelle({ poste: 'nuit', ouvertureISO: '2026-10-14T20:05:00Z' })), '2026-10-15T12:00:00.000Z');
  assert.strictEqual(iso(limiteHabituelle({ poste: 'nuit', ouvertureISO: '2026-10-15T05:00:00Z' })), '2026-10-15T12:00:00.000Z');
  assert.strictEqual(iso(limiteHabituelle({ poste: 'jour', ouvertureISO: '2026-12-10T14:00:00Z' })), '2026-12-10T21:00:00.000Z');
  assert.strictEqual(limiteHabituelle({ poste: 'jour', ouvertureISO: 'pas une date' }), null);
  assert.deepStrictEqual(partiesHaiti(instantHaiti(2026, 10, 14, 16)).heure, 16);
});

test("« Garder actif » repousse la limite ; une prolongation plus ancienne que l'heure habituelle ne la raccourcit jamais", () => {
  const s = { poste: 'jour', ouvertureISO: '2026-10-15T13:00:00Z' }; // 9h Haïti → fin 16h = 20:00Z
  assert.strictEqual(iso(limiteEffective(s)), '2026-10-15T20:00:00.000Z');
  assert.strictEqual(iso(limiteEffective({ ...s, prolongeJusqua: '2026-10-15T20:10:00Z' })), '2026-10-15T20:10:00.000Z');
  assert.strictEqual(iso(limiteEffective({ ...s, prolongeJusqua: '2026-10-15T15:00:00Z' })), '2026-10-15T20:00:00.000Z');
});

test("sessionsAFermer : seulement les postes ouverts dont la limite est atteinte", () => {
  const ouvert = { id: 'a', statut: 'ouverte', poste: 'jour', ouvertureISO: '2026-10-15T13:00:00Z' };
  const ferme = { id: 'b', statut: 'fermee', poste: 'jour', ouvertureISO: '2026-10-14T13:00:00Z' };
  const t = (z) => new Date(z).getTime();
  assert.deepStrictEqual(sessionsAFermer([ouvert, ferme], t('2026-10-15T19:59:59Z')), []);
  assert.deepStrictEqual(sessionsAFermer([ouvert, ferme], t('2026-10-15T20:00:00Z')).map(x => x.session.id), ['a']);
  assert.deepStrictEqual(sessionsAFermer([{ ...ouvert, prolongeJusqua: '2026-10-15T20:10:00Z' }], t('2026-10-15T20:05:00Z')), []);
});

function faux(items, { erreurEcriture = null, sansFonctionOuvertes = false } = {}) {
  const ecrit = []; const audits = []; const lectures = { complete: 0, ouvertes: 0 };
  return {
    ecrit, audits, lectures,
    from(table) {
      if (table === 'catalog') return { select: () => ({ eq: () => ({ maybeSingle: async () => { lectures.complete++; return { data: { items }, error: null }; } }) }) };
      if (table === 'audit_log') return { insert: async (l) => { audits.push(l); return { error: null }; } };
      throw new Error('table ' + table);
    },
    async rpc(nom, args) {
      if (nom === 'sessions_caisse_ouvertes') {
        if (sansFonctionOuvertes) return { data: null, error: { code: '42883', message: 'function does not exist' } };
        lectures.ouvertes++; return { data: items.filter(s => s.statut === 'ouverte'), error: null };
      }
      ecrit.push([nom, args]); return { data: null, error: erreurEcriture };
    },
  };
}
const silencieux = { log() {}, warn() {} };

test("Le poste oublié d'hier est fermé au réveil, à l'heure de sa LIMITE (pas à l'heure du réveil), argent non compté, avec trace dans le journal", async () => {
  const supabase = faux([
    { id: 'e', uid: 'u1', nom: 'Esdras', statut: 'ouverte', poste: 'jour', ouvertureISO: '2026-10-14T17:27:50.306Z' },
    { id: 't', uid: 'u2', nom: 'Thamar', statut: 'ouverte', poste: 'jour', ouvertureISO: '2026-10-15T15:34:31.239Z' },
  ]);
  const n = await fermerPostesExpires({ supabase, maintenant: () => new Date('2026-10-15T16:55:00Z').getTime(), journal: silencieux });
  assert.strictEqual(n, 1);
  const [nom, args] = supabase.ecrit[0];
  assert.strictEqual(nom, 'definir_champs_catalogue_lot');
  assert.strictEqual(args.p_type, 'sessions_caisse');
  assert.strictEqual(args.p_maj.length, 1);
  assert.strictEqual(args.p_maj[0].id, 'e');
  const c = args.p_maj[0].champs;
  assert.strictEqual(c.fermetureISO, '2026-10-14T20:00:00.000Z');
  assert.strictEqual(c.statut, 'fermee');
  assert.strictEqual(c.fermetureAuto, true);
  assert.strictEqual(c.comptantRemis, null);
  assert.strictEqual(c.fondConserve, null);
  assert.match(c.justification, /Fermeture automatique/);
  assert.strictEqual(supabase.audits.length, 1);
  assert.strictEqual(supabase.audits[0].action, 'fermeture_auto_session_caisse');
  assert.strictEqual(supabase.audits[0].details.caissier, 'Esdras');
});

test("Rien à fermer → aucune écriture ; une erreur d'écriture ne lève jamais et ne journalise pas de fausse fermeture", async () => {
  const rien = faux([{ id: 't', statut: 'ouverte', poste: 'jour', ouvertureISO: '2026-10-15T15:34:31Z' }]);
  assert.strictEqual(await fermerPostesExpires({ supabase: rien, maintenant: () => new Date('2026-10-15T16:00:00Z').getTime(), journal: silencieux }), 0);
  assert.strictEqual(rien.ecrit.length, 0);
  const panne = faux([{ id: 'e', statut: 'ouverte', poste: 'jour', ouvertureISO: '2026-10-14T17:00:00Z' }], { erreurEcriture: { message: 'boum' } });
  assert.strictEqual(await fermerPostesExpires({ supabase: panne, maintenant: () => new Date('2026-10-15T16:00:00Z').getTime(), journal: silencieux }), 0);
  assert.strictEqual(panne.audits.length, 0);
});

test("server.js : vérification chaque minute ET au réveil du serveur", () => {
  const src = require('./serveurSource').lireServeur();
  assert.match(src, /cron\.schedule\('\* \* \* \* \*', \(\) => \{ fermerPostesExpires\(\{ supabase \}\); \}\);/);
  assert.match(src, /setTimeout\(\(\) => \{ fermerPostesExpires\(\{ supabase \}\); \}, 20000\)\.unref\(\);/);
});

test("La fermeture automatique ne lit QUE les postes ouverts (la liste complète grossit sans fin et est relue chaque minute)", async () => {
  const supabase = faux([
    { id: 'vieux', statut: 'fermee', poste: 'jour', ouvertureISO: '2026-10-01T13:00:00Z' },
    { id: 'e', statut: 'ouverte', poste: 'jour', ouvertureISO: '2026-10-14T17:27:50.306Z' },
  ]);
  const n = await fermerPostesExpires({ supabase, maintenant: () => new Date('2026-10-15T16:55:00Z').getTime(), journal: silencieux });
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(supabase.lectures, { complete: 0, ouvertes: 1 }, 'aucune lecture de la liste complète');
});

test("Tant que la fonction SQL n'existe pas en base, on retombe sur l'ancienne lecture complète : un poste oublié est quand même fermé", async () => {
  const supabase = faux([{ id: 'e', statut: 'ouverte', poste: 'jour', ouvertureISO: '2026-10-14T17:27:50.306Z' }], { sansFonctionOuvertes: true });
  const n = await fermerPostesExpires({ supabase, maintenant: () => new Date('2026-10-15T16:55:00Z').getTime(), journal: silencieux });
  assert.strictEqual(n, 1);
  assert.strictEqual(supabase.lectures.complete, 1);
});
