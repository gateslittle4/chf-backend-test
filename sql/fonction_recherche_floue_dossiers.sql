-- Recherche VRAIMENT tolérante aux fautes de frappe/accents (au-delà de la recherche partielle
-- %nom% déjà en place dans server.js, GET /api/dossiers/recherche) — nécessite l'extension
-- Postgres pg_trgm, pas activable depuis cette session (pas d'accès direct à la base). À coller
-- dans Supabase → SQL Editor par une session qui a cet accès, ou par Esdras.
--
-- Après avoir collé ce fichier, adapter GET /api/dossiers/recherche (server.js) pour appeler
-- cette fonction via supabase.rpc('rechercher_dossiers_flou', { p_nom: nom }) au lieu du
-- .ilike('nom', `%${nom}%`) actuel, avec le même repli défensif que decrementer_stock_medicaments
-- (error.code === '42883' → message clair si la fonction n'existe pas encore).

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_dossiers_nom_trgm ON dossiers USING gin (nom gin_trgm_ops);

CREATE OR REPLACE FUNCTION rechercher_dossiers_flou(p_nom text)
RETURNS SETOF dossiers
LANGUAGE sql STABLE
AS $$
  SELECT * FROM dossiers
  WHERE similarity(nom, p_nom) > 0.25 OR nom ILIKE '%' || p_nom || '%'
  ORDER BY similarity(nom, p_nom) DESC
  LIMIT 20;
$$;
