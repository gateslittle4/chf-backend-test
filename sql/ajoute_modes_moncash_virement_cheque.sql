-- 30/09 : trouvé en test réel — un encaissement MonCash, Virement ou Chèque échouait :
-- "new row for relation paiements violates check constraint paiements_mode_check".
-- Le Calculateur propose ces 3 modes (CalculateurPanel.js) et la Caisse les compte (DashboardCaisse.js),
-- mais la contrainte ne les autorisait pas. La fiche était enregistrée SANS paiement.
-- À appliquer dans le SQL Editor Supabase (projet woghiwalsxusqtxvpzfo).

begin;
alter table paiements drop constraint paiements_mode_check;
alter table paiements add constraint paiements_mode_check check (mode = any (array[
  'cash','ong','credit','depot','exoneration','remboursement_credit','remboursement_patient',
  'moncash','virement','cheque']));
commit;
