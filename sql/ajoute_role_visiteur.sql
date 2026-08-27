-- Retour d'Esdras (27/08) : "je veux créer un rôle pour visiteur, voir mais ne peut rien
-- modifier" — ex. le PDG ou sa fille qui veut voir l'app sans avoir accès aux boutons qui
-- annulent/suppriment/modifient une vraie donnée.
--
-- La contrainte users_role_check n'autorisait que les 7 rôles déjà codés en dur
-- (administrateur, direction, comptable, auditeur, lecteur, archiviste, infirmier) — sans ce
-- correctif, créer un utilisateur avec role='visiteur' échoue avec une violation de contrainte
-- (même classe de bug que sql/correctif_mode_remboursement_patient.sql, trouvée et corrigée le
-- même jour). Corrigé cette fois AVANT de coder la fonctionnalité, pas après.
--
-- Déjà appliqué directement sur le projet Supabase (woghiwalsxusqtxvpzfo) via apply_migration —
-- ce fichier documente le changement pour une future recréation de la base depuis zéro.
--
-- Voir aussi utils/permissions.js (chf-app2) et le miroir PERMISSIONS_PAR_DEFAUT (server.js) pour
-- les permissions par défaut du rôle visiteur — uniquement des permissions "voir", jamais une
-- action.

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY['administrateur'::text, 'direction'::text, 'comptable'::text, 'auditeur'::text, 'lecteur'::text, 'archiviste'::text, 'infirmier'::text, 'visiteur'::text]));
