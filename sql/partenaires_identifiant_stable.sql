-- sql/partenaires_identifiant_stable.sql — rattacher les épisodes et les paiements d'un partenaire à son IDENTIFIANT, pas seulement à son nom (15/10).
-- Pourquoi : episodes.ong_partenaire et paiements.ong_partenaire contiennent le NOM du partenaire. Corriger l'écriture d'un nom (« AVSI » → « Avsi ») couperait ses
-- anciens épisodes, ses lots et ses rapports de son nouveau nom : l'historique de deux ans se retrouverait en deux morceaux.
-- ÉTAT : PRÉPARÉ, PAS ENCORE APPLIQUÉ (décision d'Esdras, 15/10). Rien dans le site ne lit ces colonnes : le coller ne change aucun écran, et le serveur n'a pas besoin de changer.
-- Entièrement AJOUTÉ (aucune colonne ni donnée existante n'est modifiée ou supprimée) et rejouable sans danger.
--
-- Ce que ça fait :
--   1. ajoute ong_partenaire_id (nullable, indexée) sur episodes et paiements ;
--   2. la remplit pour l'historique : nom identique (sans tenir compte des majuscules ni des espaces autour) à UN SEUL partenaire non supprimé ; les noms ambigus ou inconnus restent vides ;
--   3. un déclencheur la remplit toute seule à chaque nouvelle ligne (ou quand ong_partenaire change) : le serveur n'a rien à faire ;
--   4. renommer_partenaire(id, nouveau_nom) change le nom du partenaire ET celui de tous ses épisodes et paiements d'un seul bloc.
-- Reste hors de ce script (à traiter à l'activation) : les « dons par partenaire » du stock (catalog.medicaments[].donsParOng) sont rangés par NOM dans un champ JSON.

ALTER TABLE public.episodes  ADD COLUMN IF NOT EXISTS ong_partenaire_id text;
ALTER TABLE public.paiements ADD COLUMN IF NOT EXISTS ong_partenaire_id text;
CREATE INDEX IF NOT EXISTS idx_episodes_ong_partenaire_id  ON public.episodes  (ong_partenaire_id)  WHERE ong_partenaire_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paiements_ong_partenaire_id ON public.paiements (ong_partenaire_id) WHERE ong_partenaire_id IS NOT NULL;

-- Le partenaire (non supprimé) qui porte ce nom ; NULL si aucun ou si plusieurs portent le même nom (on ne devine pas).
CREATE OR REPLACE FUNCTION public.id_partenaire_par_nom(p_nom text) RETURNS text
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(id) END
  FROM ong_partenaires
  WHERE supprime_le IS NULL AND lower(btrim(nom)) = lower(btrim(coalesce(p_nom, '')));
$$;

-- 2. Historique.
UPDATE public.episodes  SET ong_partenaire_id = public.id_partenaire_par_nom(ong_partenaire) WHERE ong_partenaire_id IS NULL AND ong_partenaire IS NOT NULL AND btrim(ong_partenaire) <> '';
UPDATE public.paiements SET ong_partenaire_id = public.id_partenaire_par_nom(ong_partenaire) WHERE ong_partenaire_id IS NULL AND ong_partenaire IS NOT NULL AND btrim(ong_partenaire) <> '';

-- 3. Nouvelles lignes. Si le nom change (ou si l'identifiant n'est pas fourni), l'identifiant suit le nom ; un nom vide efface l'identifiant.
CREATE OR REPLACE FUNCTION public.rattacher_partenaire_id() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NEW.ong_partenaire IS NULL OR btrim(NEW.ong_partenaire) = '' THEN
    NEW.ong_partenaire_id := NULL;
  ELSIF TG_OP = 'INSERT' OR NEW.ong_partenaire IS DISTINCT FROM OLD.ong_partenaire THEN
    NEW.ong_partenaire_id := public.id_partenaire_par_nom(NEW.ong_partenaire);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS rattacher_partenaire_id ON public.episodes;
CREATE TRIGGER rattacher_partenaire_id BEFORE INSERT OR UPDATE OF ong_partenaire ON public.episodes  FOR EACH ROW EXECUTE FUNCTION public.rattacher_partenaire_id();
DROP TRIGGER IF EXISTS rattacher_partenaire_id ON public.paiements;
CREATE TRIGGER rattacher_partenaire_id BEFORE INSERT OR UPDATE OF ong_partenaire ON public.paiements FOR EACH ROW EXECUTE FUNCTION public.rattacher_partenaire_id();

-- 4. Renommer un partenaire sans couper son historique. Renvoie le nombre d'épisodes et de paiements suivis.
CREATE OR REPLACE FUNCTION public.renommer_partenaire(p_id text, p_nouveau_nom text) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE v_nom text := btrim(coalesce(p_nouveau_nom, '')); v_ep int; v_pa int;
BEGIN
  IF v_nom = '' THEN RAISE EXCEPTION 'Le nouveau nom est vide.' USING errcode = 'CHF20'; END IF;
  IF NOT EXISTS (SELECT 1 FROM ong_partenaires WHERE id = p_id AND supprime_le IS NULL) THEN RAISE EXCEPTION 'Partenaire introuvable.' USING errcode = 'CHF21'; END IF;
  IF EXISTS (SELECT 1 FROM ong_partenaires WHERE id <> p_id AND supprime_le IS NULL AND lower(btrim(nom)) = lower(v_nom)) THEN RAISE EXCEPTION 'Un autre partenaire porte déjà ce nom.' USING errcode = 'CHF22'; END IF;
  UPDATE ong_partenaires SET nom = v_nom WHERE id = p_id;
  UPDATE episodes  SET ong_partenaire = v_nom WHERE ong_partenaire_id = p_id; GET DIAGNOSTICS v_ep = ROW_COUNT;
  UPDATE paiements SET ong_partenaire = v_nom WHERE ong_partenaire_id = p_id; GET DIAGNOSTICS v_pa = ROW_COUNT;
  RETURN jsonb_build_object('episodes', v_ep, 'paiements', v_pa);
END $$;

-- Réservé au serveur (clé de service), comme les autres fonctions d'écriture.
REVOKE EXECUTE ON FUNCTION public.renommer_partenaire(text, text) FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.renommer_partenaire(text, text) TO service_role;
  END IF;
END $$;
