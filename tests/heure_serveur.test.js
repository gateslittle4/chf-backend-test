// tests/heure_serveur.test.js — 13/10 (Esdras) : « l'heure du paiement doit être l'heure réelle, pas l'heure de l'ordi ; on peut dérégler l'ordi ».
// La route POST /api/paiements enregistre l'heure du SERVEUR pour une requête en direct ; un rejeu de la file hors ligne garde l'heure corrigée de
// l'app, sans jamais l'avancer dans le futur. Chaque réponse porte l'heure du serveur (X-CHF-Heure) pour que l'app cale son horloge.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { TOLERANCE_MS, heureDuPaiement, appliquerHeureAuPaiement, estRejeu, middlewareHeureServeur } = require('../utils/heureServeur');

const MAINTENANT = new Date('2026-10-13T15:00:00.000Z');
const iso = (ms) => new Date(MAINTENANT.getTime() + ms).toISOString();

test("En direct : l'heure du serveur fait foi, quelle que soit l'heure annoncée par l'ordinateur", () => {
  for (const decalage of [0, 30e3, -30e3, 3 * 3600e3, -5 * 3600e3, 40 * 86400e3]) {
    const r = heureDuPaiement({ dateClient: iso(decalage), rejeu: false, maintenant: MAINTENANT });
    assert.strictEqual(r.date, MAINTENANT.toISOString(), `décalage ${decalage}`);
  }
  assert.strictEqual(heureDuPaiement({ dateClient: undefined, maintenant: MAINTENANT }).date, MAINTENANT.toISOString(), 'sans date : heure du serveur');
  assert.strictEqual(heureDuPaiement({ dateClient: 'pas une date', maintenant: MAINTENANT }).date, MAINTENANT.toISOString());
});

test("En direct : un écart de plus de 2 minutes est gardé dans details (quelle heure l'ordinateur annonçait, de combien) ; en dessous, rien", () => {
  assert.strictEqual(heureDuPaiement({ dateClient: iso(TOLERANCE_MS - 1000), maintenant: MAINTENANT }).details, null);
  assert.strictEqual(heureDuPaiement({ dateClient: iso(-(TOLERANCE_MS - 1000)), maintenant: MAINTENANT }).details, null);
  const r = heureDuPaiement({ dateClient: iso(2 * 3600e3), maintenant: MAINTENANT });
  assert.deepStrictEqual(r.details, { heure_appareil: iso(2 * 3600e3), decalage_appareil_s: 7200 });
  const r2 = heureDuPaiement({ dateClient: iso(-600e3), maintenant: MAINTENANT });
  assert.strictEqual(r2.details.decalage_appareil_s, -600);
});

test("Rejeu hors ligne : l'heure corrigée de l'app est GARDÉE (le paiement a eu lieu avant), marquée heure_hors_ligne", () => {
  const avant = iso(-3 * 3600e3); // fait il y a 3 h, rejoué maintenant
  const r = heureDuPaiement({ dateClient: avant, rejeu: true, maintenant: MAINTENANT });
  assert.strictEqual(r.date, avant);
  assert.deepStrictEqual(r.details, { heure_hors_ligne: true });
});

test("Rejeu hors ligne : jamais dans le futur ; sans heure lisible : heure du serveur, signalé", () => {
  const futur = heureDuPaiement({ dateClient: iso(2 * 3600e3), rejeu: true, maintenant: MAINTENANT });
  assert.strictEqual(futur.date, MAINTENANT.toISOString(), 'une opération hors ligne ne vient pas du futur');
  assert.strictEqual(futur.details.heure_hors_ligne, true);
  assert.strictEqual(futur.details.decalage_appareil_s, 7200);
  const presqueMaintenant = heureDuPaiement({ dateClient: iso(30e3), rejeu: true, maintenant: MAINTENANT });
  assert.ok(Date.parse(presqueMaintenant.date) <= MAINTENANT.getTime(), 'jamais au-delà de maintenant');
  const inconnu = heureDuPaiement({ dateClient: null, rejeu: true, maintenant: MAINTENANT });
  assert.strictEqual(inconnu.date, MAINTENANT.toISOString());
  assert.deepStrictEqual(inconnu.details, { heure_hors_ligne: true, heure_inconnue: true });
});

test("estRejeu : seulement l'en-tête X-CHF-Rejeu à 1 ou true", () => {
  assert.strictEqual(estRejeu({ headers: { 'x-chf-rejeu': '1' } }), true);
  assert.strictEqual(estRejeu({ headers: { 'x-chf-rejeu': 'true' } }), true);
  for (const h of [{}, { 'x-chf-rejeu': '0' }, { 'x-chf-rejeu': 'oui' }, { 'x-chf-rejeu': '' }]) assert.strictEqual(estRejeu({ headers: h }), false, JSON.stringify(h));
  assert.strictEqual(estRejeu({}), false);
  assert.strictEqual(estRejeu(null), false);
});

test("appliquerHeureAuPaiement : écrase date_paiement, fusionne details sans perdre ceux de l'app (dépôt utilisé, paiement partiel...)", () => {
  const corps = { montant: 100, date_paiement: iso(5 * 3600e3), details: { montant_depot_utilise: 50, paiement_partiel: true } };
  appliquerHeureAuPaiement(corps, { headers: {} }, MAINTENANT);
  assert.strictEqual(corps.date_paiement, MAINTENANT.toISOString());
  assert.strictEqual(corps.details.montant_depot_utilise, 50);
  assert.strictEqual(corps.details.paiement_partiel, true);
  assert.strictEqual(corps.details.decalage_appareil_s, 18000);
  const propre = { montant: 1, date_paiement: iso(1000) };
  appliquerHeureAuPaiement(propre, { headers: {} }, MAINTENANT);
  assert.strictEqual(propre.details, undefined, 'pas de bruit quand l\'horloge est juste');
  // details non objet (tableau, texte) : remplacé proprement, jamais d'exception
  const bizarre = { date_paiement: iso(5 * 3600e3), details: ['x'] };
  assert.doesNotThrow(() => appliquerHeureAuPaiement(bizarre, { headers: {} }, MAINTENANT));
  assert.strictEqual(bizarre.details.decalage_appareil_s, 18000);
  const rejeu = { date_paiement: iso(-7200e3) };
  appliquerHeureAuPaiement(rejeu, { headers: { 'x-chf-rejeu': '1' } }, MAINTENANT);
  assert.strictEqual(rejeu.date_paiement, iso(-7200e3));
  assert.strictEqual(rejeu.details.heure_hors_ligne, true);
});

test("middleware : chaque réponse porte l'heure du serveur en millisecondes", () => {
  const entetes = {};
  let suite = false;
  const avant = Date.now();
  middlewareHeureServeur({}, { setHeader: (k, v) => { entetes[k] = v; } }, () => { suite = true; });
  assert.ok(suite);
  const ms = Number(entetes['X-CHF-Heure']);
  assert.ok(ms >= avant && ms <= Date.now());
});

test("server.js : l'heure est appliquée AVANT le calcul du solde, l'en-tête est exposé à CORS et le middleware est installé avant les routes", () => {
  const src = require('./serveurSource').lireServeur();
  assert.match(src, /exposedHeaders: \[ENTETE_HEURE\]/, 'sans cela le navigateur ne peut pas lire l\'heure du serveur');
  const iMiddleware = src.indexOf('app.use(middlewareHeureServeur);');
  const iJson = src.indexOf("app.use(express.json({ limit: '10mb' }));");
  assert.ok(iMiddleware > 0 && iMiddleware < iJson, 'middleware installé avant les routes');
  const route = src.slice(src.indexOf("app.post('/api/paiements'"), src.indexOf("app.post('/api/paiements'") + 6000);
  const iHeure = route.indexOf('appliquerHeureAuPaiement(corps, req);');
  assert.ok(iHeure > 0, 'la route applique l\'heure');
  assert.ok(iHeure < route.indexOf('validerPaiementPartiel(corps)'), 'avant les contrôles et le calcul du solde');
  assert.ok(iHeure > route.indexOf('const corps = { ...req.body };'), 'sur la copie du corps');
  // Les autres routes qui créent un paiement utilisent déjà l'heure du serveur (jamais celle de l'ordinateur)
  assert.strictEqual((src.match(/date_paiement: maintenant,/g) || []).length, 4);
});

test("sql/heure_reelle_audit.sql : l'heure d'une ligne d'audit est celle de la base (déclencheur BEFORE INSERT), sans DROP ni REVOKE", () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'heure_reelle_audit.sql'), 'utf8');
  assert.match(sql, /new\.date := now\(\);/);
  assert.match(sql, /before insert on public\.audit_log/i);
  assert.doesNotMatch(sql, /^\s*(drop|revoke)\b/im, 'le connecteur Supabase des sessions Claude bloque DROP/REVOKE');
  assert.match(sql, /create or replace function chf_interne\./i);
});
