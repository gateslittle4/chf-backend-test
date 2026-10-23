// tests/limiteur.test.js — 13/10 : « Add rate limits ... to login, OTP, transfers, withdrawals and other sensitive operations » (liste de contrôle fintech d'Esdras).
// Compteurs, middlewares, et un vrai serveur HTTP Express : mêmes réponses que la production (429 + Retry-After + message en français).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { creerCompteur, creerLimiteUtilisateur, creerLimitePublique, creerLimiteEchecsAuth, SEUILS, desactive } = require('../utils/limiteur');

function horloge(depart = 1_000_000) { const h = { t: depart, maintenant: () => h.t, avancer(ms) { h.t += ms; } }; return h; }

test("Compteur : laisse passer jusqu'au seuil, refuse ensuite en disant dans combien de temps réessayer, repart à la fenêtre suivante", () => {
  const h = horloge();
  const c = creerCompteur({ fenetreMs: 60000, max: 3, maintenant: h.maintenant });
  for (let i = 0; i < 3; i++) assert.strictEqual(c.essayer('a').autorise, true, `requête ${i + 1}`);
  const refus = c.essayer('a');
  assert.strictEqual(refus.autorise, false);
  assert.strictEqual(refus.reessayerDansMs, 60000);
  h.avancer(45000);
  assert.strictEqual(c.essayer('a').reessayerDansMs, 15000, 'le temps restant diminue');
  assert.strictEqual(c.essayer('b').autorise, true, 'une autre clé n\'est pas touchée');
  h.avancer(15000);
  assert.strictEqual(c.essayer('a').autorise, true, 'nouvelle fenêtre : on repart de zéro');
});

test("Compteur : le nettoyage oublie les fenêtres terminées (la mémoire ne grossit pas)", () => {
  const h = horloge();
  const c = creerCompteur({ fenetreMs: 1000, max: 5, maintenant: h.maintenant });
  for (let i = 0; i < 100; i++) c.essayer(`cle-${i}`);
  assert.strictEqual(c.taille, 100);
  h.avancer(500); c.nettoyer(); assert.strictEqual(c.taille, 100, 'fenêtres encore ouvertes : gardées');
  h.avancer(600); c.nettoyer(); assert.strictEqual(c.taille, 0);
});

// Faux verifyToken : « Bearer <id> » → req.user.id ; sinon 401, comme le vrai (qui compte aussi les échecs).
async function demarrerServeur({ seuils, maxEchecs, maxPublic, h } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  const limiteUtilisateur = creerLimiteUtilisateur({ maintenant: h.maintenant, seuils });
  const echecs = creerLimiteEchecsAuth({ maintenant: h.maintenant, max: maxEchecs });
  const publique = creerLimitePublique({ maintenant: h.maintenant, max: maxPublic });
  const { refuser } = require('../utils/limiteur');
  app.get('/', (req, res) => res.json({ ok: true }));
  app.get('/invitation/:t', publique, (req, res) => res.json({ invitation: true }));
  app.use('/api', (req, res, next) => {
    const a = req.headers.authorization || '';
    if (a.startsWith('Bearer ') && a !== 'Bearer mauvais') { req.user = { id: a.slice(7) }; return next(); }
    const b = echecs.signalerEchec(req);
    if (b.bloque) return refuser(res, b.reessayerDansMs, 'echecs_auth');
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  });
  app.use('/api', limiteUtilisateur);
  app.get('/api/episodes', (req, res) => res.json([]));
  app.post('/api/paiements', (req, res) => res.status(201).json({ id: 1 }));
  app.post('/api/fiches', (req, res) => res.status(201).json({ id: 1 }));
  const serveur = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = serveur.address().port;
  const appeler = (methode, chemin, { jeton, ip } = {}) => new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (jeton) headers.Authorization = `Bearer ${jeton}`;
    if (ip) headers['X-Forwarded-For'] = ip;
    const req = http.request({ host: '127.0.0.1', port, path: chemin, method: methode, headers }, (res) => {
      let corps = ''; res.on('data', d => corps += d); res.on('end', () => resolve({ statut: res.statusCode, entetes: res.headers, corps: corps ? JSON.parse(corps) : null }));
    });
    req.on('error', reject); req.end(methode === 'POST' ? '{}' : undefined);
  });
  return { appeler, fermer: () => new Promise(r => serveur.close(r)) };
}

test("Un usage normal ne rencontre jamais la limite (rythme d'une caisse, reprise de 40 paiements après une longue coupure)", async () => {
  const h = horloge();
  const s = await demarrerServeur({ h });
  try {
    for (let i = 0; i < 40; i++) assert.strictEqual((await s.appeler('POST', '/api/paiements', { jeton: 'caissiere' })).statut, 201, `paiement ${i + 1} de la reprise`);
    for (let i = 0; i < 100; i++) assert.strictEqual((await s.appeler('GET', '/api/episodes', { jeton: 'caissiere' })).statut, 200);
    assert.strictEqual((await s.appeler('GET', '/')).statut, 200, 'le test de santé de Render n\'est jamais limité');
  } finally { await s.fermer(); }
});

test("Paiements : au-delà du seuil par compte, 429 avec Retry-After et un message clair ; les autres comptes ne sont pas touchés ; la minute suivante tout repart", async () => {
  const h = horloge();
  const s = await demarrerServeur({ h, seuils: { paiements: 5, ecritures: 100, generale: 100 } });
  try {
    for (let i = 0; i < 5; i++) assert.strictEqual((await s.appeler('POST', '/api/paiements', { jeton: 'script' })).statut, 201);
    const r = await s.appeler('POST', '/api/paiements', { jeton: 'script' });
    assert.strictEqual(r.statut, 429);
    assert.strictEqual(r.corps.error, 'TROP_DE_REQUETES');
    assert.strictEqual(r.corps.raison, 'paiements');
    assert.match(r.corps.message, /Trop de demandes en peu de temps\. Réessaie dans 60 secondes\./);
    assert.strictEqual(r.entetes['retry-after'], '60');
    assert.strictEqual((await s.appeler('POST', '/api/paiements', { jeton: 'autre-caissiere' })).statut, 201, 'un autre compte passe');
    assert.strictEqual((await s.appeler('GET', '/api/episodes', { jeton: 'script' })).statut, 200, 'les lectures du même compte passent encore');
    assert.strictEqual((await s.appeler('POST', '/api/fiches', { jeton: 'script' })).statut, 201, 'une autre écriture aussi : seuls les paiements sont limités ici');
    h.avancer(61000);
    assert.strictEqual((await s.appeler('POST', '/api/paiements', { jeton: 'script' })).statut, 201, 'la minute suivante');
  } finally { await s.fermer(); }
});

test("Écritures et requêtes générales : seuils par compte, indépendants", async () => {
  const h = horloge();
  const s = await demarrerServeur({ h, seuils: { ecritures: 3, generale: 6, paiements: 100 } });
  try {
    for (let i = 0; i < 3; i++) assert.strictEqual((await s.appeler('POST', '/api/fiches', { jeton: 'u' })).statut, 201);
    const e = await s.appeler('POST', '/api/fiches', { jeton: 'u' });
    assert.strictEqual(e.statut, 429); assert.strictEqual(e.corps.raison, 'ecritures');
    // 4 requêtes comptées jusqu'ici (3 + 1 refusée) ; il en reste 2 avant la limite générale de 6
    assert.strictEqual((await s.appeler('GET', '/api/episodes', { jeton: 'u' })).statut, 200);
    assert.strictEqual((await s.appeler('GET', '/api/episodes', { jeton: 'u' })).statut, 200);
    const g = await s.appeler('GET', '/api/episodes', { jeton: 'u' });
    assert.strictEqual(g.statut, 429); assert.strictEqual(g.corps.raison, 'generale');
  } finally { await s.fermer(); }
});

test("Mauvais jetons : après trop d'échecs depuis la même adresse, 429 au lieu de 401 — mais un jeton VALIDE passe toujours, même depuis cette adresse", async () => {
  const h = horloge();
  const s = await demarrerServeur({ h, maxEchecs: 4 });
  try {
    for (let i = 0; i < 4; i++) assert.strictEqual((await s.appeler('GET', '/api/episodes', { jeton: 'mauvais', ip: '203.0.113.7' })).statut, 401, `échec ${i + 1}`);
    const bloque = await s.appeler('GET', '/api/episodes', { jeton: 'mauvais', ip: '203.0.113.7' });
    assert.strictEqual(bloque.statut, 429);
    assert.strictEqual(bloque.corps.raison, 'echecs_auth');
    assert.ok(Number(bloque.entetes['retry-after']) > 0);
    assert.strictEqual((await s.appeler('GET', '/api/episodes', { ip: '203.0.113.7' })).statut, 429, 'sans jeton : bloqué aussi');
    assert.strictEqual((await s.appeler('GET', '/api/episodes', { jeton: 'caissiere', ip: '203.0.113.7' })).statut, 200, 'jeton valide depuis la même adresse : jamais bloqué');
    assert.strictEqual((await s.appeler('GET', '/api/episodes', { jeton: 'mauvais', ip: '198.51.100.9' })).statut, 401, 'une autre adresse n\'est pas touchée');
    h.avancer(11 * 60 * 1000);
    assert.strictEqual((await s.appeler('GET', '/api/episodes', { jeton: 'mauvais', ip: '203.0.113.7' })).statut, 401, 'après 10 minutes l\'adresse repart de zéro');
  } finally { await s.fermer(); }
});

test("Pages publiques (invitation) : limitées par adresse, large ; une autre adresse n'est pas touchée", async () => {
  const h = horloge();
  const s = await demarrerServeur({ h, maxPublic: 5 });
  try {
    for (let i = 0; i < 5; i++) assert.strictEqual((await s.appeler('GET', '/invitation/abc', { ip: '203.0.113.7' })).statut, 200);
    const r = await s.appeler('GET', '/invitation/abc', { ip: '203.0.113.7' });
    assert.strictEqual(r.statut, 429); assert.strictEqual(r.corps.raison, 'publique');
    assert.strictEqual((await s.appeler('GET', '/invitation/abc', { ip: '198.51.100.9' })).statut, 200);
  } finally { await s.fermer(); }
});

test("Interrupteur de secours : DESACTIVER_LIMITES=1 coupe toutes les limites sans toucher au code", async () => {
  const h = horloge();
  const s = await demarrerServeur({ h, seuils: { paiements: 1, ecritures: 1, generale: 1 }, maxEchecs: 1, maxPublic: 1 });
  const avant = process.env.DESACTIVER_LIMITES;
  try {
    process.env.DESACTIVER_LIMITES = '1';
    assert.strictEqual(desactive(), true);
    for (let i = 0; i < 5; i++) assert.strictEqual((await s.appeler('POST', '/api/paiements', { jeton: 'u' })).statut, 201);
    for (let i = 0; i < 5; i++) assert.strictEqual((await s.appeler('GET', '/invitation/x', { ip: '203.0.113.7' })).statut, 200);
    for (let i = 0; i < 5; i++) assert.strictEqual((await s.appeler('GET', '/api/episodes', { jeton: 'mauvais', ip: '203.0.113.7' })).statut, 401);
    delete process.env.DESACTIVER_LIMITES;
    assert.strictEqual(desactive(), false);
    assert.strictEqual((await s.appeler('POST', '/api/paiements', { jeton: 'nouveau' })).statut, 201);
    assert.strictEqual((await s.appeler('POST', '/api/paiements', { jeton: 'nouveau' })).statut, 429, 'remis en route');
  } finally { if (avant === undefined) delete process.env.DESACTIVER_LIMITES; else process.env.DESACTIVER_LIMITES = avant; await s.fermer(); }
});

test("Seuils par défaut : très au-dessus d'un usage normal (une caisse, tout l'hôpital sur une même adresse)", () => {
  assert.ok(SEUILS.generale >= 300 && SEUILS.ecritures >= 100 && SEUILS.paiements >= 60);
  assert.ok(SEUILS.paiements <= SEUILS.ecritures && SEUILS.ecritures <= SEUILS.generale, 'du plus précis au plus large');
});

test("server.js : limites branchées au bon endroit (après l'identité, avant l'idempotence et les routes), mauvais jetons comptés, pages publiques limitées, trust proxy réglable", () => {
  const src = require('./serveurSource').lireServeur();
  const iVerif = src.indexOf("app.use('/api', verifyToken);");
  const iLimite = src.indexOf("app.use('/api', limiteUtilisateur);");
  const iIdem = src.indexOf("app.use('/api', creerMiddlewareIdempotence(supabase));");
  assert.ok(iVerif > 0 && iVerif < iLimite && iLimite < iIdem, 'verifyToken, puis limites par compte, puis idempotence');
  assert.strictEqual((src.match(/limiteEchecsAuth\.signalerEchec\(req\)/g) || []).length, 2, 'jeton absent ET jeton invalide');
  assert.match(src, /app\.get\('\/invitation\/:token', limitePublique,/);
  assert.match(src, /app\.post\('\/invitation\/:token\/creer-compte', limitePublique,/);
  assert.match(src, /process\.env\.TRUST_PROXY/);
  assert.match(src, /app\.set\('trust proxy', sautsDeProxy\);/);
  assert.match(src, /\.unref\(\);/, 'le nettoyage périodique ne retient pas l\'arrêt du serveur');
  assert.ok(src.indexOf("app.get('/', (req, res)") < iVerif && !/app\.get\('\/', limite/.test(src), 'le test de santé de Render n\'est pas limité');
});
