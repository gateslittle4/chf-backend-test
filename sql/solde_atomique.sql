-- sql/solde_atomique.sql — enregistrement d'un paiement avec son solde, EN UNE SEULE opération de la base, avec un verrou par épisode (13/10).
-- Avant, le serveur LISAIT le dernier solde de l'épisode, calculait, puis ÉCRIVAIT le paiement : deux paiements du même patient arrivant en même temps
-- (deux caisses, ou un rejeu de la file hors ligne pendant qu'une caisse encaisse) lisaient le même ancien solde, et le second écrasait le report du premier —
-- une dette pouvait être « oubliée » ou un remboursement dépasser la dette. Ici : verrou consultatif par épisode (pg_advisory_xact_lock, relâché à la fin de
-- l'opération) → le 2e paiement attend le 1er, relit le solde À JOUR, puis écrit. Les paiements d'épisodes différents ne s'attendent jamais.
--
-- Même règle de solde qu'avant (voir server.js, historique) : solde de l'épisode = solde_restant du DERNIER paiement non annulé et non supprimé (par date_paiement) ;
-- remboursement de crédit : solde − montant (refusé s'il n'y a rien à rembourser, si le montant est ≤ 0 ou dépasse le solde) ; tout autre paiement : solde + p_ajout
-- (p_ajout = ce que CE paiement ajoute : sa dette pour un crédit, son reste pour un paiement partiel, 0 sinon — calculé par le serveur, utils/paiementPartiel.js).
-- p_heure_serveur (défaut vrai) : la date_paiement d'un paiement en direct est celle de l'écriture elle-même (voir plus bas) ; faux pour un rejeu hors ligne (date de l'appareil gardée).
-- Refus de remboursement : codes d'erreur CHF01 / CHF02 / CHF03 (le serveur répond 400 avec le message).
-- Sans DROP ni REVOKE (bloqués par le connecteur Supabase des sessions Claude). SECURITY INVOKER : la sécurité par lignes de paiements s'applique à l'appelant
-- (anon / authenticated n'ont aucune règle, donc aucun accès) ; seul le serveur (service_role) peut s'en servir. Relançable sans effet.
create or replace function public.enregistrer_paiement_atomique(p_corps jsonb, p_ajout numeric default 0, p_remboursement_credit boolean default false, p_heure_serveur boolean default true)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_episode uuid;
  v_solde numeric;
  v_montant numeric;
  v_corps jsonb := p_corps;
  v_colonnes text;
  v_resultat jsonb;
begin
  v_episode := nullif(p_corps ->> 'episode_id', '')::uuid;

  if v_episode is not null then
    -- Un seul paiement à la fois PAR ÉPISODE : le suivant attend ici que celui-ci soit écrit.
    perform pg_advisory_xact_lock(hashtextextended('chf:paiement:' || v_episode::text, 0));

    select coalesce(solde_restant, 0) into v_solde
      from public.paiements
     where episode_id = v_episode and (annule = false or annule is null) and supprime_le is null
     order by date_paiement desc, numero_paiement desc
     limit 1;
    v_solde := coalesce(v_solde, 0);

    if p_remboursement_credit then
      v_montant := coalesce(nullif(p_corps ->> 'montant', '')::numeric, 0);
      if v_solde <= 0 then
        raise exception 'Aucun solde de crédit à rembourser pour cet épisode.' using errcode = 'CHF01';
      end if;
      if v_montant <= 0 then
        raise exception 'Le montant du remboursement doit être supérieur à 0.' using errcode = 'CHF02';
      end if;
      if v_montant > v_solde then
        raise exception 'Le remboursement (%) dépasse le solde restant (%).', v_montant, v_solde using errcode = 'CHF03';
      end if;
      v_corps := v_corps || jsonb_build_object('solde_restant', v_solde - v_montant);
    else
      v_corps := v_corps || jsonb_build_object('solde_restant', v_solde + coalesce(p_ajout, 0));
    end if;
  end if;

  -- Date d'un paiement EN DIRECT : prise ICI, sous le verrou (clock_timestamp = l'instant réel de l'écriture), jamais l'heure de DÉBUT de la requête. Sinon deux paiements
  -- simultanés pouvaient s'écrire dans l'ordre inverse de leurs dates : le « dernier paiement par date » n'était plus celui qui porte le solde à jour, et le suivant repartait
  -- d'un solde périmé (défaut trouvé par le test de concurrence). Un REJEU de la file hors ligne (p_heure_serveur = false) garde la date envoyée : le paiement a eu lieu avant.
  if coalesce(p_heure_serveur, true) then
    v_corps := v_corps || jsonb_build_object('date_paiement', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  end if;

  -- Seules les colonnes ENVOYÉES sont écrites : les autres gardent leur valeur par défaut (identifiant, numéro de paiement, date, annule...).
  -- (catalogue système : ne dépend pas des droits de l'appelant, contrairement à information_schema)
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
