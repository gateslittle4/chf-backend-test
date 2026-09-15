-- Suite de ajoute_date_fin_contrat_ong.sql — backfill des données existantes (appliqué le 15/09).
-- Tous les actes existants suivent la règle "ancien prix pour ONG sous contrat, nouveau prix pour
-- privé" (services/labo, retour d'Esdras). Exception ponctuelle : Glycémie (id m113), un examen
-- classé dans "medicaments"/pharmacie parce que dispensé aux enfants au comptoir de la pharmacie,
-- mais qui doit suivre la même règle qu'un vrai acte de labo.
update catalog
set items = (
  select jsonb_agg(item || jsonb_build_object('tarifParContrat', true))
  from jsonb_array_elements(items) as item
),
updated_at = now()
where type = 'actes';

update catalog
set items = (
  select jsonb_agg(case when item->>'id' = 'm113' then item || jsonb_build_object('tarifParContrat', true) else item end)
  from jsonb_array_elements(items) as item
),
updated_at = now()
where type = 'medicaments';
