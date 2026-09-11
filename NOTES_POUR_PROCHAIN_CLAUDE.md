# 📍 OÙ SONT LES NOTES

Le journal de bord complet des sessions Claude vit dans **l'autre dépôt** :
`gateslittle4/chf-app2` → `NOTES_POUR_PROCHAIN_CLAUDE.md` (2 400+ lignes, entrées les plus
récentes en haut). **Le lire en premier**, même pour un chantier purement backend — les deux
dépôts se déploient ensemble et la plupart des bugs traversent les deux.

Ce fichier-ci ne contient que ce qui est spécifique au backend et qu'il serait dangereux de
découvrir trop tard.

---

# 🚨 CHANTIER N°1 (état au 11/09) — LA SAUVEGARDE NE PEUT PAS ÊTRE RESTAURÉE

C'est **le seul vrai blocage** pour la mise en production à l'hôpital. Détail complet dans les
notes de `chf-app2` (section tout en haut). Résumé côté backend :

`sauvegarderVersStorage()` (~L2579) écrit chaque nuit un dump des 17 tables vers Supabase Storage
et Backblaze B2. L'écriture est **confirmée fonctionnelle** par Esdras le 11/09.

**Rien ne sait relire ce fichier.** Le seul mécanisme de restauration existant est le bouton
« 📤 Restore » de l'app (`chf-app2/app/AppHospitaliere.js` L1105), qui attend un format totalement
différent (`{ verifications, ongTargets, medicaments, actes }` — l'ancien export manuel chiffré).
Nourri avec un fichier de sauvegarde automatique, il restaure **0 ligne** et affiche un **toast de
succès**. Simulé et vérifié, pas supposé.

À construire : une restauration qui lit le format serveur, réinsère les tables dans l'ordre des
dépendances (`dossiers` → `episodes` → `fiches` → `paiements`, puis le reste), ne duplique pas
l'existant, et **ne dit jamais « réussi » quand 0 ligne a été écrite**.

**Puis la tester pour de vrai** : base Supabase jetable + vraie sauvegarde tirée du bucket +
comparaison du compte de lignes table par table. Un backup qu'on n'a jamais restauré ne protège
personne — c'est exactement l'erreur qui a été commise ici pendant des semaines.

## Ce qui est déjà propre (ne pas refaire ce travail)

Couverture des tables recoupée le 11/09 entre `TABLES_A_SAUVEGARDER` (~L2572, 17 tables) et les
20 tables réelles de `woghiwalsxusqtxvpzfo`. Les 3 absentes sont sans conséquence :
`medicaments` et `actes` (0 ligne, remplacées par `catalog`, qui est sauvegardée) et `compteurs`
(0 ligne, vestige). **Le compteur de numéros de lot n'est PAS dans `compteurs`** : la RPC
`incrementer_prochain_numero_lot` incrémente `ong_partenaires.prochain_numero`, et
`ong_partenaires` est bien sauvegardée — pas de risque de numéros de lot dupliqués après une
restauration.

---

# 🔴 CORBEILLE 30 JOURS — phase 2 jamais branchée (constaté le 11/09)

La colonne `supprime_le` existe sur 5 tables (`episodes`, `fiches`, `paiements`, `pieces_jointes`,
`ong_partenaires`) depuis le 01/09, mais **`supprime_le` apparaît 0 fois dans `server.js`**.
Aucune route ne l'écrit, aucune requête ne la filtre.

Toutes les suppressions sont physiques et immédiates : **L971** (`episodes`), **L1219**
(`pieces_jointes`), **L1527/L1530** (`paiements`/`fiches`), **L1970** (paiement de dépôt),
**L2063-2065** (nettoyage en cascade).

Seul `purgerCorbeilleCatalogue()` existe — c'est la phase 1 (médicaments/actes), qui elle
fonctionne. Un commentaire du code affirme que les colonnes `supprime_le` « servent encore » :
**il est périmé.**

Conséquence : un mauvais clic détruit un dossier patient et son historique de facturation, sans
récupération. C'est l'inverse de ce qu'Esdras avait demandé. **Attend son feu vert** (la question
lui a été posée le 11/09, sans réponse pour l'instant) — ça change la sémantique de suppression
sur 5 tables, ne pas le faire unilatéralement.

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
