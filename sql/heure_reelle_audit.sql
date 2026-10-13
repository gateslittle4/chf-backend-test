-- sql/heure_reelle_audit.sql — l'heure d'une ligne du journal d'audit est celle de la base de données, jamais celle de l'ordinateur (13/10, Esdras :
-- « l'heure doit être l'heure réelle, on peut dérégler l'ordi »). L'application écrit audit_log directement (policy audit_insertion_soi) avec
-- date = new Date() du navigateur : un PC déréglé faussait la date de chaque action. Le journal n'est écrit qu'en ligne (hors ligne l'insertion
-- échoue, rien n'est mis en file), donc now() est toujours l'heure réelle de l'action.
-- Sans DROP ni REVOKE (le connecteur Supabase des sessions Claude les bloque) ; relançable sans effet. Fonction dans le schéma interne chf_interne.
create schema if not exists chf_interne;

create or replace function chf_interne.audit_heure_serveur() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.date := now();
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_audit_heure_serveur' and tgrelid = 'public.audit_log'::regclass) then
    create trigger trg_audit_heure_serveur before insert on public.audit_log
      for each row execute function chf_interne.audit_heure_serveur();
  end if;
end;
$$;
