# 💯 CONTRÔLE DES MONTANTS (13/10, liste de contrôle fintech montrée par Esdras : « montants négatifs, énormes, illisibles »)
- **Avant** : `POST /api/paiements` enregistrait le montant tel quel (seul le remboursement de crédit était contrôlé) ; la base n'avait aucune contrainte sur `montant`. Un appel direct avec un jeton valide pouvait envoyer −500, « abc », Infinity ou 1e15.
- **Maintenant** (`utils/validationMontant.js`, appelé dans la route juste après `appliquerHeureAuPaiement`, AVANT le paiement partiel et le calcul du solde) : 400 avec un message clair si le montant est absent, négatif, illisible (texte non numérique, `1e3`, `0x10`, virgule), infini, ou > 100 000 000 Gdes ; un dépôt ou un remboursement doit être > 0 ; `solde_restant`, s'il est fourni, doit être un nombre raisonnable. Le montant est arrondi au centime (colonne `numeric(12,2)`). **0 reste valide** (vente à crédit, exonération à 100 %, fiche payée entièrement par dépôt).
- **Double verrou** : `sql/controles_montants.sql` ajoute `paiements_montant_borne CHECK (montant >= 0 AND montant <= 100000000)` (testé sur Postgres jetable : `python3 scripts/test-controles-montants-sql.py`). **À coller dans Supabase** (121 paiements existants au 13/10, tous conformes ; sans DROP/REVOKE). Le serveur marche sans lui.
- Tests : `tests/validation_montant.test.js` (7, 4 sabotages détectés). Non couvert : `fiches.total_global` et les autres tables d'argent n'ont pas encore ce contrôle.

---

# 🕐 HEURE RÉELLE DES PAIEMENTS (13/10, Esdras : « l'heure du paiement doit être l'heure réelle, pas celle de l'ordi, on peut dérégler l'ordi »)
- **Avant** : l'app envoyait `date_paiement = new Date()` du navigateur et `POST /api/paiements` l'enregistrait telle quelle → un PC déréglé rangeait le paiement dans le mauvais poste de caisse / jour. (Les autres routes qui créent un paiement — remboursements — utilisaient déjà `maintenant` côté serveur.)
- **Maintenant** (`utils/heureServeur.js`, `appliquerHeureAuPaiement` appelé juste après `const corps = { ...req.body }`) : requête **en direct** → `date_paiement` = heure du SERVEUR, toujours ; un écart > 2 min avec l'heure annoncée par l'ordinateur est gardé dans `details` (`heure_appareil`, `decalage_appareil_s`) pour repérer le poste déréglé. **Rejeu hors ligne** (en-tête `X-CHF-Rejeu: 1` posé par `syncPending` côté app) → l'heure CORRIGÉE de l'app est gardée (le paiement a eu lieu avant ; corrigée avec le dernier calage sur le serveur, voir chf-app2 `utils/heureReelle.js`), jamais dans le futur, `details.heure_hors_ligne = true`.
- **Chaque réponse** porte `X-CHF-Heure` (millisecondes) — middleware `middlewareHeureServeur` avant `express.json`, et `exposedHeaders: ['X-CHF-Heure']` dans CORS (sans cela le navigateur ne peut pas le lire). L'app s'en sert pour caler son horloge.
- **Journal d'audit** : l'app l'écrit directement (date du navigateur). `sql/heure_reelle_audit.sql` pose un déclencheur `BEFORE INSERT` qui force `date = now()` (testé sur Postgres jetable : `python3 scripts/test-heure-reelle-audit-sql.py`). **À coller dans Supabase** (sans DROP/REVOKE). Tant qu'il ne l'est pas, les dates d'audit restent celles de l'ordinateur.
- Tests : `tests/heure_serveur.test.js` (9). Déployer le SERVEUR d'abord : une ancienne app sans en-tête de rejeu est traitée « en direct » (heure du serveur, c'est le comportement voulu).

---

# 🔌 POST /api/dossiers : MÊME NUMÉRO + MÊME NOM = MÊME PATIENT (09/10) — côté serveur

> **⚠️ CHANGEMENT DU 13/10 (Esdras : « une notification pour réunir ou non, pas une réunion automatique ») — remplace le point (2) ci-dessous :** même numéro ET même nom → **409 `error: 'PATIENT_DEJA_ENREGISTRE'`** avec `message` et `dossierExistant {id, numero_dossier, nom, date_naissance, telephone}` ; rien n'est créé ni journalisé. Seule la même création avec **`reunir: true`** (strictement le booléen `true`, jamais une chaîne ni 1) renvoie le 200 `dejaEnregistre: true` + l'audit `dossier_deja_enregistre` (`details.confirme: true`). Un nom différent reste le 409 habituel même avec `reunir: true`. Le champ `reunir` n'est jamais écrit en base. Tests : `tests/dossier_meme_patient.test.js` (15). Déploiement : serveur d'abord ; une ancienne app qui reçoit ce 409 l'affiche comme une erreur ordinaire (pas de réunion).

Détail et contexte (question d'Esdras « quand le net est tombé, plus de connexion entre les deux ordinateurs ») : section « 🔌 COUPURE D'INTERNET : LA PORTE ET LA
CAISSE » des notes de chf-app2. Ici :
- **`utils/dossiers.js`** : `jetonsDuNom` (sans accent, casse, ponctuation, ordre des mots) et `memePatient(dossierExistant, nomRecu)` (compare aussi `nom_origine`, jamais vrai
  pour un nom vide). À n'utiliser QUE pour un dossier qui porte déjà le MÊME numéro.
- **`POST /api/dossiers`**, branche 23505 : (1) rejeu du même `local_id` → 200 comme avant ; (2) NOUVEAU : dossier existant de même numéro ET même nom → **200 avec ce dossier +
  `dejaEnregistre: true`** et une ligne `audit_log` `dossier_deja_enregistre` (best-effort : un journal qui refuse la ligne ne bloque pas la caisse) ; (3) sinon 409, dont le message
  donne maintenant le nom du dossier en place. **`PUT /api/dossiers/:id` (changer un numéro) est inchangé** : jamais de réunion silencieuse là (un test le vérifie).
- Pourquoi : deux postes hors ligne créent le même patient ; le 2e dossier envoyé était refusé et `syncPending` (app) abandonnait en cascade épisode, fiche et PAIEMENT.
  `syncPending` lit `result.id` quel que soit le code HTTP : un 200 sur le dossier existant suffit à tout rattacher.
- Tests : `tests/dossier_meme_patient.test.js` (14, exécute la vraie route extraite de `server.js` contre un faux Supabase) ; côté app, le test Chrome réel à deux ordinateurs
  (`tests/e2e/dossier_meme_patient.e2e.test.js`) lit CE `server.js`.

---

# 🧩 RÔLES CRÉÉS DEPUIS L'APP (09/10) — côté serveur

Détail complet, décisions et pièges : section « 🧩 RÔLES CRÉÉS DEPUIS L'APP » des notes de chf-app2. Ici, ce qu'il faut savoir en lisant ce dépôt :
- **`utils/roles.js`** est la SEULE barrière (l'écran n'est qu'un confort) : `verifierTablePermissions` (validation + normalisation de la table envoyée à
  `PUT /api/catalog/permissions`, calcul de ce qui est créé / supprimé / renommé / modifié), `appliquerMiseAJourPermissions` (lecture de l'ancienne table → vérif
  → refus de supprimer un rôle encore attribué (409) → garde « la base accepte-t-elle les rôles créés ? » à la CRÉATION seulement → écriture → audit
  `creation_role` / `suppression_role` / `renommage_role` / `modification_droits_role`), `verifierRoleInvitation` (création d'un lien), `verifierRoleDuLienOuvert`
  (lien déjà émis dont le rôle a été supprimé), `etatBasePourRolesPersonnalises` (appelle la fonction SQL `roles_personnalises_actifs()`).
- `server.js` ne fait que câbler : `PUT /api/catalog/:type` (cas `permissions`), `POST /api/admin/invitations`, `GET /api/admin/roles-personnalises/pret`
  (droit `utilisateurs_gerer`), `GET /invitation/:token` (renvoie `role_libelle`), acceptation d'un lien (refus de la base ⇒ compte Firebase orphelin supprimé,
  lien relâché, message à la personne invitée). Un rôle créé n'est JAMAIS administrateur (sa clé ne peut pas être celle d'un rôle du code).
- **`sql/roles_personnalises.sql`** — à coller UNE fois par Esdras (**pas encore appliqué** au 09/10) : fonction de garde-fou + contrôle de FORMAT
  de `users_role_check` à la place de la liste fixe + `NOTIFY pgrst`. Les 5 `sql/ajoute_role_*.sql` sont OBSOLÈTES (bandeau, test) : ne plus en écrire.
  Test sur un Postgres 16 jetable : `python3 scripts/test-roles-personnalises-sql.py` (à relancer si le SQL ou `CLE_ROLE` change).
- Tests : `tests/roles_personnalises.test.js` (253 tests au total dans ce dépôt), dont le SQL comparé à `CLE_ROLE` sur des centaines d'exemples. `tests/regressions.test.js`
  a deux tests adaptés (invitations, upsert du catalogue).
- Ajouter un rôle livré avec le code (comme `pharmacien_chef`) : entrée dans `PERMISSIONS_PAR_DEFAUT` + `ROLES_INVITABLES` + `LIBELLES_INTEGRES` (utils/roles.js) ;
  plus de SQL. Un test échoue si `LIBELLES_INTEGRES` ne couvre pas exactement les rôles du code.

---

# ✅ IDEMPOTENCE EN PRODUCTION (30/09)

`utils/idempotence.js` (en-tête Idempotency-Key) + fusion de main : PR #10 fusionnée le 30/09
(`main` = a65865c), déployée sur Render AVANT l'app (PR #25 de chf-app2). Table
`requetes_idempotentes` vérifiée en base (vide, normal). Si elle manquait, le middleware laisse
passer (code 42P01) : pas de panne, juste pas de protection contre les rejeux.
Tests : 197/197 sur des fichiers en LF ; dans le dossier Windows (CRLF, `core.autocrlf=true`)
6 tests échouent car ils cherchent des `\n` littéraux — pas une régression.
Détails et pièges du commit : NOTES_POUR_PROCHAIN_CLAUDE.md de chf-app2 (section du 30/09).

# 🔓 POSTE DE CAISSE OUVERT HORS LIGNE : REJEU IDEMPOTENT (28/09)

`POST /api/catalog/:type/item` : si `item.id` existe déjà dans ce catalogue → 200
`{ success, item, dejaEnregistre: true }`, sans appeler `ajouter_article_catalogue` (qui ajoute
sans regarder). Motif : l'app met maintenant en file l'ouverture d'un poste de caisse faite hors
ligne (voir la note du même jour dans chf-app2) ; une file peut rejouer une opération (réponse
perdue, synchro interrompue) → postes en double. 200 et non 409 : un 4xx classerait le rejeu en
"échec définitif" côté app. Test qui exécute la vraie route contre un faux Supabase (échoue sans
le correctif). 188/0.

---

# 🧪 AUDIT HORS LIGNE AVANT LE 1er OCTOBRE (28/09, 2e session)

Détail dans les notes de chf-app2 (entrée du même nom). Côté serveur :
- Fusion de `claude/corbeille-sauvegarde-avant-prod` (25/09), jamais arrivée dans main : sauvegarde
  paginée (tronquée à 1000 lignes avant !), corbeille exclue des lectures, restauration sans URL géante.
- `GET /api/dossiers/liste-hors-ligne` : liste réduite des patients, recopiée par chaque appareil
  pour la recherche hors ligne. Déclarée AVANT `/api/dossiers/:id`.
- `GET /api/dossiers/:id/solde` : permission `fiche_patient_voir_finances` exigée, corbeille exclue.

Tests : 187, 0 échec.

---

# 📌 POINT DE REPRISE — état au 28/09

Tout est commité, fusionné et en ligne. **Lire d'abord le point de reprise en tête des notes de
`chf-app2`** : décisions en attente d'Esdras, et la contrainte n°1 du projet depuis le 28/09 —
l'internet de l'hôpital tombe ~90% de la journée, tout doit fonctionner hors ligne d'abord.

Côté serveur, ce que ça implique : toute nouvelle route de CRÉATION doit accepter un `local_id` et
dédoublonner dessus (un test recense toutes les routes et échoue sinon) — la file d'attente hors
ligne du navigateur rejoue les opérations au retour du réseau, parfois plusieurs fois. Et toute
lecture (GET) est désormais copiée côté navigateur et resservie hors ligne : une route qui renvoie
une donnée servant à DÉCIDER (anti-doublon, contrôle d'accès) doit être signalée côté app avec
`sansCopieLocale` (voir `api/supabase.js`, `request()`).

Tests : `npm test` → 175, 0 échec.

---

# ✅ AUDIT AVANT MISE EN PRODUCTION DU 1er OCTOBRE (25/09)

Retour d'Esdras : *"vérifie s'il n'y a pas d'erreur ou de bug, fais un test complet de l'app avant
la production"*. `server.js` relu en entier ; 2 familles de bugs corrigées.

**1. Sauvegarde automatique tronquée à 1000 lignes par table, en silence.**
`sauvegarderVersStorage()` lisait chaque table d'un seul `select('*')` — le plafond de lignes de
Supabase (1000) coupe la réponse SANS erreur. Au 25/09 : `audit_log` = 476 lignes, donc aucune
sauvegarde encore amputée, mais ça serait arrivé dans les premiers jours d'usage réel. Passe
maintenant par `lireToutesLesPages`, trié sur la vraie clé primaire (`CLE_PRIMAIRE_SAUVEGARDE` :
`catalog`→`type`, `invitations`→`token`, `decrements_stock_appliques`→`local_id`, sinon `id` —
recoupé dans `information_schema` le 25/09). Test qui EXÉCUTE la fonction contre une fausse base
plafonnée à 1000 lignes (2500 lignes attendues dans le fichier).

**2. Lectures qui ignoraient la corbeille (`supprime_le`)**, oubliées lors du branchement de la
phase 2 le 12/09 :
- **Solde de crédit** (`lireSoldeEpisode`, POST /api/paiements) : le paiement d'une fiche à crédit
  mise à la corbeille restait la référence du solde → la dette supprimée restait due et se
  reportait sur chaque nouveau paiement. Idem solde de dépôt, `/api/dossiers/:id/solde` (État de
  compte), historique Fiche Patient, et les 2 routes de transfert partenaire.
- **Épisodes « ouverts »** (création d'épisode, `/episodes-ouverts`, lits occupés) : une
  hospitalisation supprimée bloquait toute nouvelle hospitalisation du patient pendant 30 jours
  (`BLOCAGE_HOSPITALISATION`, sans contournement).
- **Portail patient** : montrait au patient des visites/fiches supprimées.

Règle à retenir : **toute nouvelle lecture d'`episodes`, `fiches` ou `paiements` doit filtrer
`.is('supprime_le', null)`** — sauf les recherches d'idempotence par `local_id` (un rejeu doit
retrouver la ligne même supprimée) et les routes de corbeille elles-mêmes. Des tests verrouillent
les lectures de paiements « non annulés » et les recherches d'épisodes « ouverts ».

La corbeille était vide en production au 25/09 : aucune donnée à rattraper.

**3. Restauration de sauvegarde bloquée au-delà de quelques centaines de lignes.**
`restaurerDepuisSauvegarde()` cherchait les lignes déjà en base avec `.in(colonneId, lot)` par lots
de 500 ids — tous DANS l'URL (~19 ko pour 500 UUID), au-delà de la limite de PostgREST : la
restauration d'une table un peu remplie échouait en bloc, le jour même où on en aurait eu besoin.
Lit maintenant toute la colonne clé page par page (`lireToutesLesPages`), sans aucun id dans
l'URL. Même famille corrigée dans `GET /api/episodes/corbeille` (lots de 200 via
`lireParLotsDIds`) et `GET /api/requisitions` (paginée).

Règle à retenir : **jamais de `.in()` sur une liste d'ids dont la taille n'est pas bornée** —
passer par `lireParLotsDIds`. **Jamais de liste complète sans `lireToutesLesPages`.**

Tests : 10 ajoutés (185 au total, 0 échec), vérifiés en échec sur l'ancien `server.js` — dont 2
qui EXÉCUTENT la sauvegarde et la restauration contre une fausse base qui applique, comme la
vraie, le plafond de 1000 lignes et la limite de longueur d'URL.

**⚠️ Sur un PC Windows** : Git (`core.autocrlf=true`) convertit les fichiers en CRLF, et 6 tests
qui lisent le source avec des regex échouent alors à tort. Lancer les tests sur une copie en LF
(`git -c core.autocrlf=false clone ...`) avant de conclure à une régression.

---

# ✅ RATTRAPAGE DE SAUVEGARDE AU RÉVEIL DU SERVEUR (25/09)

**Constat qui a déclenché ce chantier** : en listant le bucket `sauvegardes-automatiques` le
25/09, une seule sauvegarde automatique réelle depuis le 2 septembre — toutes les autres dataient
d'un clic manuel d'Esdras. Le minuteur `cron.schedule('0 6 * * *')` existait bien, mais :

- le service tourne sur le **plan gratuit** de Render, qui éteint le processus après ~15 min sans
  visite ;
- le minuteur vit *dans* ce processus — quand il s'éteint, le minuteur meurt avec lui ;
- 6h UTC, c'est 1h-2h du matin en Haïti : précisément l'heure où personne n'utilise l'app, donc où
  le serveur est **garanti éteint**.

**Correctif** : la logique de sauvegarde (autrefois écrite directement dans le corps du
`cron.schedule`) est extraite dans `executerSauvegardeQuotidienne(origine)` — le paramètre `origine`
sert uniquement à distinguer les deux appelants dans les logs Render. Les deux appelants :

1. `cron.schedule('0 6 * * *', () => executerSauvegardeQuotidienne('minuteur 6h UTC'))` — inchangé
   dans son intention, mais ne se déclenche en pratique que si le serveur est déjà réveillé à 6h
   UTC (un déploiement récent, un utilisateur insomniaque…).
2. **Nouveau** : `rattraperSauvegardeAuDemarrage()`, lancé 30s après le démarrage du processus
   (`setTimeout(..., 30000).unref()` — décalé pour répondre d'abord aux requêtes qui ont réveillé
   le serveur, `unref()` pour ne jamais empêcher un arrêt propre). Vérifie via
   `sauvegardeDuJourExisteDeja()` (compare le nom de fichier attendu — `backup-YYYY-MM-DD.json`,
   heure d'Haïti — à la liste du bucket) si une sauvegarde a déjà été faite aujourd'hui ; sinon,
   appelle **exactement la même fonction** que le minuteur.

Résultat pratique : une sauvegarde par jour d'utilisation réelle de l'app, gratuitement, sans
dépendre d'un service externe pour réveiller le serveur. Ce n'est **pas** un vrai cron fiable — un
jour sans aucune visite n'a pas de sauvegarde — mais un jour sans visite est aussi un jour sans
nouvelle donnée à protéger.

**Si un jour le plan passe en payant (Starter, ~7$/mois)** : le service ne s'éteint plus, le
minuteur de 6h redevient fiable à lui seul, et ce rattrapage devient une redondance inoffensive —
pas la peine de le retirer, `sauvegardeDuJourExisteDeja()` empêchera juste une double sauvegarde
le jour où les deux se chevauchent.

Tests : 5 ajoutés (175 au total, 0 échec), dont 2 qui EXÉCUTENT réellement
`sauvegardeDuJourExisteDeja` extrait du fichier (même approche que `chargerLecteursEpisodes`) avec
un faux Storage en mémoire — pas une relecture du code.

---

# 📍 OÙ SONT LES NOTES

Le journal de bord complet des sessions Claude vit dans **l'autre dépôt** :
`gateslittle4/chf-app2` → `NOTES_POUR_PROCHAIN_CLAUDE.md` (2 400+ lignes, entrées les plus
récentes en haut). **Le lire en premier**, même pour un chantier purement backend — les deux
dépôts se déploient ensemble et la plupart des bugs traversent les deux.

Ce fichier-ci ne contient que ce qui est spécifique au backend et qu'il serait dangereux de
découvrir trop tard.

---

# ✅ CHANTIER N°1 — RÉSOLU LE 13-14/09 : LA SAUVEGARDE SE RESTAURE VRAIMENT MAINTENANT

C'était **le seul vrai blocage** pour la mise en production à l'hôpital. Détail complet dans les
notes de `chf-app2` (section tout en haut). Résumé côté backend :

`sauvegarderVersStorage()` (~L2579) écrit chaque nuit un dump des 17 tables vers Supabase Storage
et Backblaze B2 — écriture confirmée fonctionnelle par Esdras le 11/09, inchangée.

Ce qui manquait : **rien ne savait relire ce fichier.** L'ancien bouton « 📤 Restore » attendait un
format totalement différent (l'ancien export manuel chiffré) et affichait un toast de succès même
à 0 ligne écrite.

Construit le 13/09 : `restaurerDepuisSauvegarde()` (~fin de server.js, avant `app.listen`) — insère
UNIQUEMENT ce qui manque (jamais d'upsert), dans l'ordre `dossiers → episodes → fiches → paiements`
puis les tables sans dépendance, relit le nombre de lignes RÉELLEMENT écrites, retente ligne par
ligne un lot refusé en bloc. Routes `GET /api/admin/sauvegardes` (liste) et
`POST /api/admin/restaurer-sauvegarde` (restaure le fichier choisi, renvoie un rapport détaillé —
aucun champ `success` générique). Câblé côté chf-app2 : nouveau bouton « 🗄️ Restaurer sauvegarde
auto » (`components/RestaurationSauvegarde.js`), l'ancien « 📤 Restore » reste pour l'export manuel
chiffré (fonctionnalité distincte, inchangée).

**Testé pour de vrai, pas en théorie** : branching Supabase indisponible (hors plan Pro) et limite
de 2 projets gratuits déjà atteinte → schéma Postgres jetable (`restauration_test`) créé dans le
MÊME projet, 17 tables répliquées à l'identique depuis `information_schema`/`pg_constraint`, vraies
données de production copiées dedans (32 dossiers, 27 épisodes, 68 fiches, 70 paiements...), perte
simulée (suppression en cascade d'un dossier avec 5 épisodes), restauration, comptage ligne par
ligne — récupération exacte, aucune erreur de contrainte. Schéma supprimé ensuite, aucun impact sur
la vraie base à aucun moment.

Tests : 166/166 (backend), 583/583 (frontend). Poussé et déployé le 14/09.

## Ce qui est déjà propre (ne pas refaire ce travail)

Couverture des tables recoupée le 11/09 entre `TABLES_A_SAUVEGARDER` (~L2572, 17 tables) et les
20 tables réelles de `woghiwalsxusqtxvpzfo`. Les 3 absentes sont sans conséquence :
`medicaments` et `actes` (0 ligne, remplacées par `catalog`, qui est sauvegardée) et `compteurs`
(0 ligne, vestige). **Le compteur de numéros de lot n'est PAS dans `compteurs`** : la RPC
`incrementer_prochain_numero_lot` incrémente `ong_partenaires.prochain_numero`, et
`ong_partenaires` est bien sauvegardée — pas de risque de numéros de lot dupliqués après une
restauration.

---

# ✅ CORBEILLE 30 JOURS — phase 2 branchée le 12/09 (retour d'Esdras : "corrige la corbeille")

Détail complet dans les notes de `chf-app2` (section tout en haut). Résumé côté backend :

Les 3 vraies routes de suppression utilisateur (`DELETE /api/episodes/:id`, `DELETE
/api/fiches/:id`, `DELETE /api/dossiers/:id/pieces-jointes/:fichierId`) posent maintenant
`supprime_le` au lieu d'un vrai DELETE, avec cascade manuelle vers les enfants (episodes→fiches→
paiements, fiches→paiements) puisqu'un simple UPDATE ne déclenche pas le `ON DELETE CASCADE` de la
base. 3 routes `POST .../restaurer` en miroir — ne restaurent que les enfants au MÊME horodatage
que le parent (jamais un enfant supprimé séparément). Nouvelle fonction `purgerCorbeilleDossiers()`
dans le même cron 6h UTC que la corbeille catalogue, déclenchement manuel via `POST
/api/admin/purger-corbeille-dossiers`.

**Piège à ne pas réintroduire** : les `.delete()` internes de rollback (L1970, L2063-2065 dans
l'ancienne numérotation — correction de type de patient ratée, qui supprime des lignes créées
l'instant d'avant dans la MÊME requête) sont restés de vrais DELETE, volontairement. Un brouillon
jamais visible côté utilisateur n'a aucune raison d'aller à la corbeille.

`ong_partenaires` a toujours la colonne `supprime_le` mais aucune route ne les supprime — rien à
purger tant que cette fonctionnalité n'existe pas.

Tests : 161/161 (7 nouveaux).

---

# ⏰ FUSEAU HORAIRE — le serveur tourne en UTC, jamais l'oublier

Corrigé le 11/09 après un vrai bug de données en production depuis des semaines : `dateHeure`
était calculée sans fuseau, donc **tout dossier créé entre 20h et minuit heure d'Haïti était daté
du LENDEMAIN**, définitivement, en base.

Constante `FUSEAU_HAITI = 'America/Port-au-Prince'` déclarée près de `ORIGINE_FRONTEND`, appliquée
à 3 endroits (date du dossier, nom du fichier de sauvegarde, message WhatsApp).

**Ne jamais remplacer par un `-4` en dur** : Haïti suit l'heure d'été américaine (UTC-5 l'hiver,
UTC-4 l'été) — un décalage figé recrée le bug la moitié de l'année. Le fuseau nommé est bien
disponible dans l'ICU de Node sur Render (vérifié).

Toute nouvelle date affichée ou nommée doit passer par `{ timeZone: FUSEAU_HAITI }`.

---

# ⚠️ PIÈGES CONNUS DU BACKEND

**Les routes épisodes ne lisent que du snake_case.** `POST /api/episodes` (L828) et
`PUT /api/episodes/:id` (L877) lisent `d.nom_patient`, jamais `d.nomPatient` — le front convertit
via `toEpisodeApi()` avant d'envoyer. Lire un champ en camelCase ici le laisse silencieusement
`undefined` et la mise à jour réussit (200 OK) **sans rien écrire**. Ce bug a déjà été commis.

**Tout nouveau champ d'épisode doit être ajouté aux DEUX endroits** : la carte de conversion
côté front (`chf-app2/api/supabase.js`, `toEpisodeApi`/`fromEpisodeApi`) **et** la liste des
champs acceptés par la route `PUT`. Depuis le 11/09, `toEpisodeApi` a un repli générique
camelCase → snake_case qui rattrape l'oubli côté front — mais la route `PUT` filtre toujours
explicitement, donc l'oubli côté backend reste possible.

**`fromEpisodeApi` n'a délibérément PAS de repli symétrique.** Plusieurs écrans lisent des champs
snake_case bruts (`local_id`, `voie_entree`, `numero_dossier`, `nom_origine`,
`est_hospitalisation`) directement sur les objets épisode. Un test verrouille cette asymétrie :
elle est **voulue**, ne pas la « corriger ».

**Tout nouveau champ de sauvegarde** doit entrer dans `TABLES_A_SAUVEGARDER` — une table oubliée
n'est sauvegardée nulle part. C'était déjà arrivé à 5 tables (audit du 31/08).

---

# 📋 REPÈRES

- **Tests** : `npm test` → 185 / 185, aucun échec attendu. Un échec = une régression réelle.
- **Render** : backend `srv-da0j3f7lk1mc7382rm0g` (web service), app2
  `srv-da175dpt0dsc73b5lj70` (static site). Workspace `tea-d9h2bivlk1mc738tli3g`. `autoDeploy`
  actif sur `main` dans les deux.
- **Supabase de production** : `woghiwalsxusqtxvpzfo`. Le nom affiché est « chf-backend-test » —
  **c'est bien la production**, malgré le nom.
- **Variables Backblaze** sur Render : `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`.
  `EMAIL_SAUVEGARDE_EXPEDITEUR` / `EMAIL_SAUVEGARDE_MOT_DE_PASSE_APP` (ère SMTP) ne servent plus.
- **Le proxy de cet environnement bloque les requêtes directes vers `*.onrender.com`** — on ne
  peut pas visiter le site en production depuis une session Claude. Vérifier par les logs Render,
  les requêtes SQL Supabase et les tests, jamais « en allant voir ».

---

# 🚦 LIMITE DU NOMBRE DE REQUÊTES (13/10, liste de contrôle fintech montrée par Esdras : « rate limits sur la connexion et les opérations sensibles »)
- **Avant** : aucune limite (seul le portail patient avait la sienne : 5 essais / 15 min). Un script avec un compte valide pouvait envoyer des milliers de requêtes par minute (saturer le serveur gratuit de Render, remplir la base de faux paiements) ; des jetons invalides pouvaient être testés sans fin.
- **Maintenant** (`utils/limiteur.js`, compteurs en mémoire à fenêtre fixe, un seul serveur → pas de Redis) : **par COMPTE connecté** (jamais par adresse : tout l'hôpital sort par la même adresse) — 600 requêtes/min au total, 240 écritures/min, 120 paiements/min (la reprise de 40 paiements après une longue coupure passe) ; **par adresse** — 60/min sur les pages publiques d'invitation, et 30 jetons manquants/invalides par 10 min (au-delà, 429 au lieu de 401 ; **un jeton valide n'est jamais bloqué**, même depuis une adresse qui a échoué). Réponse : `429 { error: 'TROP_DE_REQUETES', message: 'Trop de demandes en peu de temps. Réessaie dans N secondes.', raison }` + `Retry-After`. Le test de santé `/` et les OPTIONS ne sont jamais limités.
- **Où** : `app.use('/api', limiteUtilisateur)` juste APRÈS `verifyToken` (il lui faut `req.user.id`), AVANT l'idempotence ; `limiteEchecsAuth.signalerEchec(req)` dans les deux rejets de `verifyToken` ; `limitePublique` sur `GET /invitation/:token` et `POST /invitation/:token/creer-compte`. Nettoyage des compteurs toutes les 5 min (`unref`).
- **Application** : `STATUTS_REESSAYABLES_ECRITURE` contient déjà 429 → une écriture limitée reste dans la file et repart (jamais un refus définitif). ⚠️ Une LECTURE limitée (429 sur un GET) n'est pas dans `STATUTS_INDISPONIBILITE` : elle s'afficherait comme une erreur au lieu de servir la copie locale — improbable avec ces seuils, mais à ajouter si besoin.
- **⚠️ Adresse derrière Render** : sans réglage, `req.ip` serait l'adresse du proxy de Render (la même pour tous). `app.set('trust proxy', 1)` (variable d'environnement **`TRUST_PROXY`** pour changer le nombre de proxys sans toucher au code) : je n'ai pas pu vérifier combien de proxys Render met devant le serveur. Si les limites par adresse paraissent mal calibrées (tout le monde bloqué ensemble, ou jamais), ajuster `TRUST_PROXY` d'abord. Effet de bord voulu : la limite du portail patient (par `ip:numéro de dossier`) voit enfin la vraie adresse du visiteur.
- **Interrupteur de secours** : variable d'environnement Render `DESACTIVER_LIMITES=1` coupe TOUTES les limites sans redéployer le code (seuils ajustables aussi : `LIMITE_GENERALE`, `LIMITE_ECRITURES`, `LIMITE_PAIEMENTS`).
- Tests : `tests/limiteur.test.js` (10, sur un vrai serveur Express ; 5 sabotages détectés).

---

# 🔒 SOLDE ATOMIQUE DES PAIEMENTS (13/10, liste de contrôle fintech montrée par Esdras : « 20 retraits en même temps sur le même solde »)
- **Défaut corrigé** : `POST /api/paiements` LISAIT le solde du dernier paiement de l'épisode puis ÉCRIVAIT le nouveau paiement en deux appels séparés. Deux paiements du même épisode simultanés (deux caisses, ou un rejeu de la file hors ligne pendant qu'une caisse encaisse) partaient du même ancien solde : le 2e écrasait le report du 1er (dette « oubliée », ou remboursements qui dépassent la dette). Mesuré sur Postgres jetable : 20 crédits simultanés de 100 → **3 soldes distincts sur 20, dernier à 300 au lieu de 2000** ; 20 remboursements de 100 sur une dette de 1000 → **les 20 passent**.
- **Maintenant** : `sql/solde_atomique.sql` → fonction `public.enregistrer_paiement_atomique(p_corps jsonb, p_ajout numeric, p_remboursement_credit boolean, p_heure_serveur boolean)` : verrou consultatif PAR ÉPISODE (`pg_advisory_xact_lock`), puis lecture du solde à jour, calcul et écriture d'un seul bloc. Même règle de solde qu'avant (solde = `solde_restant` du dernier paiement non annulé et non supprimé ; crédit/partiel : `+ p_ajout` ; remboursement de crédit : `− montant`, refusé par CHF01/CHF02/CHF03 → 400 avec le message). Les paiements d'épisodes différents ne s'attendent pas. SECURITY INVOKER (RLS de `paiements` : seul le serveur, `service_role`, s'en sert). Sans DROP/REVOKE.
- **Piège trouvé par le test de concurrence** : choisir « le dernier paiement par `date_paiement` » ne marche PAS sous concurrence si la date est l'heure de DÉBUT de la requête (ou le `now()` de la transaction) : l'ordre des dates n'est pas l'ordre du verrou, le suivant repart d'un solde périmé (échec intermittent, 1 fois sur 3 avec 20 sessions). Solution : un paiement EN DIRECT est daté **sous le verrou** (`clock_timestamp()`, `p_heure_serveur` vrai), départage par `numero_paiement`. Un REJEU de la file hors ligne (en-tête `X-CHF-Rejeu`) garde la date de l'appareil (`p_heure_serveur` faux).
- **Serveur** (`server.js`, `utils/soldeAtomique.js`) : après les contrôles (heure, montant, paiement partiel), UN appel `supabase.rpc('enregistrer_paiement_atomique', …)` ; refus CHF0x → 400 ; 23505 (même `local_id`) → 200 avec le paiement existant ; autre erreur → 500 ; **fonction absente (PGRST202 / 42883 : script SQL pas encore collé) → l'ancien chemin lecture-puis-écriture, inchangé** : jamais une panne. Déployer le serveur avant ou après le SQL est sans danger.
- **À coller dans Supabase** : `sql/solde_atomique.sql`. Test : `python3 scripts/test-solde-atomique-sql.py` (Postgres jetable : règle de solde, annulés/supprimés, valeurs par défaut, `local_id` en double, 8 tours de 20 sessions simultanées, version NAÏVE qui doit échouer, deux épisodes qui ne s'attendent pas, rejeu du script ; sabotages détectés : sans verrou, sans date sous verrou). Côté JS : `tests/solde_atomique.test.js` (12, la vraie route extraite de `server.js`).
- **Limite connue, non corrigée** (déjà là avant) : les lecteurs (Créances, Fiche Patient, Calculateur) prennent « le dernier paiement » **par date** ; un paiement rejoué hors ligne a une date plus ancienne que des paiements saisis depuis → le solde porté par la dernière LIGNE écrite peut ne pas être celui que lisent ces écrans. Une vraie correction demanderait de lire aussi par `numero_paiement`.


## Doublons d'identité, fusion, dossier de naissance, état du système (14/10, demandes d'Esdras)
**Rien de ceci n'est appliqué en production tant qu'on ne l'a pas dit.** Deux scripts SQL à coller (sans danger, se rejouent, testés sur un Postgres jetable : `python3 scripts/test-naissance-fusion-sql.py`, root) :
1. `sql/dossiers_naissance_fusion.sql` — `dossiers.mere_dossier_id` (bébé → mère), `anciens_noms` (jsonb), `fusionne_dans/le/par` + `fusion_details`, table `doublons_ignores`, fonctions `fusionner_dossiers(source, cible, par)` / `defusionner_dossiers(source, par)` (SQLSTATE `CHF11`…`CHF16`, 5 caractères — un code plus long est refusé par Postgres), `rechercher_dossiers_flou` mise à jour (cache les fusionnés, cherche aussi `anciens_noms`). EXECUTE retiré à anon/authenticated, rendu explicitement à service_role.
2. `sql/etat_systeme.sql` — tables `postes_etat` (un poste = une ligne, heure de vue = heure du SERVEUR) et `erreurs_client` (regroupées par empreinte, statut nouveau/vu/résolu, une erreur résolue qui revient repasse à « nouveau »), fonctions `signaler_erreur_client`, `nettoyer_etat_systeme`. RLS activée sans policy (seul le serveur y accède).
Le serveur fonctionne AVANT que les scripts soient collés (repli 42703/42P01/42883 : réponses 503 explicites ou 204 silencieux, jamais de lien à la mère perdu en silence).
**Ordre : SQL → serveur → application** (une application neuve avec un serveur ancien perdrait le sexe/la mère à la création).
- Routes : `utils/routesDoublons.js` (`GET /api/dossiers/similaires`, `GET /api/dossiers/doublons-possibles`, `POST /api/dossiers/doublons-ignores`, `POST /api/dossiers/:id/fusionner|defusionner`) — montées AVANT `/api/dossiers/:id` ; `utils/routesEtatSysteme.js` (`POST /api/postes/battement`, `POST /api/erreurs-client`, `GET /api/etat-systeme/postes|erreurs`, `PATCH /api/etat-systeme/erreurs/:id`, lectures réservées à l'**administrateur**) ; `GET /api/qualite-donnees` (`utils/qualiteDonnees.js`, direction_voir ou fiche_patient_modifier).
- Score des doublons : `utils/doublonsIdentite.js` (nom proche + date de naissance + téléphone ; garde-fous : mère↔enfant, nom « Bébé » d'un seul côté, dates > 1 an d'écart, sexes différents, téléphone seul jamais suffisant). 10 000 dossiers en moins de quelques secondes (regroupement par clés).
- `POST /api/dossiers` accepte `sexe` et `mere_dossier_id` ; `PUT /api/dossiers/:id` garde l'ancien nom dans `anciens_noms` à chaque renommage (le nom de création, lui, ne bouge jamais) et accepte `mere_dossier_id` (null = lien retiré) ; `GET /api/dossiers/:id` renvoie `mere`, `enfants`, `fusionne_dans_dossier`.
- Les erreurs des postes sont NETTOYÉES (e-mails et suites de 5 chiffres retirés) avant d'être gardées : `utils/erreursClient.js`.
- Tests : `tests/doublons_identite.test.js`, `routes_doublons.test.js`, `etat_systeme_serveur.test.js`, `naissance.test.js`, `qualite_donnees.test.js` (+ `tests/aides/fauxSupabase.js`, `appFausse.js`).
