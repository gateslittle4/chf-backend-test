// tests/regressions.test.js — Niveau 4 : "un vieux bug ne revient jamais en douce"
// Lancer avec : node --test tests/
// Un test par bug déjà trouvé et corrigé pendant le travail sur ce projet, pour que personne
// (moi y compris, dans une future session) ne puisse le réintroduire sans s'en rendre compte.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test("Aucune route dupliquée (même méthode + même chemin) — le bug qui désactivait silencieusement l'anti-doublon patient", () => {
  const routes = [...serverSrc.matchAll(/^app\.(get|post|put|patch|delete)\('([^']+)'/gm)]
    .map(m => `${m[1].toUpperCase()} ${m[2]}`);
  const doublons = routes.filter((r, i) => routes.indexOf(r) !== i);
  assert.deepStrictEqual(doublons, [], `Route(s) enregistrée(s) 2 fois — Express n'exécute jamais que la première : ${doublons.join(', ')}`);
});

test("Le backend utilise la clé service_role, jamais la clé anon (elle contourne RLS ; le navigateur, lui, doit rester bloqué par RLS)", () => {
  assert.match(serverSrc, /SUPABASE_SERVICE_ROLE_KEY/, "SUPABASE_SERVICE_ROLE_KEY doit apparaître dans server.js");
  assert.doesNotMatch(serverSrc, /createClient\([^)]*SUPABASE_ANON_KEY/, "Le client Supabase du backend ne doit jamais utiliser la clé anon");
});

test("Validation création d'épisode : accepte une Consultation (service=null + type_consultation rempli) — bloquait TOUJOURS avant, jamais juste l'hospitalisation", () => {
  const { validerCreationEpisode } = require('../utils/validationEpisode');
  const erreur = validerCreationEpisode({
    dossier_id: 'abc', voie_entree: 'consultation', service: null,
    type_consultation: 'Générale', type_patient: 'prive',
  });
  assert.strictEqual(erreur, null, erreur);
});

test("Validation création d'épisode : accepte une Hospitalisation (service rempli, sans type_consultation)", () => {
  const { validerCreationEpisode } = require('../utils/validationEpisode');
  const erreur = validerCreationEpisode({
    dossier_id: 'abc', voie_entree: 'urgence', service: 'Maternité',
    type_consultation: null, type_patient: 'prive',
  });
  assert.strictEqual(erreur, null, erreur);
});

test("Validation création d'épisode : refuse si ni service ni type_consultation (les deux vraiment absents)", () => {
  const { validerCreationEpisode } = require('../utils/validationEpisode');
  const erreur = validerCreationEpisode({ dossier_id: 'abc', voie_entree: 'consultation', service: null, type_consultation: null, type_patient: 'prive' });
  assert.notStrictEqual(erreur, null, "devrait refuser quand aucun des deux n'est fourni");
});

test("Toutes les écritures (update/insert) vérifient une ligne réellement affectée, sauf via .single() qui échoue déjà tout seul sur 0 ligne", () => {
  // Repère chaque .update(...) suivi de .eq(...) sans .select() dans les ~15 lignes suivantes —
  // pas parfait (analyse de texte, pas du code réel), mais attrape le motif exact du bug du
  // catalogue et de la mise à jour des dossiers/fiches (succès silencieux sans rien écrire).
  const blocsUpdate = [...serverSrc.matchAll(/\.update\(/g)];
  for (const bloc of blocsUpdate) {
    const contexte = serverSrc.slice(bloc.index, bloc.index + 400);
    const aVerification = /\.select\(\)|\.single\(\)/.test(contexte);
    assert.ok(aVerification, `Un .update() sans .select()/.single() à proximité (vers le caractère ${bloc.index}) — risque de succès silencieux sans rien écrire`);
  }
});

test("La route de catalogue utilise upsert (pas update seul) — sinon impossible de créer la toute première ligne", () => {
  const blocCatalog = serverSrc.slice(serverSrc.indexOf("app.put('/api/catalog"));
  assert.match(blocCatalog.slice(0, 500), /\.upsert\(/, "PUT /api/catalog doit utiliser upsert, pas update seul");
});

test("POST /api/paiements en mode remboursement_credit relit le solde en base — n'accepte jamais tel quel le solde_restant envoyé par le navigateur", () => {
  const blocPaiements = serverSrc.slice(serverSrc.indexOf("app.post('/api/paiements'"), serverSrc.indexOf("app.patch('/api/paiements/:id/annuler'"));
  assert.match(blocPaiements, /mode\s*===\s*['"]remboursement_credit['"]/, "la route doit détecter mode === 'remboursement_credit'");
  assert.match(blocPaiements, /\.from\('paiements'\)\.select\('solde_restant'\)/, "doit relire solde_restant depuis la table, pas depuis req.body");
  assert.match(blocPaiements, /montant\s*>\s*soldeActuel/, "doit refuser un montant supérieur au solde réel");
  assert.match(blocPaiements, /corps\.solde_restant\s*=\s*soldeActuel\s*-\s*montant/, "le nouveau solde_restant doit être calculé côté serveur, pas repris de req.body");
});

test("episodeVersFlat expose est_hospitalisation — sinon l'onglet Hospitalisation et le taux d'occupation Direction ne peuvent pas savoir qui est hospitalisé", () => {
  const blocFlat = serverSrc.slice(serverSrc.indexOf('function episodeVersFlat'), serverSrc.indexOf('function episodeVersFlat') + 800);
  assert.match(blocFlat, /estHospitalisation:\s*ep\.est_hospitalisation/, "episodeVersFlat doit renvoyer estHospitalisation");
});

test("POST /api/admin/generer-lien-reinitialisation exige utilisateurs_gerer et utilise generatePasswordResetLink (jamais sendPasswordResetEmail, qui enverrait à une adresse @chf.com qui n'existe pas)", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.post('/api/admin/generer-lien-reinitialisation'"));
  assert.match(blocRoute, /aPermission\(req\.user\.id, 'utilisateurs_gerer'\)/, "doit exiger la permission utilisateurs_gerer");
  assert.match(blocRoute, /generatePasswordResetLink/, "doit générer le lien sans l'envoyer");
});

test("POST /api/stock/decrementer appelle la fonction Postgres atomique decrementer_stock_medicaments et renvoie 409 si le stock est insuffisant", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.post('/api/stock/decrementer'"));
  assert.match(blocRoute, /supabase\.rpc\('decrementer_stock_medicaments'/, "doit appeler la fonction Postgres atomique, pas un update direct de la table catalog");
  assert.match(blocRoute, /res\.status\(409\)/, "doit renvoyer 409 (pas 200) si le stock est insuffisant");
});

test("POST /api/dossiers et POST /api/dossiers/:dossierId/episodes vérifient local_id avant d'insérer — nécessaire maintenant que apiDossierEpisode.js peut rejouer ces appels automatiquement (file d'attente hors-ligne)", () => {
  const blocDossier = serverSrc.slice(serverSrc.indexOf("app.post('/api/dossiers'"), serverSrc.indexOf("app.get('/api/dossiers/:id'"));
  assert.match(blocDossier, /if \(local_id\)/, "POST /api/dossiers doit vérifier local_id avant d'insérer");
  assert.match(blocDossier, /local_id: local_id \|\| null/, "doit enregistrer le local_id reçu");

  const blocEpisode = serverSrc.slice(serverSrc.indexOf("app.post('/api/dossiers/:dossierId/episodes'"), serverSrc.indexOf("app.patch('/api/episodes/:id/hospitaliser'"));
  assert.match(blocEpisode, /if \(local_id\)/, "POST /api/dossiers/:dossierId/episodes doit vérifier local_id avant d'insérer");
  assert.match(blocEpisode, /local_id: local_id \|\| null/, "doit enregistrer le local_id reçu");
});

test("PUT /api/episodes/:id ne traite une fiche comme UPDATE que si f.id est un vrai UUID — sinon un id local ('fiche-' + Date.now()) provoquait 'invalid input syntax for type uuid', une erreur permanente jamais résolue par un nouvel essai, qui bloquait l'opération indéfiniment dans pending_ops côté navigateur", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.put('/api/episodes/:id'"), serverSrc.indexOf("app.delete('/api/episodes/:id'"));
  assert.match(blocRoute, /estUnVraiUuid\(f\.id\)/, "la boucle sur d.fiches doit choisir UPDATE/INSERT via une validation UUID, pas juste 'if (f.id)'");
  assert.doesNotMatch(blocRoute, /if \(f\.id\) \{/, "ne doit plus traiter tout f.id non-vide comme une fiche existante");

  const uuidRegexMatch = serverSrc.match(/const UUID_REGEX = (\/.*\/i);/);
  assert.ok(uuidRegexMatch, "UUID_REGEX introuvable dans server.js");
  const UUID_REGEX = eval(uuidRegexMatch[1]);
  assert.strictEqual(UUID_REGEX.test('fiche-1755878400000'), false, "un id généré côté navigateur ne doit pas passer pour un UUID");
  assert.strictEqual(UUID_REGEX.test('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), true, "un vrai UUID doit être reconnu");
});
