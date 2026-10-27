// tests/routes_enregistrees.test.js — le VRAI server.js démarre (avec une fausse base et un faux Firebase) et enregistre EXACTEMENT les mêmes routes, dans le même ordre,
// qu'avant la découpe du 23/10 (server.js + routes/*.js). L'ordre compte pour Express : /api/dossiers/recherche doit rester avant /api/dossiers/:id, un middleware
// avant les routes qu'il protège. Si tu ajoutes ou déplaces une route volontairement : regénère le fichier avec UPDATE_ROUTES=1.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ATTENDU = path.join(__dirname, 'routes_attendues.txt');

function routesEnregistrees() {
  const sortie = path.join(os.tmpdir(), `routes-${process.pid}-${Date.now()}.txt`);
  const r = spawnSync(process.execPath, ['-r', path.join(__dirname, 'crochetRoutes.js'), path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, SORTIE_JOURNAL: sortie, PORT: '0', SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'x', FIREBASE_SERVICE_ACCOUNT: '{}' },
    encoding: 'utf8', timeout: 30000,
  });
  assert.ok(fs.existsSync(sortie), `server.js n'a pas démarré : ${(r.stderr || '').slice(0, 400)}`);
  const lignes = fs.readFileSync(sortie, 'utf8');
  fs.rmSync(sortie, { force: true });
  return lignes;
}

test('server.js démarre et enregistre les mêmes routes, dans le même ordre (118 entrées à la découpe, 121 avec « exonérer une créance », « passer une sortie de caisse » et « rendre le dépôt »)', () => {
  const reel = routesEnregistrees();
  if (process.env.UPDATE_ROUTES === '1') { fs.writeFileSync(ATTENDU, reel + '\n'); return; }
  assert.strictEqual(reel.trim(), fs.readFileSync(ATTENDU, 'utf8').trim());
});
