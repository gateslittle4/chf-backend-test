-- 20/10 (Esdras) : réception de médicaments dans un onglet à part (source : achat ou don, « exonération jusqu'à 50 % » pour un médicament reçu en don), et réquisitions annulables / modifiables.
-- Additif, sans risque : une nouvelle table, des colonnes avec valeurs par défaut, une nouvelle fonction. Rien d'existant n'est modifié ni supprimé.
CREATE TABLE IF NOT EXISTS public.receptions_medicaments (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  medicament_id text NOT NULL,
  nom text NOT NULL,
  quantite numeric NOT NULL CONSTRAINT receptions_medicaments_quantite_bornee CHECK (quantite > 0 AND quantite <= 10000000),
  source text NOT NULL CONSTRAINT receptions_medicaments_source_check CHECK (source IN ('achat', 'don')),
  exoneration_50 boolean,            -- renseigné seulement pour un don : ce médicament peut être vendu avec jusqu'à 50 % d'exonération
  note text,
  recu_par text NOT NULL,
  recu_par_uid text NOT NULL,
  date_reception timestamptz NOT NULL DEFAULT now(),
  local_id text UNIQUE
);
ALTER TABLE public.receptions_medicaments ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS receptions_medicaments_date_idx ON public.receptions_medicaments (date_reception);

ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS annulee boolean NOT NULL DEFAULT false;
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS annulee_par text;
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS annulee_par_uid text;
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS annulee_le timestamptz;
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS motif_annulation text;
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS modifiee_par text;
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS modifiee_par_uid text;
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS modifiee_le timestamptz;

-- Marque (ou non) un médicament « vendable avec jusqu'à 50 % d'exonération » (don de l'hôpital). Verrouille la ligne du catalogue comme les autres fonctions de stock.
CREATE OR REPLACE FUNCTION public.marquer_exoneration_50_medicament(p_id text, p_valeur boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_items jsonb;
  v_index int;
  v_item jsonb;
BEGIN
  SELECT items INTO v_items FROM catalog WHERE type = 'medicaments' FOR UPDATE;
  IF v_items IS NULL THEN RAISE EXCEPTION 'Catalogue "medicaments" introuvable'; END IF;
  SELECT (ordinality - 1)::int INTO v_index
  FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(elem, ordinality)
  WHERE elem ->> 'id' = p_id;
  IF v_index IS NULL THEN RAISE EXCEPTION 'Médicament "%" introuvable', p_id; END IF;
  v_item := jsonb_set(v_items -> v_index, '{exoneration50}', to_jsonb(p_valeur));
  v_items := jsonb_set(v_items, ARRAY[v_index::text], v_item);
  UPDATE catalog SET items = v_items, updated_at = now() WHERE type = 'medicaments';
  RETURN v_item;
END;
$function$;
