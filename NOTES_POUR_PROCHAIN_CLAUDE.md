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

- **Tests** : `npm test` → 153 / 153, aucun échec attendu. Un échec = une régression réelle.
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
