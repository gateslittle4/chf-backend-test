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
  assert.match(blocCatalog.slice(0, 1800), /\.upsert\(/, "PUT /api/catalog doit utiliser upsert, pas update seul");
});

test("POST /api/paiements en mode remboursement_credit relit le solde en base — n'accepte jamais tel quel le solde_restant envoyé par le navigateur", () => {
  const blocPaiements = serverSrc.slice(serverSrc.indexOf("app.post('/api/paiements'"), serverSrc.indexOf("app.patch('/api/paiements/:id/annuler'"));
  assert.match(blocPaiements, /mode\s*===\s*['"]remboursement_credit['"]/, "la route doit détecter mode === 'remboursement_credit'");
  assert.match(blocPaiements, /\.from\('paiements'\)\.select\('solde_restant'\)/, "doit relire solde_restant depuis la table, pas depuis req.body");
  assert.match(blocPaiements, /montant\s*>\s*soldeActuel/, "doit refuser un montant supérieur au solde réel");
  assert.match(blocPaiements, /corps\.solde_restant\s*=\s*soldeActuel\s*-\s*montant/, "le nouveau solde_restant doit être calculé côté serveur, pas repris de req.body");
});

test("episodeVersFlat expose est_hospitalisation — sinon l'onglet Hospitalisation et le taux d'occupation Direction ne peuvent pas savoir qui est hospitalisé", () => {
  const blocFlat = serverSrc.slice(serverSrc.indexOf('function episodeVersFlat'), serverSrc.indexOf("app.get('/api/episodes'"));
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
  assert.match(blocRoute, /const \{ episode_id, numero_fiche, cree_par, cree_par_uid,/, "doit lire cree_par_uid depuis req.body");
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
  assert.match(blocRoute, /const \{ episode_id, numero_fiche, cree_par, cree_par_uid, raw_state, local_id, total_global, breakdown, mode_paiement \}/, "doit lire total_global, breakdown et mode_paiement depuis req.body");
  assert.match(blocRoute, /total_global: total_global \|\| 0/, "doit insérer total_global");
  assert.match(blocRoute, /breakdown: breakdown \|\| \{\}/, "doit insérer breakdown");
  assert.match(blocRoute, /mode_paiement: mode_paiement \|\| null/, "doit insérer mode_paiement");
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

test("PERMISSIONS_PAR_DEFAUT (repli backend si le catalogue Supabase est vide) inclut sauvegarde_gerer pour administrateur — sinon ce repli divergeait silencieusement de utils/permissions.js (front), qui l'a déjà", () => {
  const blocDefaut = serverSrc.slice(serverSrc.indexOf('const PERMISSIONS_PAR_DEFAUT'), serverSrc.indexOf("role: 'direction'"));
  assert.match(blocDefaut, /'sauvegarde_gerer'/, "administrateur doit avoir sauvegarde_gerer dans le repli par défaut");
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
