-- sql/recherche_dossiers_grands_volumes.sql — recherche de dossiers par nom, rapide même avec des dizaines de milliers de dossiers (15/10).
-- Mesure (Postgres jetable, scripts/bench-recherche-dossiers-sql.py) : l'ancienne fonction lisait TOUTE la table à chaque frappe — 80 ms à 5 000 dossiers, 330 ms à 50 000,
-- 1,1 s à 200 000 — parce que `similarity(nom, …) > 0.25` et `anciens_noms::text ILIKE …` ne peuvent pas utiliser d'index. Ici : l'opérateur `%` (même seuil de 0,25, mais
-- compatible avec l'index trigramme) et un index sur anciens_noms. Mêmes résultats, mêmes colonnes, même ordre, même limite de 20 : rien ne change pour l'écran.
-- Rejouable sans danger (CREATE ... IF NOT EXISTS / OR REPLACE) ; n'enlève ni ne modifie aucune donnée.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_dossiers_nom_trgm ON public.dossiers USING gin (nom gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_dossiers_nom_origine_trgm ON public.dossiers USING gin (nom_origine gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_dossiers_anciens_noms_trgm ON public.dossiers USING gin ((anciens_noms::text) gin_trgm_ops) WHERE anciens_noms IS NOT NULL;

CREATE OR REPLACE FUNCTION public.rechercher_dossiers_flou(p_nom text)
RETURNS SETOF public.dossiers
LANGUAGE sql STABLE
SET pg_trgm.similarity_threshold TO '0.25'
AS $$
  SELECT d.* FROM public.dossiers d
  WHERE d.fusionne_dans IS NULL
    AND (d.nom % p_nom OR d.nom ILIKE '%' || p_nom || '%'
      OR d.nom_origine % p_nom OR d.nom_origine ILIKE '%' || p_nom || '%'
      OR (d.anciens_noms IS NOT NULL AND d.anciens_noms::text ILIKE '%' || p_nom || '%'))
  ORDER BY GREATEST(similarity(d.nom, p_nom), similarity(d.nom_origine, p_nom)) DESC
  LIMIT 20;
$$;
