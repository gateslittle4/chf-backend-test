# chf-backend-test — serveur du système hospitalier CHF

Serveur Express qui fait le pont entre l'application (`chf-app2`) et la base de données
Supabase. Il vérifie l'identité Firebase de chaque appelant avant de toucher aux données,
gère les permissions par rôle, et fait tourner la sauvegarde quotidienne.

Déployé sur Render : chaque enregistrement sur la branche `main` part automatiquement en
production.

## Travailler dessus depuis ton ordinateur

Le guide complet — installation, clés, lancement, tests, et comment modifier sans risquer
la production — est dans l'autre dépôt :
**[`chf-app2/DEMARRAGE_LOCAL.md`](https://github.com/gateslittle4/chf-app2/blob/main/DEMARRAGE_LOCAL.md)**

En résumé, pour ce dépôt-ci :

```bash
npm install
cp .env.example .env    # puis remplis les valeurs (voir les commentaires du fichier)
npm start               # → http://localhost:3001
npm test                # ≈ 650 tests ; un seul échec connu : le test de performance « trouverDoublons »
```

> ⚠️ **La clé `SUPABASE_SERVICE_ROLE_KEY` contourne toutes les protections de la base.**
> Si tu mets celle de production dans ton `.env` local, ton ordinateur modifie la vraie
> base de l'hôpital. Pour des essais, crée une base Supabase séparée (gratuite) et utilise
> ses clés.

## Où trouver quoi

```
server.js       Toutes les routes /api/… (≈ 100), dans l'ordre : sécurité (jeton Firebase, limiteur, idempotence),
                puis dossiers/épisodes, fiches, paiements, caisse, stock, utilisateurs, rapports, sauvegarde
utils/          Les règles métier, une par fichier, testables sans serveur :
                verificationPrixFiche.js (prix contre le catalogue), soldeAtomique.js, paiementPartiel.js,
                retraitFicheCaisse.js (retirer / corriger une fiche), validationMontant.js, roles.js,
                fermetureAutoPostes.js, heureServeur.js, sauvegardeServeur.js …
sql/            Les fonctions et tables de la base, un fichier par sujet, relançables sans effet
scripts/        Outils d'exploitation : vérifier le journal SQL, essai de restauration, simulation sur 5 ans
tests/          Un fichier par sujet ; les routes sont exécutées contre une fausse base,
                les fonctions SQL contre un vrai Postgres embarqué (pglite)
```

**Règle d'or** : le serveur est l'autorité. L'application cache ou montre des boutons ; c'est ici que les droits, les
montants et les délais sont vraiment vérifiés. Les montants sont **toujours en gourdes** (la caisse les affiche en
dollars haïtiens à l'écran, mais rien n'est converti ici). Les messages d'erreur qui contiennent un montant le
font suivre de « Gdes » : l'application les convertit pour l'écran.

**Changer la base** : écrire un fichier dans `sql/` (`create or replace`, relançable), l'appliquer dans Supabase, le
noter dans le journal (`node scripts/verifier-sql.js`). Appliquer le SQL **avant** de fusionner le code qui en dépend.

## Pour comprendre le projet

- **[Architecture d'ensemble](https://github.com/gateslittle4/chf-app2/blob/main/docs/ARCHITECTURE.md)** (dépôt `chf-app2`) —
  schéma navigateur / serveur / base, parcours d'un encaissement, mode hors ligne, argent, droits.
- **`NOTES_POUR_PROCHAIN_CLAUDE.md`** — les pièges du backend, les chantiers en cours, les
  repères d'environnement. Long : le chercher avec `grep`.
- **`server.js`** — tout le serveur, commenté en français. Les commentaires expliquent
  *pourquoi* le code est écrit comme ça, pas seulement ce qu'il fait.
- **`sql/`** — les migrations appliquées à la base, avec leur contexte.
- **`PLAN_RLS.md`** — le plan de sécurisation des accès aux données.
