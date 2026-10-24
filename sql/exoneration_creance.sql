-- sql/exoneration_creance.sql — « Exonérer cette créance » (24/10, Esdras) : la direction décide sur papier de pardonner tout ou partie de la dette d'un patient,
-- la caisse passe l'écriture. Une ligne de paiement en mode « exoneration » (déjà connu partout : rapport des exonérations, détection d'anomalies, Direction) :
--   montant = 0 (AUCUN argent n'entre dans le tiroir)  ·  solde_restant = dette d'avant − montant pardonné  ·  details.exoneration_creance = true  ·  exoneration.montantExonere = montant pardonné.
-- Comme pour tout paiement, le solde d'un épisode est le solde_restant de son DERNIER paiement valide ; ici lecture + vérification + écriture se font d'un bloc, sous le MÊME verrou
-- par épisode que enregistrer_paiement_atomique (sql/solde_atomique.sql) : un remboursement qui arrive en même temps attend, la dette ne peut pas passer sous 0.
-- Refus (rien n'est écrit) : CHF01 aucune dette à exonérer · CHF02 montant ≤ 0 · CHF03 montant supérieur à la dette.
-- Sans DROP ni REVOKE. SECURITY INVOKER : seul le serveur (service_role) peut s'en servir. Relançable sans effet (create or replace).
create or replace function public.exonerer_creance_atomique(p_episode uuid, p_montant numeric, p_corps jsonb, p_heure_serveur boolean default true)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_solde numeric;
  v_corps jsonb;
  v_colonnes text;
  v_resultat jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('chf:paiement:' || p_episode::text, 0));

  select coalesce(solde_restant, 0) into v_solde
    from public.paiements
   where episode_id = p_episode and (annule = false or annule is null) and supprime_le is null
   order by date_paiement desc, numero_paiement desc
   limit 1;
  v_solde := coalesce(v_solde, 0);

  if v_solde <= 0 then
    raise exception 'Aucune dette à exonérer pour cet épisode.' using errcode = 'CHF01';
  end if;
  if coalesce(p_montant, 0) <= 0 then
    raise exception 'Le montant à exonérer doit être supérieur à 0.' using errcode = 'CHF02';
  end if;
  if p_montant > v_solde then
    raise exception 'Le montant à exonérer (%) dépasse la dette restante (%).', p_montant, v_solde using errcode = 'CHF03';
  end if;

  v_corps := p_corps || jsonb_build_object('episode_id', p_episode, 'mode', 'exoneration', 'montant', 0, 'solde_restant', v_solde - p_montant);
  if coalesce(p_heure_serveur, true) then
    v_corps := v_corps || jsonb_build_object('date_paiement', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  end if;

  select string_agg(quote_ident(a.attname), ', ') into v_colonnes
    from pg_catalog.pg_attribute a
   where a.attrelid = 'public.paiements'::regclass and a.attnum > 0 and not a.attisdropped
     and v_corps ? a.attname::text;

  execute format(
    'insert into public.paiements (%1$s) select %1$s from jsonb_populate_record(null::public.paiements, $1) returning to_jsonb(paiements.*)',
    v_colonnes
  ) using v_corps into v_resultat;

  return v_resultat;
end;
$$;
