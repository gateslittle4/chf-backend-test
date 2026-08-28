-- Retour d'Esdras (28/08) : "l'infirmier ne peut voir que Dossier/Épisode et Fiche Patient" +
-- "laisse les rapports RMS, c'est pour l'infirmier en chef" — nouveau rôle infirmier_chef (mêmes
-- droits qu'infirmier, plus rapport_chf_voir), pour ne pas donner ce rapport à tous les infirmiers
-- sans distinction.
--
-- Même bug que sql/ajoute_role_visiteur.sql (27/08), reproduit à l'identique : la contrainte
-- users_role_check n'autorisait que les rôles déjà codés en dur, sans infirmier_chef — essayer de
-- mettre un utilisateur ("test3") en infirmier_chef échouait avec une violation de contrainte.
-- Cette fois-ci trouvée APRÈS coup (le rôle avait déjà été ajouté côté code sans mettre à jour
-- cette contrainte) — à vérifier systématiquement à chaque nouveau rôle ajouté.
--
-- Déjà appliqué directement sur le projet Supabase (woghiwalsxusqtxvpzfo) via apply_migration —
-- ce fichier documente le changement pour une future recréation de la base depuis zéro.
--
-- Voir aussi utils/permissions.js (chf-app2, LABELS_ROLE + PERMISSIONS_PAR_DEFAUT) et le miroir
-- PERMISSIONS_PAR_DEFAUT (server.js) pour les permissions par défaut du rôle infirmier_chef.

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY['administrateur'::text, 'direction'::text, 'comptable'::text, 'auditeur'::text, 'lecteur'::text, 'archiviste'::text, 'infirmier'::text, 'infirmier_chef'::text, 'visiteur'::text]));
