// tests/etat_systeme_serveur.test.js — nettoyage/empreinte des erreurs des postes et routes de l'état du système (14/10).
const { test } = require('node:test');
const assert = require('node:assert');
const { creerFauxSupabase } = require('./aides/fauxSupabase');
const { creerAppFausse } = require('./aides/appFausse');
const { nettoyerTexte, empreinte, premierCadre, preparerErreur } = require('../utils/erreursClient');
const { creerRoutesEtatSysteme, MAX_ERREURS_PAR_MINUTE } = require('../utils/routesEtatSysteme');

test('nettoyerTexte : e-mails et suites de chiffres retirés, longueur coupée', () => {
  assert.strictEqual(nettoyerTexte('Dossier de marie@x.com tél 34567890 N-12', 500), 'Dossier de [e-mail] tél [nombre] N-12');
  assert.strictEqual(nettoyerTexte('a'.repeat(900), 500).length, 500);
  assert.strictEqual(nettoyerTexte(null, 10), '');
});
test('empreinte : stable d\'une version à l\'autre et d\'un patient à l\'autre ; différente pour une autre erreur', () => {
  const pile1 = "TypeError: x\n    at Calculer (https://chf-app2.onrender.com/bundle.js?v=abc123:1204:15)\n    at autre (bundle.js:3:4)";
  const pile2 = "TypeError: x\n    at Calculer (https://chf-app2.onrender.com/bundle.js?v=def456:1310:22)";
  assert.strictEqual(empreinte("Cannot read properties of undefined (reading 'nom')", pile1, 'js'), empreinte("Cannot read properties of undefined (reading 'nom')", pile2, 'js'));
  assert.strictEqual(empreinte('Dossier 123456 introuvable', pile1, 'js'), empreinte('Dossier 987654 introuvable', pile1, 'js'));
  assert.notStrictEqual(empreinte('Autre message', pile1, 'js'), empreinte('Cannot read', pile1, 'js'));
  assert.notStrictEqual(empreinte('m', pile1, 'js'), empreinte('m', pile1, 'promesse'));
  assert.match(premierCadre(pile1), /at Calculer \(bundle\.js\)/);
});
test('preparerErreur : message requis, source inconnue → js, compteur borné, champs assainis', () => {
  assert.ok(preparerErreur({}).erreur);
  const e = preparerErreur({ message: 'boom', source: 'inconnue', nombre: 9999, onglet: 'calcul<script>', version_app: 'v1.2', poste_id: 'poste-12345678' });
  assert.strictEqual(e.source, 'js');
  assert.strictEqual(e.nombre, 50);
  assert.strictEqual(e.onglet, 'calculscript');
  assert.ok(e.empreinte.length === 20);
});

const USERS = [{ id: 'admin', role: 'administrateur', active: true, display_name: 'Esdras' }, { id: 'caisse', role: 'caissier', active: true, display_name: 'Marie' }, { id: 'ancien-admin', role: 'administrateur', active: false }];
function monter({ tablesAbsentes, temps = { t: Date.parse('2026-10-14T12:00:00Z') }, rpcs } = {}) {
  const supabase = creerFauxSupabase({ users: USERS.map(u => ({ ...u })), postes_etat: [], erreurs_client: [] }, { tablesAbsentes, rpcs: rpcs || {
    signaler_erreur_client: async (a, tables) => { tables.erreurs_client.push({ id: `e${tables.erreurs_client.length + 1}`, empreinte: a.p_empreinte, message: a.p_message, nombre: a.p_nombre, statut: 'nouveau', derniere_le: new Date().toISOString() }); return { data: null, error: null }; },
    nettoyer_etat_systeme: async () => ({ data: 0, error: null }),
  } });
  const { app, appeler } = creerAppFausse();
  creerRoutesEtatSysteme({ supabase, maintenant: () => temps.t }).monter(app);
  return { supabase, appeler, temps };
}
const battement = { poste_id: 'poste-abcdef12', version_app: 'v123', appareil: 'Chrome / Windows', onglet: 'calcul', en_ligne: true, en_attente: 3, bloquees: 1, anciennete_file_s: 120, derniere_sync_age_s: 60, decalage_ms: 4000, latence_ms: 350 };

test('battement : enregistre la ligne du poste avec l\'heure du SERVEUR, le nom et le rôle du compte ; un 2e battement met à jour la même ligne', async () => {
  const { appeler, supabase, temps } = monter();
  const r = await appeler('POST', '/api/postes/battement', { body: battement, user: { id: 'caisse', email: 'marie@chf.com' } });
  assert.strictEqual(r.code, 204);
  const l = supabase.tables.postes_etat[0];
  assert.strictEqual(l.vu_le, '2026-10-14T12:00:00.000Z');
  assert.strictEqual(l.derniere_sync_le, '2026-10-14T11:59:00.000Z');
  assert.deepStrictEqual([l.utilisateur, l.role, l.en_attente, l.bloquees], ['Marie', 'caissier', 3, 1]);
  temps.t += 120000;
  await appeler('POST', '/api/postes/battement', { body: { ...battement, en_attente: 0 }, user: { id: 'caisse' } });
  assert.strictEqual(supabase.tables.postes_etat.length, 1);
  assert.strictEqual(supabase.tables.postes_etat[0].en_attente, 0);
  assert.strictEqual(supabase.tables.postes_etat[0].vu_le, '2026-10-14T12:02:00.000Z');
});
test('battement : identifiant invalide → 400 ; valeurs absurdes bornées ; table absente → 204 sans bruit', async () => {
  const { appeler, supabase } = monter();
  assert.strictEqual((await appeler('POST', '/api/postes/battement', { body: { poste_id: 'court' }, user: { id: 'caisse' } })).code, 400);
  await appeler('POST', '/api/postes/battement', { body: { ...battement, en_attente: -5, bloquees: 'abc', decalage_ms: 1e15, appareil: '<b>x</b>' }, user: { id: 'caisse' } });
  const l = supabase.tables.postes_etat[0];
  assert.deepStrictEqual([l.en_attente, l.bloquees, l.decalage_ms, l.appareil], [0, 0, 1e11, 'bx/b']);
  assert.strictEqual((await monter({ tablesAbsentes: ['postes_etat'] }).appeler('POST', '/api/postes/battement', { body: battement, user: { id: 'caisse' } })).code, 204);
});
test('lecture des postes et des erreurs : ADMINISTRATEUR seulement (caissier, compte désactivé → 403)', async () => {
  const { appeler } = monter();
  for (const chemin of ['/api/etat-systeme/postes', '/api/etat-systeme/erreurs']) {
    assert.strictEqual((await appeler('GET', chemin, { user: { id: 'caisse' } })).code, 403, chemin);
    assert.strictEqual((await appeler('GET', chemin, { user: { id: 'ancien-admin' } })).code, 403, chemin + ' (désactivé)');
    assert.strictEqual((await appeler('GET', chemin, { user: { id: 'admin' } })).code, 200, chemin);
  }
  assert.strictEqual((await appeler('PATCH', '/api/etat-systeme/erreurs/e1', { body: { statut: 'resolu' }, user: { id: 'caisse' } })).code, 403);
});
test('postes : tables manquantes → installe:false (l\'écran explique quel script coller)', async () => {
  const { appeler } = monter({ tablesAbsentes: ['postes_etat', 'erreurs_client'] });
  assert.strictEqual((await appeler('GET', '/api/etat-systeme/postes', { user: { id: 'admin' } })).corps.installe, false);
  assert.strictEqual((await appeler('GET', '/api/etat-systeme/erreurs', { user: { id: 'admin' } })).corps.installe, false);
});
test('erreurs : envoi nettoyé → regroupé ; traitement par l\'administrateur (vu, résolu, retour à nouveau) ; id inconnu → 404 ; statut invalide → 400', async () => {
  const { appeler, supabase } = monter();
  await appeler('POST', '/api/erreurs-client', { body: { message: 'Dossier de marie@x.com 34567890 introuvable', source: 'js', poste_id: 'poste-abcdef12' }, user: { id: 'caisse' } });
  const e = supabase.tables.erreurs_client[0];
  assert.strictEqual(e.message, 'Dossier de [e-mail] [nombre] introuvable');
  const lecture = (await appeler('GET', '/api/etat-systeme/erreurs', { user: { id: 'admin' } })).corps;
  assert.strictEqual(lecture.nouvelles, 1);
  const ok = await appeler('PATCH', `/api/etat-systeme/erreurs/${e.id}`, { body: { statut: 'resolu' }, user: { id: 'admin', email: 'admin@chf.com' } });
  assert.deepStrictEqual([ok.corps.statut, ok.corps.traite_par], ['resolu', 'admin@chf.com']);
  const retour = await appeler('PATCH', `/api/etat-systeme/erreurs/${e.id}`, { body: { statut: 'nouveau' }, user: { id: 'admin' } });
  assert.deepStrictEqual([retour.corps.statut, retour.corps.traite_par], ['nouveau', null]);
  assert.strictEqual((await appeler('PATCH', '/api/etat-systeme/erreurs/inconnu', { body: { statut: 'vu' }, user: { id: 'admin' } })).code, 404);
  assert.strictEqual((await appeler('PATCH', `/api/etat-systeme/erreurs/${e.id}`, { body: { statut: 'oups' }, user: { id: 'admin' } })).code, 400);
  assert.strictEqual((await appeler('POST', '/api/erreurs-client', { body: {}, user: { id: 'caisse' } })).code, 400);
});
test(`erreurs : plafond de ${MAX_ERREURS_PAR_MINUTE} envois par minute et par compte (429), puis de nouveau permis la minute suivante`, async () => {
  const { appeler, temps } = monter();
  let dernier;
  for (let i = 0; i < MAX_ERREURS_PAR_MINUTE + 1; i++) dernier = await appeler('POST', '/api/erreurs-client', { body: { message: `erreur ${i}` }, user: { id: 'caisse' } });
  assert.strictEqual(dernier.code, 429);
  temps.t += 61000;
  assert.strictEqual((await appeler('POST', '/api/erreurs-client', { body: { message: 'encore' }, user: { id: 'caisse' } })).code, 204);
});
test('erreurs : table absente (script pas collé) → 204 sans bruit', async () => {
  const { appeler } = monter({ tablesAbsentes: [], rpcs: { signaler_erreur_client: async () => ({ data: null, error: { code: '42883', message: 'function does not exist' } }) } });
  assert.strictEqual((await appeler('POST', '/api/erreurs-client', { body: { message: 'x' }, user: { id: 'caisse' } })).code, 204);
});
