-- Dernière activité de chaque compte (écran « Qui est connecté »). Additif, sans risque.
alter table public.users add column if not exists derniere_activite timestamptz;
