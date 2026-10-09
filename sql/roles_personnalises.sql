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
-- TROIS ÉTAPES, dans cet ordre :
--   1) une petite fonction de GARDE-FOU, roles_personnalises_actifs(), qui répond « oui » seulement quand la
--      contrainte de l'étape 2 est en place. Le SERVEUR l'interroge avant d'accepter la CRÉATION d'un rôle (et
--      d'un lien d'invitation pour un rôle créé) : tant que ce script n'a pas été collé, l'écran refuse de créer
--      un rôle en disant quoi faire. Sans cela, un compte de connexion pouvait être créé alors que la base
--      refusait son rôle : il restait sans profil, et à sa première connexion l'app lui aurait donné le rôle
--      « auditeur » — des droits que personne n'a décidés. Réservée au serveur (service_role) : ni les visiteurs
--      ni les personnes connectées ne peuvent l'appeler (même principe que PLAN_RLS.md) ; elle ne lit que la
--      définition de la contrainte, rien d'autre.
--   2) le contrôle de FORMAT, en UNE SEULE instruction (DROP + ADD dans le même ALTER TABLE) : atomique. Si un
--      compte existant a un rôle qui ne respecte pas ce format, Postgres refuse (« check constraint
--      "users_role_check" ... is violated by some row ») et RIEN ne change — la fonction de l'étape 1 répond alors
--      « non » (ou n'existe plus, si l'éditeur SQL annule tout le script d'un bloc) et le serveur continue de
--      refuser la création de rôles : aucun état incohérent possible.
--   3) une ligne qui demande à l'API de Supabase de relire la structure tout de suite (sans effet sur les données).
--
-- FORMAT ACCEPTÉ (identique à CLE_ROLE dans utils/roles.js, qu'un test compare sur des centaines d'exemples) :
-- de 3 à 30 caractères ; des minuscules sans accent et des chiffres, le 1er caractère étant une lettre ; des
-- tirets bas ENTRE deux mots seulement (« caissier_nuit » oui ; « Caissier », « 1caissier », « caissier_ »,
-- « caissier__nuit », « caïssier », « caissier nuit » non). Les 12 rôles actuels y entrent tous.
-- Les lettres sont écrites une à une (pas de plage a-z) pour que le résultat ne dépende JAMAIS de la langue du
-- serveur. Comme avant, une valeur vide (NULL) reste permise par la contrainte elle-même.
--
-- Rejouable sans erreur. Remplace aussi ajoute_role_pharmacien.sql et ajoute_role_pharmacien_chef.sql (inutiles
-- une fois celui-ci appliqué : « pharmacien » et « pharmacien_chef » respectent le format).
-- ATTENTION : ne PLUS coller ajoute_role_*.sql après celui-ci — ils remettraient la liste fixe, et les rôles créés
-- depuis l'écran cesseraient de pouvoir être attribués (le serveur le détecterait et refuserait d'en créer).
--
-- VÉRIFIÉ le 09/10 sur un Postgres 16 jetable (PAS sur la vraie base) : rôles actuels acceptés, formats
-- invalides refusés, garde-fou « non » avant et « oui » après, fonction interdite aux visiteurs et aux personnes
-- connectées, échec atomique (instructions séparées comme transaction unique), rejeu, ancien script ajoute_role_*
-- recollé après coup (le garde-fou le voit), et accord exact avec le contrôle du serveur sur 2 000 exemples
-- aléatoires. Dix variantes volontairement cassées de ce script ont toutes été repérées par ces vérifications.
--
-- À APPLIQUER une seule fois sur le projet Supabase woghiwalsxusqtxvpzfo (nommé « chf-backend-test », c'est la
-- production) — SQL Editor — AVANT de créer un rôle depuis l'écran. Statut : PAS ENCORE APPLIQUÉ.

-- 1) Le garde-fou d'abord : tant que la contrainte n'est pas changée, il répond « non ».
CREATE OR REPLACE FUNCTION public.roles_personnalises_actifs()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.users'::regclass
      AND c.conname = 'users_role_check'
      AND pg_get_constraintdef(c.oid) LIKE '%char_length%'
  );
$$;
REVOKE ALL ON FUNCTION public.roles_personnalises_actifs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.roles_personnalises_actifs() TO service_role;

-- 2) Le contrôle de format, en UNE instruction atomique.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check,
  ADD CONSTRAINT users_role_check
    CHECK (
      char_length(role) BETWEEN 3 AND 30
      AND role ~ '^[abcdefghijklmnopqrstuvwxyz][abcdefghijklmnopqrstuvwxyz0123456789]*(_[abcdefghijklmnopqrstuvwxyz0123456789]+)*$'
    );

-- 3) Demande à l'API de Supabase de relire la structure tout de suite, pour que le serveur voie la fonction du 1)
--    sans attendre (sans effet si elle l'a déjà fait toute seule).
NOTIFY pgrst, 'reload schema';
