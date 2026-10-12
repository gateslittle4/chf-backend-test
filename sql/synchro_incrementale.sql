-- 12/10 : synchronisation INCRÉMENTALE des listes d'épisodes et de paiements.
--
-- Pourquoi : chaque poste retéléchargeait TOUT l'historique toutes les 45 s (~4 Ko par épisode avec ses
-- fiches et paiements). Ça passe à 50 épisodes ; à 2 000 (quelques semaines d'activité réelle), c'est
-- ~1 Mo compressé par poste et par rafraîchissement, des centaines de Mo de données mobiles par jour et
-- par téléphone, et un serveur qui assemble des dizaines de Mo de JSON en boucle. Avec ce script, l'app ne
-- demande plus que ce qui a changé depuis sa dernière lecture (voir utils/synchroListes.js).
--
-- Ce que fait ce script (rejouable sans risque : chaque étape vérifie si elle est déjà faite) :
--   1) une colonne modifie_le sur episodes, dossiers, fiches et paiements, mise à l'heure AUTOMATIQUEMENT
--      par un déclencheur à chaque création ou modification — aucun code n'a à y penser ;
--   2) une table lignes_effacees qui garde une trace (quelques jours) de chaque épisode, fiche ou paiement
--      SUPPRIMÉ définitivement (purge de la corbeille, annulation d'une opération ratée), pour que les
--      autres postes le retirent aussi de leur liste ;
--   3) des index sur ces dates, pour que « qu'est-ce qui a changé depuis 10 h 32 ? » reste instantané.
--
-- Avant ce script, l'app fonctionne exactement comme avant (liste complète à chaque fois) : le serveur
-- vérifie que tout est en place avant d'utiliser la synchronisation incrémentale. Rien ne casse si le
-- script n'est jamais collé, ou s'il est collé deux fois.
--
-- Données existantes : toutes les lignes reçoivent l'heure d'application du script ; le premier
-- rafraîchissement de chaque poste après coup relit donc tout une fois, puis seulement les changements.
--
-- Sécurité : les deux fonctions ci-dessous ne servent qu'aux déclencheurs. Personne (ni visiteur, ni
-- personne connectée) ne peut les appeler directement ; un déclencheur, lui, n'a pas besoin de ce droit
-- pour s'exécuter. Aucune règle RLS ne les utilise (contrairement à mon_role_chf(), incident du 08/10).
-- La table lignes_effacees n'est lisible que par le serveur (service_role), comme les autres tables.
--
-- Testé sur un Postgres 16 jetable : python3 scripts/test-synchro-incrementale-sql.py

-- 1) Colonne modifie_le + déclencheur
ALTER TABLE public.episodes  ADD COLUMN IF NOT EXISTS modifie_le timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.dossiers  ADD COLUMN IF NOT EXISTS modifie_le timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.fiches    ADD COLUMN IF NOT EXISTS modifie_le timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.paiements ADD COLUMN IF NOT EXISTS modifie_le timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.marquer_modifie_le()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- Toujours l'heure de la base, jamais une valeur envoyée par l'app (une restauration de sauvegarde
  -- qui réinsère une ligne doit, elle aussi, être vue comme un changement par les autres postes).
  NEW.modifie_le := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_episodes_modifie_le  ON public.episodes;
DROP TRIGGER IF EXISTS trg_dossiers_modifie_le  ON public.dossiers;
DROP TRIGGER IF EXISTS trg_fiches_modifie_le    ON public.fiches;
DROP TRIGGER IF EXISTS trg_paiements_modifie_le ON public.paiements;
CREATE TRIGGER trg_episodes_modifie_le  BEFORE INSERT OR UPDATE ON public.episodes  FOR EACH ROW EXECUTE FUNCTION public.marquer_modifie_le();
CREATE TRIGGER trg_dossiers_modifie_le  BEFORE INSERT OR UPDATE ON public.dossiers  FOR EACH ROW EXECUTE FUNCTION public.marquer_modifie_le();
CREATE TRIGGER trg_fiches_modifie_le    BEFORE INSERT OR UPDATE ON public.fiches    FOR EACH ROW EXECUTE FUNCTION public.marquer_modifie_le();
CREATE TRIGGER trg_paiements_modifie_le BEFORE INSERT OR UPDATE ON public.paiements FOR EACH ROW EXECUTE FUNCTION public.marquer_modifie_le();

-- 2) Trace des suppressions définitives
CREATE TABLE IF NOT EXISTS public.lignes_effacees (
  id         bigserial PRIMARY KEY,
  table_nom  text NOT NULL,
  ligne_id   uuid NOT NULL,
  episode_id uuid,               -- pour une fiche ou un paiement : l'épisode à rafraîchir
  efface_le  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.lignes_effacees ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lignes_effacees FROM anon, authenticated;
GRANT SELECT, DELETE ON public.lignes_effacees TO service_role;

-- SECURITY DEFINER : l'écriture de la trace ne dépend pas des droits de qui supprime (le serveur, la
-- tâche de purge...). search_path fixé, et EXECUTE retiré à tout le monde juste en dessous.
CREATE OR REPLACE FUNCTION public.noter_ligne_effacee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.lignes_effacees (table_nom, ligne_id, episode_id)
  VALUES (TG_TABLE_NAME, OLD.id, NULLIF(to_jsonb(OLD) ->> 'episode_id', '')::uuid);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_episodes_efface  ON public.episodes;
DROP TRIGGER IF EXISTS trg_fiches_efface    ON public.fiches;
DROP TRIGGER IF EXISTS trg_paiements_efface ON public.paiements;
CREATE TRIGGER trg_episodes_efface  AFTER DELETE ON public.episodes  FOR EACH ROW EXECUTE FUNCTION public.noter_ligne_effacee();
CREATE TRIGGER trg_fiches_efface    AFTER DELETE ON public.fiches    FOR EACH ROW EXECUTE FUNCTION public.noter_ligne_effacee();
CREATE TRIGGER trg_paiements_efface AFTER DELETE ON public.paiements FOR EACH ROW EXECUTE FUNCTION public.noter_ligne_effacee();

REVOKE ALL ON FUNCTION public.marquer_modifie_le()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.noter_ligne_effacee() FROM PUBLIC, anon, authenticated;

-- 3) Index
CREATE INDEX IF NOT EXISTS idx_episodes_modifie_le  ON public.episodes  (modifie_le);
CREATE INDEX IF NOT EXISTS idx_dossiers_modifie_le  ON public.dossiers  (modifie_le);
CREATE INDEX IF NOT EXISTS idx_fiches_modifie_le    ON public.fiches    (modifie_le);
CREATE INDEX IF NOT EXISTS idx_paiements_modifie_le ON public.paiements (modifie_le);
CREATE INDEX IF NOT EXISTS idx_lignes_effacees_efface_le ON public.lignes_effacees (efface_le);
