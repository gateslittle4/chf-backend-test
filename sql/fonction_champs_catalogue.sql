-- Gère le nom/prix/prix d'achat/catégorie/fréquence d'usage d'UN article du catalogue
-- (medicaments ou actes) de façon atomique — remplace le read-modify-write complet du
-- catalogue fait depuis GrilleEdition.js ("Tarifs Pharma"/"Tarifs Actes") et depuis
-- CalculateurPanel.js (compteur de fréquence d'usage), qui réécrivaient tout le tableau à
-- chaque clic. Ce n'était pas qu'un problème de performance : cette réécriture pouvait
-- silencieusement ANNULER le stock ou les dons ONG d'un médicament décrémentés entre-temps
-- par une vente (instantané périmé écrasant le tableau entier) — exactement le bug déjà
-- corrigé pour le stock lui-même dans fonction_maj_stock_medicament.sql.
--
-- Ces 3 fonctions ne touchent JAMAIS quantite/seuilAlerte/donsParOng : definir_champs_catalogue_lot
-- retire explicitement ces clés de ce qu'on lui envoie, quoi que le navigateur ait pu inclure —
-- le stock ne peut être modifié que depuis "Gestion des stocks" (fonction_maj_stock_medicament.sql,
-- fonction_stock_dons.sql), jamais depuis "Tarifs Pharma".
--
-- À coller dans Supabase → SQL Editor.

-- Ajoute un nouvel article au catalogue (medicaments ou actes). Pour "medicaments", le stock
-- démarre TOUJOURS à 0 (et aucun don), quoi que p_item contienne — l'ajout se fait ensuite
-- depuis "Gestion des stocks", jamais ici.
CREATE OR REPLACE FUNCTION ajouter_article_catalogue(p_type text, p_item jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_items jsonb;
  v_item jsonb;
BEGIN
  SELECT items INTO v_items FROM catalog WHERE type = p_type FOR UPDATE;
  IF v_items IS NULL THEN
    RAISE EXCEPTION 'Catalogue "%" introuvable', p_type;
  END IF;

  v_item := p_item;
  IF p_type = 'medicaments' THEN
    v_item := v_item || jsonb_build_object('quantite', 0, 'donsParOng', '{}'::jsonb);
  END IF;

  v_items := v_items || jsonb_build_array(v_item);
  UPDATE catalog SET items = v_items, updated_at = now() WHERE type = p_type;
  RETURN v_item;
END;
$$;

-- Modifie des champs (nom, prix, prixAchat, sub, ordre, nouveauPrix, nbUtilisations, ...) sur un
-- ou plusieurs articles existants en une seule opération atomique. p_maj :
-- [{ "id": "...", "champs": { "prix": 150 } }, ...]. Un id introuvable est ignoré (pas d'erreur) —
-- ex. l'article a été supprimé entre-temps par quelqu'un d'autre.
CREATE OR REPLACE FUNCTION definir_champs_catalogue_lot(p_type text, p_maj jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_items jsonb;
  v_entree jsonb;
  v_index int;
  v_champs jsonb;
BEGIN
  SELECT items INTO v_items FROM catalog WHERE type = p_type FOR UPDATE;
  IF v_items IS NULL THEN
    RAISE EXCEPTION 'Catalogue "%" introuvable', p_type;
  END IF;

  FOR v_entree IN SELECT * FROM jsonb_array_elements(p_maj) LOOP
    SELECT (ordinality - 1)::int INTO v_index
    FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ordinality)
    WHERE elem ->> 'id' = v_entree ->> 'id';

    IF v_index IS NULL THEN
      CONTINUE;
    END IF;

    v_champs := (v_entree -> 'champs') - 'quantite' - 'seuilAlerte' - 'donsParOng';
    v_items := jsonb_set(v_items, ARRAY[v_index::text], (v_items -> v_index) || v_champs);
  END LOOP;

  UPDATE catalog SET items = v_items, updated_at = now() WHERE type = p_type;
  RETURN v_items;
END;
$$;

-- Supprime un article du catalogue par id, de façon atomique.
CREATE OR REPLACE FUNCTION supprimer_article_catalogue(p_type text, p_id text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_items jsonb;
BEGIN
  SELECT items INTO v_items FROM catalog WHERE type = p_type FOR UPDATE;
  IF v_items IS NULL THEN
    RAISE EXCEPTION 'Catalogue "%" introuvable', p_type;
  END IF;

  v_items := COALESCE(
    (SELECT jsonb_agg(elem) FROM jsonb_array_elements(v_items) elem WHERE elem ->> 'id' <> p_id),
    '[]'::jsonb
  );

  UPDATE catalog SET items = v_items, updated_at = now() WHERE type = p_type;
  RETURN v_items;
END;
$$;
