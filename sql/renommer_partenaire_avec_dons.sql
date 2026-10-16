-- sql/renommer_partenaire_avec_dons.sql — renommer un partenaire sans couper son historique NI ses dons de médicaments (16/10).
-- Remplace renommer_partenaire(id, nom) de partenaires_identifiant_stable.sql : même résultat, plus le stock donné par ce partenaire.
-- Ce que ça change quand on renomme « Ancien » en « Nouveau » :
--   1. ong_partenaires.nom ;
--   2. episodes.ong_partenaire et paiements.ong_partenaire — les lignes rattachées à ce partenaire par identifiant, plus celles qui portent encore l'ancien nom
--      sans identifiant (même nom, majuscules et espaces ignorés) ; le déclencheur rattacher_partenaire_id remet l'identifiant tout seul ;
--   3. catalog.medicaments[].donsParOng : la clé « Ancien » devient « Nouveau » (si « Nouveau » existait déjà comme clé, les quantités s'additionnent).
-- Tout-ou-rien (une seule transaction). Renvoie { episodes, paiements, dons } = nombre de lignes / de médicaments touchés.
-- Réservée au serveur (clé de service) : c'est la route PATCH /api/ong-partenaires/:id/renommer qui décide qui a le droit (administrateur, direction).
-- Rejouable sans danger. À coller dans Supabase → SQL Editor (nécessite d'abord partenaires_identifiant_stable.sql).

CREATE OR REPLACE FUNCTION public.renommer_partenaire(p_id text, p_nouveau_nom text) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  v_nom text := btrim(coalesce(p_nouveau_nom, ''));
  v_ancien text;
  v_ep int := 0; v_pa int := 0; v_dons int := 0;
  v_items jsonb; v_nouveaux jsonb;
BEGIN
  IF v_nom = '' THEN RAISE EXCEPTION 'Le nouveau nom est vide.' USING errcode = 'CHF20'; END IF;
  SELECT nom INTO v_ancien FROM ong_partenaires WHERE id = p_id AND supprime_le IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Partenaire introuvable.' USING errcode = 'CHF21'; END IF;
  IF EXISTS (SELECT 1 FROM ong_partenaires WHERE id <> p_id AND supprime_le IS NULL AND lower(btrim(nom)) = lower(v_nom)) THEN
    RAISE EXCEPTION 'Un autre partenaire porte déjà ce nom.' USING errcode = 'CHF22';
  END IF;
  IF v_ancien = v_nom THEN
    RETURN jsonb_build_object('episodes', 0, 'paiements', 0, 'dons', 0, 'inchange', true);
  END IF;

  UPDATE ong_partenaires SET nom = v_nom WHERE id = p_id;

  UPDATE episodes SET ong_partenaire = v_nom
   WHERE ong_partenaire_id = p_id
      OR (ong_partenaire_id IS NULL AND lower(btrim(coalesce(ong_partenaire, ''))) = lower(btrim(v_ancien)));
  GET DIAGNOSTICS v_ep = ROW_COUNT;
  UPDATE paiements SET ong_partenaire = v_nom
   WHERE ong_partenaire_id = p_id
      OR (ong_partenaire_id IS NULL AND lower(btrim(coalesce(ong_partenaire, ''))) = lower(btrim(v_ancien)));
  GET DIAGNOSTICS v_pa = ROW_COUNT;

  -- Dons : la clé est le NOM exact écrit au moment du don ; on cherche l'ancienne clé telle quelle ET sa variante de casse/espaces.
  SELECT items INTO v_items FROM catalog WHERE type = 'medicaments' FOR UPDATE;
  IF v_items IS NOT NULL AND jsonb_typeof(v_items) = 'array' AND jsonb_array_length(v_items) > 0 THEN
    SELECT jsonb_agg(
             CASE WHEN jsonb_typeof(t.elem -> 'donsParOng') = 'object' AND EXISTS (
                    SELECT 1 FROM jsonb_object_keys(t.elem -> 'donsParOng') k WHERE lower(btrim(k)) = lower(btrim(v_ancien)))
                  THEN jsonb_set(t.elem, '{donsParOng}', (
                    SELECT coalesce(jsonb_object_agg(cle, qte), '{}'::jsonb) FROM (
                      SELECT CASE WHEN lower(btrim(d.key)) = lower(btrim(v_ancien)) THEN v_nom ELSE d.key END AS cle,
                             sum((d.value #>> '{}')::numeric) AS qte
                      FROM jsonb_each(t.elem -> 'donsParOng') d GROUP BY 1) regroupe))
                  ELSE t.elem END
             ORDER BY t.ord),
           count(*) FILTER (WHERE jsonb_typeof(t.elem -> 'donsParOng') = 'object' AND EXISTS (
                    SELECT 1 FROM jsonb_object_keys(t.elem -> 'donsParOng') k WHERE lower(btrim(k)) = lower(btrim(v_ancien))))
      INTO v_nouveaux, v_dons
      FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ord);
    IF v_dons > 0 THEN
      UPDATE catalog SET items = v_nouveaux, updated_at = now() WHERE type = 'medicaments';
    END IF;
  END IF;

  RETURN jsonb_build_object('episodes', v_ep, 'paiements', v_pa, 'dons', coalesce(v_dons, 0));
END $$;

REVOKE EXECUTE ON FUNCTION public.renommer_partenaire(text, text) FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.renommer_partenaire(text, text) TO service_role;
  END IF;
END $$;
