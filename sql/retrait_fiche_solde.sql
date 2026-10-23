-- sql/retrait_fiche_solde.sql — retirer / corriger une fiche encaissée SANS fausser la dette du patient (22/10, « Corriger une fiche » de la caisse).
-- Le problème : le solde (la dette) d'un épisode est un total COURANT. Chaque paiement porte `solde_restant` = (solde du paiement précédent) + (ce que CE paiement ajoute),
-- et l'épisode doit ce que dit le DERNIER paiement valide. Retirer une fiche à crédit (ou en paiement partiel) en mettant son paiement à la corbeille laissait donc sa dette
-- recopiée dans tous les paiements d'après : le patient restait débiteur d'une fiche qui n'existe plus. Idem pour une fiche corrigée (retirée puis refaite) : la dette comptée deux fois.
-- Ici, en UNE opération de la base, avec le même verrou par épisode que sql/solde_atomique.sql (un paiement qui arrive en même temps attend) :
--   1. la dette ajoutée par un paiement retiré = max(0, son solde − solde du paiement valide juste avant lui) ;
--   2. chaque paiement valide POSTÉRIEUR perd cette dette dans son solde (jamais sous 0) ;
--   3. les paiements retirés et la fiche passent à la corbeille (supprime_le = p_horodatage) — restaurable, comme avant.
-- Refus (rien n'est écrit) : un remboursement de crédit est déjà passé APRÈS cette dette (CHF11 : on ne sait plus quelle part a été remboursée → annuler d'abord le
-- remboursement), ou un des paiements retirés est lui-même un remboursement de crédit (CHF12).
-- Idempotente : fiche déjà à la corbeille → rien à faire (`deja_retiree`). Sans DROP ni REVOKE. SECURITY INVOKER : seul le serveur (service_role) peut s'en servir. Relançable sans effet.
create or replace function public.retirer_fiche_ajuster_solde(p_fiche uuid, p_paiements uuid[], p_horodatage timestamptz default now())
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_episode uuid;
  v_ids uuid[] := coalesce(p_paiements, '{}'::uuid[]);
  v_ligne record;
  v_precedent numeric := 0;   -- solde du paiement valide qui précède la ligne en cours (avant tout ajustement)
  v_dette numeric := 0;       -- dette ajoutée, jusqu'ici, par les paiements retirés
  v_nouveau numeric;
  v_ajustes integer := 0;
begin
  select episode_id into v_episode from public.fiches where id = p_fiche and supprime_le is null for update;
  if not found then
    return jsonb_build_object('deja_retiree', true, 'dette_retiree', 0, 'paiements_ajustes', 0);
  end if;

  if v_episode is not null then
    -- Même verrou que enregistrer_paiement_atomique : un seul changement de solde à la fois PAR ÉPISODE.
    perform pg_advisory_xact_lock(hashtextextended('chf:paiement:' || v_episode::text, 0));

    for v_ligne in
      select id, mode, coalesce(solde_restant, 0) as solde, (id = any(v_ids)) as retire
        from public.paiements
       where episode_id = v_episode and (annule = false or annule is null) and supprime_le is null
       order by date_paiement, numero_paiement, id
    loop
      if v_ligne.retire then
        if v_ligne.mode = 'remboursement_credit' then
          raise exception 'Un remboursement de crédit ne se retire pas depuis une fiche.' using errcode = 'CHF12';
        end if;
        v_dette := v_dette + greatest(0, v_ligne.solde - v_precedent);
      elsif v_dette > 0 then
        if v_ligne.mode = 'remboursement_credit' then
          raise exception 'Un remboursement de crédit a été fait après cette dette : annule d''abord ce remboursement, ou voir la direction.' using errcode = 'CHF11';
        end if;
        v_nouveau := greatest(0, v_ligne.solde - v_dette);
        if v_nouveau <> v_ligne.solde then
          update public.paiements set solde_restant = v_nouveau where id = v_ligne.id;
          v_ajustes := v_ajustes + 1;
        end if;
      end if;
      v_precedent := v_ligne.solde;
    end loop;
  end if;

  update public.paiements set supprime_le = p_horodatage
   where id = any(v_ids) and supprime_le is null and (fiche_id = p_fiche or episode_id = v_episode);
  update public.fiches set supprime_le = p_horodatage where id = p_fiche;

  return jsonb_build_object('deja_retiree', false, 'dette_retiree', v_dette, 'paiements_ajustes', v_ajustes);
end;
$$;
