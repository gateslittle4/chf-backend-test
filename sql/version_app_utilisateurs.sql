-- 27/11 (Esdras) : savoir quelle version de l'application chaque compte fait tourner (écran « Qui est connecté »), pour voir si un poste a bien chargé une version déployée.
-- Additif, sans risque : DEUX colonnes ajoutées à users, vides au départ (« pas encore vue »). Rien d'existant n'est modifié ni supprimé.
-- Tant que ce script n'est pas appliqué, le serveur ignore l'écriture de la version (sans erreur visible) et l'écran « Qui est connecté » fonctionne comme avant.
alter table public.users add column if not exists version_app text;      -- identifiant de la version (le commit déployé)
alter table public.users add column if not exists version_build timestamptz; -- date de construction de cette version
