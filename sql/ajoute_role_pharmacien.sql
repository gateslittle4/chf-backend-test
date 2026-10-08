-- 08/10 (Krystofia) : "créer un rôle pharmacien avec la même logique que celui de la caisse, mais il voit
-- l'onglet pharmacie" — nouveau rôle 'pharmacien'. Même piège que ajoute_role_medecin.sql : sans cette
-- contrainte mise à jour, attribuer le rôle échoue (violation de users_role_check).
--
-- À APPLIQUER sur le projet Supabase (woghiwalsxusqtxvpzfo) — SQL Editor — AVANT d'attribuer le rôle.
-- Voir aussi utils/permissions.js (chf-app2 : LABELS_ROLE + PERMISSIONS_PAR_DEFAUT + permission
-- pharmacie_voir) et le miroir PERMISSIONS_PAR_DEFAUT + ROLES_INVITABLES (server.js).

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY['administrateur'::text, 'direction'::text, 'comptable'::text, 'auditeur'::text, 'lecteur'::text, 'archiviste'::text, 'infirmier'::text, 'infirmier_chef'::text, 'medecin'::text, 'pharmacien'::text, 'visiteur'::text]));
