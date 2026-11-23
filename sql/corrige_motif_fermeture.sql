-- 23/11 (Esdras) : « Problème temporaire côté serveur (archivage) — new row for relation "episodes" violates check constraint "episodes_motif_fermeture_check" ».
-- Cause : le script du 19/10 (hospitaliser_depuis_consultation.sql) a remplacé la liste des motifs de fermeture par une liste qui ne contenait plus les 4 motifs réellement envoyés par l'application
-- (formulaire Hébergement : normale, sans_autorisation, transfert, deces). Toute clôture d'une hospitalisation avec motif de sortie était donc refusée par la base.
-- Correction : la liste contient maintenant les 4 motifs de l'application ET les anciens (exeat_*, hospitalise, fermeture_automatique). Aucune donnée n'est modifiée. DÉJÀ APPLIQUÉ en production le 23/11.
begin;
alter table public.episodes drop constraint if exists episodes_motif_fermeture_check;
alter table public.episodes add constraint episodes_motif_fermeture_check check (motif_fermeture is null or motif_fermeture = any (array[
  'normale','sans_autorisation','transfert','deces',
  'exeat_normal','exeat_sans_autorisation','hospitalise','fermeture_automatique']));
commit;
