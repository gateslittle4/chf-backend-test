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
  assert.match(blocCatalog.slice(0, 2200), /\.upsert\(/, "PUT /api/catalog doit utiliser upsert, pas update seul");
});

test("POST /api/paiements en mode remboursement_credit relit le solde en base — n'accepte jamais tel quel le solde_restant envoyé par le navigateur", () => {
  const blocPaiements = serverSrc.slice(serverSrc.indexOf("app.post('/api/paiements'"), serverSrc.indexOf("app.patch('/api/paiements/:id/annuler'"));
  assert.match(blocPaiements, /mode\s*===\s*['"]remboursement_credit['"]/, "la route doit détecter mode === 'remboursement_credit'");
  assert.match(blocPaiements, /\.from\('paiements'\)\.select\('solde_restant'\)/, "doit relire solde_restant depuis la table, pas depuis req.body");
  assert.match(blocPaiements, /montant\s*>\s*soldeActuel/, "doit refuser un montant supérieur au solde réel");
  assert.match(blocPaiements, /corps\.solde_restant\s*=\s*soldeActuel\s*-\s*montant/, "le nouveau solde_restant doit être calculé côté serveur, pas repris de req.body");
});

// Audit financier (24/08, "on ne peut pas se permettre l'erreur") : "dernier paiement d'un
// épisode" est utilisé à 2 endroits (historique patient, plafond de remboursement de crédit) —
// aucun n'excluait un paiement ANNULÉ (mode PATCH /api/paiements/:id/annuler, réservé à la
// direction pour corriger une fraude/erreur) de ce calcul. Si le paiement le plus RÉCENT d'un
// épisode avait été annulé, le statut affiché (payé/solde restant) et le plafond de remboursement
// se basaient sur une transaction qui n'existe plus — pouvant masquer une vraie dette ou bloquer
// un remboursement légitime.
test("GET /api/dossiers/:id/historique et le calcul du plafond de remboursement de crédit (POST /api/paiements) excluent tous les deux un paiement ANNULÉ du 'dernier paiement' — via .or('annule.eq.false,annule.is.null'), pas .eq('annule', false) qui exclurait à tort les paiements d'avant cette fonctionnalité (annule=NULL)", () => {
  const blocHistorique = serverSrc.slice(serverSrc.indexOf("app.get('/api/dossiers/:id/historique'"), serverSrc.indexOf("// ============================================================\n// PIÈCES JOINTES"));
  assert.match(blocHistorique, /\.or\('annule\.eq\.false,annule\.is\.null'\)/, "GET /api/dossiers/:id/historique doit exclure les paiements annulés du dernier paiement");

  const blocPaiements = serverSrc.slice(serverSrc.indexOf("app.post('/api/paiements'"), serverSrc.indexOf("app.patch('/api/paiements/:id/annuler'"));
  assert.match(blocPaiements, /\.or\('annule\.eq\.false,annule\.is\.null'\)/, "le calcul du solde de référence pour un remboursement de crédit doit aussi exclure les paiements annulés");
});

test("episodeVersFlat expose est_hospitalisation — sinon l'onglet Hospitalisation et le taux d'occupation Direction ne peuvent pas savoir qui est hospitalisé", () => {
  const blocFlat = serverSrc.slice(serverSrc.indexOf('function episodeVersFlat'), serverSrc.indexOf("app.get('/api/episodes'"));
  assert.match(blocFlat, /estHospitalisation:\s*ep\.est_hospitalisation/, "episodeVersFlat doit renvoyer estHospitalisation");
});

// Audit financier (24/08, Esdras : "on ne peut pas se permettre l'erreur") : episodeVersFlat
// recalcule totalGlobal en sommant TOUTES les fiches — avant, une fiche dont le paiement a été
// annulé (fraude/erreur corrigée par la direction) comptait quand même dedans, faussant les
// rapports de revenus (AnalyticsPanel/Statistiques, Direction, Archives...) qui lisent ce champ,
// alors que le registre de caisse, lui, avait déjà été corrigé (DashboardCaisse.js).
test("episodeVersFlat exclut de totalGlobal toute fiche dont le paiement associé a été ANNULÉ (via paiements.fiche_id), et marque chaque fiche individuelle avec paiementAnnule pour les écrans qui itèrent episode.fiches eux-mêmes (ex. AnalyticsPanel)", () => {
  const blocFlat = serverSrc.slice(serverSrc.indexOf('async function episodeVersFlat'), serverSrc.indexOf("app.get('/api/episodes'"));
  assert.match(blocFlat, /\.from\('paiements'\)\.select\('fiche_id'\)\.eq\('episode_id', ep\.id\)\.eq\('annule', true\)\.not\('fiche_id', 'is', null\)/, "doit chercher les paiements annulés liés à une fiche de cet épisode");
  assert.match(blocFlat, /const fichesAvecPaiementAnnule = new Set\(\(paiementsAnnules \|\| \[\]\)\.map\(p => p\.fiche_id\)\);/);
  assert.match(blocFlat, /fichesAvecPaiementAnnule\.has\(f\.id\) \? s : s \+ \(Number\(f\.total_global\) \|\| 0\)/, "totalGlobal doit sauter une fiche dont le paiement a été annulé, pas juste continuer à l'additionner");
  assert.match(blocFlat, /fiches: \(fiches \|\| \[\]\)\.map\(f => ficheVersFlat\(f, fichesAvecPaiementAnnule\)\),/, "doit transmettre l'ensemble des fiches annulées à ficheVersFlat pour chaque fiche");

  const blocFicheVersFlat = serverSrc.slice(serverSrc.indexOf('function ficheVersFlat'), serverSrc.indexOf('function ficheVersColonnes'));
  assert.match(blocFicheVersFlat, /paiementAnnule: !!\(fichesAvecPaiementAnnule && fichesAvecPaiementAnnule\.has\(f\.id\)\),/, "chaque fiche doit porter son propre statut paiementAnnule");
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

test("POST /api/stock/ajouter et PATCH /api/stock/:id appellent des fonctions Postgres atomiques (ajouter_stock_medicament, definir_stock_medicament), pas un update direct de la table catalog — sinon GestionStock.js peut de nouveau perdre la modification d'un poste en écrasant le catalogue entier avec un instantané périmé", () => {
  const blocAjouter = serverSrc.slice(serverSrc.indexOf("app.post('/api/stock/ajouter'"), serverSrc.indexOf("app.patch('/api/stock/:id'"));
  assert.match(blocAjouter, /supabase\.rpc\('ajouter_stock_medicament'/, "POST /api/stock/ajouter doit appeler la fonction Postgres atomique ajouter_stock_medicament");

  const blocDefinir = serverSrc.slice(serverSrc.indexOf("app.patch('/api/stock/:id'"));
  assert.match(blocDefinir, /supabase\.rpc\('definir_stock_medicament'/, "PATCH /api/stock/:id doit appeler la fonction Postgres atomique definir_stock_medicament");
});

test("POST /api/dossiers et POST /api/dossiers/:dossierId/episodes vérifient local_id avant d'insérer — nécessaire maintenant que apiDossierEpisode.js peut rejouer ces appels automatiquement (file d'attente hors-ligne)", () => {
  const blocDossier = serverSrc.slice(serverSrc.indexOf("app.post('/api/dossiers'"), serverSrc.indexOf("app.get('/api/dossiers/:id'"));
  assert.match(blocDossier, /if \(local_id\)/, "POST /api/dossiers doit vérifier local_id avant d'insérer");
  assert.match(blocDossier, /local_id: local_id \|\| null/, "doit enregistrer le local_id reçu");

  const blocEpisode = serverSrc.slice(serverSrc.indexOf("app.post('/api/dossiers/:dossierId/episodes'"), serverSrc.indexOf("app.patch('/api/episodes/:id/hospitaliser'"));
  assert.match(blocEpisode, /if \(local_id\)/, "POST /api/dossiers/:dossierId/episodes doit vérifier local_id avant d'insérer");
  assert.match(blocEpisode, /local_id: local_id \|\| null/, "doit enregistrer le local_id reçu");
});

// Retour d'Esdras (23/08) : un dossier créé hors ligne avec un numero_dossier déjà pris par un
// AUTRE patient (vraie violation de la contrainte unique dossiers_numero_dossier_key, pas résolue
// par le local_id) tombait dans le 500 générique — indiscernable côté client d'une vraie panne
// serveur, donc syncPending() le réessayait indéfiniment toutes les 30s au lieu de le signaler une
// fois : c'est ce qui faisait "apparaître et disparaître" un dossier bloqué dans la file hors ligne.
test("POST /api/dossiers renvoie 409 (pas 500) quand la violation 23505 n'est PAS résolue par le local_id — un vrai conflit de numero_dossier, permanent, à distinguer d'une panne serveur transitoire", () => {
  const blocDossier = serverSrc.slice(serverSrc.indexOf("app.post('/api/dossiers'"), serverSrc.indexOf("app.get('/api/dossiers/:id'"));
  assert.match(blocDossier, /if \(error\.code === '23505'\)/, "doit distinguer 23505 des autres erreurs avant de statuer sur le code HTTP");
  assert.match(blocDossier, /res\.status\(409\)\.json\(\{ error: `Le numéro de dossier/, "un conflit numero_dossier non résolu par local_id doit renvoyer 409 avec un message clair");
  const posConflit = blocDossier.indexOf("status(409)");
  const posLocalIdCheck = blocDossier.indexOf("if (local_id) {", blocDossier.indexOf("error.code === '23505'"));
  assert.ok(posLocalIdCheck !== -1 && posLocalIdCheck < posConflit, "doit d'abord retenter la résolution par local_id (retour 200 si c'est bien notre propre tentative rejouée) avant de conclure à un vrai conflit 409");
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

test("POST /api/episodes lit le corps en snake_case (nom_patient, numero_dossier, service_choisi, type_patient, ong_partenaire) — tous les appelants passent par toEpisodeApi() côté navigateur, qui envoie du snake_case ; lire du camelCase laissait ces champs toujours undefined et bloquait TOUTE création de dossier avec 'Le nom du patient est requis', même nom valide fourni", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.post('/api/episodes'"), serverSrc.indexOf("app.put('/api/episodes/:id'"));
  assert.match(blocRoute, /!d\.nom_patient/, "la vérification du nom doit lire d.nom_patient, pas d.nomPatient");
  assert.doesNotMatch(blocRoute, /d\.nomPatient/, "ne doit plus lire d.nomPatient (camelCase) nulle part dans cette route");
  assert.match(blocRoute, /d\.numero_dossier/, "doit lire d.numero_dossier pour le numéro de dossier saisi par l'utilisateur");
  assert.match(blocRoute, /d\.service_choisi/, "doit lire d.service_choisi");
  assert.match(blocRoute, /d\.type_patient/, "doit lire d.type_patient");
  assert.match(blocRoute, /d\.ong_partenaire/, "doit lire d.ong_partenaire");
});

test("POST /api/episodes lit voie_entree/est_hospitalisation depuis le corps de la requête, plus jamais figés en dur — sinon un épisode Achat Express (voie_entree:'vente_comptoir') redevient indiscernable d'une consultation classique dès qu'il passe par cette route de compatibilité", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.post('/api/episodes'"), serverSrc.indexOf("app.put('/api/episodes/:id'"));
  assert.doesNotMatch(blocRoute, /voie_entree:\s*'consultation'/, "voie_entree ne doit plus être figé en dur sur 'consultation'");
  assert.doesNotMatch(blocRoute, /est_hospitalisation:\s*false\s*,/, "est_hospitalisation ne doit plus être figé en dur sur false");
  assert.match(blocRoute, /voie_entree:\s*d\.voie_entree\s*\|\|\s*'consultation'/, "doit lire d.voie_entree, avec 'consultation' comme valeur par défaut (comportement inchangé pour les appelants qui ne l'envoient pas)");
  assert.match(blocRoute, /est_hospitalisation:\s*!!d\.est_hospitalisation/, "doit lire d.est_hospitalisation");
});

test("episodeVersFlat expose voieEntree — sinon le badge de classification ne peut pas distinguer Consultation de Vente comptoir (les deux ont estHospitalisation: false)", () => {
  const blocFlat = serverSrc.slice(serverSrc.indexOf('function episodeVersFlat'), serverSrc.indexOf("app.get('/api/episodes'"));
  assert.match(blocFlat, /voieEntree:\s*ep\.voie_entree/, "episodeVersFlat doit renvoyer voieEntree");
});

test("PUT /api/episodes/:id lit le corps en snake_case (service_choisi, type_patient, ong_partenaire, numero_lot, verrouille_facture, date_suspension, mois_report) — sinon l'assignation à un lot de facturation, le changement de service/ONG/type, la suspension et le report au mois suivant réussissaient (200 OK) sans jamais rien écrire en base", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.put('/api/episodes/:id'"), serverSrc.indexOf("app.delete('/api/episodes/:id'"));
  for (const champ of ['service_choisi', 'type_patient', 'ong_partenaire', 'numero_lot', 'verrouille_facture', 'date_suspension', 'mois_report']) {
    assert.match(blocRoute, new RegExp(`d\\.${champ}\\b`), `doit lire d.${champ}`);
  }
  assert.doesNotMatch(blocRoute, /d\.(serviceChoisi|typePatient|ongPartenaire|numeroLot|verrouilleFacture|dateSuspension|moisReport)\b/, "ne doit plus lire ces champs en camelCase");
});

test("PUT /api/episodes/:id exige la permission facturation_modifier pour modifier un dossier déjà archivé (statut ferme) — avant, n'importe quel utilisateur connecté pouvait modifier les fiches/totaux d'un dossier déjà facturé et verrouillé en appelant l'API directement, même si le bouton était caché dans l'interface", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.put('/api/episodes/:id'"), serverSrc.indexOf("app.delete('/api/episodes/:id'"));
  assert.match(blocRoute, /statut === 'ferme'/, "doit vérifier le statut de l'épisode avant toute modification");
  assert.match(blocRoute, /aPermission\(req\.user\.id, 'facturation_modifier'\)/, "doit exiger la permission facturation_modifier pour un dossier déjà archivé");
  assert.match(blocRoute, /res\.status\(403\)/, "doit renvoyer 403 si la permission manque");
});

test("PUT /api/episodes/:id met à jour dossiers.nom quand nom_patient est fourni — avant, corriger un nom de patient depuis Archives affichait 'succès' sans que rien ne soit jamais enregistré (le nom vit sur dossiers, que cette route ne touchait pas du tout)", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.put('/api/episodes/:id'"), serverSrc.indexOf("app.delete('/api/episodes/:id'"));
  assert.match(blocRoute, /d\.nom_patient !== undefined/, "doit vérifier la présence de d.nom_patient");
  assert.match(blocRoute, /\.from\('dossiers'\)\.update\(\{ nom: d\.nom_patient \}\)/, "doit mettre à jour la colonne nom de la table dossiers");
  assert.match(blocRoute, /\.from\('dossiers'\)\.update\(\{ nom: d\.nom_patient \}\)\.eq\('id', episodeActuel\.dossier_id\)\.select\(\)/, "doit vérifier qu'une ligne a bien été affectée (même angle mort que les autres updates de ce fichier)");
});

test("episodeVersFlat journalise (ne l'avale plus silencieusement) l'erreur de lecture du dossier lié à un épisode — avant, un dossier introuvable ou une erreur Supabase transitoire faisait apparaître un patient 'sans nom' dans Archives/Analytics sans aucun signal d'erreur", () => {
  const blocFonction = serverSrc.slice(serverSrc.indexOf('async function episodeVersFlat'), serverSrc.indexOf('async function episodeVersFlat') + 700);
  assert.match(blocFonction, /error: erreurDossier/, "doit capturer l'erreur de la requête sur dossiers");
  assert.match(blocFonction, /console\.error\(.*erreurDossier/, "doit journaliser l'erreur au lieu de l'ignorer");
});

test("dateOuNull convertit une date de naissance vide en null, jamais en chaîne vide — Postgres refuse '' pour une colonne date ('invalid input syntax for type date'), et la date de naissance est optionnelle (saisie rétroactive, patient qui ne la connaît pas)", () => {
  assert.match(serverSrc, /function dateOuNull\(v\) \{ return v \? v : null; \}/, "dateOuNull introuvable ou modifiée");
  for (const routeStart of ["app.post('/api/episodes'", "app.post('/api/dossiers'", "app.put('/api/dossiers/:id'"]) {
    const i = serverSrc.indexOf(routeStart);
    assert.ok(i !== -1, `route ${routeStart} introuvable`);
    const bloc = serverSrc.slice(i, i + 1400);
    assert.match(bloc, /date_naissance:\s*dateOuNull\(/, `${routeStart} doit passer date_naissance par dateOuNull()`);
  }
});

test("episodeVersFlat recalcule totalGlobal à partir des fiches — la table episodes n'a pas de colonne total_global, ce total n'existait qu'en mémoire côté navigateur (calculé une fois à l'archivage, jamais recalculé au chargement suivant) ; tout dossier rechargé depuis le serveur (F5, nouvel onglet, écran Lots & Facturation) affichait 0 Gdes malgré des fiches réelles en base", () => {
  const blocFonction = serverSrc.slice(serverSrc.indexOf('async function episodeVersFlat'), serverSrc.indexOf("app.get('/api/episodes'"));
  assert.match(blocFonction, /const totalGlobal = \(fiches \|\| \[\]\)\.reduce\(/, "totalGlobal doit être recalculé depuis les fiches réellement en base");
  assert.match(blocFonction, /Number\(f\.total_global\)/, "doit convertir total_global en nombre (peut revenir en chaîne depuis Postgres)");
  assert.match(blocFonction, /\n\s*totalGlobal,\n/, "totalGlobal doit être inclus dans l'objet renvoyé");
});

test("POST /api/fiches enregistre cree_par_uid — envoyé par CalculateurPanel.js mais silencieusement ignoré jusqu'ici (aucune colonne correspondante lue) : on ne savait pas QUI (par UID Firebase) avait créé une fiche, seulement son nom affiché", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.post('/api/fiches'"), serverSrc.indexOf("app.get('/api/fiches/episode/:episodeId'"));
  assert.match(blocRoute, /const \{ episode_id, cree_par, cree_par_uid,/, "doit lire cree_par_uid depuis req.body");
  assert.match(blocRoute, /cree_par_uid: cree_par_uid \|\| null/, "doit l'inclure dans l'insertion");
});

// Audit du 23/08 : 13 routes d'écriture sur 19 n'avaient AUCUNE vérification de permission
// côté serveur — les permissions ne protégeaient que l'écran, pas le serveur. N'importe quel
// compte connecté (même un rôle censé être en lecture seule) pouvait créer des dossiers,
// changer des prix, encaisser, gérer le stock... en appelant l'API directement. Un test par
// route corrigée, pour qu'aucune ne redevienne silencieusement ouverte à l'avenir.
function blocRoutePermission(debutRoute, prochaineRouteOuFin) {
  const i = serverSrc.indexOf(debutRoute);
  assert.ok(i !== -1, `route introuvable : ${debutRoute}`);
  const fin = prochaineRouteOuFin ? serverSrc.indexOf(prochaineRouteOuFin, i) : i + 400;
  assert.ok(fin !== -1, `borne de fin introuvable pour : ${debutRoute}`);
  return serverSrc.slice(i, fin);
}

test("POST /api/episodes et POST /api/dossiers exigent dossier_creer", () => {
  assert.match(blocRoutePermission("app.post('/api/episodes'"), /aPermission\(req\.user\.id, 'dossier_creer'\)/);
  assert.match(blocRoutePermission("app.post('/api/dossiers',"), /aPermission\(req\.user\.id, 'dossier_creer'\)/);
});

test("PUT /api/dossiers/:id exige fiche_patient_modifier — seul l'écran Fiche Patient l'appelle", () => {
  assert.match(blocRoutePermission("app.put('/api/dossiers/:id'"), /aPermission\(req\.user\.id, 'fiche_patient_modifier'\)/);
});

// Retour d'Esdras (29/08) : poids + conjoint ajoutés aux données personnelles, et un endroit pour
// corriger le numéro de dossier "au cas où" — voir sql/ajoute_poids_conjoint_dossiers.sql pour les
// 2 nouvelles colonnes. numero_dossier reste optionnel dans le corps (un appel qui ne l'envoie pas
// — l'écran n'affiche pas toujours ce champ en édition — ne doit jamais l'effacer par erreur).
test("PUT /api/dossiers/:id accepte poids/conjoint, et numero_dossier seulement s'il est fourni — avec le même conflit 409 que la création s'il est déjà pris par un autre patient", () => {
  const bloc = blocRoutePermission("app.put('/api/dossiers/:id'", "app.get('/api/dossiers/:id/historique'");
  assert.match(bloc, /const \{ nom, date_naissance, telephone, adresse, poids, conjoint, numero_dossier \} = req\.body;/);
  assert.match(bloc, /const maj = \{ nom, date_naissance: dateOuNull\(date_naissance\), telephone, adresse, poids: poids \|\| null, conjoint \};/, "poids/conjoint doivent toujours être écrits, sans condition");
  assert.match(bloc, /if \(numero_dossier !== undefined\) \{/, "numero_dossier ne doit être touché QUE s'il est explicitement envoyé");
  assert.match(bloc, /if \(!String\(numero_dossier\)\.trim\(\)\) return res\.status\(400\)/, "un numero_dossier vide envoyé explicitement doit être refusé, pas accepté comme un effacement");
  assert.match(bloc, /if \(error\.code === '23505'\) \{\s*\n\s*return res\.status\(409\)\.json\(\{ error: `Le numéro de dossier "\$\{numero_dossier\}" est déjà utilisé par un autre patient\.` \}\);/, "même message de conflit que POST /api/dossiers");
});

test("hospitaliser / fermer / attente-resultats exigent caisse_travailler", () => {
  assert.match(blocRoutePermission("app.patch('/api/episodes/:id/hospitaliser'"), /aPermission\(req\.user\.id, 'caisse_travailler'\)/);
  assert.match(blocRoutePermission("app.patch('/api/episodes/:id/fermer'"), /aPermission\(req\.user\.id, 'caisse_travailler'\)/);
  assert.match(blocRoutePermission("app.patch('/api/episodes/:id/attente-resultats'"), /aPermission\(req\.user\.id, 'caisse_travailler'\)/);
});

test("POST /api/fiches et POST /api/paiements acceptent caisse_travailler OU demandes_repondre — utilisés à la fois par le Calculateur et par l'approbation d'une exonération", () => {
  for (const route of ["app.post('/api/fiches'", "app.post('/api/paiements',"]) {
    const bloc = blocRoutePermission(route);
    assert.match(bloc, /aPermission\(req\.user\.id, 'caisse_travailler'\)\) && !\(await aPermission\(req\.user\.id, 'demandes_repondre'\)/, `${route} doit accepter caisse_travailler OU demandes_repondre`);
  }
});

test("POST /api/fiches enregistre total_global, breakdown et mode_paiement dès la création — avant, ces champs n'étaient écrits qu'à l'archivage (ficheVersColonnes, route PUT /api/episodes/:id), donc un dossier encore actif affichait un total de 0 malgré des transactions déjà encaissées", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.post('/api/fiches'"), serverSrc.indexOf("app.get('/api/fiches/episode/:episodeId'"));
  assert.match(blocRoute, /const \{ episode_id, cree_par, cree_par_uid, raw_state, local_id, total_global, breakdown, mode_paiement \}/, "doit lire total_global, breakdown et mode_paiement depuis req.body");
  assert.match(blocRoute, /total_global: total_global \|\| 0/, "doit insérer total_global");
  assert.match(blocRoute, /breakdown: breakdown \|\| \{\}/, "doit insérer breakdown");
  assert.match(blocRoute, /mode_paiement: mode_paiement \|\| null/, "doit insérer mode_paiement");
});

// Bug financier découvert le 28/08 : numero_fiche venait du CLIENT (CalculateurPanel.js,
// Math.max(fichesDossier) + 1), un état local qui peut rester en retard — notamment quand le
// paiement d'une fiche précédente échoue pour de vrai (la fiche existe déjà en base, mais l'app
// n'apprend jamais son numéro puisqu'elle ne l'ajoute à son état local qu'après un encaissement
// COMPLET, fiche + paiement). Constaté en production : 2 fiches distinctes avec le même numéro
// dans le même dossier ("esd"/ddtdtd, numero_fiche=2 en double). Le serveur doit désormais
// toujours calculer lui-même le vrai prochain numéro à partir de ce qui existe en base, jamais
// faire confiance à une valeur envoyée par le client.
test("POST /api/fiches calcule numero_fiche lui-même (MAX+1 depuis la base, jamais depuis req.body) et retente sur un conflit (episode_id, numero_fiche) au lieu de faire confiance à l'état local du client", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.post('/api/fiches'"), serverSrc.indexOf("app.get('/api/fiches/episode/:episodeId'"));
  assert.doesNotMatch(blocRoute, /const \{ episode_id, [^}]*numero_fiche/, "numero_fiche ne doit plus être lu depuis req.body — sinon un état client en retard peut refaire un numéro déjà utilisé");
  assert.match(blocRoute, /\.order\('numero_fiche', \{ ascending: false \}\)\.limit\(1\)\.maybeSingle\(\)/, "doit lire le vrai dernier numero_fiche en base avant chaque insertion");
  assert.match(blocRoute, /const numero_fiche = \(derniere\?\.numero_fiche \|\| 0\) \+ 1;/, "doit calculer le prochain numéro depuis la base, pas depuis req.body");
  assert.match(blocRoute, /if \(error\.code === '23505'\) \{/, "doit détecter un conflit de contrainte unique");
  assert.match(blocRoute, /continue;/, "doit relire et retenter plutôt qu'échouer ou dupliquer sur un conflit (episode_id, numero_fiche)");
});

// Retour d'Esdras (23/08) : URGENT — cette route n'existait pas du tout. "🗑️ Supprimer" côté client
// ne retirait la fiche que de l'état React local (+ restitution de stock) ; la fiche ET son
// paiement restaient en base pour toujours, donc réapparaissaient au moindre rechargement de page.
test("DELETE /api/fiches/:id existe, exige dossier_annuler, supprime les paiements liés (fiche_id) AVANT la fiche elle-même, et reste idempotente (fiche déjà absente = succès, pas une erreur)", () => {
  const bloc = blocRoutePermission("app.delete('/api/fiches/:id'", "// Route : récupération du catalogue");
  assert.match(bloc, /aPermission\(req\.user\.id, 'dossier_annuler'\)/, "doit exiger la permission dossier_annuler (même permission que le bouton côté client)");
  const posPaiements = bloc.indexOf("from('paiements').delete()");
  const posFiche = bloc.indexOf("from('fiches').delete()");
  assert.ok(posPaiements !== -1, "doit supprimer les paiements liés à cette fiche (fiche_id)");
  assert.ok(posFiche !== -1 && posPaiements < posFiche, "doit supprimer les paiements AVANT la fiche — sinon un paiement pourrait rester orphelin si la 2e suppression échoue");
  assert.match(bloc, /if \(!fiche\) return res\.status\(200\)\.json\(\{ success: true \}\);/, "une fiche déjà supprimée doit renvoyer un succès, pas une erreur — nécessaire pour une relecture idempotente depuis la file hors ligne");
});

test("PUT /api/catalog/:type exige permissions_gerer pour 'permissions', catalogue_gerer sinon (medicaments/actes déjà rejetés en 410 avant d'arriver ici)", () => {
  const bloc = blocRoutePermission("app.put('/api/catalog/:type'", "// Route : récupération des paiements");
  assert.match(bloc, /if \(type === 'permissions'\)/);
  assert.match(bloc, /permissionOk = await aPermission\(req\.user\.id, 'permissions_gerer'\)/);
  assert.match(bloc, /permissionOk = await aPermission\(req\.user\.id, 'catalogue_gerer'\)/);
});

test("POST /api/lots/prochain-numero exige facturation_exporter", () => {
  assert.match(blocRoutePermission("app.post('/api/lots/prochain-numero'"), /aPermission\(req\.user\.id, 'facturation_exporter'\)/);
});

test("POST /api/stock/decrementer exige caisse_travailler ; POST /api/stock/ajouter et PATCH /api/stock/:id exigent stock_gerer", () => {
  assert.match(blocRoutePermission("app.post('/api/stock/decrementer'"), /aPermission\(req\.user\.id, 'caisse_travailler'\)/);
  assert.match(blocRoutePermission("app.post('/api/stock/ajouter'"), /aPermission\(req\.user\.id, 'stock_gerer'\)/);
  assert.match(blocRoutePermission("app.patch('/api/stock/:id'"), /aPermission\(req\.user\.id, 'stock_gerer'\)/);
});

test("PATCH /api/paiements/:id/annuler empêche d'annuler sa propre transaction — avant, un compte ayant à la fois caisse_travailler et paiement_annuler (direction/comptable) pouvait encaisser en cash puis annuler lui-même, exactement ce que le commentaire du code disait vouloir empêcher sans jamais le vérifier", () => {
  const bloc = blocRoutePermission("app.patch('/api/paiements/:id/annuler'", "app.post('/api/lots/prochain-numero'");
  assert.match(bloc, /if \(paiement\.traite_par_uid && paiement\.traite_par_uid === req\.user\.id\)/, "doit comparer traite_par_uid à req.user.id");
  assert.match(bloc, /status\(403\)/, "doit refuser (403) l'auto-annulation");
});

test("PUT /api/episodes/:id enregistre motif_fermeture et date_fermeture à la clôture (status==='archived') — le bouton Clôturer existait déjà, seul le motif de sortie manquait", () => {
  const bloc = blocRoutePermission("app.put('/api/episodes/:id'", "// Le nom du patient vit sur la table dossiers");
  assert.match(bloc, /if \(d\.status === 'archived'\) \{/, "doit distinguer le cas clôture");
  assert.match(bloc, /maj\.motif_fermeture = d\.motif_fermeture \|\| null;/, "doit écrire motif_fermeture");
  assert.match(bloc, /maj\.date_fermeture = new Date\(\)\.toISOString\(\);/, "doit horodater la fermeture");
});

test("episodeVersFlat expose motifFermeture et dateFermeture — sinon Fiche Patient ne peut jamais afficher pourquoi/quand un patient hospitalisé est sorti", () => {
  const blocFonction = serverSrc.slice(serverSrc.indexOf('async function episodeVersFlat'), serverSrc.indexOf("app.get('/api/episodes'"));
  assert.match(blocFonction, /motifFermeture: ep\.motif_fermeture, dateFermeture: ep\.date_fermeture,/);
});

test("POST /api/dossiers/:dossierId/episodes bloque une 2e hospitalisation, mais autorise une consultation pendant une hospitalisation en cours — avant, N'IMPORTE QUEL nouvel épisode (même une consultation) était bloqué dès qu'une hospitalisation était ouverte, retour d'Esdras", () => {
  const bloc = blocRoutePermission("app.post('/api/dossiers/:dossierId/episodes'", "app.patch('/api/episodes/:id/hospitaliser'");
  assert.match(bloc, /if \(episodeHospitalisationOuvert && est_hospitalisation\) \{/, "le blocage dur doit exiger que le NOUVEL épisode soit aussi une hospitalisation, pas n'importe quel épisode");
  assert.doesNotMatch(bloc, /if \(episodeHospitalisationOuvert\) \{/, "ne doit plus bloquer sur la seule présence d'une hospitalisation ouverte, sans regarder le type du nouvel épisode");
});

test("GET /api/dossiers/recherche par nom appelle rechercher_dossiers_flou (tolérant aux fautes de frappe/accents, pg_trgm), avec un repli %nom% si la fonction/extension n'existe pas encore (code 42883, même patron que les autres fonctions atomiques du projet) — avant, la moindre variation faisait croire qu'aucun dossier n'existait et créait un doublon au lieu de retrouver le patient existant", () => {
  const bloc = blocRoutePermission("app.get('/api/dossiers/recherche'", "app.post('/api/dossiers'");
  assert.match(bloc, /supabase\.rpc\('rechercher_dossiers_flou', \{ p_nom: nom \}\)/, "doit appeler la fonction Postgres de recherche floue");
  assert.match(bloc, /error\.code === '42883'/, "doit détecter l'absence de la fonction/extension");
  assert.match(bloc, /\.ilike\('nom', `%\$\{nom\}%`\)/, "doit se replier sur une recherche partielle si la fonction n'existe pas encore");
});

test("GET /api/dossiers/recherche par numéro reste une correspondance EXACTE (numero_dossier) — pas de recherche floue sur un identifiant, seulement sur le nom", () => {
  const bloc = blocRoutePermission("app.get('/api/dossiers/recherche'", "app.post('/api/dossiers'");
  assert.match(bloc, /\.eq\('numero_dossier', numero\)/, "la recherche par numéro doit rester une égalité stricte");
});

test("Sauvegarde automatique : planifiée tous les jours (cron), n'écrit jamais sur le disque du serveur (éphémère sur Render — perdu à chaque redéploiement), et reste déclenchable manuellement pour vérifier qu'elle fonctionne sans attendre l'exécution planifiée", () => {
  assert.match(serverSrc, /cron\.schedule\('0 6 \* \* \*'/, "doit planifier une exécution quotidienne");
  assert.match(serverSrc, /\.from\(BUCKET_SAUVEGARDES\)\s*\n?\s*\.upload\(/, "doit écrire vers Supabase Storage");
  assert.doesNotMatch(serverSrc, /require\('fs'\)/, "ne doit jamais écrire de fichier sur le disque local du serveur (perdu au redéploiement)");
  const blocManuel = blocRoutePermission("app.post('/api/admin/backup-manuel'", null);
  assert.match(blocManuel, /aPermission\(req\.user\.id, 'sauvegarde_gerer'\)/, "le déclenchement manuel doit exiger la permission sauvegarde_gerer");
});

// Retour d'Esdras (25/08, "je suis administrateur, je ne vois pas Rôles et permissions") :
// PERMISSIONS_PAR_DEFAUT.administrateur avait déjà dérivé du vrai catalogue (fiche_patient_
// modifier et audit_voir manquaient) — la preuve qu'une liste "administrateur = tout" recopiée à
// la main finit toujours par désynchroniser. Remplacé par un court-circuit dans aPermission() :
// administrateur n'a plus d'entrée du tout dans ce repli, il n'en a pas besoin.
test("PERMISSIONS_PAR_DEFAUT (repli backend si le catalogue Supabase est vide) n'a PLUS d'entrée 'administrateur' — aPermission() le court-circuite avant même de lire cette table, donc plus aucun risque de dérive/oubli d'une permission pour ce rôle", () => {
  const blocDefaut = serverSrc.slice(serverSrc.indexOf('const PERMISSIONS_PAR_DEFAUT'), serverSrc.indexOf("role: 'direction'"));
  assert.doesNotMatch(blocDefaut, /role: 'administrateur'/, "ne doit plus y avoir d'entrée administrateur dans ce tableau — devenue inutile et source de dérive");
  assert.match(serverSrc, /if \(profil\.role === 'administrateur'\) return true;/, "aPermission() doit court-circuiter administrateur avant de lire la table, jamais soumis à ce qu'elle contient");
});

test("POST /api/stock/ajouter-don et POST /api/stock/decrementer-dons appellent les fonctions Postgres atomiques dédiées au stock donné, séparées du stock acheté — sinon un don d'ONG risque de se mélanger avec le stock normal (catalog.items[].quantite), perdant la réservation au patient de cet ONG", () => {
  const blocAjouter = blocRoutePermission("app.post('/api/stock/ajouter-don'", "app.post('/api/stock/decrementer-dons'");
  assert.match(blocAjouter, /aPermission\(req\.user\.id, 'stock_gerer'\)/, "doit exiger stock_gerer");
  assert.match(blocAjouter, /supabase\.rpc\('ajouter_stock_don_medicament'/, "doit appeler la fonction Postgres atomique dédiée au don, pas ajouter_stock_medicament (stock acheté)");

  const blocDecrementer = blocRoutePermission("app.post('/api/stock/decrementer-dons'", "app.patch('/api/stock/:id'");
  assert.match(blocDecrementer, /aPermission\(req\.user\.id, 'caisse_travailler'\)/, "doit exiger caisse_travailler");
  assert.match(blocDecrementer, /supabase\.rpc\('decrementer_stock_dons'/, "doit appeler la fonction Postgres atomique dédiée au don, pas decrementer_stock_medicaments (stock acheté)");
  assert.match(blocDecrementer, /res\.status\(409\)/, "doit renvoyer 409 si le stock donné est insuffisant, pas 200");
});

// Retour d'Esdras (23/08) : "on peut ajouter des médicaments en tarif pharmacie ET en stock,
// n'est-ce pas un problème ?" — oui : GrilleEdition.js ("Tarifs Pharma") réécrivait TOUT le
// catalogue à chaque prix modifié/article ajouté (lecture d'un instantané côté navigateur, puis
// réenregistrement du tableau entier), ce qui pouvait silencieusement ANNULER un stock ou des
// dons ONG décrémentés entre-temps par une vente. Corrigé par 3 fonctions Postgres atomiques
// dédiées (fonction_champs_catalogue.sql) qui ne touchent jamais quantite/seuilAlerte/donsParOng.
test("PUT /api/catalog/:type refuse maintenant medicaments et actes (410) — la réécriture complète du tableau pouvait annuler un stock/don décrémenté entre-temps par une vente", () => {
  const blocPut = serverSrc.slice(serverSrc.indexOf("app.put('/api/catalog/:type'"), serverSrc.indexOf("app.post('/api/catalog/:type/item'"));
  assert.match(blocPut, /type === 'medicaments' \|\| type === 'actes'/, "doit détecter medicaments/actes avant tout le reste");
  assert.match(blocPut, /res\.status\(410\)/, "doit renvoyer 410 (route retirée), pas accepter l'écriture");
});

test("POST /api/catalog/:type/item (ajout d'un article) exige catalogue_gerer et force quantite=0/donsParOng={} pour medicaments — le stock initial ne doit jamais être fixable depuis Tarifs Pharma, quoi que le navigateur envoie", () => {
  const bloc = blocRoutePermission("app.post('/api/catalog/:type/item'", "app.patch('/api/catalog/:type/champs'");
  assert.match(bloc, /aPermission\(req\.user\.id, 'catalogue_gerer'\)/, "doit exiger catalogue_gerer (pas caisse_travailler — créer un article n'est pas une vente)");
  assert.match(bloc, /supabase\.rpc\('ajouter_article_catalogue'/, "doit appeler la fonction Postgres atomique dédiée");
});

test("PATCH /api/catalog/:type/champs accepte catalogue_gerer OU caisse_travailler (utilisée aussi par le compteur d'usage du Calculateur) et appelle la fonction qui retire elle-même quantite/seuilAlerte/donsParOng", () => {
  const bloc = blocRoutePermission("app.patch('/api/catalog/:type/champs'", "app.delete('/api/catalog/:type/item/:id'");
  assert.match(bloc, /aPermission\(req\.user\.id, 'catalogue_gerer'\)\) && !\(await aPermission\(req\.user\.id, 'caisse_travailler'\)/, "doit accepter catalogue_gerer OU caisse_travailler");
  assert.match(bloc, /supabase\.rpc\('definir_champs_catalogue_lot'/, "doit appeler la fonction Postgres atomique dédiée");
});

test("DELETE /api/catalog/:type/item/:id exige catalogue_gerer et appelle la fonction Postgres atomique dédiée", () => {
  const bloc = blocRoutePermission("app.delete('/api/catalog/:type/item/:id'", null);
  assert.match(bloc, /aPermission\(req\.user\.id, 'catalogue_gerer'\)/, "doit exiger catalogue_gerer");
  assert.match(bloc, /supabase\.rpc\('supprimer_article_catalogue'/, "doit appeler la fonction Postgres atomique dédiée");
});

// Retour d'Esdras (23/08) : demande d'un rôle à accès temporaire. En creusant "Désactiver un
// compte" (déjà existant), on découvre que ce bouton n'a JAMAIS été appliqué nulle part — ni
// côté écran, ni côté serveur — il écrivait juste un booléen que rien ne lisait. Corrigé en même
// temps que l'ajout de date_expiration, avec le même mécanisme.
test("verifyToken rejette (403) un compte désactivé (active===false) ou dont date_expiration est dépassée — avant, ces 2 champs n'étaient vérifiés NULLE PART, un compte 'désactivé' pouvait continuer à travailler normalement", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf('async function verifyToken'), serverSrc.indexOf('// Application du middleware'));
  assert.match(bloc, /\.select\('active, date_expiration'\)\.eq\('id', decoded\.uid\)/, "doit relire active et date_expiration depuis la table users à CHAQUE requête, pas seulement à la connexion");
  assert.match(bloc, /profil\.active === false/, "doit rejeter un compte désactivé");
  assert.match(bloc, /new Date\(profil\.date_expiration\) < new Date\(\)/, "doit rejeter un accès expiré");
  assert.match(bloc, /res\.status\(403\)/, "doit renvoyer 403, pas laisser passer");
});

// Retour d'Esdras (29/08) : "des paiements refusés par le serveur pour token manquant ou invalide"
// — jusqu'ici ces rejets ne laissaient AUCUNE trace côté serveur (ni les logs Render, ni ailleurs),
// impossible de savoir combien ça arrivait ni sur quelles routes. Juste assez pour repérer un pic
// ou une route précise dans les logs, sans jamais loguer le jeton lui-même.
test("verifyToken logue (console.warn) chacun de ses 2 rejets 401, avec la méthode et le chemin — sinon aucune trace de ces rejets ne survit nulle part", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf('async function verifyToken'), serverSrc.indexOf('// Application du middleware'));
  assert.match(bloc, /console\.warn\(`verifyToken: en-tête Authorization absent \(\$\{req\.method\} \$\{req\.path\}\)`\);\s*\n\s*return res\.status\(401\)\.json\(\{ error: 'Token manquant ou invalide' \}\);/, "doit loguer avant de rejeter faute d'en-tête Authorization");
  assert.match(bloc, /console\.warn\(`verifyToken: jeton invalide ou expiré \(\$\{req\.method\} \$\{req\.path\}\):`, e\.message\);\s*\n\s*return res\.status\(401\)\.json\(\{ error: 'Token invalide ou expiré' \}\);/, "doit loguer avant de rejeter pour un jeton invalide/expiré");
  assert.doesNotMatch(bloc, /console\.warn\([^\n]*\$\{token\}/, "ne doit jamais loguer le jeton lui-même, seulement la méthode/le chemin");
});

// Retour d'Esdras (23/08) : pièces jointes au dossier, en priorité les fiches de référence ONG.
test("Pièces jointes : GET est ouvert (comme GET /api/dossiers/:id), POST/DELETE exigent fiche_patient_modifier (comme PUT /api/dossiers/:id)", () => {
  const blocGet = blocRoutePermission("app.get('/api/dossiers/:id/pieces-jointes'", "app.post('/api/dossiers/:id/pieces-jointes'");
  assert.doesNotMatch(blocGet, /aPermission/, "la lecture doit rester ouverte à tout compte connecté, comme GET /api/dossiers/:id");

  const blocPost = blocRoutePermission("app.post('/api/dossiers/:id/pieces-jointes'", "app.get('/api/dossiers/:id/pieces-jointes/:fichierId/lien'");
  assert.match(blocPost, /aPermission\(req\.user\.id, 'fiche_patient_modifier'\)/, "l'ajout doit exiger fiche_patient_modifier");

  const blocDelete = blocRoutePermission("app.delete('/api/dossiers/:id/pieces-jointes/:fichierId'", "app.get('/api/dossiers/:id/episodes-ouverts'");
  assert.match(blocDelete, /aPermission\(req\.user\.id, 'fiche_patient_modifier'\)/, "la suppression doit exiger fiche_patient_modifier");
});

test("Pièces jointes : le lien de téléchargement est un lien signé temporaire (createSignedUrl), le fichier ne transite jamais par ce serveur", () => {
  const bloc = blocRoutePermission("app.get('/api/dossiers/:id/pieces-jointes/:fichierId/lien'", "app.delete('/api/dossiers/:id/pieces-jointes/:fichierId'");
  assert.match(bloc, /createSignedUrl\(piece\.storage_path, 3600\)/, "doit générer un lien signé (1h), pas streamer les octets");
});

test("Pièces jointes : le bucket Storage est privé (public: false) et créé automatiquement s'il n'existe pas encore, même principe que les sauvegardes automatiques", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf('async function assurerBucketPiecesJointes'), serverSrc.indexOf("app.get('/api/dossiers/:id/pieces-jointes'"));
  assert.match(bloc, /createBucket\(BUCKET_PIECES_JOINTES, \{ public: false \}\)/, "le bucket doit être privé");
});

// Retour d'Esdras (23/08) : réquisition de stock par un autre service, jusqu'ici seulement
// possible en corrigeant chaque médicament un par un dans "Gestion des stocks" (fastidieux, sans
// trace de quel service a pris quoi).
test("POST /api/requisitions exige stock_gerer (pas caisse_travailler — retirer du stock pour un service n'est pas une vente), réutilise decrementer_stock_medicaments (tout-ou-rien) et renvoie 409 si le stock est insuffisant", () => {
  const bloc = blocRoutePermission("app.post('/api/requisitions'", "app.get('/api/requisitions'");
  assert.match(bloc, /aPermission\(req\.user\.id, 'stock_gerer'\)/, "doit exiger stock_gerer");
  assert.doesNotMatch(bloc, /'caisse_travailler'/, "une réquisition n'est pas une vente");
  assert.match(bloc, /supabase\.rpc\('decrementer_stock_medicaments'/, "doit réutiliser la fonction atomique déjà utilisée pour les ventes, pas une nouvelle fonction dupliquée");
  assert.match(bloc, /res\.status\(409\)/, "doit refuser (409) si le stock est insuffisant, pas laisser passer");
});

test("POST /api/requisitions capture les noms des médicaments depuis le catalogue à jour renvoyé par le décrément, PAS depuis req.body — la réquisition doit rester lisible même si un médicament est renommé/supprimé plus tard", () => {
  const bloc = blocRoutePermission("app.post('/api/requisitions'", "app.get('/api/requisitions'");
  assert.match(bloc, /article = \(data\.items \|\| \[\]\)\.find\(i => i\.id === l\.id\)/, "doit chercher le nom dans data.items (catalogue à jour), pas faire confiance à un nom envoyé par le navigateur");
});

test("GET /api/requisitions accepte stock_gerer OU analytics_voir — Direction/comptable doivent pouvoir consulter le rapport sans avoir le droit de sortir du stock", () => {
  const bloc = blocRoutePermission("app.get('/api/requisitions'", "app.post('/api/stock/ajouter'");
  assert.match(bloc, /aPermission\(req\.user\.id, 'stock_gerer'\)\) && !\(await aPermission\(req\.user\.id, 'analytics_voir'\)/, "doit accepter stock_gerer OU analytics_voir");
});

// Retour d'Esdras (23/08) : transfert d'un patient hospitalisé entre services (ex. Maternité ->
// Néonatologie) — rien ne traçait ça avant.
test("PATCH /api/episodes/:id/transferer exige caisse_travailler, refuse un épisode non-hospitalisation ou déjà fermé, et trace le transfert (transferts_service) sans faire échouer la réponse si la trace échoue", () => {
  const bloc = blocRoutePermission("app.patch('/api/episodes/:id/transferer'", "app.get('/api/episodes/:id/transferts'");
  assert.match(bloc, /aPermission\(req\.user\.id, 'caisse_travailler'\)/, "doit exiger caisse_travailler");
  assert.match(bloc, /if \(!episode\.est_hospitalisation\)/, "doit refuser un épisode qui n'est pas en hospitalisation");
  assert.match(bloc, /if \(episode\.statut !== 'ouvert'\)/, "doit refuser un épisode déjà fermé");
  assert.match(bloc, /\.from\('transferts_service'\)\.insert/, "doit tracer le transfert");
  assert.match(bloc, /console\.error\('Transfert effectué mais non tracé/, "un échec de la trace ne doit pas faire échouer le transfert lui-même (déjà appliqué à ce moment-là)");
});

test("GET /api/episodes/:id/transferts est ouvert (comme le reste de l'historique d'un dossier), pas de permission bloquante", () => {
  const bloc = blocRoutePermission("app.get('/api/episodes/:id/transferts'", "app.patch('/api/episodes/:id/lit'");
  assert.doesNotMatch(bloc, /aPermission/, "la lecture de l'historique des transferts doit rester ouverte");
});

// Retour d'Esdras (23/08) : lits nommés individuellement — "on sait X lits occupés à Maternité"
// mais pas "Lit 3 occupé, Lit 4 libre".
test("PATCH /api/episodes/:id/lit refuse d'assigner un lit déjà occupé par un AUTRE épisode ouvert du même service (409), et PATCH .../transferer vide le lit (appartient à l'ancien service)", () => {
  const blocLit = blocRoutePermission("app.patch('/api/episodes/:id/lit'", "app.post('/api/fiches'");
  assert.match(blocLit, /aPermission\(req\.user\.id, 'caisse_travailler'\)/, "doit exiger caisse_travailler");
  assert.match(blocLit, /\.eq\('service', episode\.service\)\.eq\('lit', lit\)\.eq\('statut', 'ouvert'\)\.neq\('id', req\.params\.id\)/, "doit vérifier qu'aucun AUTRE épisode ouvert du même service n'a déjà ce lit");
  assert.match(blocLit, /res\.status\(409\)/, "doit refuser (409) un lit déjà occupé, pas laisser 2 patients sur le même lit");

  const blocTransfert = serverSrc.slice(serverSrc.indexOf("app.patch('/api/episodes/:id/transferer'"), serverSrc.indexOf("app.get('/api/episodes/:id/transferts'"));
  assert.match(blocTransfert, /\.update\(\{ service: nouveau_service\.trim\(\), lit: null \}\)/, "un transfert doit vider le lit — il appartient à l'ancien service");
});

test("episodeVersFlat expose lit — sinon Hospitalisation ne peut jamais afficher quel lit est occupé", () => {
  const blocFlat = serverSrc.slice(serverSrc.indexOf('async function episodeVersFlat'), serverSrc.indexOf("app.get('/api/episodes'"));
  assert.match(blocFlat, /lit: ep\.lit \|\| null,/);
});

// Chantier de robustesse hors ligne, item 8 (23/08) : jusqu'ici seule la CRÉATION d'un dossier/
// épisode avait une protection contre les doublons (local_id) — une MODIFICATION (transfert, lit)
// partie en file d'attente hors ligne pouvait écraser en aveugle un changement fait entre-temps
// par quelqu'un d'autre en ligne sur ce même patient, sans jamais prévenir personne.
test("PATCH /api/episodes/:id/lit détecte un conflit (409) si lit_attendu (optionnel) ne correspond plus au lit RÉEL actuel du patient — le lit a été changé entre-temps par quelqu'un d'autre pendant que cette requête attendait en file hors ligne", () => {
  const blocLit = blocRoutePermission("app.patch('/api/episodes/:id/lit'", "app.post('/api/fiches'");
  assert.match(blocLit, /const \{ lit, lit_attendu \} = req\.body;/, "doit accepter lit_attendu, optionnel");
  assert.match(blocLit, /\.select\('service, est_hospitalisation, statut, lit'\)/, "doit relire le lit RÉEL actuel du patient pour pouvoir le comparer");
  assert.match(blocLit, /if \(lit_attendu !== undefined && \(episode\.lit \|\| null\) !== \(lit_attendu \|\| null\)\)/, "ne doit vérifier le conflit QUE si lit_attendu a été transmis — un appelant qui ne l'envoie pas garde l'ancien comportement");
  assert.match(blocLit, /return res\.status\(409\)\.json\(\{\s*error: `Conflit/, "doit renvoyer 409 avec un message explicite, pas écraser silencieusement");
});

test("PATCH /api/episodes/:id/transferer détecte un conflit (409) si service_attendu (optionnel) ne correspond plus au service RÉEL actuel du patient — même principe que /lit ci-dessus", () => {
  const blocTransfert = serverSrc.slice(serverSrc.indexOf("app.patch('/api/episodes/:id/transferer'"), serverSrc.indexOf("app.get('/api/episodes/:id/transferts'"));
  assert.match(blocTransfert, /const \{ nouveau_service, motif, transfere_par, service_attendu \} = req\.body;/, "doit accepter service_attendu, optionnel");
  assert.match(blocTransfert, /if \(service_attendu !== undefined && episode\.service !== service_attendu\)/, "ne doit vérifier le conflit QUE si service_attendu a été transmis");
  assert.match(blocTransfert, /return res\.status\(409\)\.json\(\{\s*error: `Conflit/, "doit renvoyer 409 avec un message explicite, pas écraser silencieusement");
  // Le contrôle de conflit doit avoir lieu AVANT l'update — sinon le transfert est déjà appliqué
  // quand le conflit est détecté, ce qui ne protège plus rien.
  assert.ok(blocTransfert.indexOf('service_attendu') < blocTransfert.indexOf(".update({ service: nouveau_service.trim(), lit: null })"), "la vérification du conflit doit précéder l'update, pas le suivre");
});

// Retour d'Esdras (24/08) : "corrige cela" — dernier coin non uniformisé de l'audit financier.
// episodeVersFlat (utilisé par Statistiques/Direction/Archives) excluait déjà une fiche au
// paiement annulé de totalGlobal, mais GET /api/fiches/episode/:episodeId (utilisé par le
// Calculateur/Fiche Patient pour rouvrir un dossier en cours de facturation) n'avait pas ce même
// filtre — les totaux affichés pendant une session de caisse active pouvaient rester faux.
test("GET /api/fiches/episode/:episodeId marque chaque fiche avec paiement_annule (même source que episodeVersFlat : paiements.fiche_id + annule=true), pour que le Calculateur/Fiche Patient puisse exclure ces fiches de ses propres totaux", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.get('/api/fiches/episode/:episodeId'"), serverSrc.indexOf("// PIÈCES JOINTES") !== -1 && serverSrc.indexOf("// PIÈCES JOINTES") > serverSrc.indexOf("app.get('/api/fiches/episode/:episodeId'") ? serverSrc.indexOf("// PIÈCES JOINTES") : serverSrc.length);
  assert.match(blocRoute, /\.from\('paiements'\)\.select\('fiche_id'\)\.eq\('episode_id', req\.params\.episodeId\)\.eq\('annule', true\)\.not\('fiche_id', 'is', null\)/, "doit chercher les paiements annulés liés à une fiche de cet épisode, comme episodeVersFlat");
  assert.match(blocRoute, /res\.json\(\(data \|\| \[\]\)\.map\(f => \(\{ \.\.\.f, paiement_annule: fichesAvecPaiementAnnule\.has\(f\.id\) \}\)\)\);/, "doit renvoyer chaque fiche marquée paiement_annule, pas les fiches brutes telles quelles");
});

// Perfectionnement (24/08, "on fait le plus facile d'abord") : la sauvegarde automatique tourne
// seule tous les jours (cron 6h UTC, voir sauvegarderVersStorage) mais rien ne permettait de
// vérifier depuis l'appli que ça avait vraiment marché. Cette route lit juste le nom du fichier le
// plus récent du bucket (backup-YYYY-MM-DD.json) — pas besoin de dépendre des métadonnées Storage.
test("GET /api/admin/derniere-sauvegarde exige sauvegarde_gerer et renvoie la date déduite du nom du fichier le plus récent du bucket sauvegardes-automatiques", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.get('/api/admin/derniere-sauvegarde'"), serverSrc.indexOf('const PORT ='));
  assert.match(blocRoute, /aPermission\(req\.user\.id, 'sauvegarde_gerer'\)/, "doit exiger la permission sauvegarde_gerer, comme le déclenchement manuel");
  assert.match(blocRoute, /supabase\.storage\.from\(BUCKET_SAUVEGARDES\)\.list\(\)/, "doit lister le même bucket que sauvegarderVersStorage");
  assert.match(blocRoute, /fichiers\.sort\(\(a, b\) => b\.name\.localeCompare\(a\.name\)\)\[0\]/, "doit prendre le fichier le plus récent par tri du nom (backup-YYYY-MM-DD.json trie naturellement)");
  assert.match(blocRoute, /if \(!fichiers \|\| fichiers\.length === 0\) return res\.json\(\{ date: null \}\);/, "doit renvoyer date: null si le bucket est vide (jamais réussie), pas planter");
});

// Portail patient (retour d'Esdras, 24/08) : un patient qui a perdu sa prescription papier peut
// retrouver la liste de ses médicaments/actes récents, sans compte à créer. Seul accès public de
// tout ce backend — à vérifier avec un soin particulier.
test("motsDuNom (utils/portailPatient.js) : compare 2 noms sans tenir compte de l'ordre des mots, des accents ni de la casse", () => {
  const { motsDuNom } = require('../utils/portailPatient');
  assert.strictEqual(motsDuNom('Jéan Baptiste Pierre'), motsDuNom('pierre JEAN baptiste'), "même mots, ordre différent, accent différent, casse différente : doit quand même correspondre");
  assert.notStrictEqual(motsDuNom('Jean Pierre'), motsDuNom('Jean Paul'), "des mots réellement différents ne doivent jamais correspondre");
  assert.strictEqual(motsDuNom(''), motsDuNom(null), "une valeur vide/absente ne doit jamais planter");
});

test("POST /portail-patient/recherche est déclarée HORS de /api (donc jamais protégée par verifyToken) — c'est le seul accès public voulu de ce backend", () => {
  assert.match(serverSrc, /app\.post\('\/portail-patient\/recherche'/, "la route doit exister");
  assert.doesNotMatch(serverSrc, /app\.post\('\/api\/portail-patient\/recherche'/, "ne doit JAMAIS être sous /api — sinon verifyToken l'exigerait, et un patient n'a pas de compte");
});

test("POST /portail-patient/recherche : limite les tentatives (5 par 15 minutes, par IP+numéro de dossier), exige les 3 informations ensemble, et ne renvoie jamais prix/solde/mode de paiement", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.post('/portail-patient/recherche'"), serverSrc.indexOf("app.use('/api', verifyToken)", serverSrc.indexOf("app.post('/portail-patient/recherche'")));
  assert.match(blocRoute, /if \(!numero_dossier \|\| !date_naissance \|\| !nom\)/, "les 3 informations (numéro de dossier, date de naissance, nom) doivent être exigées ensemble");
  assert.match(blocRoute, /MAX_TENTATIVES_PORTAIL/, "doit limiter le nombre de tentatives");
  assert.match(blocRoute, /res\.status\(429\)/, "doit renvoyer 429 (trop de tentatives) au-delà de la limite");
  assert.match(blocRoute, /motsDuNom\(dossier\.nom\) !== motsDuNom\(nom\)/, "le nom doit être vérifié en plus du numéro de dossier et de la date de naissance");
  // Ignore les commentaires explicatifs (qui MENTIONNENT "prix" pour dire qu'on l'exclut) —
  // ne vérifie que le code réellement exécuté : les .select(...) et le res.json(...) final.
  const selects = [...blocRoute.matchAll(/\.select\('([^']+)'\)/g)].map(m => m[1]);
  for (const champs of selects) {
    assert.doesNotMatch(champs, /prix|total_global|mode_paiement|solde/, `un .select() de cette route lit un champ financier : ${champs}`);
  }
  const blocReponse = blocRoute.slice(blocRoute.indexOf('const historique ='));
  assert.doesNotMatch(blocReponse.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'), /prix|total_global|mode_paiement|solde/, "la réponse construite (historique/res.json) ne doit jamais exposer de donnée financière");
  assert.match(blocRoute, /articles: \(f\.raw_state\?\.lignesCalcul \|\| \[\]\)\.map\(l => \(\{ nom: l\.nom, quantite: l\.qte \}\)\)/, "seuls le nom et la quantité de chaque article doivent quitter ce backend");
});

test("POST /portail-patient/recherche : un dossier introuvable ET un nom/date qui ne correspond pas renvoient le MÊME message d'erreur générique — jamais de quoi deviner quelle information était fausse", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.post('/portail-patient/recherche'"), serverSrc.indexOf("app.use('/api', verifyToken)", serverSrc.indexOf("app.post('/portail-patient/recherche'")));
  const occurrences = (blocRoute.match(/Aucun dossier ne correspond à ces informations\./g) || []).length;
  assert.strictEqual(occurrences, 1, "un seul message d'erreur générique doit exister, réutilisé pour tous les cas de désaccord (fonction echec())");
  assert.match(blocRoute, /if \(!dossier \|\| motsDuNom\(dossier\.nom\) !== motsDuNom\(nom\)\) return echec\(\);/, "dossier introuvable ET nom incorrect doivent passer par le MÊME appel à echec()");
});

// Onglet Paramètres (retour d'Esdras, 24/08) : "je peux désactiver le portail patient sans tout
// supprimer ?" — oui, via un réglage désactivable, vérifié CÔTÉ SERVEUR (pas seulement masqué à
// l'écran, cette route étant publique) puisque parametres_gerer est réservé à l'administrateur.
test("POST /portail-patient/recherche refuse (503) quand catalog('parametres').portailPatientActif est explicitement false, mais reste actif par défaut si jamais réglé", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf('async function portailPatientActif'), serverSrc.indexOf("app.post('/portail-patient/recherche'"));
  assert.match(blocRoute, /return !parametres \|\| parametres\.portailPatientActif !== false;/, "doit rester actif par défaut (true) tant que personne n'a jamais réglé cette valeur");
  const blocPost = serverSrc.slice(serverSrc.indexOf("app.post('/portail-patient/recherche'"), serverSrc.indexOf("app.use('/api', verifyToken)", serverSrc.indexOf("app.post('/portail-patient/recherche'")));
  assert.match(blocPost, /if \(!\(await portailPatientActif\(\)\)\) \{\s*\n\s*return res\.status\(503\)/, "doit vérifier le réglage EN TOUT PREMIER, avant même la limite de tentatives");
});

test("PUT /api/catalog/parametres exige la permission parametres_gerer, distincte de catalogue_gerer (réglages d'infrastructure, pas des tarifs)", () => {
  const blocRoute = serverSrc.slice(serverSrc.indexOf("app.put('/api/catalog/:type'"), serverSrc.indexOf("app.post('/api/catalog/:type/item'"));
  assert.match(blocRoute, /else if \(type === 'parametres'\) \{\s*\n\s*permissionOk = await aPermission\(req\.user\.id, 'parametres_gerer'\);/, "le type 'parametres' doit exiger parametres_gerer, pas catalogue_gerer");
});

test("parametres_gerer n'a pas besoin d'exister dans le miroir PERMISSIONS_PAR_DEFAUT pour administrateur — le court-circuit dans aPermission() le lui accorde de toute façon, sans dépendre de cette liste", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf('const PERMISSIONS_PAR_DEFAUT'), serverSrc.indexOf('async function aPermission'));
  assert.doesNotMatch(bloc, /role: 'administrateur'/, "toujours pas d'entrée administrateur ici — voir le test dédié plus haut");
});

// Retour d'Esdras (27/08, remplace l'ancienne route à une seule fiche du 25/08 après un long
// brainstorming) : transformer un privé en partenaire distingue 2 cas.
//
// CAS 1 (/transferer-partenaire) : le partenaire prend en charge À PARTIR DE MAINTENANT — aucun
// remboursement des services déjà rendus, seulement le solde de dépôt non dépensé.
test("POST /api/episodes/:id/transferer-partenaire (Cas 1) exige paiement_annuler, un partenaire, un motif ET un nom d'autorisation — et seulement sur un épisode encore ouvert", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("app.post('/api/episodes/:id/transferer-partenaire'"), serverSrc.indexOf("app.post('/api/episodes/:id/rembourser-transferer-partenaire'"));
  assert.match(bloc, /if \(!\(await aPermission\(req\.user\.id, 'paiement_annuler'\)\)\) \{/);
  assert.match(bloc, /if \(!ong_partenaire\) return res\.status\(400\)/);
  assert.match(bloc, /if \(!motif \|\| !motif\.trim\(\)\) return res\.status\(400\)/);
  assert.match(bloc, /if \(!autorise_par \|\| !autorise_par\.trim\(\)\) return res\.status\(400\)/, "le nom de la personne qui autorise ce changement doit être obligatoire");
  assert.match(bloc, /if \(episode\.statut !== 'ouvert'\) return res\.status\(400\)/, "sans remboursement n'a de sens que pour un épisode encore ouvert");
});

test("POST /api/episodes/:id/transferer-partenaire (Cas 1) ne touche à AUCUNE fiche déjà facturée/payée — seul le solde de dépôt non dépensé est remboursé en cash, l'épisode se ferme et un nouvel épisode partenaire s'ouvre pour la suite", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("app.post('/api/episodes/:id/transferer-partenaire'"), serverSrc.indexOf("app.post('/api/episodes/:id/rembourser-transferer-partenaire'"));
  assert.doesNotMatch(bloc, /from\('fiches'\)/, "le Cas 1 ne doit jamais toucher aux fiches — c'est tout le sens de \"sans remboursement\"");
  assert.match(bloc, /const \{ soldeDepot \} = calculerSoldeDepot\(paiements\);/);
  assert.match(bloc, /mode: 'remboursement_patient',\s*\n\s*date_paiement: maintenant, encaisse_par: encaissePar, traite_par_uid: req\.user\.id,\s*\n\s*details: detailsAudit,/, "le remboursement du dépôt doit garder motif/autorise_par dans details");
  assert.match(bloc, /dossier_id: episode\.dossier_id, voie_entree: episode\.voie_entree, service: episode\.service,\s*\n\s*type_patient: 'partenaire', ong_partenaire, statut: 'ouvert', est_hospitalisation: episode\.est_hospitalisation,/, "le nouvel épisode doit rester OUVERT (la visite continue, juste facturée au partenaire) et reprendre le service/type de soin de l'épisode d'origine");
  assert.match(bloc, /await supabase\.from\('episodes'\)\.update\(\{ statut: 'ferme' \}\)\.eq\('id', episode\.id\)\.select\(\);/, "l'épisode d'origine doit se refermer");
});

// CAS 2 (/rembourser-transferer-partenaire) : le partenaire couvrait DÉJÀ le patient (référence,
// notification manquée) — tout ce qui a été payé (cash et/ou dépôt) est remboursé, un solde à
// crédit (jamais réellement encaissé) est annulé plutôt que remboursé, et les fiches choisies sont
// transférées vers un seul nouvel épisode partenaire.
test("POST /api/episodes/:id/rembourser-transferer-partenaire (Cas 2) exige paiement_annuler, un partenaire, un motif, un nom d'autorisation, et au moins une fiche sélectionnée", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("app.post('/api/episodes/:id/rembourser-transferer-partenaire'"), serverSrc.length);
  assert.match(bloc, /if \(!\(await aPermission\(req\.user\.id, 'paiement_annuler'\)\)\) \{/);
  assert.match(bloc, /if \(!ong_partenaire\) return res\.status\(400\)/);
  assert.match(bloc, /if \(!motif \|\| !motif\.trim\(\)\) return res\.status\(400\)/);
  assert.match(bloc, /if \(!autorise_par \|\| !autorise_par\.trim\(\)\) return res\.status\(400\)/);
  assert.match(bloc, /if \(!Array\.isArray\(fiche_ids\) \|\| fiche_ids\.length === 0\) return res\.status\(400\)/);
  assert.match(bloc, /if \(\(fiches \|\| \[\]\)\.length !== fiche_ids\.length\) return res\.status\(400\)/, "doit refuser une fiche qui n'appartient pas à cet épisode");
});

test("POST /api/episodes/:id/rembourser-transferer-partenaire (Cas 2) valide TOUTES les fiches AVANT de toucher à la base — une seule fiche déjà transférée/annulée bloque tout le lot avant la moindre écriture", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("app.post('/api/episodes/:id/rembourser-transferer-partenaire'"), serverSrc.length);
  const indexValidation = bloc.indexOf('const paiementsOriginaux = new Map();');
  const indexNouvelEpisode = bloc.indexOf("await supabase.from('episodes').insert({");
  assert.ok(indexValidation !== -1 && indexNouvelEpisode !== -1 && indexValidation < indexNouvelEpisode, "la validation de toutes les fiches doit précéder la moindre écriture (le nouvel épisode)");
  assert.match(bloc, /if \(!paiementOriginal\) \{\s*\n\s*return res\.status\(400\)/, "une fiche sans paiement encaissable/à crédit valide doit bloquer tout le lot");
});

test("POST /api/episodes/:id/rembourser-transferer-partenaire (Cas 2) : une fiche payée à crédit est ANNULÉE (rien n'a jamais été encaissé), une fiche payée (cash et/ou dépôt) est REMBOURSÉE en cash pour son montant total — les deux sont transférées vers un seul nouvel épisode partenaire, jamais un par fiche", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("app.post('/api/episodes/:id/rembourser-transferer-partenaire'"), serverSrc.length);
  assert.match(bloc, /if \(paiementOriginal\.mode === 'credit'\) \{/, "une fiche à crédit doit être détectée séparément");
  assert.match(bloc, /annule: true, annule_par: autoriseParTrim, annule_par_uid: req\.user\.id,\s*\n\s*annule_le: maintenant, motif_annulation: `Transféré à \$\{ong_partenaire\} : \$\{motifTrim\}`,/, "le crédit doit être annulé, jamais remboursé (rien n'a été réellement encaissé)");
  assert.match(bloc, /montant: fiche\.total_global, mode: 'remboursement_patient',/, "une fiche payée doit être remboursée pour son montant TOTAL (cash et dépôt confondus)");
  assert.match(bloc, /dossier_id: episode\.dossier_id, voie_entree: 'consultation', service: episode\.service \|\| 'Général',\s*\n\s*type_patient: 'partenaire', ong_partenaire, statut: 'ouvert', est_hospitalisation: false,/, "un seul nouvel épisode, OUVERT (retour d'Esdras 29/08 : le patient est souvent encore là, la caisse doit pouvoir continuer à ajouter des fiches dessus)");
  assert.match(bloc, /let numeroFiche = 1;/, "chaque fiche transférée doit avoir son propre numéro dans le nouvel épisode");
});

test("POST /api/episodes/:id/rembourser-transferer-partenaire (Cas 2) rembourse aussi le solde de dépôt restant de l'épisode (une seule fois, jamais par fiche) et referme TOUJOURS l'épisode d'origine, même si certaines fiches ont été exclues du transfert", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("app.post('/api/episodes/:id/rembourser-transferer-partenaire'"), serverSrc.length);
  const indexSoldeDepot = bloc.indexOf("const { soldeDepot } = calculerSoldeDepot(paiementsEpisode);");
  const indexFermeture = bloc.indexOf("await supabase.from('episodes').update({ statut: 'ferme' }).eq('id', episode.id).select();");
  assert.ok(indexSoldeDepot !== -1, "doit calculer le solde de dépôt restant sur l'épisode entier");
  assert.ok(indexFermeture !== -1 && indexFermeture > indexSoldeDepot, "la fermeture doit avoir lieu après le remboursement du dépôt, à la toute fin");
});

test("POST /api/episodes/:id/rembourser-transferer-partenaire (Cas 2) : un échec en cours de route nettoie (rollback) tout ce qui a déjà été inséré — paiements, fiches, puis le nouvel épisode, dans l'ordre inverse", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("app.post('/api/episodes/:id/rembourser-transferer-partenaire'"), serverSrc.length);
  assert.match(bloc, /const nettoyer = async \(\) => \{\s*\n\s*for \(const id of aNettoyer\.paiements\) await supabase\.from\('paiements'\)\.delete\(\)\.eq\('id', id\);\s*\n\s*for \(const id of aNettoyer\.fiches\) await supabase\.from\('fiches'\)\.delete\(\)\.eq\('id', id\);\s*\n\s*for \(const id of aNettoyer\.episodes\) await supabase\.from\('episodes'\)\.delete\(\)\.eq\('id', id\);/);
  assert.match(bloc, /\} catch \(e\) \{\s*\n\s*await nettoyer\(\);\s*\n\s*res\.status\(500\)\.json\(\{ error: e\.message \}\);\s*\n\s*\}/);
});

// Retour d'Esdras (25/08) : "je suis administrateur, je ne vois pas Rôles et permissions" —
// dès qu'un tableau de permissions personnalisé a été enregistré une seule fois, il devient la
// seule source de vérité, et une entrée 'administrateur' incomplète (ou datant d'avant l'ajout
// d'une permission) prive même un vrai administrateur de l'accès — verrouillage complet si la
// permission manquante est permissions_gerer elle-même (rien ne permet plus de la recocher).
test("aPermission() accorde TOUJOURS tout à administrateur, avant même de lire catalog('permissions') — jamais soumis à ce qui y est enregistré (ou pas)", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf('async function aPermission'), serverSrc.indexOf("app.use(cors())"));
  const indexCourtCircuit = bloc.indexOf("if (profil.role === 'administrateur') return true;");
  const indexLectureTable = bloc.indexOf("await supabase.from('catalog')");
  assert.ok(indexCourtCircuit !== -1, "doit court-circuiter administrateur");
  assert.ok(indexCourtCircuit < indexLectureTable, "le court-circuit doit avoir lieu AVANT la lecture de catalog('permissions') — jamais après, sinon une table incomplète pourrait encore refuser l'accès avant que ce test ne s'applique");
});

// Retour d'Esdras (26/08) : un dépôt (paiement mode='depot') n'était jamais décrémenté au fur et
// à mesure de sa consommation — chaque nouvelle fiche du même épisode resoustrayait le total BRUT
// de tous les dépôts jamais faits, jamais net de ce qu'un achat précédent avait déjà consommé. Cas
// réel signalé : dépôt initial pour un nouveau-né en néonatalogie, consommé par plusieurs achats
// de médicaments étalés dans le temps — le même dépôt pouvait couvrir bien plus que son montant réel.
test("calculerSoldeDepot() calcule le solde de dépôt RÉELLEMENT disponible (total des dépôts moins ce qui a déjà été consommé par des paiements antérieurs), jamais juste le total brut déposé", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf('function calculerSoldeDepot'), serverSrc.indexOf('app.get(\'/api/episodes/:id/solde-depot\''));
  assert.match(bloc, /p\.mode === 'depot'/, "doit isoler les paiements mode='depot' pour le total brut déposé");
  assert.match(bloc, /details\?\.montant_depot_utilise/, "doit soustraire ce qui a déjà été consommé (details.montant_depot_utilise), jamais juste renvoyer le total brut");
  assert.match(bloc, /Math\.max\(0, totalDepots - totalDepotUtilise\)/, "le solde disponible ne doit jamais descendre sous 0");
});

test("GET /api/episodes/:id/solde-depot expose le solde de dépôt réellement disponible pour un épisode — utilisé par CalculateurPanel.js au moment de facturer, jamais le total brut déposé", () => {
  assert.match(serverSrc, /app\.get\('\/api\/episodes\/:id\/solde-depot', async \(req, res\) => \{/);
  const bloc = serverSrc.slice(serverSrc.indexOf("app.get('/api/episodes/:id/solde-depot'"), serverSrc.indexOf("app.get('/api/episodes', async"));
  assert.match(bloc, /\.or\('annule\.eq\.false,annule\.is\.null'\)/, "doit exclure les paiements annulés du calcul, comme partout ailleurs");
  assert.match(bloc, /calculerSoldeDepot\(paiements\)/);
});

test("GET /api/dossiers/:id/historique inclut soldeDepot par épisode (affiché sur Fiche Patient, très consulté par l'archiviste) — recalculé à partir de tout l'historique des paiements, pas seulement le dernier", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("app.get('/api/dossiers/:id/historique'"), serverSrc.indexOf("// ============================================================\n// PIÈCES JOINTES"));
  assert.doesNotMatch(bloc, /\.order\('date_paiement', \{ ascending: false \}\)\.limit\(1\)/, "ne doit plus se limiter au dernier paiement — calculerSoldeDepot a besoin de tout l'historique");
  assert.match(bloc, /\.\.\.calculerSoldeDepot\(paiements\)/, "chaque épisode enrichi doit porter son soldeDepot");
});

// Retour d'Esdras (26/08) : "les infirmiers et archivistes vont avoir accès à Fiche Patient, ils
// ne peuvent pas voir si le patient a un solde ou statut de paiement". Filtré ici (pas seulement
// côté client, FichePatient.js) : une donnée financière ne doit jamais transiter vers un navigateur
// qui n'a pas le droit de la voir, même consultable via l'onglet réseau.
test("GET /api/dossiers/:id/historique n'inclut dernierPaiement/soldeDepot que si l'appelant a fiche_patient_voir_finances — vérifié UNE fois pour tout le dossier, pas par épisode", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("app.get('/api/dossiers/:id/historique'"), serverSrc.indexOf("// ============================================================\n// PIÈCES JOINTES"));
  assert.match(bloc, /const peutVoirFinances = await aPermission\(req\.user\.id, 'fiche_patient_voir_finances'\);/);
  assert.match(bloc, /if \(!peutVoirFinances\) return \{ \.\.\.ep, dernierPaiement: null, intervention, fichesDetail \};/, "sans la permission, dernierPaiement et soldeDepot/totalDepots ne doivent jamais quitter le serveur (intervention et fichesDetail restent inclus, jamais une donnée financière)");
});

test("PERMISSIONS_PAR_DEFAUT (miroir serveur) : dossier_creer retiré de tous les rôles sauf infirmier, fiche_patient_voir_finances accordée à direction/comptable/auditeur — reflète exactement le retour d'Esdras (\"seul l'infirmier peut créer un dossier, la caisse crée l'épisode et travaille au calculateur, archiviste et infirmier consultent le dossier\")", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf('const PERMISSIONS_PAR_DEFAUT'), serverSrc.indexOf('async function aPermission'));
  assert.match(bloc, /\{ role: 'infirmier', permissions: \['dossier_creer'/, "infirmier doit garder dossier_creer");
  for (const role of ['direction', 'comptable', 'auditeur', 'lecteur', 'archiviste']) {
    const ligne = bloc.slice(bloc.indexOf(`{ role: '${role}'`), bloc.indexOf('\n', bloc.indexOf(`{ role: '${role}'`)));
    assert.doesNotMatch(ligne, /'dossier_creer'/, `${role} ne doit plus avoir dossier_creer dans le miroir serveur`);
  }
  for (const role of ['direction', 'comptable', 'auditeur']) {
    const ligne = bloc.slice(bloc.indexOf(`{ role: '${role}'`), bloc.indexOf('\n', bloc.indexOf(`{ role: '${role}'`)));
    assert.match(ligne, /'fiche_patient_voir_finances'/, `${role} doit avoir fiche_patient_voir_finances dans le miroir serveur`);
  }
});

// Retour d'Esdras (27/08) : "seulement l'intervention, soit accouchement, soit césarienne, soit
// chirurgie, pour savoir ce que la personne a fait en dernier" — jamais un prix, donc jamais
// gardé par fiche_patient_voir_finances (voir le bloc historique juste au-dessus).
test("extraireIntervention() détecte accouchement/césarienne/chirurgie dans les lignes facturées (via leur clé 'sub') et la chirurgie nommée en texte libre (hasChirSpec/nomChirSpec), jamais un prix", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf('const CLES_INTERVENTION'), serverSrc.indexOf('app.get(\'/api/episodes/:id/solde-depot\''));
  assert.match(bloc, /const CLES_INTERVENTION = \['accouchement', 'cesarienne', 'chirurgie'\];/);
  assert.match(bloc, /CLES_INTERVENTION\.includes\(l\.sub\)\)\.map\(l => l\.nom\)/, "doit prendre le nom de l'acte, jamais son prix");
  assert.match(bloc, /state\.hasChirSpec && state\.nomChirSpec/, "doit aussi détecter une chirurgie nommée en texte libre");
  assert.doesNotMatch(bloc, /\.prix\b/, "aucun prix ne doit être lu ici — cette info n'est jamais gardée par fiche_patient_voir_finances");
});

test("GET /api/dossiers/:id/historique inclut intervention par épisode, même sans fiche_patient_voir_finances (jamais une donnée financière)", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("app.get('/api/dossiers/:id/historique'"), serverSrc.indexOf("// ============================================================\n// PIÈCES JOINTES"));
  assert.match(bloc, /const intervention = extraireIntervention\(fiches\);/);
  assert.match(bloc, /return \{ \.\.\.ep, dernierPaiement: \(paiements && paiements\[0\]\) \|\| null, intervention, fichesDetail, \.\.\.calculerSoldeDepot\(paiements\) \};/);
});

// Retour d'Esdras (28/08) : "on voit les actes sans prix" — l'infirmier/archiviste consultant
// Fiche Patient doit voir QUOI a été acheté (médicament/acte, quantité) pour chaque visite, sans
// jamais voir COMBIEN ça a coûté — même philosophie qu'extraireIntervention juste au-dessus.
test("extraireFichesDetail() regroupe les lignes facturées par fiche (avec la date), nom et quantité seulement — jamais le prix", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf('function extraireFichesDetail'), serverSrc.indexOf('function extraireFichesDetail') + 700);
  assert.match(bloc, /actes: \(f\.raw_state\?\.lignesCalcul \|\| \[\]\)\.map\(l => \(\{ nom: l\.nom, qte: l\.qte, type: l\.type \}\)\)/, "ne doit reprendre que nom/qte/type de chaque ligne — jamais l.prix");
  assert.doesNotMatch(bloc, /\bprix\b/, "extraireFichesDetail ne doit jamais toucher au champ prix");
});

test("GET /api/dossiers/:id/historique : la requête sur fiches inclut date_creation (pour grouper fichesDetail par visite) en plus de raw_state", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("app.get('/api/dossiers/:id/historique'"), serverSrc.indexOf("// ============================================================\n// PIÈCES JOINTES"));
  assert.match(bloc, /\.from\('fiches'\)\.select\('raw_state, date_creation'\)\.eq\('episode_id', ep\.id\)/);
  assert.match(bloc, /const fichesDetail = extraireFichesDetail\(fiches\);/);
});

// BUG CRITIQUE trouvé le 27/08 en testant réellement le transfert privé→partenaire (dossier de
// test créé en base, jamais détecté avant par ces tests — des regex sur le code source, jamais une
// exécution réelle) : la contrainte paiements_mode_check n'a JAMAIS inclus 'remboursement_patient'
// (créé le 25/08) — chaque tentative réelle d'utiliser cette fonctionnalité en production aurait
// échoué avec une violation de contrainte. Déjà corrigé directement sur Supabase (apply_migration) ;
// ce test s'assure que le fichier qui documente le correctif (à recoller si la base est recréée
// depuis zéro) reste cohérent avec les modes que server.js utilise réellement.
test("sql/correctif_mode_remboursement_patient.sql documente bien 'remboursement_patient' comme mode autorisé — sans ce correctif (déjà appliqué en base), rembourser-partenaire échoue avec une violation de contrainte", () => {
  const sqlSrc = fs.readFileSync(path.join(__dirname, '..', 'sql', 'correctif_mode_remboursement_patient.sql'), 'utf8');
  assert.match(sqlSrc, /'remboursement_patient'::text/, "le correctif doit ajouter remboursement_patient à la liste des modes autorisés");
  assert.match(serverSrc, /mode: 'remboursement_patient',/, "server.js doit bien utiliser ce mode (sinon ce correctif serait sans objet)");
});

// Retour d'Esdras (27/08) : "je veux créer un rôle pour visiteur, voir mais ne peut rien modifier"
// — ex. le PDG ou sa fille qui veut voir l'app sans avoir accès aux boutons qui annulent/
// suppriment/modifient une vraie donnée. Cette fois-ci, sql/ajoute_role_visiteur.sql (contrainte
// users_role_check) a été corrigé AVANT de coder la fonctionnalité, pas après comme pour
// remboursement_patient — testé en base (insertion réelle) avant d'écrire ce test.
test("sql/ajoute_role_visiteur.sql documente bien 'visiteur' comme rôle autorisé, et le miroir serveur PERMISSIONS_PAR_DEFAUT ne lui accorde que des permissions \"voir\" (jamais dossier_creer, episode_creer, caisse_travailler, ni aucun *_gerer/*_annuler/*_supprimer/*_modifier, ni analytics_voir qui inclut les salaires)", () => {
  const sqlSrc = fs.readFileSync(path.join(__dirname, '..', 'sql', 'ajoute_role_visiteur.sql'), 'utf8');
  assert.match(sqlSrc, /'visiteur'::text/, "le correctif doit ajouter visiteur à la liste des rôles autorisés");

  const bloc = serverSrc.slice(serverSrc.indexOf('const PERMISSIONS_PAR_DEFAUT'), serverSrc.indexOf('async function aPermission'));
  const ligne = bloc.slice(bloc.indexOf("{ role: 'visiteur'"), bloc.indexOf('\n', bloc.indexOf("{ role: 'visiteur'")));
  assert.match(ligne, /'fiche_patient_voir'/);
  assert.match(ligne, /'fiche_patient_voir_finances'/);
  assert.match(ligne, /'direction_voir'/);
  assert.match(ligne, /'rapport_chf_voir'/);
  assert.match(ligne, /'audit_voir'/);
  assert.doesNotMatch(ligne, /'dossier_creer'|'episode_creer'|'caisse_travailler'|'analytics_voir'/, "visiteur ne doit avoir aucune permission d'action, ni analytics_voir (salaires)");
  assert.doesNotMatch(ligne, /_gerer'|_annuler'|_supprimer'|_modifier'/, "visiteur ne doit avoir aucune permission de gestion/annulation/suppression/modification");
});

// Retour d'Esdras (28/08) : "j'ai essayé de mettre test3 comme infirmière en chef, c'est écrit
// erreur" — même bug que visiteur le 27/08 (users_role_check n'autorisait pas le nouveau rôle),
// mais trouvé APRÈS coup cette fois : infirmier_chef avait été ajouté au catalogue de permissions
// sans mettre à jour cette contrainte. sql/ajoute_role_infirmier_chef.sql corrige ça.
test("sql/ajoute_role_infirmier_chef.sql documente bien 'infirmier_chef' comme rôle autorisé, et le miroir serveur PERMISSIONS_PAR_DEFAUT lui accorde exactement les droits d'un infirmier normal plus rapport_chf_voir", () => {
  const sqlSrc = fs.readFileSync(path.join(__dirname, '..', 'sql', 'ajoute_role_infirmier_chef.sql'), 'utf8');
  assert.match(sqlSrc, /'infirmier_chef'::text/, "le correctif doit ajouter infirmier_chef à la liste des rôles autorisés");
  assert.match(sqlSrc, /'infirmier'::text/, "infirmier doit rester dans la liste (pas remplacé par erreur)");

  const bloc = serverSrc.slice(serverSrc.indexOf('const PERMISSIONS_PAR_DEFAUT'), serverSrc.indexOf('async function aPermission'));
  const ligneInfirmier = bloc.slice(bloc.indexOf("{ role: 'infirmier'"), bloc.indexOf('\n', bloc.indexOf("{ role: 'infirmier'")));
  const ligneChef = bloc.slice(bloc.indexOf("{ role: 'infirmier_chef'"), bloc.indexOf('\n', bloc.indexOf("{ role: 'infirmier_chef'")));
  assert.doesNotMatch(ligneInfirmier, /'rapport_chf_voir'/, "infirmier (de ligne) ne doit plus avoir rapport_chf_voir");
  assert.match(ligneChef, /'dossier_creer'/);
  assert.match(ligneChef, /'fiche_patient_voir'/);
  assert.match(ligneChef, /'rapport_chf_voir'/, "infirmier_chef doit avoir rapport_chf_voir, c'est toute la raison de ce rôle");
});

// Faille trouvée le 27/08 (audit de sécurité avant mise en production) : GET /api/paiements
// renvoyait TOUTE la table (montants, modes, motifs de transfert...) à n'importe quel utilisateur
// authentifié, sans vérifier fiche_patient_voir_finances — un archiviste ou infirmier pouvait
// contourner, en appelant directement l'API, la même restriction déjà correctement appliquée sur
// GET /api/dossiers/:id/historique. rapport_chf_voir ne doit JAMAIS suffire ici : infirmier l'a
// aussi, et ne doit justement jamais voir les paiements (seulement son historique clinique).
test("GET /api/paiements exige fiche_patient_voir_finances, caisse_travailler, demandes_repondre ou caisse_voir (jamais rapport_chf_voir seul, qu'infirmier possède aussi)", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("app.get('/api/paiements'"), serverSrc.indexOf("app.post('/api/paiements'"));
  assert.match(bloc, /aPermission\(req\.user\.id, 'fiche_patient_voir_finances'\)/, "doit vérifier fiche_patient_voir_finances");
  assert.match(bloc, /aPermission\(req\.user\.id, 'caisse_travailler'\)/, "doit aussi autoriser caisse_travailler (la caisse doit pouvoir travailler)");
  assert.match(bloc, /aPermission\(req\.user\.id, 'demandes_repondre'\)/, "doit aussi autoriser demandes_repondre (Demandes.js en a besoin)");
  assert.match(bloc, /aPermission\(req\.user\.id, 'caisse_voir'\)/, "doit aussi autoriser caisse_voir (28/08 — Caisse en lecture seule pour visiteur)");
  assert.doesNotMatch(bloc, /'rapport_chf_voir'/, "rapport_chf_voir ne doit jamais suffire seul : infirmier l'a aussi et ne doit pas voir les paiements");
  assert.match(bloc, /res\.status\(403\)/, "doit renvoyer 403 si aucune de ces permissions n'est présente");
});

// Retour d'Esdras (28/08) : la fille du PDG (visiteur) doit pouvoir tout voir sauf modifier — 5
// permissions "_voir" ajoutées (caisse/hospitalisation/stock/catalogue/requisitions), customisables
// par rôle depuis "Rôles & permissions" comme n'importe quelle autre permission (pas un cas spécial
// codé en dur pour visiteur). Ce test vérifie le côté serveur des deux endpoints GET concernés —
// les 3 autres écrans (Hospitalisation, Tarifs Pharma/Actes) n'ont pas de garde serveur dédiée,
// juste des colonnes déjà accessibles à tous les rôles authentifiés.
test("GET /api/requisitions accepte aussi requisitions_voir en plus de stock_gerer/analytics_voir, mais POST /api/requisitions (qui décrémente le vrai stock) reste réservé à stock_gerer seul", () => {
  const blocGet = serverSrc.slice(serverSrc.indexOf("app.get('/api/requisitions'"), serverSrc.indexOf("app.get('/api/requisitions'") + 600);
  assert.match(blocGet, /aPermission\(req\.user\.id, 'stock_gerer'\)/);
  assert.match(blocGet, /aPermission\(req\.user\.id, 'analytics_voir'\)/);
  assert.match(blocGet, /aPermission\(req\.user\.id, 'requisitions_voir'\)/, "doit aussi autoriser requisitions_voir (28/08 — Réquisitions en lecture seule pour visiteur)");

  const blocPost = serverSrc.slice(serverSrc.indexOf("app.post('/api/requisitions'"), serverSrc.indexOf("app.post('/api/requisitions'") + 400);
  assert.match(blocPost, /aPermission\(req\.user\.id, 'stock_gerer'\)/);
  assert.doesNotMatch(blocPost, /requisitions_voir/, "requisitions_voir est un droit de LECTURE seule — ne doit jamais suffire pour créer une réquisition (décrémente le stock réel)");
});

// Correctif sécurité (27/08, audit avant mise en production) : cors() sans options autorisait
// n'importe quel site web à appeler cette API depuis le navigateur d'un utilisateur connecté.
// Restreint à FRONTEND_URL (déjà utilisé pour les liens de réinitialisation de mot de passe) +
// l'URL onrender.com actuelle, en gardant les requêtes sans Origin (curl, health check) autorisées.
test("CORS restreint à l'origine du frontend (FRONTEND_URL), plus l'URL onrender.com actuelle pendant la transition — jamais cors() ouvert à tout le monde", () => {
  assert.doesNotMatch(serverSrc, /app\.use\(cors\(\)\)/, "cors() sans options autorise n'importe quel site web à appeler l'API");
  const bloc = serverSrc.slice(serverSrc.indexOf('const ORIGINE_FRONTEND'), serverSrc.indexOf("app.use(express.json"));
  assert.match(bloc, /process\.env\.FRONTEND_URL \|\| 'https:\/\/chf-app2\.onrender\.com'/, "doit réutiliser FRONTEND_URL, avec repli sur l'URL onrender.com actuelle");
  assert.match(bloc, /if \(!origin \|\|/, "une requête sans en-tête Origin (curl, health check, serveur à serveur) doit rester autorisée");
});

// Retour d'Esdras (29/08) : "call me bot, on va l'activer" — alertes WhatsApp pour 3 événements
// (stock bas franchi, demande d'exonération en attente, sauvegarde automatique échouée). La clé
// API vit UNIQUEMENT dans les variables d'environnement (jamais codée en dur, jamais envoyée au
// navigateur) — l'appel à CallMeBot passe toujours par le serveur.
test("envoyerCallMeBot lit CALLMEBOT_PHONE/CALLMEBOT_APIKEY depuis les variables d'environnement (jamais codées en dur), n'envoie rien si absentes, et ne fait jamais planter l'appelant si l'envoi échoue", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf('async function envoyerCallMeBot'), serverSrc.indexOf('// ============================================================\n// SAUVEGARDE AUTOMATIQUE'));
  assert.match(bloc, /const phone = process\.env\.CALLMEBOT_PHONE;/);
  assert.match(bloc, /const apikey = process\.env\.CALLMEBOT_APIKEY;/);
  assert.match(bloc, /if \(!phone \|\| !apikey\) \{/, "doit se taire proprement si pas configuré, pas planter");
  assert.match(bloc, /catch \(e\) \{\s*\n\s*console\.warn\('CallMeBot : envoi échoué —', e\.message\);\s*\n\s*\}/, "une erreur réseau/API ne doit jamais remonter à l'appelant");
});

test("cron de sauvegarde automatique envoie une alerte CallMeBot en cas d'échec, en plus du log console existant", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf("cron.schedule('0 6 * * *'"), serverSrc.indexOf("app.post('/api/admin/backup-manuel'"));
  assert.match(bloc, /console\.error\('❌ Échec de la sauvegarde automatique :', e\.message\);/, "le log existant doit rester (logs Render toujours utiles)");
  assert.match(bloc, /await envoyerCallMeBot\(`⚠️ CHF : la sauvegarde automatique a échoué/);
});

test("POST /api/stock/decrementer envoie une alerte CallMeBot SEULEMENT quand un article FRANCHIT son seuil (avant > seuil, après <= seuil) — jamais à chaque vente d'un article déjà bas", () => {
  const debut = serverSrc.indexOf("app.post('/api/stock/decrementer'");
  const bloc = serverSrc.slice(debut, debut + 3500);
  assert.match(bloc, /const \{ data: avantData \} = await supabase\.from\('catalog'\)\.select\('items'\)\.eq\('type', 'medicaments'\)\.single\(\);/, "doit lire l'état AVANT le décrément, pas seulement après");
  assert.match(bloc, /\(avant\.seuilAlerte \?\? seuilParDefaut\) < avant\.quantite && apres\.quantite <= \(avant\.seuilAlerte \?\? seuilParDefaut\)/, "doit détecter un franchissement (avant au-dessus, après en-dessous), pas juste 'être bas'");
  assert.match(bloc, /envoyerCallMeBot\(`📦 CHF : stock bas/);
  assert.doesNotMatch(bloc, /await envoyerCallMeBot\(`📦/, "l'alerte stock ne doit pas bloquer la réponse à la caisse (fire-and-forget, pas de await)");
});

test("POST /api/notifications/exoneration-demandee existe, protégée par verifyToken (déclarée après app.use('/api', verifyToken)), et reste best-effort (toujours 200 même si CallMeBot échoue)", () => {
  const indexVerifyToken = serverSrc.indexOf("app.use('/api', verifyToken);");
  const indexRoute = serverSrc.indexOf("app.post('/api/notifications/exoneration-demandee'");
  assert.ok(indexVerifyToken !== -1 && indexRoute !== -1 && indexRoute > indexVerifyToken, "la route doit être déclarée APRÈS app.use('/api', verifyToken) pour être protégée");
  const bloc = serverSrc.slice(indexRoute, indexRoute + 700);
  assert.match(bloc, /envoyerCallMeBot\(`🎯 CHF : demande d'exonération/);
  assert.match(bloc, /res\.json\(\{ success: true \}\); \/\/ best-effort/, "doit toujours répondre 200, ne jamais faire échouer la demande côté écran si l'alerte échoue");
});

// Audit du 31/08 (veille du lancement) : dateEntreePourTri et periodeSejourString sont des
// vestiges de l'époque Firestore — le navigateur les calculait à l'archivage et les envoyait,
// mais aucune colonne d'episodes ne les stocke, ni POST ni PUT ne les écrit, et episodeVersFlat
// ne les renvoyait pas. Tout dossier relu depuis le serveur les recevait donc `undefined`.
// Le plus grave : ArchivesPanel filtre par date via `new Date(v.dateEntreePourTri)` et écarte la
// ligne si la date est invalide → AUCUN dossier ne ressortait dès qu'un filtre de date était posé,
// sur l'écran même qui sert à préparer les factures partenaires.
test("episodeVersFlat renvoie dateEntreePourTri et periodeSejourString, recalculés depuis le raw_state des fiches (aucune colonne ne les stocke)", () => {
  // L'assemblage a été extrait dans assemblerEpisodeFlat le 31/08 (lecture groupée des épisodes) —
  // les vérifications ci-dessous sont inchangées, seul le repère de découpe suit le déplacement.
  const debut = serverSrc.indexOf('function assemblerEpisodeFlat(');
  assert.ok(debut !== -1, "assemblerEpisodeFlat introuvable");
  const bloc = serverSrc.slice(debut, serverSrc.indexOf('\n}', debut));
  assert.match(bloc, /dateEntreePourTri: datesSejour\.length > 0 \? datesSejour\[0\]\.in : '9999-12-31'/, "sans exeat, la valeur doit rester une date VALIDE (convention 9999-12-31 du navigateur) — sinon le filtre de date fait à nouveau disparaître la ligne");
  assert.match(bloc, /periodeSejourString,/, "la colonne 'période de séjour' de l'export Excel partenaire en dépend");
  assert.match(bloc, /const rs = f\.raw_state \|\| \{\};/, "doit lire le raw_state des fiches, seul endroit où les dates de séjour sont réellement persistées");
});

test("episodeVersFlat : le calcul du séjour, exécuté réellement, reproduit la mise en forme du navigateur (une date seule, une période, deux périodes, aucun séjour)", () => {
  const debut = serverSrc.indexOf('const datesSejour = [];');
  const fin = serverSrc.indexOf("\n\n  return {", debut);
  assert.ok(debut !== -1 && fin > debut, "bloc de calcul du séjour introuvable");
  const calcul = serverSrc.slice(debut, fin);
  const executer = new Function('fiches', `${calcul}; return { datesSejour, periodeSejourString };`);

  const aucun = executer([{ raw_state: {} }]);
  assert.strictEqual(aucun.periodeSejourString, '—', "une consultation sans séjour n'affiche pas de période");
  assert.strictEqual(aucun.datesSejour.length, 0);

  const memeJour = executer([{ raw_state: { dateEntree1: '2026-09-01', dateSortie1: '2026-09-01' } }]);
  assert.strictEqual(memeJour.periodeSejourString, '01/09', "entrée et sortie le même jour : une seule date, pas 'du X au X'");

  const periode = executer([{ raw_state: { dateEntree1: '2026-09-01', dateSortie1: '2026-09-04' } }]);
  assert.strictEqual(periode.periodeSejourString, 'du 01/09 au 04/09');
  assert.strictEqual(periode.datesSejour[0].in, '2026-09-01', "dateEntreePourTri doit être la date d'ENTRÉE, au format triable AAAA-MM-JJ");

  const deux = executer([{ raw_state: { dateEntree1: '2026-09-01', dateSortie1: '2026-09-04', multiPeriode: true, dateEntree2: '2026-09-10', dateSortie2: '2026-09-12' } }]);
  assert.strictEqual(deux.periodeSejourString, 'du 01/09 au 04/09 et du 10/09 au 12/09', "un séjour en deux périodes doit apparaître en entier sur la facture partenaire");

  // Une sortie manquante (hospitalisation encore en cours) ne doit pas produire "du 01/09 au undefined".
  const sansSortie = executer([{ raw_state: { dateEntree1: '2026-09-01' } }]);
  assert.strictEqual(sansSortie.periodeSejourString, '01/09');
});

// Audit du 31/08 : 5 tables réellement utilisées par l'application ne figuraient pas dans
// TABLES_A_SAUVEGARDER et n'étaient donc sauvegardées NULLE PART — dont demandes_exoneration,
// la trace de qui a accordé quelle remise et pour quel montant. Personne n'aurait pu s'en rendre
// compte avant d'avoir besoin d'une restauration. Ce test se maintient tout seul : toute nouvelle
// table utilisée par le serveur OU par le navigateur doit être ajoutée à la liste, sinon il casse.
test("Sauvegarde automatique : toute table utilisée par l'app (serveur ou navigateur) figure dans TABLES_A_SAUVEGARDER", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf('const TABLES_A_SAUVEGARDER'), serverSrc.indexOf('async function sauvegarderVersStorage'));
  const sauvegardees = new Set([...bloc.matchAll(/'([a-z_]+)'/g)].map(m => m[1]));

  const utilisees = new Set([...serverSrc.matchAll(/\.from\('([a-z_]+)'\)/g)].map(m => m[1]));
  // Le navigateur parle à certaines tables directement (shim db / client supabase), sans passer
  // par le serveur : elles n'apparaissent donc jamais dans server.js et se faisaient oublier.
  const dossierApp = path.join(__dirname, '..', '..', 'chf-app2');
  for (const sousDossier of ['components', 'app', 'api', 'utils']) {
    const chemin = path.join(dossierApp, sousDossier);
    if (!fs.existsSync(chemin)) continue;
    for (const f of fs.readdirSync(chemin).filter(x => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(chemin, f), 'utf8');
      for (const m of src.matchAll(/(?:db\.collection\('|supabase\.from\(')([a-z_]+)'/g)) utilisees.add(m[1]);
    }
  }
  // 'storage' n'est pas une table (API Storage de Supabase), 'catalog' couvre médicaments/actes/paramètres.
  utilisees.delete('storage');

  const oubliees = [...utilisees].filter(t => !sauvegardees.has(t)).sort();
  assert.deepStrictEqual(oubliees, [], `Table(s) utilisée(s) par l'app mais JAMAIS sauvegardée(s) : ${oubliees.join(', ')} — ajoute-les à TABLES_A_SAUVEGARDER`);
});

test("Sauvegarde automatique : une table illisible ne fait plus échouer la sauvegarde entière, et le trou est signalé", () => {
  const debut = serverSrc.indexOf('async function sauvegarderVersStorage');
  const bloc = serverSrc.slice(debut, serverSrc.indexOf('\n}', serverSrc.indexOf('return { fichier: nomFichier', debut)));
  assert.match(bloc, /tablesEnEchec\.push\(/, "une table illisible doit être collectée, pas interrompre tout le reste");
  assert.doesNotMatch(bloc, /if \(error\) throw new Error\(`Lecture de/, "l'ancien comportement tout-ou-rien ne doit plus exister : une seule table en défaut privait de TOUTE sauvegarde");
  assert.match(bloc, /contenu\._tables_en_echec = tablesEnEchec/, "le trou doit être inscrit dans le fichier de sauvegarde lui-même");
  assert.match(bloc, /throw new Error\(`Aucune table n'a pu être lue/, "si RIEN n'est lisible, il faut quand même échouer franchement");
  const blocCron = serverSrc.slice(serverSrc.indexOf("cron.schedule('0 6 * * *'"), serverSrc.indexOf('// Déclenchement manuel'));
  assert.match(blocCron, /resultat\.tablesEnEchec && resultat\.tablesEnEchec\.length > 0/, "une sauvegarde partielle doit déclencher une alerte WhatsApp, sinon le trou reste invisible des mois");
});

// ============================================================================================
// Lecture groupée des épisodes (31/08) — le risque de montée en charge n°1 de l'audit :
// GET /api/episodes appelait episodeVersFlat sur CHAQUE épisode, soit 3 requêtes Supabase par
// épisode (~9000 requêtes pour 3000 épisodes). Remplacé par episodesVersFlatEnLot, qui lit en lots.
//
// Ces tests EXÉCUTENT réellement le code extrait de server.js (même approche que le test de calcul
// du séjour plus haut), avec un faux client Supabase en mémoire. Ils ne vérifient pas seulement
// que le code "a l'air correct" : ils comparent les DEUX chemins ligne par ligne. C'est le seul
// moyen de garantir qu'un refactor de performance n'a rien changé aux chiffres affichés.
// ============================================================================================

// Extrait les fonctions de conversion + les deux chemins de lecture de server.js, et les exécute
// avec un `supabase` injecté. Le bloc est contigu dans server.js (statutVersFlat -> fin de
// episodesVersFlatEnLot), donc rien n'est recopié ici : c'est le VRAI code qui est testé.
function chargerLecteursEpisodes(supabase) {
  const debut = serverSrc.indexOf('function statutVersFlat(ep) {');
  const marqueurFin = serverSrc.indexOf('async function episodesVersFlatEnLot');
  const fin = serverSrc.indexOf('\n}', serverSrc.indexOf('return episodes.map(ep => {', marqueurFin)) + 2;
  assert.ok(debut !== -1 && marqueurFin > debut && fin > marqueurFin, "bloc de lecture des épisodes introuvable dans server.js");
  const code = serverSrc.slice(debut, fin);
  return new Function('supabase', 'console', `${code}\nreturn { episodeVersFlat, episodesVersFlatEnLot };`)(
    supabase,
    { ...console, error: () => {} }, // les avertissements "dossier introuvable" sont attendus ici
  );
}

// Faux client Supabase : juste assez pour les enchaînements utilisés par les deux chemins
// (.select/.eq/.in/.not/.order/.range/.single, et l'attente directe de la requête).
function faireFauxSupabase(donnees, compteur) {
  return {
    from(table) {
      compteur.requetes++;
      const etat = { eq: [], in: null, notNull: null, order: null };
      const lignes = () => {
        let r = (donnees[table] || []).slice();
        for (const [col, val] of etat.eq) r = r.filter(l => l[col] === val);
        if (etat.in) r = r.filter(l => etat.in.valeurs.includes(l[etat.in.colonne]));
        if (etat.notNull) r = r.filter(l => l[etat.notNull] !== null && l[etat.notNull] !== undefined);
        if (etat.order) r = r.sort((a, b) => String(a[etat.order]).localeCompare(String(b[etat.order])));
        return r;
      };
      const api = {
        select: () => api,
        eq: (col, val) => { etat.eq.push([col, val]); return api; },
        in: (col, valeurs) => {
          // Simule la limite réelle : PostgREST met tous les ids dans l'URL, qui a une longueur
          // maximale. Sans découpage en lots, la requête échouerait en production (414) — ici elle
          // échoue franchement, pour que le test le voie au lieu de passer à côté.
          if (valeurs.length > 200) throw new Error(`URL trop longue : ${valeurs.length} ids dans un seul .in() — le découpage en lots a disparu`);
          etat.in = { colonne: col, valeurs }; return api;
        },
        not: (col) => { etat.notNull = col; return api; },
        order: (col) => { etat.order = col; return api; },
        range: (d, f) => Promise.resolve({ data: lignes().slice(d, f + 1), error: null }),
        single: () => {
          const r = lignes();
          return Promise.resolve(r.length === 1 ? { data: r[0], error: null } : { data: null, error: { message: 'aucune ligne' } });
        },
        then: (ok, ko) => Promise.resolve({ data: lignes(), error: null }).then(ok, ko),
      };
      return api;
    },
  };
}

// Jeu de données couvrant les cas qui cassent typiquement un refactor de ce genre.
function donneesDeTest() {
  const dossiers = [
    { id: 'dos-1', nom: 'Patient Un', numero_dossier: 'D-001', telephone: '3000', adresse: 'Fontaine', date_naissance: '1990-01-01' },
    { id: 'dos-2', nom: 'Patient Deux', numero_dossier: 'D-002', telephone: null, adresse: null, date_naissance: null },
  ];
  const episodes = [
    // Deux épisodes qui PARTAGENT le même dossier — un regroupement naïf par dossier les mélangerait.
    { id: 'ep-1', dossier_id: 'dos-1', type_patient: 'prive', service: 'Urgences', statut: 'ouvert', est_hospitalisation: true, voie_entree: 'consultation', date_ouverture: '2026-08-20T08:00:00Z', lit: 'L1' },
    { id: 'ep-2', dossier_id: 'dos-1', type_patient: 'partenaire', ong_partenaire: 'ALIMA', service: 'Maternité', statut: 'ferme', est_hospitalisation: false, voie_entree: 'vente_comptoir', date_ouverture: '2026-08-21T09:00:00Z' },
    // Épisode SANS aucune fiche : ne doit pas disparaître, et son totalGlobal doit valoir 0.
    { id: 'ep-3', dossier_id: 'dos-2', type_patient: 'prive', service: null, statut: 'ouvert', est_hospitalisation: false, voie_entree: 'consultation', date_ouverture: '2026-08-22T10:00:00Z' },
    // Épisode ORPHELIN (dossier supprimé/illisible) : doit rester présent, sans nom de patient.
    { id: 'ep-4', dossier_id: 'dos-disparu', type_patient: 'prive', statut: 'ouvert', est_hospitalisation: false, voie_entree: 'consultation', date_ouverture: '2026-08-23T11:00:00Z' },
  ];
  const fiches = [
    { id: 'fi-1', episode_id: 'ep-1', numero_fiche: 1, date_creation: '2026-08-20T08:30:00Z', total_global: 1000, breakdown: { service: 1000 }, mode_paiement: 'cash', raw_state: { dateEntree1: '2026-08-20', dateSortie1: '2026-08-22' } },
    { id: 'fi-2', episode_id: 'ep-1', numero_fiche: 2, date_creation: '2026-08-21T08:30:00Z', total_global: 500, breakdown: { med: 500 }, mode_paiement: 'cash', raw_state: {} },
    // Fiche dont le paiement a été ANNULÉ : exclue de totalGlobal, mais marquée paiementAnnule.
    { id: 'fi-3', episode_id: 'ep-2', numero_fiche: 3, date_creation: '2026-08-21T09:30:00Z', total_global: 7000, breakdown: { labo: 7000 }, mode_paiement: 'ong', raw_state: {} },
    { id: 'fi-4', episode_id: 'ep-2', numero_fiche: 4, date_creation: '2026-08-21T10:30:00Z', total_global: 250, breakdown: { med: 250 }, mode_paiement: 'ong', raw_state: {} },
  ];
  const paiements = [
    { id: 'pa-1', episode_id: 'ep-2', fiche_id: 'fi-3', annule: true },
    // Paiement annulé SANS fiche (un dépôt remboursé) : ne doit exclure aucune fiche.
    { id: 'pa-2', episode_id: 'ep-1', fiche_id: null, annule: true },
    // Paiement normal : ne doit rien exclure.
    { id: 'pa-3', episode_id: 'ep-1', fiche_id: 'fi-1', annule: false },
  ];
  return { dossiers, episodes, fiches, paiements };
}

test("Lecture groupée : episodesVersFlatEnLot renvoie EXACTEMENT le même résultat qu'episodeVersFlat appelé un par un (dossier partagé, épisode sans fiche, épisode orphelin, paiement annulé avec et sans fiche)", async () => {
  const donnees = donneesDeTest();
  const compteurUnitaire = { requetes: 0 };
  const compteurGroupe = { requetes: 0 };
  const { episodeVersFlat } = chargerLecteursEpisodes(faireFauxSupabase(donnees, compteurUnitaire));
  const { episodesVersFlatEnLot } = chargerLecteursEpisodes(faireFauxSupabase(donnees, compteurGroupe));

  const attendu = await Promise.all(donnees.episodes.map(episodeVersFlat));
  const obtenu = await episodesVersFlatEnLot(donnees.episodes);

  assert.deepStrictEqual(obtenu, attendu, "les deux chemins doivent produire des objets strictement identiques");

  // Vérifications explicites sur le contenu, pour que le test échoue de façon lisible si les DEUX
  // chemins dérivaient ensemble (une comparaison seule ne le verrait pas).
  const parId = Object.fromEntries(obtenu.map(e => [e.id, e]));
  assert.strictEqual(parId['ep-1'].totalGlobal, 1500, "les 2 fiches non annulées de ep-1 doivent être sommées");
  assert.strictEqual(parId['ep-1'].nomPatient, 'Patient Un');
  assert.strictEqual(parId['ep-1'].periodeSejourString, 'du 20/08 au 22/08');
  assert.strictEqual(parId['ep-1'].fiches.length, 2);
  assert.strictEqual(parId['ep-2'].totalGlobal, 250, "la fiche dont le paiement est annulé (7000) doit être exclue du total");
  assert.strictEqual(parId['ep-2'].fiches.find(f => f.id === 'fi-3').paiementAnnule, true, "la fiche annulée doit rester visible mais marquée");
  assert.strictEqual(parId['ep-2'].fiches.find(f => f.id === 'fi-4').paiementAnnule, false, "l'autre fiche du même épisode ne doit pas être marquée");
  assert.strictEqual(parId['ep-2'].nomPatient, 'Patient Un', "un dossier partagé par 2 épisodes doit être rattaché aux deux");
  assert.strictEqual(parId['ep-3'].totalGlobal, 0, "un épisode sans fiche vaut 0, il ne disparaît pas");
  assert.deepStrictEqual(parId['ep-3'].fiches, []);
  assert.strictEqual(parId['ep-4'].nomPatient, undefined, "un épisode orphelin reste présent, sans nom de patient");

  // Le fond du correctif : beaucoup moins de requêtes, pour un résultat identique.
  assert.ok(compteurGroupe.requetes < compteurUnitaire.requetes,
    `la lecture groupée doit faire moins de requêtes (groupée: ${compteurGroupe.requetes}, unitaire: ${compteurUnitaire.requetes})`);
});

// Le piège qui ferait échouer ce correctif exactement à l'échelle qu'il vise : `.in()` met tous les
// ids dans l'URL (limite de longueur) et PostgREST tronque les réponses trop longues SANS erreur.
// D'où le découpage en lots + la pagination .range(). Ce test le prouve à une échelle qui force les
// deux (plus de 200 épisodes -> plusieurs lots ; plus de 500 fiches -> plusieurs pages).
test("Lecture groupée à l'échelle : aucun épisode ni aucune fiche perdus au-delà des tailles de lot et de page (le piège du plafond silencieux de PostgREST)", async () => {
  const NB_EPISODES = 250; // > TAILLE_LOT_IDS (200) -> force le découpage des ids
  const dossiers = [];
  const episodes = [];
  const fiches = [];
  for (let i = 0; i < NB_EPISODES; i++) {
    dossiers.push({ id: `dos-${i}`, nom: `Patient ${i}`, numero_dossier: `D-${i}` });
    episodes.push({ id: `ep-${i}`, dossier_id: `dos-${i}`, type_patient: 'prive', statut: 'ouvert', est_hospitalisation: false, voie_entree: 'consultation', date_ouverture: '2026-08-20T08:00:00Z' });
    // 4 fiches par épisode : le PREMIER lot (200 épisodes) porte donc 800 fiches, au-delà de
    // TAILLE_PAGE_LECTURE (500) — c'est ce qui force réellement une 2e page à l'intérieur d'un
    // même lot. Avec seulement 2 fiches par épisode, le découpage suffisait à rester sous la
    // taille de page et la pagination n'était jamais exercée (piège vérifié : retirer la
    // pagination ne faisait alors échouer aucun test).
    for (let n = 1; n <= 4; n++) {
      fiches.push({ id: `fi-${i}-${n}`, episode_id: `ep-${i}`, numero_fiche: n, date_creation: `2026-08-20T0${n}:00:00Z`, total_global: 100, breakdown: {}, raw_state: {} });
    }
  }
  const donnees = { dossiers, episodes, fiches, paiements: [] };
  const { episodesVersFlatEnLot } = chargerLecteursEpisodes(faireFauxSupabase(donnees, { requetes: 0 }));

  const obtenu = await episodesVersFlatEnLot(episodes);

  assert.strictEqual(obtenu.length, NB_EPISODES, "aucun épisode ne doit se perdre au-delà de la taille d'un lot d'ids");
  assert.ok(obtenu.every(e => e.fiches.length === 4), "chaque épisode doit retrouver SES 4 fiches, malgré la pagination des lectures");
  assert.ok(obtenu.every(e => e.totalGlobal === 400), "un total faux signalerait des fiches perdues ou mal rattachées");
  assert.ok(obtenu.every(e => e.nomPatient === `Patient ${e.id.slice(3)}`), "chaque épisode doit être rattaché à SON dossier, pas à celui d'un autre lot");
  assert.deepStrictEqual(obtenu[0].fiches.map(f => f.numeroFiche), [1, 2, 3, 4], "l'ordre des fiches (date_creation) doit être préservé après regroupement");
});

// Suite du correctif de lecture groupée : la pagination doit rester correcte même si Supabase
// plafonne les réponses PLUS BAS que la taille de page demandée. Une première version s'arrêtait
// dès qu'une page revenait "incomplète" — avec un plafond serveur à 100 lignes pour 500 demandées,
// elle aurait pris la 1re page pour la dernière et perdu tout le reste SANS ERREUR, exactement le
// piège que ce correctif est censé fermer.
test("Lecture groupée : aucune ligne perdue même si le serveur plafonne les réponses plus bas que la taille de page demandée", async () => {
  const PLAFOND_SERVEUR = 100; // très en dessous de TAILLE_PAGE_LECTURE (500)
  const NB_EPISODES = 120;
  const dossiers = [], episodes = [], fiches = [];
  for (let i = 0; i < NB_EPISODES; i++) {
    dossiers.push({ id: `dos-${i}`, nom: `Patient ${i}` });
    episodes.push({ id: `ep-${i}`, dossier_id: `dos-${i}`, type_patient: 'prive', statut: 'ouvert', est_hospitalisation: false, voie_entree: 'consultation', date_ouverture: '2026-08-20T08:00:00Z' });
    fiches.push({ id: `fi-${i}`, episode_id: `ep-${i}`, numero_fiche: 1, date_creation: '2026-08-20T08:00:00Z', total_global: 70, breakdown: {}, raw_state: {} });
  }
  const donnees = { dossiers, episodes, fiches, paiements: [] };

  // Faux client identique au précédent, SAUF que .range() ne renvoie jamais plus de PLAFOND_SERVEUR
  // lignes, quelle que soit la fenêtre demandée — comme le ferait un PostgREST configuré ainsi.
  const supabasePlafonne = {
    from(table) {
      const etat = { in: null, notNull: null };
      const lignes = () => {
        let r = (donnees[table] || []).slice();
        if (etat.in) r = r.filter(l => etat.in.valeurs.includes(l[etat.in.colonne]));
        if (etat.notNull) r = r.filter(l => l[etat.notNull] != null);
        return r;
      };
      const api = {
        select: () => api, eq: () => api, not: (c) => { etat.notNull = c; return api; }, order: () => api,
        in: (col, valeurs) => { etat.in = { colonne: col, valeurs }; return api; },
        range: (d, f) => Promise.resolve({ data: lignes().slice(d, Math.min(f + 1, d + PLAFOND_SERVEUR)), error: null }),
      };
      return api;
    },
  };
  const { episodesVersFlatEnLot } = chargerLecteursEpisodes(supabasePlafonne);

  const obtenu = await episodesVersFlatEnLot(episodes);
  assert.strictEqual(obtenu.length, NB_EPISODES);
  assert.ok(obtenu.every(e => e.nomPatient === `Patient ${e.id.slice(3)}`), "tous les dossiers doivent être lus, malgré le plafond serveur");
  assert.ok(obtenu.every(e => e.fiches.length === 1), "toutes les fiches doivent être lues, malgré le plafond serveur");
  assert.ok(obtenu.every(e => e.totalGlobal === 70), "un total à 0 signalerait des fiches perdues par une pagination arrêtée trop tôt");
});

// Suite du 31/08 : les DEUX requêtes d'entrée des routes de liste (episodes, paiements) n'étaient
// pas paginées. Un plafond de lignes côté Supabase les aurait tronquées SANS erreur — les épisodes
// et paiements les plus anciens auraient disparu des rapports, un manque d'argent invisible.
// Le reste du correctif n'y changeait rien : tout part de ces deux lectures.
test("Routes de liste : /api/episodes et /api/paiements lisent TOUTES les pages (jamais une seule réponse potentiellement tronquée)", () => {
  const blocEpisodes = serverSrc.slice(serverSrc.indexOf("app.get('/api/episodes'"), serverSrc.indexOf("app.post('/api/episodes'"));
  assert.match(blocEpisodes, /lireToutesLesPages\(/, "la liste des épisodes doit être lue page par page");
  assert.doesNotMatch(blocEpisodes, /await supabase\.from\('episodes'\)\.select\('\*'\)\.order\([^)]*\);/,
    "l'ancienne lecture en une seule requête non paginée ne doit plus exister");

  const blocPaiements = serverSrc.slice(serverSrc.indexOf("app.get('/api/paiements'"), serverSrc.indexOf("app.post('/api/paiements'"));
  assert.match(blocPaiements, /lireToutesLesPages\(/, "la liste des paiements doit être lue page par page");
});

// Une lecture paginée sans tri TOTAL est un piège classique : deux lignes de même valeur peuvent
// changer de place d'une page à l'autre, ce qui duplique une ligne et en saute une autre, sans
// erreur. D'où le `.order('id')` final sur chaque requête paginée.
test("Toute lecture paginée a un tri total (.order('id') en dernier) — sinon une ligne peut être dupliquée et une autre sautée entre deux pages", () => {
  const blocLot = serverSrc.slice(serverSrc.indexOf('async function episodesVersFlatEnLot'), serverSrc.indexOf('const dossierParId'));
  for (const table of ['dossiers', 'fiches', 'paiements']) {
    const ligne = blocLot.split('\n').find(l => l.includes(`.from('${table}')`));
    assert.ok(ligne, `requête sur ${table} introuvable dans la lecture groupée`);
    assert.match(ligne, /\.order\('id'\)\s*\)?,?\s*$/, `la lecture de ${table} doit se terminer par .order('id') : elle est paginée, son tri doit être total`);
  }
  const blocEpisodes = serverSrc.slice(serverSrc.indexOf("app.get('/api/episodes'"), serverSrc.indexOf("app.post('/api/episodes'"));
  assert.match(blocEpisodes, /\.order\('date_ouverture', \{ ascending: false \}\)\.order\('id'\)/, "la liste des épisodes est paginée : son tri doit être total");
  const blocPaiements = serverSrc.slice(serverSrc.indexOf("app.get('/api/paiements'"), serverSrc.indexOf("app.post('/api/paiements'"));
  assert.match(blocPaiements, /\.order\('date_paiement', \{ ascending: false \}\)\.order\('id'\)/, "la liste des paiements est paginée : son tri doit être total");
});

// Une seule implémentation de la pagination, appelée partout : c'est ce qui garantit qu'on ne
// corrigera pas un jour la lecture des épisodes en oubliant celle des paiements (ou l'inverse).
test("Une seule implémentation de la pagination (lireToutesLesPages), réutilisée par la lecture par lots d'ids", () => {
  assert.strictEqual((serverSrc.match(/async function lireToutesLesPages/g) || []).length, 1, "la pagination ne doit exister qu'à un seul endroit");
  const blocLots = serverSrc.slice(serverSrc.indexOf('async function lireParLotsDIds'), serverSrc.indexOf('async function episodesVersFlatEnLot'));
  assert.match(blocLots, /lireToutesLesPages\(\(\) => construireRequete\(lot\)\)/, "la lecture par lots doit réutiliser lireToutesLesPages, jamais recopier sa boucle");
  assert.doesNotMatch(blocLots, /\.range\(/, "plus aucune boucle de pagination dupliquée dans lireParLotsDIds");
});

// Audit du 31/08 : /api/episodes/:id/solde-depot renvoie un solde de dépôt — une donnée
// FINANCIÈRE. La même information servie par /api/dossiers/:id/historique est filtrée sur
// 'fiche_patient_voir_finances', permission volontairement refusée à archiviste et infirmier (ils
// consultent le dossier pour son historique clinique, pas ses montants). Cette route-ci n'avait
// aucun contrôle : la donnée restait accessible par un autre chemin, ce qui vide le filtrage de
// l'autre route de son sens. Aucun appelant côté navigateur (chf.getSoldeDepot n'est utilisé
// nulle part), donc le correctif ne peut rien casser.
// NB : les autres routes GET sans aPermission (dossiers, pièces jointes, fiches...) sont un choix
// ASSUMÉ et testé plus haut — lecture ouverte à tout compte connecté, écriture protégée. Ne pas
// les "corriger" : seules les données financières sont filtrées, et c'est cohérent.
test("GET /api/episodes/:id/solde-depot exige fiche_patient_voir_finances — même règle que l'historique, qui sert la même donnée", () => {
  const bloc = blocRoutePermission("app.get('/api/episodes/:id/solde-depot'", "app.get('/api/dossiers/recherche'");
  assert.match(bloc, /aPermission\(req\.user\.id, 'fiche_patient_voir_finances'\)/, "un solde de dépôt est une donnée financière, filtrée comme telle ailleurs");
  // La route financière voisine doit garder le même filtrage, sinon l'incohérence revient.
  const blocHisto = serverSrc.slice(serverSrc.indexOf("app.get('/api/dossiers/:id/historique'"));
  assert.match(blocHisto.slice(0, 2500), /aPermission\(req\.user\.id, 'fiche_patient_voir_finances'\)/, "l'historique doit continuer de filtrer les montants côté serveur");
});

// ⚠️ Correctif sécurité (audit du 31/08). Un compte DÉSACTIVÉ ou dont l'accès a EXPIRÉ n'était
// refusé que côté navigateur (chargerProfil, api/firebase.js). Le serveur ne regardait que le
// rôle : verifyToken valide le jeton Firebase — donc l'identité — jamais le statut du compte.
// Donc une personne renvoyée dont on venait de désactiver le compte continuait de travailler tant
// qu'elle ne rechargeait pas sa page, et un jeton encore valide (il se renouvelle seul) permettait
// d'appeler l'API directement. C'est pourtant LE mécanisme utilisé pour couper un accès.
test("aPermission refuse un compte désactivé ou expiré, à chaque requête et avant le raccourci administrateur", () => {
  const bloc = serverSrc.slice(serverSrc.indexOf('async function aPermission'), serverSrc.indexOf('// Correctif sécurité (27/08'));
  assert.match(bloc, /\.select\('role, active, date_expiration'\)/, "les 3 champs doivent être lus, pas seulement le rôle");
  assert.match(bloc, /if \(profil\.active === false\) return false;/, "un compte désactivé doit être refusé");
  assert.match(bloc, /if \(profil\.date_expiration && new Date\(profil\.date_expiration\) < new Date\(\)\) return false;/, "un accès expiré doit être refusé");
  // Doit passer AVANT le raccourci administrateur, sinon un administrateur désactivé reste tout-puissant.
  assert.ok(bloc.indexOf('profil.active === false') < bloc.indexOf("profil.role === 'administrateur'"), "le contrôle doit précéder le raccourci administrateur");
  // active NULL/absent = actif : ne jamais bloquer un compte qui n'a pas encore ce champ.
  assert.doesNotMatch(bloc, /if \(!profil\.active\) return false;/, "active absent/NULL doit rester ACTIF (mêmes règles que le navigateur), sinon on verrouille tout le monde");
});
