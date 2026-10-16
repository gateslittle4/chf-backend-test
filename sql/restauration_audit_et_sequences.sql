-- sql/restauration_audit_et_sequences.sql — ce qu'il faut pour RESTAURER une sauvegarde sans abîmer les données (16/10, test de restauration).
-- Deux problèmes trouvés en essayant vraiment de restaurer une sauvegarde dans une base vide :
--
-- 1. LE JOURNAL D'AUDIT PERDAIT TOUTES SES DATES. Le déclencheur trg_audit_heure_serveur remet `date` à l'heure de la base à chaque insertion (voulu : un poste dont
--    l'horloge est fausse ne doit pas pouvoir antidater une trace). Mais une restauration réinsère les lignes : toutes auraient reçu l'heure de la restauration, et
--    des années de journal n'auraient plus eu qu'une seule date. Solution : la restauration passe par restaurer_audit_log(), réservée au serveur, qui lève
--    le drapeau « chf.restauration » le temps d'UNE transaction ; le déclencheur le respecte. Personne d'autre ne peut le lever (la fonction n'est pas appelable par
--    les utilisateurs), donc rien n'est antidatable.
-- 2. LES NUMÉROS DE PAIEMENT REPARTAIENT DE 1. paiements.numero_paiement vient d'une séquence : dans une base neuve elle démarre à 1, alors que les paiements
--    restaurés portent déjà ces numéros (unicité) — le premier encaissement après la restauration échouait. realigner_sequences() la remet après le plus grand numéro.
-- Réservées au serveur (clé de service). Rejouable sans danger. À coller dans Supabase → SQL Editor.

CREATE OR REPLACE FUNCTION chf_interne.audit_heure_serveur() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
begin
  -- Restauration d'une sauvegarde (voir restaurer_audit_log) : la date d'origine est conservée.
  if coalesce(current_setting('chf.restauration', true), '') = 'on' then
    return new;
  end if;
  new.date := now();
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION public.restaurer_audit_log(p_lignes jsonb) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
declare
  v_n integer;
begin
  perform set_config('chf.restauration', 'on', true);  -- vaut pour cette transaction seulement
  insert into public.audit_log
    select * from jsonb_populate_recordset(null::public.audit_log, p_lignes)
    on conflict (id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

CREATE OR REPLACE FUNCTION public.realigner_sequences() RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
declare
  v_paiement bigint;
begin
  select coalesce(max(numero_paiement), 0) into v_paiement from public.paiements;
  -- Ne jamais reculer : si la séquence est déjà plus loin (restauration dans une base en service), on la laisse.
  if v_paiement > 0 and v_paiement >= (select coalesce(last_value, 0) from pg_sequences where schemaname = 'public' and sequencename = 'paiements_numero_paiement_seq') then
    perform setval('public.paiements_numero_paiement_seq', v_paiement, true);
  end if;
  return jsonb_build_object('paiements_numero_paiement_seq', (select last_value from pg_sequences where schemaname = 'public' and sequencename = 'paiements_numero_paiement_seq'));
end;
$$;

REVOKE EXECUTE ON FUNCTION public.restaurer_audit_log(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.realigner_sequences() FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.restaurer_audit_log(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.realigner_sequences() TO service_role;
  END IF;
END $$;
