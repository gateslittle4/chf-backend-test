-- 14/10 — État du système (page réservée à l'administrateur) : suivi des postes et des erreurs de l'application.
--
-- postes_etat : UNE ligne par poste (navigateur) — chaque poste signale sa santé toutes les quelques minutes (file d'attente, opérations
--   refusées, horloge, dernière synchronisation, version). L'heure de dernière vue est celle du SERVEUR, jamais celle de l'ordinateur.
-- erreurs_client : les erreurs JavaScript réellement vues sur les postes, regroupées par empreinte (même erreur = une ligne avec un
--   compteur), avec un statut (nouveau / vu / résolu). Une erreur « résolue » qui revient repasse à « nouveau ».
--
-- SANS DANGER À COLLER : deux nouvelles tables (RLS activée, aucune policy : seul le serveur y accède) et deux fonctions nouvelles.
-- Le serveur répond « tables manquantes » à l'écran tant que ce script n'est pas collé, sans erreur ailleurs. Se rejoue sans erreur.
-- Testé sur un Postgres jetable : scripts/test-naissance-fusion-sql.py.

CREATE TABLE IF NOT EXISTS public.postes_etat (
  poste_id text PRIMARY KEY CHECK (length(poste_id) BETWEEN 8 AND 64),
  uid text, utilisateur text, role text,
  premier_le timestamptz NOT NULL DEFAULT now(),
  vu_le timestamptz NOT NULL DEFAULT now(),
  version_app text, appareil text, onglet text,
  en_ligne boolean NOT NULL DEFAULT true,
  en_attente integer NOT NULL DEFAULT 0 CHECK (en_attente >= 0),
  bloquees integer NOT NULL DEFAULT 0 CHECK (bloquees >= 0),
  anciennete_file_s integer,
  derniere_sync_le timestamptz,
  decalage_ms bigint,
  latence_ms integer,
  erreurs_recentes integer NOT NULL DEFAULT 0 CHECK (erreurs_recentes >= 0)
);
CREATE INDEX IF NOT EXISTS idx_postes_etat_vu ON public.postes_etat (vu_le DESC);
ALTER TABLE public.postes_etat ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.erreurs_client (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empreinte text NOT NULL UNIQUE,
  message text NOT NULL,
  pile text,
  source text NOT NULL DEFAULT 'js' CHECK (source IN ('js', 'promesse', 'react')),
  onglet text, version_app text,
  premiere_le timestamptz NOT NULL DEFAULT now(),
  derniere_le timestamptz NOT NULL DEFAULT now(),
  nombre integer NOT NULL DEFAULT 1,
  postes text[] NOT NULL DEFAULT '{}',
  utilisateurs text[] NOT NULL DEFAULT '{}',
  statut text NOT NULL DEFAULT 'nouveau' CHECK (statut IN ('nouveau', 'vu', 'resolu')),
  traite_par text, traite_le timestamptz
);
CREATE INDEX IF NOT EXISTS idx_erreurs_client_derniere ON public.erreurs_client (derniere_le DESC);
ALTER TABLE public.erreurs_client ENABLE ROW LEVEL SECURITY;

-- Enregistre une erreur : nouvelle ligne, ou +1 sur la ligne de la même empreinte (postes et utilisateurs concernés gardés, 20 au plus).
CREATE OR REPLACE FUNCTION public.signaler_erreur_client(
  p_empreinte text, p_message text, p_pile text, p_source text, p_onglet text, p_version text, p_poste text, p_utilisateur text, p_nombre integer DEFAULT 1
) RETURNS public.erreurs_client
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE r public.erreurs_client;
BEGIN
  INSERT INTO erreurs_client AS e (empreinte, message, pile, source, onglet, version_app, nombre, postes, utilisateurs)
  VALUES (p_empreinte, left(p_message, 500), left(p_pile, 4000), coalesce(nullif(p_source, ''), 'js'), left(p_onglet, 60), left(p_version, 40), greatest(1, least(coalesce(p_nombre, 1), 50)),
          CASE WHEN p_poste IS NULL THEN '{}' ELSE ARRAY[left(p_poste, 64)] END,
          CASE WHEN p_utilisateur IS NULL THEN '{}' ELSE ARRAY[left(p_utilisateur, 80)] END)
  ON CONFLICT (empreinte) DO UPDATE SET
    nombre = e.nombre + greatest(1, least(coalesce(p_nombre, 1), 50)),
    derniere_le = now(),
    version_app = coalesce(left(p_version, 40), e.version_app),
    onglet = coalesce(left(p_onglet, 60), e.onglet),
    postes = (SELECT coalesce(array_agg(x), '{}') FROM (SELECT DISTINCT x FROM unnest(CASE WHEN p_poste IS NULL THEN e.postes ELSE e.postes || left(p_poste, 64) END) x LIMIT 20) q),
    utilisateurs = (SELECT coalesce(array_agg(x), '{}') FROM (SELECT DISTINCT x FROM unnest(CASE WHEN p_utilisateur IS NULL THEN e.utilisateurs ELSE e.utilisateurs || left(p_utilisateur, 80) END) x LIMIT 20) q),
    statut = CASE WHEN e.statut = 'resolu' THEN 'nouveau' ELSE e.statut END,
    traite_par = CASE WHEN e.statut = 'resolu' THEN NULL ELSE e.traite_par END,
    traite_le = CASE WHEN e.statut = 'resolu' THEN NULL ELSE e.traite_le END
  RETURNING * INTO r;
  RETURN r;
END;
$$;

-- Ménage : efface les erreurs « résolues » de plus de 90 jours et les postes jamais revus depuis 90 jours. Renvoie le nombre de lignes retirées.
CREATE OR REPLACE FUNCTION public.nettoyer_etat_systeme() RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE a int; b int;
BEGIN
  DELETE FROM erreurs_client WHERE statut = 'resolu' AND derniere_le < now() - interval '90 days';
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM postes_etat WHERE vu_le < now() - interval '90 days';
  GET DIAGNOSTICS b = ROW_COUNT;
  RETURN a + b;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.signaler_erreur_client(text, text, text, text, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nettoyer_etat_systeme() FROM PUBLIC, anon, authenticated;

-- Le serveur (clé de service) garde le droit d'exécution explicitement (sur Supabase il l'a déjà par défaut ; le dire ici évite qu'un retrait du droit PUBLIC le lui enlève).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.signaler_erreur_client(text, text, text, text, text, text, text, text, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.nettoyer_etat_systeme() TO service_role;
  END IF;
END $$;
