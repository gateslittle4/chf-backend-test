-- sql/numero_dossier_compteur.sql — numéro de dossier donné par la caisse, avec un compteur (16/10, Esdras).
-- « Le site donne le numéro automatiquement, c'est moi qui définis où ça commence, la caisse peut le modifier. » Voir utils/numeroDossier.js.
--
-- Le compteur est la ligne id = 'dossiers' de la table `compteurs` (déjà là : id text, derniernumero integer). Quatre fonctions, TOUTES réservées au serveur (clé de service) :
--   - numero_dossier_propose()            : le prochain numéro LIBRE (compteur + 1, en sautant ceux déjà pris — un numéro d'archive tapé à la main plus tôt ne bloque rien) ;
--   - attribuer_numero_dossier(id, numero) : donne ce numéro au dossier (jamais un numéro déjà pris par un autre dossier) ; si c'est exactement le numéro proposé, le compteur avance ;
--   - numero_dossier_depart()              : le prochain numéro que le site proposerait (pour l'écran de réglage) ;
--   - definir_numero_dossier_depart(n)     : l'administrateur choisit le prochain numéro (le compteur devient n - 1).
-- Corrige au passage increment_counter(), qui visait une colonne `dernier_numero` qui n'existe pas (la colonne s'appelle `derniernumero`) : elle n'était appelée nulle part.
-- Rejouable sans danger. À coller dans Supabase → SQL Editor.

INSERT INTO public.compteurs (id, derniernumero) VALUES ('dossiers', 0) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.increment_counter(counter_name text) RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  new_value INTEGER;
BEGIN
  UPDATE compteurs
  SET derniernumero = derniernumero + 1,
      updated_at = NOW()
  WHERE id = counter_name
  RETURNING derniernumero INTO new_value;

  IF new_value IS NULL THEN
    INSERT INTO compteurs (id, derniernumero)
    VALUES (counter_name, 1)
    RETURNING derniernumero INTO new_value;
  END IF;

  RETURN new_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.numero_dossier_propose() RETURNS text
LANGUAGE plpgsql STABLE
SET search_path TO 'public'
AS $$
DECLARE
  n bigint;
BEGIN
  SELECT derniernumero + 1 INTO n FROM compteurs WHERE id = 'dossiers';
  IF n IS NULL THEN n := 1; END IF;
  WHILE EXISTS (SELECT 1 FROM dossiers WHERE numero_dossier = n::text) LOOP
    n := n + 1;
  END LOOP;
  RETURN n::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.attribuer_numero_dossier(p_dossier uuid, p_numero text) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_numero text := btrim(coalesce(p_numero, ''));
  v_ancien text;
  v_propose text;
  v_automatique boolean := false;
BEGIN
  IF v_numero = '' THEN RAISE EXCEPTION 'Le numéro de dossier est requis.' USING errcode = 'CHF30'; END IF;
  SELECT numero_dossier INTO v_ancien FROM dossiers WHERE id = p_dossier FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dossier introuvable.' USING errcode = 'CHF31'; END IF;
  IF v_ancien = v_numero THEN
    RETURN jsonb_build_object('numero', v_numero, 'ancien', v_ancien, 'inchange', true);
  END IF;
  IF EXISTS (SELECT 1 FROM dossiers WHERE numero_dossier = v_numero AND id <> p_dossier) THEN
    RAISE EXCEPTION 'Ce numéro est déjà utilisé par un autre dossier.' USING errcode = 'CHF32';
  END IF;
  v_propose := numero_dossier_propose();
  UPDATE dossiers SET numero_dossier = v_numero WHERE id = p_dossier;
  -- Le compteur n'avance que si la caisse a pris le numéro PROPOSÉ tel quel : un numéro modifié à la main (faute de frappe, numéro d'archive papier) ne le fait pas sauter.
  IF v_numero = v_propose AND v_numero ~ '^[0-9]{1,9}$' THEN
    v_automatique := true;
    UPDATE compteurs SET derniernumero = GREATEST(derniernumero, v_numero::integer), updated_at = now() WHERE id = 'dossiers';
  END IF;
  RETURN jsonb_build_object('numero', v_numero, 'ancien', v_ancien, 'automatique', v_automatique);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Ce numéro est déjà utilisé par un autre dossier.' USING errcode = 'CHF32';
END;
$$;

CREATE OR REPLACE FUNCTION public.numero_dossier_depart() RETURNS bigint
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$ SELECT coalesce((SELECT derniernumero + 1 FROM compteurs WHERE id = 'dossiers'), 1)::bigint; $$;

CREATE OR REPLACE FUNCTION public.definir_numero_dossier_depart(p_prochain bigint) RETURNS bigint
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF p_prochain IS NULL OR p_prochain < 1 OR p_prochain > 999999999 THEN
    RAISE EXCEPTION 'Le numéro de départ doit être un entier entre 1 et 999999999.' USING errcode = 'CHF33';
  END IF;
  INSERT INTO compteurs (id, derniernumero, updated_at) VALUES ('dossiers', p_prochain - 1, now())
  ON CONFLICT (id) DO UPDATE SET derniernumero = EXCLUDED.derniernumero, updated_at = now();
  RETURN p_prochain;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.numero_dossier_propose() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.attribuer_numero_dossier(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.numero_dossier_depart() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.definir_numero_dossier_depart(bigint) FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.numero_dossier_propose() TO service_role;
    GRANT EXECUTE ON FUNCTION public.attribuer_numero_dossier(uuid, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.numero_dossier_depart() TO service_role;
    GRANT EXECUTE ON FUNCTION public.definir_numero_dossier_depart(bigint) TO service_role;
  END IF;
END $$;
