-- Stock de médicaments DONNÉS par un partenaire (ONG), séparé du stock acheté normalement
-- (catalog.items[].quantite). Chaque médicament garde en plus un objet donsParOng, ex :
-- { "MSF-France": 40, "ALIMA": 10 } — une quantité par ONG donateur, jamais mélangée avec le
-- stock acheté. Voir PLAN_DONS_ONG.md pour le contexte complet de cette fonctionnalité.
--
-- Réservation stricte par défaut : le stock donné par un ONG ne sert qu'aux patients de CE MÊME
-- ONG (jamais facturé), pour que le don ne puisse jamais "disparaître" silencieusement sur
-- d'autres patients. Un déblocage manuel exceptionnel reste possible (voir
-- POST /api/stock/decrementer-dons, appelable pour n'importe quel ONG donateur quelle que soit
-- l'appartenance réelle du patient) mais nécessite une justification écrite côté frontend,
-- consignée dans audit_log — la fonction SQL elle-même ne connaît pas cette distinction, elle
-- décrémente ce qu'on lui demande, tout-ou-rien, comme decrementer_stock_medicaments.
--
-- À coller dans Supabase → SQL Editor. Voir aussi fonction_maj_stock_medicament.sql
-- (ajouter_stock_medicament/definir_stock_medicament, même principe pour le stock acheté).

CREATE OR REPLACE FUNCTION ajouter_stock_don_medicament(p_id text, p_ong text, p_quantite_ajoutee numeric)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_items jsonb;
  v_index int;
  v_item jsonb;
  v_dons jsonb;
BEGIN
  SELECT items INTO v_items FROM catalog WHERE type = 'medicaments' FOR UPDATE;
  IF v_items IS NULL THEN
    RAISE EXCEPTION 'Catalogue "medicaments" introuvable';
  END IF;

  SELECT (ordinality - 1)::int INTO v_index
  FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ordinality)
  WHERE elem ->> 'id' = p_id;

  IF v_index IS NULL THEN
    RAISE EXCEPTION 'Médicament "%" introuvable', p_id;
  END IF;

  v_dons := COALESCE(v_items -> v_index -> 'donsParOng', '{}'::jsonb);
  v_dons := jsonb_set(
    v_dons, ARRAY[p_ong],
    to_jsonb(COALESCE((v_dons ->> p_ong)::numeric, 0) + p_quantite_ajoutee)
  );
  v_item := jsonb_set(v_items -> v_index, '{donsParOng}', v_dons);
  v_items := jsonb_set(v_items, ARRAY[v_index::text], v_item);

  UPDATE catalog SET items = v_items, updated_at = now() WHERE type = 'medicaments';
  RETURN v_item;
END;
$$;

-- p_decrements : [{ "id": "...", "ong": "MSF-France", "qte": 2 }, ...] — plusieurs lignes
-- peuvent viser le même médicament avec des ONG différentes. Tout-ou-rien : si une seule ligne
-- manque de stock donné suffisant, rien n'est décrémenté (même principe que
-- decrementer_stock_medicaments). p_decrements avec qte négative = restauration (utilisé si
-- une étape suivante de l'encaissement échoue après ce décrément).
CREATE OR REPLACE FUNCTION decrementer_stock_dons(p_decrements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_items jsonb;
  v_dec jsonb;
  v_index int;
  v_dons jsonb;
  v_disponible numeric;
  v_manquants jsonb := '[]'::jsonb;
  v_touches jsonb := '{}'::jsonb; -- id -> index, pour appliquer les décréments après vérification
BEGIN
  SELECT items INTO v_items FROM catalog WHERE type = 'medicaments' FOR UPDATE;
  IF v_items IS NULL THEN
    RAISE EXCEPTION 'Catalogue "medicaments" introuvable';
  END IF;

  FOR v_dec IN SELECT * FROM jsonb_array_elements(p_decrements) LOOP
    SELECT (ordinality - 1)::int INTO v_index
    FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ordinality)
    WHERE elem ->> 'id' = v_dec ->> 'id';

    IF v_index IS NULL THEN
      v_manquants := v_manquants || jsonb_build_object('id', v_dec ->> 'id', 'ong', v_dec ->> 'ong', 'disponible', 0);
      CONTINUE;
    END IF;

    v_dons := COALESCE(v_items -> v_index -> 'donsParOng', '{}'::jsonb);
    v_disponible := COALESCE((v_dons ->> (v_dec ->> 'ong'))::numeric, 0);
    IF v_disponible < (v_dec ->> 'qte')::numeric THEN
      v_manquants := v_manquants || jsonb_build_object(
        'id', v_dec ->> 'id', 'ong', v_dec ->> 'ong', 'disponible', v_disponible,
        'nom', v_items -> v_index ->> 'nom'
      );
    END IF;
  END LOOP;

  IF jsonb_array_length(v_manquants) > 0 THEN
    RETURN jsonb_build_object('succes', false, 'manquants', v_manquants);
  END IF;

  -- 2e passage : tout est disponible, on applique réellement.
  FOR v_dec IN SELECT * FROM jsonb_array_elements(p_decrements) LOOP
    SELECT (ordinality - 1)::int INTO v_index
    FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ordinality)
    WHERE elem ->> 'id' = v_dec ->> 'id';

    v_dons := COALESCE(v_items -> v_index -> 'donsParOng', '{}'::jsonb);
    v_dons := jsonb_set(
      v_dons, ARRAY[v_dec ->> 'ong'],
      to_jsonb(COALESCE((v_dons ->> (v_dec ->> 'ong'))::numeric, 0) - (v_dec ->> 'qte')::numeric)
    );
    v_items := jsonb_set(v_items, ARRAY[v_index::text, 'donsParOng'], v_dons);
  END LOOP;

  UPDATE catalog SET items = v_items, updated_at = now() WHERE type = 'medicaments';
  RETURN jsonb_build_object('succes', true, 'items', v_items);
END;
$$;
