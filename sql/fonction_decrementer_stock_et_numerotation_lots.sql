-- Sauvegarde de 2 fonctions Postgres qui existaient UNIQUEMENT en base, sans aucune source dans
-- le dépôt (trouvé lors de l'audit du 31/08, veille du lancement, en croisant les 10
-- `supabase.rpc('...')` de server.js avec les `CREATE FUNCTION` de sql/*.sql). Copiées ici via
-- `pg_get_functiondef` depuis Supabase → Database → Functions, telles qu'elles tournent
-- réellement en production — rien réécrit de mémoire.
--
-- Pourquoi c'était grave : la sauvegarde automatique (server.js, TABLES_A_SAUVEGARDER) n'exporte
-- que les DONNÉES des tables, jamais les fonctions/policies/contraintes. Restaurer une sauvegarde
-- sans ce fichier rendrait les données mais une application NON FONCTIONNELLE : plus aucune vente
-- de médicament (`decrementer_stock_medicaments`, appelée à CHAQUE vente), plus aucune
-- numérotation de lot de facturation ONG (`incrementer_prochain_numero_lot`).
--
-- À coller dans Supabase → SQL Editor UNIQUEMENT en cas de restauration depuis zéro (nouvelle
-- base, ou base existante où ces fonctions auraient disparu) — CREATE OR REPLACE écraserait sinon
-- une éventuelle version plus récente déjà en place. Ne jamais réécrire ces fonctions de mémoire :
-- toujours re-générer ce fichier depuis la vraie base (pg_get_functiondef) si elles évoluent.

-- Décrémente le stock de plusieurs médicaments d'un coup, de façon atomique (verrouille la ligne
-- catalog(type='medicaments') via FOR UPDATE), utilisée à chaque encaissement qui inclut des
-- médicaments. Agrège d'abord les décréments par id (au cas où le même médicament apparaîtrait
-- 2 fois dans le même appel) avant de vérifier le stock disponible, pour ne jamais laisser passer
-- une demande totale supérieure au stock réel même répartie sur plusieurs lignes. Renvoie la liste
-- des médicaments manquants (avec le stock réellement disponible) si un seul est insuffisant —
-- rien n'est appliqué tant que TOUS ne sont pas suffisants.
CREATE OR REPLACE FUNCTION public.decrementer_stock_medicaments(p_decrements jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_items jsonb;
  v_demandes jsonb;
  v_id text;
  v_qte_texte text;
  v_qte_demandee numeric;
  v_qte_actuelle numeric;
  v_index int;
  v_manquants jsonb := '[]'::jsonb;
BEGIN
  SELECT items INTO v_items FROM catalog WHERE type = 'medicaments' FOR UPDATE;
  IF v_items IS NULL THEN v_items := '[]'::jsonb; END IF;

  -- Agrège par id AVANT toute vérification — si le même médicament apparaît 2 fois dans le
  -- même appel (le panier fusionne déjà les doublons normalement, mais cette fonction ne doit
  -- pas en dépendre), la vérification doit porter sur la demande TOTALE, pas sur chaque ligne
  -- isolément — sinon 2 lignes de 3 chacune pourraient chacune "passer" contre un stock de 5,
  -- pour une demande réelle de 6, et le stock finirait négatif.
  SELECT jsonb_object_agg(id, total) INTO v_demandes
  FROM (
    SELECT (d->>'id') AS id, SUM((d->>'qte')::numeric) AS total
    FROM jsonb_array_elements(p_decrements) d
    GROUP BY d->>'id'
  ) sous_requete;

  -- 1er passage : vérifie que CHAQUE médicament demandé (demande totale, agrégée) a un stock
  -- suffisant, sans rien modifier.
  FOR v_id, v_qte_texte IN SELECT key, value FROM jsonb_each_text(v_demandes)
  LOOP
    v_qte_demandee := v_qte_texte::numeric;
    SELECT (elem->>'quantite')::numeric INTO v_qte_actuelle
    FROM jsonb_array_elements(v_items) elem WHERE elem->>'id' = v_id;
    IF v_qte_actuelle IS NULL OR v_qte_actuelle < v_qte_demandee THEN
      v_manquants := v_manquants || jsonb_build_object(
        'id', v_id,
        'nom', (SELECT elem->>'nom' FROM jsonb_array_elements(v_items) elem WHERE elem->>'id' = v_id),
        'disponible', COALESCE(v_qte_actuelle, 0)
      );
    END IF;
  END LOOP;

  IF jsonb_array_length(v_manquants) > 0 THEN
    RETURN jsonb_build_object('succes', false, 'manquants', v_manquants);
  END IF;

  -- 2e passage : tout est suffisant, applique tous les décréments (déjà agrégés) d'un coup.
  FOR v_id, v_qte_texte IN SELECT key, value FROM jsonb_each_text(v_demandes)
  LOOP
    v_qte_demandee := v_qte_texte::numeric;
    SELECT (ord - 1) INTO v_index
    FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ord)
    WHERE t.elem->>'id' = v_id;
    v_items := jsonb_set(v_items, ARRAY[v_index::text, 'quantite'],
      to_jsonb((v_items->v_index->>'quantite')::numeric - v_qte_demandee));
  END LOOP;

  UPDATE catalog SET items = v_items, updated_at = now() WHERE type = 'medicaments';
  RETURN jsonb_build_object('succes', true, 'items', v_items);
END;
$function$;

-- Attribue le prochain numéro de lot de facturation à un partenaire ONG donné, et l'incrémente
-- atomiquement (UPDATE ... RETURNING) — garantit une numérotation séquentielle sans collision même
-- si 2 personnes génèrent un lot pour le même partenaire au même instant.
CREATE OR REPLACE FUNCTION public.incrementer_prochain_numero_lot(p_ong text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_numero integer;
BEGIN
  UPDATE ong_partenaires
  SET prochain_numero = prochain_numero + 1
  WHERE nom = p_ong
  RETURNING prochain_numero - 1 INTO v_numero;
  RETURN v_numero;
END;
$function$;
