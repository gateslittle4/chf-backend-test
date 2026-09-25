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

Tests : 6 ajoutés (181 au total, 0 échec), vérifiés en échec sur l'ancien `server.js`.

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

- **Tests** : `npm test` → 181 / 181, aucun échec attendu. Un échec = une régression réelle.
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
