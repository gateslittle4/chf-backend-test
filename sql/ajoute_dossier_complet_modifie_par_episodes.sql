-- 14/10 (version chf-demo2 de l'onglet Lots, demande d'Esdras) : deux ajouts sur les épisodes.
--   dossier_complet : case de suivi visuel dans la liste d'un lot (« ce dossier est prêt »). N'affecte NI la facturation NI le statut.
--   modifie_par / modifie_par_uid : qui a modifié le dossier en dernier (affiché dans l'onglet Lots).
-- Additif et relançable : IF NOT EXISTS, valeur par défaut false, aucun DROP/REVOKE. Le serveur marche sans ce script (il ne signe
-- simplement pas les modifications), sauf pour la case « dossier complet » qui répond alors une erreur claire.
ALTER TABLE public.episodes ADD COLUMN IF NOT EXISTS dossier_complet boolean NOT NULL DEFAULT false;
ALTER TABLE public.episodes ADD COLUMN IF NOT EXISTS modifie_par text;
ALTER TABLE public.episodes ADD COLUMN IF NOT EXISTS modifie_par_uid text;
