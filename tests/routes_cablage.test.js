// tests/routes_cablage.test.js — chaque module routes/*.js est BIEN câblé à server.js (23/10 : la 1re version de la découpe avait oublié `supabase` dans le contexte partagé :
// toutes les routes /api répondaient 500 en production alors que les 661 autres tests passaient). Deux garde-fous :
//   1. statique : tout nom que ces modules reçoivent existe dans le `contexte` de server.js ;
//   2. dynamique : le VRAI server.js démarre avec un faux Firebase / une fausse base et UNE route de chaque module répond sans planter.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RACINE = path.join(__dirname, '..');
const serveur = fs.readFileSync(path.join(RACINE, 'server.js'), 'utf8');
const modules = fs.readdirSync(path.join(RACINE, 'routes')).filter(f => f.endsWith('.js'));

test('statique : chaque dépendance reçue par un module de routes/ est fournie par server.js', () => {
  const contexte = new Set(serveur.match(/const contexte = \{ ([^}]*) \};/)[1].split(',').map(x => x.trim()));
  const publiques = new Set(serveur.match(/require\('\.\/routes\/publiques'\)\(app, \{ ([^}]*) \}\);/)[1].split(',').map(x => x.trim()));
  assert.ok(modules.length >= 13, 'les modules de routes sont là');
  for (const f of modules) {
    const t = fs.readFileSync(path.join(RACINE, 'routes', f), 'utf8');
    const recus = t.match(/module\.exports = function monter\w+\(app, \{ ([^}]*) \}\)/)[1].split(',').map(x => x.trim()).filter(Boolean);
    const fournis = f === 'publiques.js' ? publiques : contexte;
    for (const nom of recus) assert.ok(fournis.has(nom), `${f} reçoit « ${nom} » mais server.js ne le lui fournit pas`);
  }
});

test('dynamique : le vrai server.js démarre et une route de CHAQUE module répond sans planter (aucun statut 500)', () => {
  const sortie = path.join(os.tmpdir(), `cablage-${process.pid}-${Date.now()}.json`);
  const r = spawnSync(process.execPath, ['-r', path.join(__dirname, 'crochetSmoke.js'), path.join(RACINE, 'server.js')], {
    env: { ...process.env, SORTIE_JOURNAL: sortie, PORT: String(5800 + (process.pid % 150)), SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'x', FIREBASE_SERVICE_ACCOUNT: '{}', NODE_ENV: 'test' },
    encoding: 'utf8', timeout: 60000,
  });
  assert.ok(fs.existsSync(sortie), `server.js n'a pas démarré : ${(r.stderr || '').slice(0, 500)}`);
  const resultats = JSON.parse(fs.readFileSync(sortie, 'utf8'));
  fs.rmSync(sortie, { force: true });
  assert.strictEqual(resultats.length, 12);
  const planteees = resultats.filter(x => x.plante);
  assert.deepStrictEqual(planteees, [], `routes qui plantent : ${JSON.stringify(planteees)}`);
});
