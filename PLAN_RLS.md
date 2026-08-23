# Sécuriser l'accès aux données CHF — plan en 3 étapes (à valider avec Esdras)

## ⚠️ Déjà fait, à lire quand même
La faille la plus grave trouvée le 18/08 (bouton "Créer un compte (test)" sur l'écran de
connexion, qui donnait le rôle administrateur à quiconque cliquait dessus) est **corrigée**
dans `chf-app-8.zip` et `chf-backend-complet-3.zip`. Avant d'aller plus loin :
**vérifie la liste des comptes existants** (Firebase Console → Authentication, et la table
Supabase `users`) pour repérer un compte administrateur que ni toi ni Esdras ne reconnaissez.
Si l'app a déjà tourné en ligne avec ce bouton visible, ce n'est pas à exclure.

---

## Pourquoi ce n'est pas juste "activer RLS et écrire des règles"

L'app se connecte avec Firebase (login), mais certains écrans (Utilisateurs, Demandes
d'exonération, Partenaires, Salaires, Clôture de caisse, Journal d'audit) parlent
**directement** au navigateur → Supabase, sans repasser par ton backend. Ce chemin direct
utilise juste la clé "anon" — Supabase ne sait alors absolument pas *qui* fait la demande,
seulement qu'elle vient de "quelqu'un avec la clé publique". Résultat : on ne peut pas encore
écrire "seule la direction peut faire X", parce que Postgres n'a aucun moyen fiable de savoir
si c'est la direction ou n'importe qui d'autre qui appelle. Il faut d'abord relier l'identité
Firebase à Supabase — sinon les règles de l'étape 3 seraient soit inutiles, soit casseraient
l'app. D'où 3 étapes, dans cet ordre strict.

---

## Étape 1 — Le backend utilise la clé service_role ✅ déjà fait

`server.js` utilisait la clé "anon" pour parler à Supabase — la même famille de clé que celle
exposée côté navigateur. Il utilise maintenant la clé **service_role** (qui contourne RLS),
ce qui est correct : ce backend a déjà vérifié le jeton Firebase avant d'agir, donc RLS ne doit
pas aussi le limiter. **Sur Render, ajoute la variable d'environnement
`SUPABASE_SERVICE_ROLE_KEY`** (Supabase → Project Settings → API → service_role) — sans ça, le
backend refusera de démarrer (`process.exit(1)`, message d'erreur clair dans les logs Render).

---

## Étape 2 — Brancher Firebase dans Supabase (Third-Party Auth)

### 2a. Dans le tableau de bord Supabase — ✅ FAIT (confirmé par Esdras le 23/08, après correction
d'une faute de frappe : le Project ID doit être en minuscules, `chf-test1`, pas `Chf-test1` —
l'auto-capitalisation du clavier mobile l'avait changé)
Authentication → Third-Party Auth → nouvelle intégration → choisir Firebase → renseigner le
Project ID Firebase (`chf-test1`, visible dans `api/firebase.js`). Documentation officielle :
https://supabase.com/docs/guides/auth/third-party/firebase-auth
Lien direct (remplace `<ref>` par la référence du projet, visible dans l'URL Supabase ou dans
`SUPABASE_URL`) : `https://supabase.com/dashboard/project/<ref>/auth/third-party`
Session du 23/08 : pas d'accès MCP à ce projet Supabase précis pour le faire à la place
d'Esdras (le connecteur Supabase de cette session pointe vers un autre compte) — à refaire à
chaque nouvelle session, ou donner un token d'accès Supabase (Account → Access Tokens) si on
veut que Claude l'exécute directement via la Management API
(`POST /v1/projects/<ref>/config/auth/third-party-auth`).

### 2b. Attribuer la revendication requise à chaque utilisateur — ✅ FAIT le 23/08
Supabase exige que chaque compte porte une revendication personnalisée Firebase
`role: 'authenticated'` (nom malheureux — **rien à voir** avec le rôle CHF
administrateur/direction/comptable/auditeur/lecteur stocké dans la table `users` ; c'est un
simple marqueur que Supabase impose, toujours la même valeur pour tout le monde).
- **Nouveaux comptes** : déjà fait automatiquement par le backend corrigé
  (`/api/admin/users` appelle `setCustomUserClaims` à la création).
- **Comptes déjà existants** : rattrapés via une route backend temporaire (même logique que
  `scripts/backfill-claims-supabase.js`, retirée après usage) — 4 comptes mis à jour, 0 échec.

### 2c. Code frontend — ✅ FAIT et déployé le 23/08
Dans `api/firebase.js`, le client Supabase transmet maintenant le jeton Firebase à chaque
requête :
```js
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  accessToken: async () => (authReel.currentUser ? authReel.currentUser.getIdToken() : null)
});
```
Testé en production après déploiement : Demandes, Partenaires, Utilisateurs, Salaires,
Clôture de caisse, Journal d'audit fonctionnent toujours normalement (RLS n'étant pas encore
activée, ce changement seul ne restreint rien pour l'instant).

---

## Étape 3 — Activer RLS + règles (SQL, dans Supabase → SQL Editor)

Règles métier confirmées avec Esdras le 23/08 :
- **Demandes d'exonération** : comptable (écrit les transactions) + direction + administrateur
  + auditeur (supervision) voient tout ; un caissier ne voit/crée que ses propres demandes.
- **Salaires** : comptable n'y a **aucun accès**, ni lecture ni écriture — réservé à
  direction/administrateur uniquement.
- **Clôture de caisse** : chaque caissier ne voit/modifie QUE ses propres clôtures (le code
  a été corrigé le 23/08 pour stocker un vrai `cloturee_par_uid`, voir DashboardCaisse.js —
  avant, 2 caissiers travaillant le même jour partageaient la même fiche). Direction,
  administrateur et comptable voient toutes les clôtures (supervision/comptabilité).

```sql
-- Fonction utilitaire : rôle CHF de l'utilisateur Firebase actuellement authentifié.
-- SECURITY DEFINER évite la boucle "la policy sur users doit lire users pour s'évaluer".
CREATE OR REPLACE FUNCTION mon_role_chf()
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE
AS $$ SELECT role FROM users WHERE id = auth.uid(); $$;
-- Si auth.uid() renvoie NULL avec les jetons Firebase chez vous, remplacer par
-- (auth.jwt() ->> 'sub') partout dans ce fichier (fonction ci-dessus + policies).

-- GROUPE 1 — episodes, dossiers, fiches, paiements, catalog : seul le backend
-- (service_role, contourne RLS) doit y toucher. Aucune policy = accès refusé au
-- navigateur, ce qui est le but.
ALTER TABLE episodes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE dossiers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiches    ENABLE ROW LEVEL SECURITY;
ALTER TABLE paiements ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog   ENABLE ROW LEVEL SECURITY;

-- GROUPE 2 — users : chacun lit sa propre fiche ; administrateur lit/modifie tout.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_lecture_soi   ON users FOR SELECT USING (id = auth.uid());
CREATE POLICY users_lecture_admin ON users FOR SELECT USING (mon_role_chf() = 'administrateur');
CREATE POLICY users_ecriture_admin ON users FOR UPDATE USING (mon_role_chf() = 'administrateur');
-- Pas de policy INSERT : création uniquement via /api/admin/users (service_role).

-- GROUPE 3 — audit_log : on peut ajouter SA PROPRE trace, jamais lire/modifier/effacer
-- depuis le navigateur (un journal ne se corrige pas soi-même).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_insertion_soi ON audit_log FOR INSERT WITH CHECK (effectue_par_uid = auth.uid());
CREATE POLICY audit_lecture_admin ON audit_log FOR SELECT USING (mon_role_chf() = 'administrateur');

-- GROUPE 4 — demandes_exoneration : un caissier voit/crée SES demandes ; comptable/direction/
-- administrateur/auditeur voient tout ; direction/administrateur répondent, tant qu'en attente.
ALTER TABLE demandes_exoneration ENABLE ROW LEVEL SECURITY;
CREATE POLICY exoneration_lecture ON demandes_exoneration FOR SELECT
  USING (demandeur_uid = auth.uid() OR mon_role_chf() IN ('comptable','direction','administrateur','auditeur'));
CREATE POLICY exoneration_creation ON demandes_exoneration FOR INSERT
  WITH CHECK (demandeur_uid = auth.uid());
CREATE POLICY exoneration_reponse ON demandes_exoneration FOR UPDATE
  USING (mon_role_chf() IN ('direction','administrateur') AND statut = 'en_attente');

-- GROUPE 5 — ong_partenaires : lecture ouverte (utilisée partout dans les formulaires),
-- gestion de la liste réservée à direction/administrateur.
ALTER TABLE ong_partenaires ENABLE ROW LEVEL SECURITY;
CREATE POLICY ong_lecture_tous ON ong_partenaires FOR SELECT USING (mon_role_chf() IS NOT NULL);
CREATE POLICY ong_ecriture_admin ON ong_partenaires FOR ALL USING (mon_role_chf() IN ('direction','administrateur'));

-- GROUPE 6 — salaires_service : réservé à direction/administrateur, lecture ET écriture.
-- Le comptable n'y a AUCUN accès (confirmé par Esdras le 23/08) — aucune policy pour lui,
-- donc RLS le bloque par défaut, ce qui est le but.
ALTER TABLE salaires_service ENABLE ROW LEVEL SECURITY;
CREATE POLICY salaires_lecture_ecriture ON salaires_service FOR ALL USING (mon_role_chf() IN ('direction','administrateur'));

-- GROUPE 7 — cloture_caisse : un caissier ne voit/modifie QUE ses propres clôtures
-- (colonne cloturee_par_uid, ajoutée le 23/08) ; comptable/direction/administrateur voient tout.
ALTER TABLE cloture_caisse ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloture_lecture_soi     ON cloture_caisse FOR SELECT USING (cloturee_par_uid = auth.uid());
CREATE POLICY cloture_lecture_super   ON cloture_caisse FOR SELECT USING (mon_role_chf() IN ('comptable','direction','administrateur'));
CREATE POLICY cloture_ecriture_soi    ON cloture_caisse FOR ALL    USING (cloturee_par_uid = auth.uid());
```

**Rollback d'urgence** si un écran casse après activation (à identifier via les messages
d'erreur dans la console du navigateur, puis cibler la bonne table) :
```sql
ALTER TABLE nom_de_la_table DISABLE ROW LEVEL SECURITY;
```

---

## Ordre de déploiement conseillé
1. ✅ Déployer `chf-backend-complet-3.zip` (service_role + correctifs) — ajouter la variable
   `SUPABASE_SERVICE_ROLE_KEY` sur Render.
2. ✅ Déployer `chf-app-8.zip` (écran de connexion corrigé).
3. ✅ Configurer Third-Party Auth côté Supabase (2a) + rattrapage des claims (2b).
4. ✅ Appliquer le changement frontend de 2c, testé en production — rien n'a changé (RLS pas
   encore actif).
5. ⏳ Exécuter le SQL de l'étape 3 (ci-dessus, règles confirmées le 23/08), idéalement hors des
   heures de pointe.
6. ⏳ Tester chaque écran (Utilisateurs, Demandes, Partenaires, Salaires, Clôture, Calculateur,
   Archives) avec un compte de chaque rôle si possible.

## Hors scope de cette passe (mentionné précédemment, pas oublié)
- Numéro de lot calculé côté navigateur (collision possible si 2 personnes génèrent un lot
  au même instant).
- Export Excel/Lots — pas encore relu en détail.
