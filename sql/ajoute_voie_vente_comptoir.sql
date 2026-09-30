-- 30/09 : trouvé en test réel — CHAQUE Achat Express échouait depuis le 23/08 :
-- "new row for relation episodes violates check constraint episodes_voie_entree_check".
-- L'app envoie voie_entree = 'vente_comptoir' (commit c078283, 23/08) mais la contrainte n'autorisait
-- que 'urgence' et 'consultation'. Hors ligne, la vente partait en file puis échouait (500) à chaque
-- synchro, sans fin : le paiement qui en dépend restait bloqué aussi.
-- À appliquer dans le SQL Editor Supabase (projet woghiwalsxusqtxvpzfo).

begin;
alter table episodes drop constraint episodes_voie_entree_check;
alter table episodes add constraint episodes_voie_entree_check
  check (voie_entree = any (array['urgence','consultation','vente_comptoir']));
commit;
