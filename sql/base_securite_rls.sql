-- sql/base_securite_rls.sql — la sécurité par ligne (RLS) de la base : fonctions mon_uid()/mon_role_chf(), activation de la RLS sur chaque table, et les 15 politiques.
-- Relevé de la production le 16/10/2026. DÉJÀ EN PLACE en production : ce script n'y change rien (mêmes définitions), il existe pour que le dépôt contienne TOUT ce qu'il faut
-- pour reconstruire la base — jusqu'ici ces fonctions et politiques n'existaient que dans Supabase, et les scripts corrige_policy_* / restaure_droit_execute_fonctions_rls
-- échouaient sur une base neuve (« function mon_role_chf() does not exist »). Le nom commence par « base_ » pour être rejoué avant eux (ordre alphabétique).
-- Le serveur utilise la clé de service, qui contourne la RLS : ces politiques protègent les accès DIRECTS du navigateur (shim db) et toute clé publique qui fuiterait.
-- Rejouable sans danger (chaque politique est remplacée dans la même transaction). `auth.jwt()` vient de Supabase.

BEGIN;

CREATE OR REPLACE FUNCTION public.mon_uid() RETURNS text
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $function$ SELECT auth.jwt() ->> 'sub'; $function$;

CREATE OR REPLACE FUNCTION public.mon_role_chf() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$ SELECT role FROM users WHERE id = mon_uid(); $function$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public.mon_role_chf() FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.mon_role_chf() TO authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.mon_uid() TO anon, authenticated, service_role;
  END IF;
END $$;

ALTER TABLE public.actes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloture_caisse ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compteurs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decrements_stock_appliques ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demandes_exoneration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.depenses_caisse ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doublons_ignores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erreurs_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fiches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lignes_effacees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medicaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.migrations_appliquees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ong_partenaires ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paiements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pieces_jointes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.postes_etat ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requetes_idempotentes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salaires_service ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transferts_service ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_lecture_soi ON public.users;
CREATE POLICY users_lecture_soi ON public.users AS PERMISSIVE FOR SELECT TO public USING ((id = mon_uid()));
DROP POLICY IF EXISTS users_lecture_admin ON public.users;
CREATE POLICY users_lecture_admin ON public.users AS PERMISSIVE FOR SELECT TO public USING ((mon_role_chf() = 'administrateur'::text));
DROP POLICY IF EXISTS users_ecriture_admin ON public.users;
CREATE POLICY users_ecriture_admin ON public.users AS PERMISSIVE FOR UPDATE TO public USING ((mon_role_chf() = 'administrateur'::text));
DROP POLICY IF EXISTS users_creation_admin ON public.users;
CREATE POLICY users_creation_admin ON public.users AS PERMISSIVE FOR INSERT TO public WITH CHECK ((mon_role_chf() = 'administrateur'::text));
DROP POLICY IF EXISTS audit_insertion_soi ON public.audit_log;
CREATE POLICY audit_insertion_soi ON public.audit_log AS PERMISSIVE FOR INSERT TO public WITH CHECK ((effectue_par_uid = mon_uid()));
DROP POLICY IF EXISTS audit_lecture_admin ON public.audit_log;
CREATE POLICY audit_lecture_admin ON public.audit_log AS PERMISSIVE FOR SELECT TO public USING ((mon_role_chf() = ANY (ARRAY['administrateur'::text, 'direction'::text, 'auditeur'::text])));
DROP POLICY IF EXISTS exoneration_lecture ON public.demandes_exoneration;
CREATE POLICY exoneration_lecture ON public.demandes_exoneration AS PERMISSIVE FOR SELECT TO public USING (((demandeur_uid = mon_uid()) OR (mon_role_chf() = ANY (ARRAY['comptable'::text, 'direction'::text, 'administrateur'::text, 'auditeur'::text]))));
DROP POLICY IF EXISTS exoneration_creation ON public.demandes_exoneration;
CREATE POLICY exoneration_creation ON public.demandes_exoneration AS PERMISSIVE FOR INSERT TO public WITH CHECK ((demandeur_uid = mon_uid()));
DROP POLICY IF EXISTS exoneration_reponse ON public.demandes_exoneration;
CREATE POLICY exoneration_reponse ON public.demandes_exoneration AS PERMISSIVE FOR UPDATE TO public USING (((mon_role_chf() = ANY (ARRAY['direction'::text, 'administrateur'::text])) AND (statut = ANY (ARRAY['en_attente'::text, 'en_cours_de_traitement'::text])))) WITH CHECK ((mon_role_chf() = ANY (ARRAY['direction'::text, 'administrateur'::text])));
DROP POLICY IF EXISTS ong_lecture_tous ON public.ong_partenaires;
CREATE POLICY ong_lecture_tous ON public.ong_partenaires AS PERMISSIVE FOR SELECT TO public USING ((mon_role_chf() IS NOT NULL));
DROP POLICY IF EXISTS ong_ecriture_admin ON public.ong_partenaires;
CREATE POLICY ong_ecriture_admin ON public.ong_partenaires AS PERMISSIVE FOR ALL TO public USING ((mon_role_chf() = ANY (ARRAY['direction'::text, 'administrateur'::text])));
DROP POLICY IF EXISTS salaires_lecture_ecriture ON public.salaires_service;
CREATE POLICY salaires_lecture_ecriture ON public.salaires_service AS PERMISSIVE FOR ALL TO public USING ((mon_role_chf() = ANY (ARRAY['direction'::text, 'administrateur'::text])));
DROP POLICY IF EXISTS cloture_lecture_soi ON public.cloture_caisse;
CREATE POLICY cloture_lecture_soi ON public.cloture_caisse AS PERMISSIVE FOR SELECT TO public USING ((cloturee_par_uid = mon_uid()));
DROP POLICY IF EXISTS cloture_lecture_super ON public.cloture_caisse;
CREATE POLICY cloture_lecture_super ON public.cloture_caisse AS PERMISSIVE FOR SELECT TO public USING ((mon_role_chf() = ANY (ARRAY['comptable'::text, 'direction'::text, 'administrateur'::text])));
DROP POLICY IF EXISTS cloture_ecriture_soi ON public.cloture_caisse;
CREATE POLICY cloture_ecriture_soi ON public.cloture_caisse AS PERMISSIVE FOR ALL TO public USING ((cloturee_par_uid = mon_uid()));

COMMIT;
