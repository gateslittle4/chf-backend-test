-- Modifie le stock d'UN SEUL médicament de façon atomique (verrouille la ligne
-- catalog(type='medicaments') pendant l'opération, via SELECT ... FOR UPDATE) — remplace le
-- read-modify-write complet du catalogue fait depuis le navigateur (GestionStock.js), qui
-- pouvait perdre la modification d'un autre poste si 2 personnes modifiaient le stock de 2
-- médicaments différents presque au même moment (la 2e écriture, partie d'un instantané pris
-- avant que la 1ère ne soit enregistrée, écrasait silencieusement le tableau entier).
--
-- À coller dans Supabase → SQL Editor. Voir aussi fonction_decrementer_stock.sql (même principe,
-- déjà en place pour les ventes) et server.js (routes POST /api/stock/ajouter, PATCH /api/stock/:id).

CREATE OR REPLACE FUNCTION ajouter_stock_medicament(p_id text, p_quantite_ajoutee numeric)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_items jsonb;
  v_index int;
  v_item jsonb;
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

  v_item := jsonb_set(
    v_items -> v_index,
    '{quantite}',
    to_jsonb(COALESCE((v_items -> v_index ->> 'quantite')::numeric, 0) + p_quantite_ajoutee)
  );
  v_items := jsonb_set(v_items, ARRAY[v_index::text], v_item);

  UPDATE catalog SET items = v_items, updated_at = now() WHERE type = 'medicaments';
  RETURN v_item;
END;
$$;

CREATE OR REPLACE FUNCTION definir_stock_medicament(p_id text, p_quantite numeric, p_seuil_alerte numeric)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_items jsonb;
  v_index int;
  v_item jsonb;
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

  v_item := (v_items -> v_index) || jsonb_build_object('quantite', p_quantite, 'seuilAlerte', p_seuil_alerte);
  v_items := jsonb_set(v_items, ARRAY[v_index::text], v_item);

  UPDATE catalog SET items = v_items, updated_at = now() WHERE type = 'medicaments';
  RETURN v_item;
END;
$$;
