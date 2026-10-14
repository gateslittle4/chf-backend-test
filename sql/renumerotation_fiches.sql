-- 14/10 (demande d'Esdras, reprise de chf-demo2) : insérer une fiche oubliée ENTRE deux fiches, et refermer la numérotation quand une fiche est supprimée.
--
-- Contrainte à respecter : (episode_id, numero_fiche) est UNIQUE (voir ajoute_contrainte_numero_fiche_unique.sql) et compte AUSSI les fiches
-- à la corbeille (supprime_le non nul). Donc :
--   * une fiche mise à la corbeille LIBÈRE son numéro (numero_fiche = NULL, l'ancien numéro est gardé dans numero_fiche_avant) ;
--   * une fiche restaurée reçoit le prochain numéro libre (voir POST /api/fiches/:id/restaurer, server.js) ;
--   * les décalages se font en deux temps (négatif, puis positif) pour ne jamais violer la contrainte en cours de route.
-- Tout est atomique (une fonction = une transaction). Additif et relançable : IF NOT EXISTS / CREATE OR REPLACE, aucun DROP.
-- À coller dans Supabase → SQL Editor.

ALTER TABLE public.fiches ADD COLUMN IF NOT EXISTS numero_fiche_avant bigint;

-- Renumérote les fiches ACTIVES d'un épisode en 1..n (ordre actuel des numéros, puis date de création, puis id) et libère le numéro des fiches
-- à la corbeille. Renvoie le numéro de chaque fiche active après l'opération.
CREATE OR REPLACE FUNCTION public.renumeroter_fiches(p_episode uuid)
RETURNS TABLE(id uuid, numero_fiche bigint)
LANGUAGE plpgsql
AS $$
BEGIN
  -- 1. Verrou sur l'épisode : deux renumérotations simultanées s'enchaînent au lieu de se croiser.
  PERFORM 1 FROM public.episodes e WHERE e.id = p_episode FOR UPDATE;

  -- 2. Les fiches à la corbeille lâchent leur numéro (gardé dans numero_fiche_avant).
  UPDATE public.fiches f
     SET numero_fiche_avant = COALESCE(f.numero_fiche_avant, f.numero_fiche), numero_fiche = NULL
   WHERE f.episode_id = p_episode AND f.supprime_le IS NOT NULL AND f.numero_fiche IS NOT NULL;

  -- 3. Les fiches actives passent en négatif (aucune collision possible), puis reçoivent 1..n.
  UPDATE public.fiches f SET numero_fiche = -f.numero_fiche
   WHERE f.episode_id = p_episode AND f.supprime_le IS NULL AND f.numero_fiche IS NOT NULL;

  UPDATE public.fiches f SET numero_fiche = classement.rang
    FROM (
      SELECT g.id AS fiche_id, row_number() OVER (ORDER BY g.numero_fiche DESC, g.date_creation, g.id) AS rang
        FROM public.fiches g
       WHERE g.episode_id = p_episode AND g.supprime_le IS NULL AND g.numero_fiche IS NOT NULL
    ) classement
   WHERE f.id = classement.fiche_id;
  -- (numero_fiche négatif : l'ordre DÉCROISSANT de la valeur négative = l'ordre CROISSANT des anciens numéros)

  -- 4. Une fiche active SANS numéro (cas anormal) est rangée à la suite.
  UPDATE public.fiches f SET numero_fiche = suite.rang
    FROM (
      SELECT g.id AS fiche_id,
             (SELECT COALESCE(max(h.numero_fiche), 0) FROM public.fiches h WHERE h.episode_id = p_episode)
             + row_number() OVER (ORDER BY g.date_creation, g.id) AS rang
        FROM public.fiches g
       WHERE g.episode_id = p_episode AND g.supprime_le IS NULL AND g.numero_fiche IS NULL
    ) suite
   WHERE f.id = suite.fiche_id;

  RETURN QUERY
    SELECT f.id, f.numero_fiche FROM public.fiches f
     WHERE f.episode_id = p_episode AND f.supprime_le IS NULL ORDER BY f.numero_fiche;
END;
$$;

-- Fait de la place pour une fiche insérée au numéro p_a_partir_de : toutes les fiches (actives ou à la corbeille qui ont encore un numéro)
-- dont le numéro est >= p_a_partir_de avancent de 1. Renvoie le nombre de fiches décalées.
CREATE OR REPLACE FUNCTION public.decaler_fiches(p_episode uuid, p_a_partir_de bigint)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_nb integer;
BEGIN
  PERFORM 1 FROM public.episodes e WHERE e.id = p_episode FOR UPDATE;
  UPDATE public.fiches f SET numero_fiche = -(f.numero_fiche + 1)
   WHERE f.episode_id = p_episode AND f.numero_fiche >= p_a_partir_de;
  GET DIAGNOSTICS v_nb = ROW_COUNT;
  UPDATE public.fiches f SET numero_fiche = -f.numero_fiche
   WHERE f.episode_id = p_episode AND f.numero_fiche < 0;
  RETURN v_nb;
END;
$$;
