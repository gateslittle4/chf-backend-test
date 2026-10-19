-- 19/10 (Esdras) : « Hospitaliser » une consultation ouverte (nouvel épisode lié, dépôt et crédit transférés) + fermeture automatique des consultations après 1 mois.
-- À coller dans le SQL Editor Supabase (projet woghiwalsxusqtxvpzfo) AVANT de fusionner le backend. Rien n'est supprimé ni modifié dans les données existantes : deux colonnes en plus,
-- deux listes de valeurs autorisées un peu plus longues. Sans danger pour l'ancien code (il ne connaît simplement pas ces valeurs).
begin;

-- Le nouvel épisode d'hospitalisation pointe vers la consultation d'où il vient, et garde le type de lit choisi (normal, semi-privé, privé, isolette, incubateur).
alter table episodes add column if not exists episode_origine_id uuid references episodes(id) on delete set null;
alter table episodes add column if not exists type_lit text;
create index if not exists episodes_episode_origine_idx on episodes (episode_origine_id) where episode_origine_id is not null;

-- Motifs de fermeture d'une consultation : « hospitalise » (retenu en hospitalisation) et « fermeture_automatique » (1 mois écoulé), en plus des deux sorties d'hospitalisation existantes.
alter table episodes drop constraint if exists episodes_motif_fermeture_check;
alter table episodes add constraint episodes_motif_fermeture_check check (motif_fermeture is null or motif_fermeture = any (array[
  'exeat_normal','exeat_sans_autorisation','hospitalise','fermeture_automatique']));

-- Mode de paiement « transfert_hospitalisation » : lignes de 0 Gdes qui déplacent un dépôt ou une dette d'un épisode à l'autre, sans argent encaissé ni rendu.
alter table paiements drop constraint if exists paiements_mode_check;
alter table paiements add constraint paiements_mode_check check (mode = any (array[
  'cash','ong','credit','depot','exoneration','remboursement_credit','remboursement_patient',
  'moncash','virement','cheque','transfert_hospitalisation']));

commit;
