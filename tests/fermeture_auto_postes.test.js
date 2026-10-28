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

function faux(items, { erreurEcriture = null, sansFonctionOuvertes = false, reglages = {} } = {}) {
  const ecrit = []; const audits = []; const lectures = { complete: 0, ouvertes: 0 };
  return {
    ecrit, audits, lectures,
    from(table) {
      if (table === 'catalog') return { select: () => ({ eq: (_c, type) => ({ maybeSingle: async () => { if (type === 'parametres') return { data: { items: reglages }, error: null }; lectures.complete++; return { data: { items }, error: null }; } }) }) };
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

test("28/10 : les heures de fin de poste se règlent dans Paramètres (heureFinPosteJour / heureFinPosteNuit) ; sans réglage, 16h et 8h comme avant", async () => {
  const { heuresFinPoste } = require('../utils/reglagesDirection');
  assert.deepStrictEqual(heuresFinPoste({}), { jour: 16, nuit: 8 });
  assert.deepStrictEqual(heuresFinPoste({ heureFinPosteJour: 18, heureFinPosteNuit: 7 }), { jour: 18, nuit: 7 });
  for (const mauvais of [24, -1, 7.5, 'abc', null, '']) assert.deepStrictEqual(heuresFinPoste({ heureFinPosteJour: mauvais, heureFinPosteNuit: mauvais }), { jour: 16, nuit: 8 }, `valeur invalide ${mauvais}`);
  const s = { poste: 'jour', ouvertureISO: '2026-10-14T17:27:50.306Z' }; // 13h27 Haïti
  assert.strictEqual(iso(limiteHabituelle(s, { jour: 18, nuit: 8 })), '2026-10-14T22:00:00.000Z', 'jour jusqu\'à 18h Haïti');
  assert.strictEqual(iso(limiteHabituelle({ poste: 'nuit', ouvertureISO: '2026-10-14T20:05:00Z' }, { jour: 16, nuit: 7 })), '2026-10-15T11:00:00.000Z', 'nuit jusqu\'à 7h Haïti');
  // Fermeture réelle avec le réglage : à 17h Haïti (21:00Z) le poste de jour reste ouvert si la direction a mis 18h, mais il est fermé avec l'heure par défaut.
  const ouvert = [{ id: 'e', statut: 'ouverte', poste: 'jour', ouvertureISO: '2026-10-14T17:27:50.306Z' }];
  const tard = faux(ouvert, { reglages: { heureFinPosteJour: 18 } });
  assert.strictEqual(await fermerPostesExpires({ supabase: tard, maintenant: () => new Date('2026-10-14T21:00:00Z').getTime(), journal: silencieux }), 0);
  assert.strictEqual(await fermerPostesExpires({ supabase: tard, maintenant: () => new Date('2026-10-14T22:00:00Z').getTime(), journal: silencieux }), 1);
  assert.strictEqual(tard.ecrit[0][1].p_maj[0].champs.fermetureISO, '2026-10-14T22:00:00.000Z', 'fermée à l\'heure réglée, pas à l\'heure du réveil');
  const defaut = faux(ouvert);
  assert.strictEqual(await fermerPostesExpires({ supabase: defaut, maintenant: () => new Date('2026-10-14T21:00:00Z').getTime(), journal: silencieux }), 1);
});

test("28/10 : aucun poste ouvert → aucune lecture des réglages (la vérification tourne chaque minute)", async () => {
  const supabase = faux([{ id: 'v', statut: 'fermee', poste: 'jour', ouvertureISO: '2026-10-01T13:00:00Z' }]);
  assert.strictEqual(await fermerPostesExpires({ supabase, maintenant: () => Date.now(), journal: silencieux }), 0);
});

test("28/10 : fermeture automatique coupée dans Paramètres (fermetureAutoPostes = false) → AUCUN poste n'est fermé, même très en retard ; sans réglage ou réglage illisible, elle reste active", async () => {
  const { fermetureAutoActive } = require('../utils/reglagesDirection');
  assert.strictEqual(fermetureAutoActive({}), true);
  assert.strictEqual(fermetureAutoActive(undefined), true);
  for (const illisible of ['false', 0, null, 'non']) assert.strictEqual(fermetureAutoActive({ fermetureAutoPostes: illisible }), true, `valeur ${JSON.stringify(illisible)} : reste active`);
  assert.strictEqual(fermetureAutoActive({ fermetureAutoPostes: false }), false);
  const ouvert = [{ id: 'e', statut: 'ouverte', poste: 'jour', ouvertureISO: '2026-10-14T17:27:50.306Z' }];
  const manuel = faux(ouvert, { reglages: { fermetureAutoPostes: false } });
  assert.strictEqual(await fermerPostesExpires({ supabase: manuel, maintenant: () => new Date('2026-10-20T12:00:00Z').getTime(), journal: silencieux }), 0, 'six jours de retard : rien n\'est fermé');
  assert.strictEqual(manuel.ecrit.length, 0, 'aucune écriture');
  assert.strictEqual(manuel.audits.length, 0, 'aucune ligne de journal');
  const auto = faux(ouvert, { reglages: { fermetureAutoPostes: true } });
  assert.strictEqual(await fermerPostesExpires({ supabase: auto, maintenant: () => new Date('2026-10-20T12:00:00Z').getTime(), journal: silencieux }), 1, 'activée : le poste oublié est fermé');
});
