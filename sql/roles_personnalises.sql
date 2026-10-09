-- 09/10 (Esdras) : « Créer un rôle » directement dans l'app (écran Rôles & permissions) — « c'est trop de
-- choses à faire pour créer un rôle, et je vais en créer d'autres à la demande de la direction ».
--
-- Avant : users_role_check n'autorisait qu'une LISTE FIXE de noms de rôles, donc chaque nouveau rôle (médecin,
-- pharmacien, pharmacien en chef...) demandait un script SQL de plus, collé à la main. Ce script-ci remplace la
-- liste fixe par un simple contrôle de FORMAT : n'importe quel identifiant bien formé est accepté. C'est le
-- SERVEUR (utils/roles.js) qui décide quels rôles existent vraiment — il les enregistre dans la table des
-- permissions (catalog 'permissions') et refuse tout ce qui est suspect. Une fois ce script collé, plus aucun SQL
-- n'est nécessaire pour créer un rôle, qu'il vienne de l'écran ou d'une nouvelle version du code.
--
-- FORMAT ACCEPTÉ (identique à CLE_ROLE dans utils/roles.js, qu'un test compare sur des centaines d'exemples) :
-- de 3 à 30 caractères ; des minuscules sans accent et des chiffres, le 1er caractère étant une lettre ; des
-- tirets bas ENTRE deux mots seulement (« caissier_nuit » oui ; « Caissier », « 1caissier », « caissier_ »,
-- « caissier__nuit », « caïssier », « caissier nuit » non). Les 12 rôles actuels y entrent tous.
-- Les lettres sont écrites une à une (pas de plage a-z) pour que le résultat ne dépende JAMAIS de la langue du
-- serveur. Comme avant, une valeur vide (NULL) reste permise par la contrainte elle-même.
--
-- UNE SEULE instruction (DROP + ADD dans le même ALTER TABLE) : atomique. Si un compte existant a un rôle qui
-- ne respecte pas ce format, Postgres refuse (« check constraint "users_role_check" ... is violated by some
-- row ») et RIEN ne change. Rejouable sans erreur. Remplace aussi ajoute_role_pharmacien.sql et
-- ajoute_role_pharmacien_chef.sql (inutiles une fois celui-ci appliqué : « pharmacien » et « pharmacien_chef »
-- respectent le format).
-- VÉRIFIÉ le 09/10 sur un Postgres 16 jetable (PAS sur la vraie base) : rôles actuels acceptés, formats
-- invalides refusés, échec atomique, rejeu, et accord avec le contrôle du serveur sur des centaines d'exemples.
--
-- À APPLIQUER une seule fois sur le projet Supabase woghiwalsxusqtxvpzfo (nommé « chf-backend-test », c'est la
-- production) — SQL Editor — AVANT d'attribuer un rôle créé depuis l'écran. Statut : PAS ENCORE APPLIQUÉ.
-- Tant qu'il n'est pas appliqué, l'écran peut créer un rôle mais la base refuse de l'attribuer à quelqu'un
-- (message « colle le script roles_personnalises.sql »).

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check,
  ADD CONSTRAINT users_role_check
    CHECK (
      char_length(role) BETWEEN 3 AND 30
      AND role ~ '^[abcdefghijklmnopqrstuvwxyz][abcdefghijklmnopqrstuvwxyz0123456789]*(_[abcdefghijklmnopqrstuvwxyz0123456789]+)*$'
    );
