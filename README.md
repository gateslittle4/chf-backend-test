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
npm test                # 155 tests, 0 échec attendu
```

> ⚠️ **La clé `SUPABASE_SERVICE_ROLE_KEY` contourne toutes les protections de la base.**
> Si tu mets celle de production dans ton `.env` local, ton ordinateur modifie la vraie
> base de l'hôpital. Pour des essais, crée une base Supabase séparée (gratuite) et utilise
> ses clés.

## Pour comprendre le projet

- **`NOTES_POUR_PROCHAIN_CLAUDE.md`** — les pièges du backend, les chantiers en cours, les
  repères d'environnement. À lire en premier avant de modifier quoi que ce soit.
- **`server.js`** — tout le serveur, commenté en français. Les commentaires expliquent
  *pourquoi* le code est écrit comme ça, pas seulement ce qu'il fait.
- **`sql/`** — les migrations appliquées à la base, avec leur contexte.
- **`PLAN_RLS.md`** — le plan de sécurisation des accès aux données.
