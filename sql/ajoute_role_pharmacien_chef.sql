-- 09/10 (Esdras) : "pharmacien en chef — il pourra faire tout ce qu'un pharmacien fait, mais il peut modifier les
-- stocks, mais comme cliquable dans rôles et permissions" — nouveau rôle 'pharmacien_chef'. Même piège que
-- ajoute_role_pharmacien.sql / ajoute_role_medecin.sql : sans cette contrainte mise à jour, attribuer le rôle
-- échoue (violation de users_role_check).
--
-- CE SCRIPT REMPLACE ajoute_role_pharmacien.sql : la liste ci-dessous contient À LA FOIS 'pharmacien' et
-- 'pharmacien_chef'. Le coller est sans danger que ajoute_role_pharmacien.sql ait déjà été collé ou non (la
-- contrainte est simplement remplacée par une liste plus complète) ; ne coller que celui-ci suffit.
--
-- UNE SEULE instruction (DROP + ADD dans le même ALTER TABLE), donc atomique : si un compte existant porte un
-- rôle qui n'est pas dans la liste, Postgres refuse (« check constraint "users_role_check" ... is violated by
-- some row ») et RIEN ne change. Avec deux instructions séparées, un échec du ADD après le DROP aurait laissé
-- la table sans aucune contrainte.
-- VÉRIFIÉ le 09/10 sur un Postgres 16 jetable (PAS sur la vraie base) : le rôle est accepté, un rôle inventé est
-- refusé, les comptes existants sont intacts, et l'échec décrit ci-dessus laisse bien l'ancienne contrainte.
--
-- À APPLIQUER sur le projet Supabase woghiwalsxusqtxvpzfo (nommé « chf-backend-test », c'est la production) —
-- SQL Editor — AVANT d'attribuer le rôle. Statut : PAS ENCORE APPLIQUÉ.
-- Droits par défaut du rôle : voir utils/permissions.js (chf-app2) et PERMISSIONS_PAR_DEFAUT / ROLES_INVITABLES
-- (server.js) — les mêmes que 'pharmacien' plus stock_gerer, modifiable dans l'écran Rôles & permissions.

ALTER TABLE users
  DROP CONSTRAINT users_role_check,
  ADD CONSTRAINT users_role_check
    CHECK (role = ANY (ARRAY['administrateur'::text, 'direction'::text, 'comptable'::text, 'auditeur'::text, 'lecteur'::text, 'archiviste'::text, 'infirmier'::text, 'infirmier_chef'::text, 'medecin'::text, 'pharmacien'::text, 'pharmacien_chef'::text, 'visiteur'::text]));
