-- Stock PAR SERVICE (22/10, Esdras : « quand un service fait une réquisition, le stock devient à lui ; tout épisode créé dans ce service
-- puise dans ce stock quand on achète des médicaments »).
--
-- MODÈLE. Chaque médicament de catalog(type='medicaments') garde, en plus de `quantite` (le stock central de la pharmacie) et de `donsParOng`
-- (stock donné par un partenaire), un objet `stockServices`, ex : { "Pédiatrie": 12, "Maternité": 4 } — une quantité par service, jamais mélangée avec
-- le stock central. Même principe que `donsParOng` (voir fonction_stock_dons.sql).
--
--   transferer_stock_service(service, lignes, local_id)   réquisition (+) : la pharmacie donne au service ; annulation / modification / retour (−) : le service rend à la pharmacie.
--   decrementer_stock_service(service, decrements, id)    vente : le stock du SERVICE d'abord, le reste vient de la pharmacie ; la répartition est gardée (table repartitions_stock_service).
--   restituer_stock_ventes(entrees, local_id)             fiche supprimée / vente annulée : chaque article revient là où il avait été pris (service ou pharmacie), exactement.
--   renommer_service_stock(ancien, nouveau)               un service renommé garde son stock.
--
-- Toutes sont tout-ou-rien, prennent le verrou FOR UPDATE de la ligne catalog avant de lire, et sont idempotentes par `p_local_id` (trace dans la MÊME
-- transaction, table decrements_stock_appliques créée par idempotence_decrement_stock.sql) : un rejeu de la file hors ligne ne déplace jamais le stock deux fois.
-- Aucune fonction existante n'est modifiée : tant que le serveur ne les appelle pas, rien ne change.
--
-- À coller dans Supabase → SQL Editor (après idempotence_decrement_stock.sql).

CREATE TABLE IF NOT EXISTS repartitions_stock_service (
  local_id    text PRIMARY KEY,           -- identifiant du décrément de la vente (« <vente>-stock »)
  service     text NOT NULL,
  repartition jsonb NOT NULL,             -- [{ "id": "...", "service": 2, "central": 1 }]
  cree_le     timestamptz NOT NULL DEFAULT now(),
  restitue_le timestamptz                 -- rempli quand la vente a été annulée et le stock rendu (une seule fois)
);
ALTER TABLE repartitions_stock_service ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_repartitions_stock_service_cree ON repartitions_stock_service (cree_le);

-- Les réquisitions faites à partir de maintenant donnent le stock AU SERVICE ; celles d'avant (stock simplement sorti de la pharmacie) gardent l'ancien comportement.
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS stock_par_service boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Réquisition (+), annulation / modification / retour (−) : déplace du stock entre la pharmacie et UN service.
-- p_lignes : [{ "id": "...", "qte": 5 }, ...] ; qte > 0 : pharmacie → service ; qte < 0 : service → pharmacie.
-- Refus (succes=false, manquants) si la pharmacie n'a pas assez (qte > 0) ou si le service n'a pas assez à rendre (qte < 0, ex. déjà consommé).
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transferer_stock_service(p_service text, p_lignes jsonb, p_local_id text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_items jsonb;
  v_demandes jsonb;
  v_id text;
  v_qte numeric;
  v_index int;
  v_central numeric;
  v_service numeric;
  v_manquants jsonb := '[]'::jsonb;
BEGIN
  IF p_service IS NULL OR btrim(p_service) = '' THEN RAISE EXCEPTION 'Service requis'; END IF;
  SELECT items INTO v_items FROM catalog WHERE type = 'medicaments' FOR UPDATE;
  IF v_items IS NULL THEN RAISE EXCEPTION 'Catalogue "medicaments" introuvable'; END IF;

  IF p_local_id IS NOT NULL AND EXISTS (SELECT 1 FROM decrements_stock_appliques WHERE local_id = p_local_id) THEN
    RETURN jsonb_build_object('succes', true, 'deja_applique', true, 'items', v_items);
  END IF;

  SELECT COALESCE(jsonb_object_agg(id, total), '{}'::jsonb) INTO v_demandes
  FROM (SELECT (d->>'id') AS id, SUM((d->>'qte')::numeric) AS total FROM jsonb_array_elements(p_lignes) d GROUP BY d->>'id') s;

  -- 1er passage : vérifie tout, ne modifie rien.
  FOR v_id, v_qte IN SELECT key, value::numeric FROM jsonb_each_text(v_demandes) LOOP
    SELECT (ord - 1)::int INTO v_index FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ord) WHERE elem->>'id' = v_id;
    IF v_index IS NULL THEN
      v_manquants := v_manquants || jsonb_build_object('id', v_id, 'disponible', 0);
      CONTINUE;
    END IF;
    v_central := COALESCE((v_items -> v_index ->> 'quantite')::numeric, 0);
    v_service := COALESCE((v_items -> v_index -> 'stockServices' ->> p_service)::numeric, 0);
    IF v_qte > 0 AND v_central < v_qte THEN
      v_manquants := v_manquants || jsonb_build_object('id', v_id, 'nom', v_items -> v_index ->> 'nom', 'disponible', v_central, 'lieu', 'pharmacie');
    ELSIF v_qte < 0 AND v_service < -v_qte THEN
      v_manquants := v_manquants || jsonb_build_object('id', v_id, 'nom', v_items -> v_index ->> 'nom', 'disponible', v_service, 'lieu', 'service');
    END IF;
  END LOOP;
  IF jsonb_array_length(v_manquants) > 0 THEN
    RETURN jsonb_build_object('succes', false, 'manquants', v_manquants);
  END IF;

  -- 2e passage : applique.
  FOR v_id, v_qte IN SELECT key, value::numeric FROM jsonb_each_text(v_demandes) LOOP
    IF v_qte = 0 THEN CONTINUE; END IF;
    SELECT (ord - 1)::int INTO v_index FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ord) WHERE elem->>'id' = v_id;
    v_central := COALESCE((v_items -> v_index ->> 'quantite')::numeric, 0);
    v_service := COALESCE((v_items -> v_index -> 'stockServices' ->> p_service)::numeric, 0);
    v_items := jsonb_set(v_items, ARRAY[v_index::text, 'quantite'], to_jsonb(v_central - v_qte));
    v_items := jsonb_set(v_items, ARRAY[v_index::text, 'stockServices'],
      jsonb_set(COALESCE(v_items -> v_index -> 'stockServices', '{}'::jsonb), ARRAY[p_service], to_jsonb(v_service + v_qte)));
  END LOOP;

  UPDATE catalog SET items = v_items, updated_at = now() WHERE type = 'medicaments';
  IF p_local_id IS NOT NULL THEN
    INSERT INTO decrements_stock_appliques (local_id) VALUES (p_local_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('succes', true, 'items', v_items);
END;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Vente d'un épisode d'un service : le stock du service d'abord, le reste vient de la pharmacie.
-- p_decrements : [{ "id": "...", "qte": 3 }, ...] (qte > 0). Renvoie aussi `repartition` : [{ id, service, central }].
-- Refus si service + pharmacie ne suffisent pas. La répartition est gardée sous p_local_id pour que l'annulation rende chaque article au bon endroit.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decrementer_stock_service(p_service text, p_decrements jsonb, p_local_id text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_items jsonb;
  v_demandes jsonb;
  v_id text;
  v_qte numeric;
  v_index int;
  v_central numeric;
  v_service numeric;
  v_du_service numeric;
  v_de_central numeric;
  v_manquants jsonb := '[]'::jsonb;
  v_repartition jsonb := '[]'::jsonb;
BEGIN
  IF p_service IS NULL OR btrim(p_service) = '' THEN RAISE EXCEPTION 'Service requis'; END IF;
  SELECT items INTO v_items FROM catalog WHERE type = 'medicaments' FOR UPDATE;
  IF v_items IS NULL THEN v_items := '[]'::jsonb; END IF;

  IF p_local_id IS NOT NULL AND EXISTS (SELECT 1 FROM decrements_stock_appliques WHERE local_id = p_local_id) THEN
    RETURN jsonb_build_object('succes', true, 'deja_applique', true, 'items', v_items,
      'repartition', COALESCE((SELECT repartition FROM repartitions_stock_service WHERE local_id = p_local_id), '[]'::jsonb));
  END IF;

  SELECT COALESCE(jsonb_object_agg(id, total), '{}'::jsonb) INTO v_demandes
  FROM (SELECT (d->>'id') AS id, SUM((d->>'qte')::numeric) AS total FROM jsonb_array_elements(p_decrements) d GROUP BY d->>'id') s;

  FOR v_id, v_qte IN SELECT key, value::numeric FROM jsonb_each_text(v_demandes) LOOP
    IF v_qte <= 0 THEN RAISE EXCEPTION 'Quantité invalide pour %', v_id; END IF;
    SELECT (ord - 1)::int INTO v_index FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ord) WHERE elem->>'id' = v_id;
    IF v_index IS NULL THEN
      v_manquants := v_manquants || jsonb_build_object('id', v_id, 'disponible', 0);
      CONTINUE;
    END IF;
    v_central := COALESCE((v_items -> v_index ->> 'quantite')::numeric, 0);
    v_service := COALESCE((v_items -> v_index -> 'stockServices' ->> p_service)::numeric, 0);
    v_du_service := LEAST(GREATEST(v_service, 0), v_qte);
    v_de_central := v_qte - v_du_service;
    IF v_central < v_de_central THEN
      v_manquants := v_manquants || jsonb_build_object('id', v_id, 'nom', v_items -> v_index ->> 'nom', 'disponible', GREATEST(v_service, 0) + v_central);
    ELSE
      v_repartition := v_repartition || jsonb_build_object('id', v_id, 'service', v_du_service, 'central', v_de_central);
    END IF;
  END LOOP;
  IF jsonb_array_length(v_manquants) > 0 THEN
    RETURN jsonb_build_object('succes', false, 'manquants', v_manquants);
  END IF;

  FOR v_id, v_du_service, v_de_central IN
    SELECT r->>'id', (r->>'service')::numeric, (r->>'central')::numeric FROM jsonb_array_elements(v_repartition) r
  LOOP
    SELECT (ord - 1)::int INTO v_index FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ord) WHERE elem->>'id' = v_id;
    IF v_du_service > 0 THEN
      v_service := COALESCE((v_items -> v_index -> 'stockServices' ->> p_service)::numeric, 0);
      v_items := jsonb_set(v_items, ARRAY[v_index::text, 'stockServices'],
        jsonb_set(COALESCE(v_items -> v_index -> 'stockServices', '{}'::jsonb), ARRAY[p_service], to_jsonb(v_service - v_du_service)));
    END IF;
    IF v_de_central > 0 THEN
      v_central := COALESCE((v_items -> v_index ->> 'quantite')::numeric, 0);
      v_items := jsonb_set(v_items, ARRAY[v_index::text, 'quantite'], to_jsonb(v_central - v_de_central));
    END IF;
  END LOOP;

  UPDATE catalog SET items = v_items, updated_at = now() WHERE type = 'medicaments';
  IF p_local_id IS NOT NULL THEN
    INSERT INTO repartitions_stock_service (local_id, service, repartition) VALUES (p_local_id, p_service, v_repartition) ON CONFLICT DO NOTHING;
    INSERT INTO decrements_stock_appliques (local_id) VALUES (p_local_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('succes', true, 'items', v_items, 'repartition', v_repartition);
END;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Restitution : une vente annulée (fiche supprimée, encaissement échoué) rend CHAQUE article là où il avait été pris.
-- p_entrees : [{ "fiche": "<local_id de la fiche>" | "origine": "<local_id exact du décrément>", "lignes": [{ "id": "...", "qte": 2 }] }, ...]
--   - la répartition gardée pour cette vente (service / pharmacie) est rendue telle quelle, UNE seule fois (restitue_le) ;
--   - ce qui n'a pas de répartition gardée (ventes d'avant cette fonction, ou sans service) est rendu à la pharmacie, comme avant.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restituer_stock_ventes(p_entrees jsonb, p_local_id text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_items jsonb;
  v_entree jsonb;
  v_ligne jsonb;
  v_rep record;
  v_part jsonb;
  v_id text;
  v_index int;
  v_qte numeric;
  v_couvert numeric;
  v_a_service numeric;
  v_a_central numeric;
  v_reste numeric;
  v_valeur numeric;
BEGIN
  SELECT items INTO v_items FROM catalog WHERE type = 'medicaments' FOR UPDATE;
  IF v_items IS NULL THEN v_items := '[]'::jsonb; END IF;

  IF p_local_id IS NOT NULL AND EXISTS (SELECT 1 FROM decrements_stock_appliques WHERE local_id = p_local_id) THEN
    RETURN jsonb_build_object('succes', true, 'deja_applique', true, 'items', v_items);
  END IF;

  FOR v_entree IN SELECT * FROM jsonb_array_elements(p_entrees) LOOP
    -- Combien de chaque article la répartition gardée couvre-t-elle (pour ne pas rendre deux fois) ?
    FOR v_ligne IN SELECT * FROM jsonb_array_elements(COALESCE(v_entree -> 'lignes', '[]'::jsonb)) LOOP
      v_id := v_ligne ->> 'id';
      v_qte := COALESCE((v_ligne ->> 'qte')::numeric, 0);
      IF v_qte <= 0 THEN CONTINUE; END IF;
      SELECT (ord - 1)::int INTO v_index FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ord) WHERE elem->>'id' = v_id;
      IF v_index IS NULL THEN CONTINUE; END IF;
      v_reste := v_qte;
      -- Répartitions non encore rendues de CETTE vente : exacte, ou « fiche » + éventuel suffixe de nouvel essai (-t2).
      FOR v_rep IN
        SELECT local_id, service, repartition FROM repartitions_stock_service
        WHERE restitue_le IS NULL
          AND ((v_entree ->> 'origine') IS NOT NULL AND local_id = (v_entree ->> 'origine')
            OR (v_entree ->> 'fiche') IS NOT NULL AND (local_id = (v_entree ->> 'fiche') || '-stock' OR local_id ~ ('^' || regexp_replace(v_entree ->> 'fiche', '([.^$*+?(){}|\[\]\\])', '\\\1', 'g') || '-t[0-9]+-stock$')))
        ORDER BY cree_le
        FOR UPDATE
      LOOP
        EXIT WHEN v_reste <= 0;
        SELECT r INTO v_part FROM jsonb_array_elements(v_rep.repartition) r WHERE r ->> 'id' = v_id LIMIT 1;
        IF v_part IS NULL THEN CONTINUE; END IF;
        v_a_service := LEAST((v_part ->> 'service')::numeric, v_reste);
        v_a_central := LEAST((v_part ->> 'central')::numeric, v_reste - v_a_service);
        IF v_a_service > 0 THEN
          v_valeur := COALESCE((v_items -> v_index -> 'stockServices' ->> v_rep.service)::numeric, 0);
          v_items := jsonb_set(v_items, ARRAY[v_index::text, 'stockServices'],
            jsonb_set(COALESCE(v_items -> v_index -> 'stockServices', '{}'::jsonb), ARRAY[v_rep.service], to_jsonb(v_valeur + v_a_service)));
        END IF;
        IF v_a_central > 0 THEN
          v_valeur := COALESCE((v_items -> v_index ->> 'quantite')::numeric, 0);
          v_items := jsonb_set(v_items, ARRAY[v_index::text, 'quantite'], to_jsonb(v_valeur + v_a_central));
        END IF;
        v_reste := v_reste - v_a_service - v_a_central;
      END LOOP;
      -- Le reste (aucune répartition gardée) revient à la pharmacie, comme l'ancienne restitution.
      IF v_reste > 0 THEN
        v_valeur := COALESCE((v_items -> v_index ->> 'quantite')::numeric, 0);
        v_items := jsonb_set(v_items, ARRAY[v_index::text, 'quantite'], to_jsonb(v_valeur + v_reste));
      END IF;
    END LOOP;
    -- Les répartitions de cette vente sont marquées rendues (une seule restitution possible).
    UPDATE repartitions_stock_service SET restitue_le = now()
    WHERE restitue_le IS NULL
      AND ((v_entree ->> 'origine') IS NOT NULL AND local_id = (v_entree ->> 'origine')
        OR (v_entree ->> 'fiche') IS NOT NULL AND (local_id = (v_entree ->> 'fiche') || '-stock' OR local_id ~ ('^' || regexp_replace(v_entree ->> 'fiche', '([.^$*+?(){}|\[\]\\])', '\\\1', 'g') || '-t[0-9]+-stock$')));
  END LOOP;

  UPDATE catalog SET items = v_items, updated_at = now() WHERE type = 'medicaments';
  IF p_local_id IS NOT NULL THEN
    INSERT INTO decrements_stock_appliques (local_id) VALUES (p_local_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('succes', true, 'items', v_items);
END;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Un service renommé (Paramètres → listes) garde son stock : la clé de stockServices suit, et les répartitions gardées aussi.
-- Si le nouveau nom existe déjà, les quantités s'additionnent.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.renommer_service_stock(p_ancien text, p_nouveau text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_items jsonb;
  v_index int;
  v_stock jsonb;
  v_somme numeric;
  v_touches int := 0;
BEGIN
  IF p_ancien IS NULL OR p_nouveau IS NULL OR btrim(p_ancien) = '' OR btrim(p_nouveau) = '' OR p_ancien = p_nouveau THEN
    RETURN jsonb_build_object('succes', true, 'touches', 0);
  END IF;
  SELECT items INTO v_items FROM catalog WHERE type = 'medicaments' FOR UPDATE;
  IF v_items IS NULL THEN RETURN jsonb_build_object('succes', true, 'touches', 0); END IF;
  FOR v_index IN SELECT (ord - 1)::int FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ord) WHERE (elem -> 'stockServices') ? p_ancien LOOP
    v_stock := v_items -> v_index -> 'stockServices';
    v_somme := COALESCE((v_stock ->> p_nouveau)::numeric, 0) + COALESCE((v_stock ->> p_ancien)::numeric, 0);
    v_stock := jsonb_set(v_stock - p_ancien, ARRAY[p_nouveau], to_jsonb(v_somme));
    v_items := jsonb_set(v_items, ARRAY[v_index::text, 'stockServices'], v_stock);
    v_touches := v_touches + 1;
  END LOOP;
  IF v_touches > 0 THEN UPDATE catalog SET items = v_items, updated_at = now() WHERE type = 'medicaments'; END IF;
  UPDATE repartitions_stock_service SET service = p_nouveau WHERE service = p_ancien;
  RETURN jsonb_build_object('succes', true, 'touches', v_touches);
END;
$function$;
