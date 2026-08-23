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

## Étape 3 — Activer RLS + règles — ✅ FAIT et vérifié le 23/08

Appliquée directement en base (project `woghiwalsxusqtxvpzfo`) via migrations Supabase, testée
en simulant chaque rôle réel (`SET LOCAL ROLE authenticated` + `request.jwt.claims`, dans des
transactions annulées par ROLLBACK — aucune donnée touchée), puis confirmée propre par
`get_advisors` (plus aucune erreur de sécurité).

**2 pièges trouvés et corrigés en vérifiant, à retenir pour la suite :**
1. **`auth.uid()` ne marche PAS avec les jetons Firebase.** Elle caste le `sub` du jeton en
   `uuid` (`pg_get_functiondef` confirmé), or un UID Firebase (`U9BWGNmVVFVsi5R7PNwZtIpNVsw1`)
   n'est pas un UUID valide — ça lève une erreur à chaque évaluation de policy. Remplacé partout
   par une fonction maison `mon_uid()` qui fait `auth.jwt() ->> 'sub'` (texte brut, pas de cast).
2. **Des policies permissives `USING (true)` existaient déjà** sur `users`, `ong_partenaires`
   (x2), `cloture_caisse`, `salaires_service` — créées à un moment non documenté, dormantes tant
   que RLS était désactivée. En activant RLS, elles se sont réveillées et annulaient TOUTES les
   policies restrictives qu'on venait d'écrire (Postgres combine les policies PERMISSIVE par OR).
   Détecté en testant avec un compte auditeur qui voyait pourtant toute la table `users`.
   Supprimées (`DROP POLICY`). **Si un écran s'ouvre trop largement après une future modif de
   policy, vérifier `SELECT * FROM pg_policies WHERE qual = 'true'` en premier réflexe.**

**Bonus trouvé par `get_advisors` en cours de route (rien à voir avec ce plan, corrigé quand
même car gratuit) :** les tables `actes` et `medicaments` (vides, jamais utilisées — les vraies
données vivent dans `catalog.items`) avaient RLS **désactivée** (pas juste "pas de policy" —
carrément désactivée), donc lisibles/modifiables par n'importe qui avec la clé anon publique.
Fermées avec RLS activée + zéro policy, comme le GROUPE 1. `search_path` fixé sur `mon_uid()`/
`mon_role_chf()` (autre avertissement du linter). `mon_role_chf()` n'est plus appelable
directement par `anon` (RPC public), seulement par `authenticated` (dont mes policies).

**Restent, non urgents, notés pour plus tard :** `search_path` mutable sur des fonctions
préexistantes non touchées aujourd'hui (`increment_counter`, `decrementer_stock_medicaments`,
`incrementer_prochain_numero_lot`, `ajouter_stock_medicament`, `definir_stock_medicament`) ;
protection contre les mots de passe compromis (HaveIBeenPwned) désactivée dans Auth ; `depenses_caisse`
a RLS activée sans policy depuis un moment non documenté — déjà sûr par défaut (accès refusé),
juste à clarifier si elle doit un jour être utilisée par un écran. `demandes_decaissement`,
`demandes_requisition`, `tickets_securite` et `partenaires` (vides, jamais utilisées par aucun
écran) ont été supprimées le 23/08 — `compteurs` gardée, elle sert `increment_counter`.

**⚠️ Reste à faire par Esdras : tester chaque écran avec un compte de chaque rôle réel** (au
minimum administrateur + un rôle non-administrateur) pour confirmer que rien ne s'est cassé —
la simulation SQL couvre la logique des policies, pas le vrai jeton émis par Firebase de bout
en bout.

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
-- Uid Firebase de l'utilisateur authentifié actuel. PAS auth.uid() (voir piège n°1 ci-dessus).
CREATE OR REPLACE FUNCTION mon_uid()
RETURNS text LANGUAGE sql STABLE SET search_path = public
AS $$ SELECT auth.jwt() ->> 'sub'; $$;

-- Rôle CHF de l'utilisateur Firebase actuellement authentifié.
-- SECURITY DEFINER évite la boucle "la policy sur users doit lire users pour s'évaluer".
CREATE OR REPLACE FUNCTION mon_role_chf()
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$ SELECT role FROM users WHERE id = mon_uid(); $$;
REVOKE EXECUTE ON FUNCTION mon_role_chf() FROM anon, public;
GRANT EXECUTE ON FUNCTION mon_role_chf() TO authenticated;

-- GROUPE 1 — episodes, dossiers, fiches, paiements, catalog : seul le backend
-- (service_role, contourne RLS) doit y toucher. Aucune policy = accès refusé au
-- navigateur, ce qui est le but. actes/medicaments : tables vides et inutilisées, fermées pareil
-- (avaient RLS carrément désactivée avant — ERROR du linter Supabase, corrigé au passage).
ALTER TABLE episodes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE dossiers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE paiements   ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog     ENABLE ROW LEVEL SECURITY;
ALTER TABLE actes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicaments ENABLE ROW LEVEL SECURITY;

-- GROUPE 2 — users : chacun lit sa propre fiche ; administrateur lit/modifie tout.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_lecture_soi   ON users FOR SELECT USING (id = mon_uid());
CREATE POLICY users_lecture_admin ON users FOR SELECT USING (mon_role_chf() = 'administrateur');
CREATE POLICY users_ecriture_admin ON users FOR UPDATE USING (mon_role_chf() = 'administrateur');
-- Pas de policy INSERT : création uniquement via /api/admin/users (service_role).

-- GROUPE 3 — audit_log : on peut ajouter SA PROPRE trace, jamais lire/modifier/effacer
-- depuis le navigateur (un journal ne se corrige pas soi-même).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_insertion_soi ON audit_log FOR INSERT WITH CHECK (effectue_par_uid = mon_uid());
CREATE POLICY audit_lecture_admin ON audit_log FOR SELECT USING (mon_role_chf() = 'administrateur');

-- GROUPE 4 — demandes_exoneration : un caissier voit/crée SES demandes ; comptable/direction/
-- administrateur/auditeur voient tout ; direction/administrateur répondent, tant qu'en attente.
ALTER TABLE demandes_exoneration ENABLE ROW LEVEL SECURITY;
CREATE POLICY exoneration_lecture ON demandes_exoneration FOR SELECT
  USING (demandeur_uid = mon_uid() OR mon_role_chf() IN ('comptable','direction','administrateur','auditeur'));
CREATE POLICY exoneration_creation ON demandes_exoneration FOR INSERT
  WITH CHECK (demandeur_uid = mon_uid());
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
CREATE POLICY cloture_lecture_soi     ON cloture_caisse FOR SELECT USING (cloturee_par_uid = mon_uid());
CREATE POLICY cloture_lecture_super   ON cloture_caisse FOR SELECT USING (mon_role_chf() IN ('comptable','direction','administrateur'));
CREATE POLICY cloture_ecriture_soi    ON cloture_caisse FOR ALL    USING (cloturee_par_uid = mon_uid());
```

Cette version (`mon_uid()`, tables `actes`/`medicaments` incluses, `search_path` fixé) est
celle réellement appliquée en base le 23/08 — vérifiée avec `pg_policies` après coup pour
confirmer qu'elle correspond exactement.

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
5. ✅ SQL de l'étape 3 exécuté le 23/08, vérifié par simulation de rôles + `get_advisors`
   (plus aucune erreur de sécurité).
6. ⏳ **Reste à faire par Esdras** : tester chaque écran (Utilisateurs, Demandes, Partenaires,
   Salaires, Clôture, Calculateur, Archives) avec un compte de chaque rôle réel — la simulation
   SQL couvre la logique, pas le vrai jeton Firebase de bout en bout.

## Hors scope de cette passe (mentionné précédemment, pas oublié)
- Numéro de lot calculé côté navigateur (collision possible si 2 personnes génèrent un lot
  au même instant).
- Export Excel/Lots — pas encore relu en détail.
