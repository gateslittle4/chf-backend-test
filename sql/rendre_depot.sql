-- sql/rendre_depot.sql — « Rendre le dépôt » (27/10, Esdras : « on clique sur quoi pour retirer de l'argent si le dossier n'a pas dépensé tout le dépôt ? »).
-- Un patient a laissé un dépôt et n'en a pas dépensé la totalité : la caisse lui rend ce qui reste. Une ligne de paiement en mode « remboursement_patient » (déjà connu partout : argent qui SORT du tiroir,
-- rapport des remboursements, totaux de la direction) qui porte details.montant_depot_utilise = le montant rendu : le calcul du dépôt disponible (dépôts + transferts − utilisé, voir calculerSoldeDepot)
-- le baisse donc tout seul, sans changer aucune règle de calcul. La dette éventuelle de l'épisode est recopiée telle quelle (un remboursement de dépôt n'y touche pas).
-- Lecture du dépôt + vérification + écriture d'un bloc, sous le MÊME verrou par épisode que enregistrer_paiement_atomique (sql/solde_atomique.sql) : une vente qui consomme le dépôt en même temps attend.
-- Refus (rien n'est écrit) : CHF01 aucun dépôt disponible · CHF02 montant ≤ 0 · CHF03 montant supérieur au dépôt disponible.
-- Sans DROP ni REVOKE. SECURITY INVOKER : seul le serveur (service_role) peut s'en servir. Relançable sans effet (create or replace).
create or replace function public.rendre_depot_atomique(p_episode uuid, p_montant numeric, p_corps jsonb, p_heure_serveur boolean default true)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_depose numeric;
  v_utilise numeric;
  v_dispo numeric;
  v_dette numeric;
  v_corps jsonb;
  v_colonnes text;
  v_resultat jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('chf:paiement:' || p_episode::text, 0));

  select coalesce(sum(case when mode = 'depot' then montant else 0 end), 0) + coalesce(sum(nullif(details ->> 'depot_transfere', '')::numeric), 0),
         coalesce(sum(nullif(details ->> 'montant_depot_utilise', '')::numeric), 0)
    into v_depose, v_utilise
    from public.paiements
   where episode_id = p_episode and (annule = false or annule is null) and supprime_le is null;
  v_dispo := greatest(0, coalesce(v_depose, 0) - coalesce(v_utilise, 0));

  if v_dispo <= 0 then
    raise exception 'Aucun dépôt disponible à rendre pour cet épisode.' using errcode = 'CHF01';
  end if;
  if coalesce(p_montant, 0) <= 0 then
    raise exception 'Le montant à rendre doit être supérieur à 0.' using errcode = 'CHF02';
  end if;
  if p_montant > v_dispo then
    raise exception 'Le montant à rendre (%) dépasse le dépôt disponible (%).', p_montant, v_dispo using errcode = 'CHF03';
  end if;

  select coalesce(solde_restant, 0) into v_dette
    from public.paiements
   where episode_id = p_episode and (annule = false or annule is null) and supprime_le is null
   order by date_paiement desc, numero_paiement desc
   limit 1;

  v_corps := p_corps || jsonb_build_object(
    'episode_id', p_episode, 'mode', 'remboursement_patient', 'montant', p_montant, 'solde_restant', coalesce(v_dette, 0),
    'details', coalesce(p_corps -> 'details', '{}'::jsonb) || jsonb_build_object('depot_rendu', true, 'montant_depot_utilise', p_montant));
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
