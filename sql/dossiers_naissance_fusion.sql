-- 14/10 — Dossier de naissance (bébé lié à sa mère, nouveau nom du bébé) et fusion de doublons d'identité.
--
-- 1) NAISSANCE : mere_dossier_id relie le dossier d'un nouveau-né à celui de sa mère ; anciens_noms garde la trace de chaque nom
--    qu'a eu le dossier (le nom temporaire du néonat « Bébé Marie Joseph », puis le vrai prénom donné par la mère — nom_origine, lui,
--    reste le nom de la TOUTE première création, voir ajoute_nom_origine_dossiers.sql).
-- 2) FUSION : deux dossiers qui sont la même personne peuvent être réunis. Rien n'est supprimé : le dossier « source » reste en base,
--    marqué fusionne_dans = dossier « cible », caché des recherches ; ses épisodes et pièces jointes passent à la cible. La fusion est
--    ANNULABLE (defusionner_dossiers) parce que les listes de ce qui a été déplacé sont gardées sur la ligne du dossier source.
-- 3) doublons_ignores : paires que quelqu'un a examinées et déclarées « ce ne sont pas les mêmes personnes » (ne plus les proposer).
--
-- SANS DANGER À COLLER : colonnes nullables / avec défaut, nouvelle table, fonctions nouvelles (CREATE OR REPLACE). Le serveur (server.js)
-- fonctionne encore sans ce script (repli sur l'absence de colonnes, 42703) : le coller ACTIVE les fonctionnalités, ne casse rien avant.
-- Se rejoue sans erreur. Testé sur un Postgres jetable : scripts/test-naissance-fusion-sql.py.

ALTER TABLE public.dossiers ADD COLUMN IF NOT EXISTS mere_dossier_id uuid REFERENCES public.dossiers(id) ON DELETE SET NULL;
ALTER TABLE public.dossiers ADD COLUMN IF NOT EXISTS anciens_noms jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.dossiers ADD COLUMN IF NOT EXISTS fusionne_dans uuid REFERENCES public.dossiers(id) ON DELETE SET NULL;
ALTER TABLE public.dossiers ADD COLUMN IF NOT EXISTS fusionne_le timestamptz;
ALTER TABLE public.dossiers ADD COLUMN IF NOT EXISTS fusionne_par text;
ALTER TABLE public.dossiers ADD COLUMN IF NOT EXISTS fusion_details jsonb;

DO $$ BEGIN
  ALTER TABLE public.dossiers ADD CONSTRAINT dossiers_mere_pas_soi CHECK (mere_dossier_id IS NULL OR mere_dossier_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.dossiers ADD CONSTRAINT dossiers_fusion_pas_soi CHECK (fusionne_dans IS NULL OR fusionne_dans <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_dossiers_mere ON public.dossiers (mere_dossier_id) WHERE mere_dossier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dossiers_fusionne_dans ON public.dossiers (fusionne_dans) WHERE fusionne_dans IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dossiers_date_naissance ON public.dossiers (date_naissance);

CREATE TABLE IF NOT EXISTS public.doublons_ignores (
  dossier_a uuid NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  dossier_b uuid NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  ignore_par text,
  ignore_le timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dossier_a, dossier_b),
  CHECK (dossier_a < dossier_b)
);
ALTER TABLE public.doublons_ignores ENABLE ROW LEVEL SECURITY; -- aucune policy : seul le serveur (clé de service) y accède

-- Recherche floue : ne montre JAMAIS un dossier fusionné, et retrouve aussi un dossier par un de ses anciens noms.
CREATE OR REPLACE FUNCTION public.rechercher_dossiers_flou(p_nom text)
RETURNS SETOF public.dossiers
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  SELECT * FROM dossiers
  WHERE fusionne_dans IS NULL
    AND (similarity(nom, p_nom) > 0.25 OR nom ILIKE '%' || p_nom || '%'
      OR similarity(nom_origine, p_nom) > 0.25 OR nom_origine ILIKE '%' || p_nom || '%'
      OR anciens_noms::text ILIKE '%' || p_nom || '%')
  ORDER BY GREATEST(similarity(nom, p_nom), similarity(nom_origine, p_nom)) DESC
  LIMIT 20;
$$;

-- FUSION. Codes d'erreur (SQLSTATE, 5 caractères) : CHF11 introuvable · CHF12 même dossier · CHF13 source déjà fusionnée · CHF14 cible déjà fusionnée ·
-- CHF15 la cible est un enfant de la source (cycle mère/enfant) · CHF16 (défusion) ce dossier n'a pas été fusionné. Renvoie ce qui a été déplacé.
CREATE OR REPLACE FUNCTION public.fusionner_dossiers(p_source uuid, p_cible uuid, p_par text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  s public.dossiers; c public.dossiers;
  v_eps uuid[]; v_pieces uuid[]; v_enfants uuid[]; v_champs jsonb := '{}'::jsonb; v_ouverts int;
BEGIN
  IF p_source IS NULL OR p_cible IS NULL OR p_source = p_cible THEN RAISE EXCEPTION 'Un dossier ne peut pas être fusionné avec lui-même.' USING errcode = 'CHF12' ; END IF;
  -- verrou dans l'ordre des identifiants : deux fusions croisées ne s'attendent pas l'une l'autre
  PERFORM 1 FROM dossiers WHERE id IN (p_source, p_cible) ORDER BY id FOR UPDATE;
  SELECT * INTO s FROM dossiers WHERE id = p_source;
  SELECT * INTO c FROM dossiers WHERE id = p_cible;
  IF s.id IS NULL OR c.id IS NULL THEN RAISE EXCEPTION 'Dossier introuvable.' USING errcode = 'CHF11'; END IF;
  IF s.fusionne_dans IS NOT NULL THEN RAISE EXCEPTION 'Ce dossier a déjà été fusionné dans un autre.' USING errcode = 'CHF13'; END IF;
  IF c.fusionne_dans IS NOT NULL THEN RAISE EXCEPTION 'Le dossier cible a lui-même été fusionné dans un autre.' USING errcode = 'CHF14'; END IF;
  IF c.mere_dossier_id = s.id THEN RAISE EXCEPTION 'Le dossier cible est un enfant du dossier à fusionner.' USING errcode = 'CHF15'; END IF;

  WITH deplaces AS (UPDATE episodes SET dossier_id = p_cible WHERE dossier_id = p_source RETURNING id)
  SELECT coalesce(array_agg(id), '{}') INTO v_eps FROM deplaces;
  WITH deplaces AS (UPDATE pieces_jointes SET dossier_id = p_cible WHERE dossier_id = p_source RETURNING id)
  SELECT coalesce(array_agg(id), '{}') INTO v_pieces FROM deplaces;
  WITH deplaces AS (UPDATE dossiers SET mere_dossier_id = p_cible WHERE mere_dossier_id = p_source RETURNING id)
  SELECT coalesce(array_agg(id), '{}') INTO v_enfants FROM deplaces;

  -- La cible garde ses valeurs ; seuls ses trous sont comblés avec ceux de la source (et notés, pour pouvoir annuler).
  IF c.date_naissance IS NULL AND s.date_naissance IS NOT NULL THEN v_champs := v_champs || jsonb_build_object('date_naissance', s.date_naissance); END IF;
  IF coalesce(c.telephone, '') = '' AND coalesce(s.telephone, '') <> '' THEN v_champs := v_champs || jsonb_build_object('telephone', s.telephone); END IF;
  IF coalesce(c.adresse, '') = '' AND coalesce(s.adresse, '') <> '' THEN v_champs := v_champs || jsonb_build_object('adresse', s.adresse); END IF;
  IF c.sexe IS NULL AND s.sexe IS NOT NULL THEN v_champs := v_champs || jsonb_build_object('sexe', s.sexe); END IF;
  IF c.poids IS NULL AND s.poids IS NOT NULL THEN v_champs := v_champs || jsonb_build_object('poids', s.poids); END IF;
  IF coalesce(c.conjoint, '') = '' AND coalesce(s.conjoint, '') <> '' THEN v_champs := v_champs || jsonb_build_object('conjoint', s.conjoint); END IF;
  IF c.mere_dossier_id IS NULL AND s.mere_dossier_id IS NOT NULL AND s.mere_dossier_id <> c.id THEN v_champs := v_champs || jsonb_build_object('mere_dossier_id', s.mere_dossier_id); END IF;

  UPDATE dossiers SET
    date_naissance = coalesce(date_naissance, (v_champs->>'date_naissance')::date),
    telephone = CASE WHEN v_champs ? 'telephone' THEN v_champs->>'telephone' ELSE telephone END,
    adresse = CASE WHEN v_champs ? 'adresse' THEN v_champs->>'adresse' ELSE adresse END,
    sexe = coalesce(sexe, v_champs->>'sexe'),
    poids = coalesce(poids, (v_champs->>'poids')::numeric),
    conjoint = CASE WHEN v_champs ? 'conjoint' THEN v_champs->>'conjoint' ELSE conjoint END,
    mere_dossier_id = coalesce(mere_dossier_id, (v_champs->>'mere_dossier_id')::uuid),
    -- les noms du dossier fusionné restent retrouvables par la cible (recherche, doublons futurs)
    anciens_noms = anciens_noms || jsonb_build_array(jsonb_build_object('nom', s.nom, 'jusqu_au', now(), 'origine', 'fusion', 'dossier', s.id, 'numero_dossier', s.numero_dossier))
  WHERE id = p_cible;

  UPDATE dossiers SET fusionne_dans = p_cible, fusionne_le = now(), fusionne_par = p_par,
    fusion_details = jsonb_build_object('episodes', to_jsonb(v_eps), 'pieces', to_jsonb(v_pieces), 'enfants', to_jsonb(v_enfants), 'champs_combles', v_champs)
  WHERE id = p_source;

  SELECT count(*) INTO v_ouverts FROM episodes WHERE dossier_id = p_cible AND statut = 'ouvert' AND supprime_le IS NULL;
  RETURN jsonb_build_object('source', p_source, 'cible', p_cible, 'episodes_deplaces', coalesce(array_length(v_eps, 1), 0),
    'pieces_deplacees', coalesce(array_length(v_pieces, 1), 0), 'enfants_rattaches', coalesce(array_length(v_enfants, 1), 0),
    'champs_combles', v_champs, 'episodes_ouverts_apres', v_ouverts);
END;
$$;

-- ANNULER une fusion : remet à la source exactement ce qui lui avait été pris (et seulement si la cible ne l'a pas changé depuis).
CREATE OR REPLACE FUNCTION public.defusionner_dossiers(p_source uuid, p_par text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  s public.dossiers; c public.dossiers; d jsonb; v_eps int; v_pieces int; v_enfants int;
BEGIN
  SELECT * INTO s FROM dossiers WHERE id = p_source FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Dossier introuvable.' USING errcode = 'CHF11'; END IF;
  IF s.fusionne_dans IS NULL THEN RAISE EXCEPTION 'Ce dossier n''a pas été fusionné.' USING errcode = 'CHF16'; END IF;
  SELECT * INTO c FROM dossiers WHERE id = s.fusionne_dans FOR UPDATE;
  d := coalesce(s.fusion_details, '{}'::jsonb);

  WITH r AS (UPDATE episodes SET dossier_id = p_source
              WHERE dossier_id = s.fusionne_dans AND id IN (SELECT (jsonb_array_elements_text(d->'episodes'))::uuid) RETURNING id)
  SELECT count(*) INTO v_eps FROM r;
  WITH r AS (UPDATE pieces_jointes SET dossier_id = p_source
              WHERE dossier_id = s.fusionne_dans AND id IN (SELECT (jsonb_array_elements_text(d->'pieces'))::uuid) RETURNING id)
  SELECT count(*) INTO v_pieces FROM r;
  WITH r AS (UPDATE dossiers SET mere_dossier_id = p_source
              WHERE mere_dossier_id = s.fusionne_dans AND id IN (SELECT (jsonb_array_elements_text(d->'enfants'))::uuid) RETURNING id)
  SELECT count(*) INTO v_enfants FROM r;

  -- champs comblés : retirés de la cible seulement s'ils ont encore la valeur qui y avait été mise
  UPDATE dossiers SET
    date_naissance = CASE WHEN d->'champs_combles' ? 'date_naissance' AND date_naissance = (d->'champs_combles'->>'date_naissance')::date THEN NULL ELSE date_naissance END,
    telephone = CASE WHEN d->'champs_combles' ? 'telephone' AND telephone = d->'champs_combles'->>'telephone' THEN NULL ELSE telephone END,
    adresse = CASE WHEN d->'champs_combles' ? 'adresse' AND adresse = d->'champs_combles'->>'adresse' THEN NULL ELSE adresse END,
    sexe = CASE WHEN d->'champs_combles' ? 'sexe' AND sexe = d->'champs_combles'->>'sexe' THEN NULL ELSE sexe END,
    poids = CASE WHEN d->'champs_combles' ? 'poids' AND poids = (d->'champs_combles'->>'poids')::numeric THEN NULL ELSE poids END,
    conjoint = CASE WHEN d->'champs_combles' ? 'conjoint' AND conjoint = d->'champs_combles'->>'conjoint' THEN NULL ELSE conjoint END,
    mere_dossier_id = CASE WHEN d->'champs_combles' ? 'mere_dossier_id' AND mere_dossier_id = (d->'champs_combles'->>'mere_dossier_id')::uuid THEN NULL ELSE mere_dossier_id END,
    anciens_noms = coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(anciens_noms) e
                              WHERE NOT (e->>'origine' = 'fusion' AND e->>'dossier' = p_source::text)), '[]'::jsonb)
  WHERE id = s.fusionne_dans;

  UPDATE dossiers SET fusionne_dans = NULL, fusionne_le = NULL, fusionne_par = NULL, fusion_details = NULL WHERE id = p_source;
  RETURN jsonb_build_object('source', p_source, 'cible', c.id, 'episodes_remis', v_eps, 'pieces_remises', v_pieces, 'enfants_remis', v_enfants);
END;
$$;

-- Ces deux fonctions ne sont appelées que par le serveur (clé de service) : pas par un navigateur avec la clé publique.
REVOKE EXECUTE ON FUNCTION public.fusionner_dossiers(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.defusionner_dossiers(uuid, text) FROM PUBLIC, anon, authenticated;

-- Le serveur (clé de service) garde le droit d'exécution explicitement (sur Supabase il l'a déjà par défaut ; le dire ici évite qu'un retrait du droit PUBLIC le lui enlève).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.fusionner_dossiers(uuid, uuid, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.defusionner_dossiers(uuid, text) TO service_role;
  END IF;
END $$;
