-- sql/controles_montants.sql — verrou EN BASE sur les montants des paiements (13/10), en plus du contrôle du serveur (utils/validationMontant.js) :
-- aucune route, aucun script, aucune erreur future ne peut enregistrer un montant négatif ou démesuré. Les 121 paiements existants au 13/10 respectent
-- déjà la règle (plus petit : 0, plus grand : 1 222 222). Relançable sans effet ; sans DROP ni REVOKE (bloqués par le connecteur Supabase des sessions Claude).
-- montant >= 0 : une vente à crédit, une exonération à 100 % ou une fiche entièrement payée par dépôt valent 0. Les remboursements et dépôts
-- (> 0) sont contrôlés par le serveur : le sens de ces montants est porté par le mode, pas par le signe.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'paiements_montant_borne' and conrelid = 'public.paiements'::regclass) then
    alter table public.paiements add constraint paiements_montant_borne check (montant >= 0 and montant <= 100000000);
  end if;
end;
$$;
