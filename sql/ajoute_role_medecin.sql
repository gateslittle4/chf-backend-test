-- ATTENTION — OBSOLÈTE depuis le 09/10 : NE PLUS COLLER ce script. Il remettrait la liste FIXE de rôles dans
-- users_role_check, et les rôles créés depuis l'écran « Rôles & permissions » ne pourraient plus être attribués.
-- Il est remplacé par sql/roles_personnalises.sql (contrôle de FORMAT à la place de la liste fixe, plus aucun SQL à
-- coller pour un nouveau rôle). Conservé pour l'historique, et pour recréer une base depuis zéro AVANT de coller
-- roles_personnalises.sql.
--
-- 30/09 (Krystofia) : "je veux aussi créer un poste docteur, car il y aura quand même des docteurs qui
-- vont créer des dossiers" — nouveau rôle 'medecin'. Même piège que ajoute_role_visiteur.sql et
-- ajoute_role_infirmier_chef.sql : sans cette contrainte mise à jour, attribuer le rôle échoue
-- (violation de users_role_check).
--
-- À APPLIQUER sur le projet Supabase (woghiwalsxusqtxvpzfo) — SQL Editor — AVANT d'attribuer le rôle.
-- Voir aussi utils/permissions.js (chf-app2 : LABELS_ROLE + PERMISSIONS_PAR_DEFAUT) et le miroir
-- PERMISSIONS_PAR_DEFAUT + ROLES_INVITABLES (server.js).

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY['administrateur'::text, 'direction'::text, 'comptable'::text, 'auditeur'::text, 'lecteur'::text, 'archiviste'::text, 'infirmier'::text, 'infirmier_chef'::text, 'medecin'::text, 'visiteur'::text]));
