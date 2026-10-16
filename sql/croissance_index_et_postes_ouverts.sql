-- sql/croissance_index_et_postes_ouverts.sql — préparer la croissance de la base (16/10, simulation à 5 ans). Entièrement AJOUTÉ, rejouable, aucune donnée touchée.
--
-- 1. Index sur les colonnes que les listes et le journal trient :
--    - audit_log(date)            : le journal d'audit lit « les 300 dernières lignes » — 38 ms → 1,6 ms à 730 000 lignes (mesuré), sans index il trie toute la table ;
--    - episodes(date_ouverture)   : la lecture complète de la liste d'épisodes trie par date d'ouverture — de 25 s à 20 s au total à 175 000 épisodes (mesuré) ;
--    - paiements(date_paiement)   : idem pour les paiements — de 110 s à 62 s à 341 000 paiements (mesuré).
--    Index PARTIELS (supprime_le IS NULL) pour correspondre exactement à la requête du serveur.
-- 2. sessions_caisse_ouvertes() : ne renvoie que les postes de caisse OUVERTS. La fermeture automatique (chaque minute) relisait toute la liste des sessions,
--    qui grossit de ~400 Ko par an — ~18 Go par mois de lecture à 1 an, ~90 Go à 5 ans. Les postes ouverts sont quelques-uns. Le serveur retombe sur l'ancienne
--    lecture complète tant que cette fonction n'existe pas.
-- Réservée au serveur (clé de service). À coller dans Supabase → SQL Editor.

CREATE INDEX IF NOT EXISTS idx_audit_log_date ON public.audit_log (date DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_date_ouverture ON public.episodes (date_ouverture DESC, id) WHERE supprime_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_paiements_date_paiement ON public.paiements (date_paiement DESC, id) WHERE supprime_le IS NULL;

CREATE OR REPLACE FUNCTION public.sessions_caisse_ouvertes() RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT coalesce(jsonb_agg(e.elem), '[]'::jsonb)
  FROM catalog c
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.items) = 'array' THEN c.items ELSE '[]'::jsonb END) AS e(elem)
  WHERE c.type = 'sessions_caisse' AND e.elem ->> 'statut' = 'ouverte';
$$;

REVOKE EXECUTE ON FUNCTION public.sessions_caisse_ouvertes() FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.sessions_caisse_ouvertes() TO service_role;
  END IF;
END $$;
