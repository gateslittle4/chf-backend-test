-- 28/11 (Esdras) : onglet « Archiviste » — suivre où se trouve chaque dossier papier : « entré à l'archiviste » (avec date et heure) et « sorti de l'archiviste » (avec date et heure).
-- Additif, sans risque : UNE nouvelle table. Rien d'existant n'est modifié ni supprimé. L'accès passe par le serveur (RLS activée, aucune politique : même schéma que demandes_commande).
-- Chaque coche est une LIGNE (jamais écrasée) : on garde qui l'a faite, quand, et un mouvement coché par erreur est ANNULÉ (annule = true), pas effacé.
-- La sortie « automatique » (un médicament acheté à la caisse) n'est pas écrite ici : elle se déduit des paiements, côté application.
CREATE TABLE IF NOT EXISTS public.mouvements_dossier_papier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id uuid NOT NULL REFERENCES public.dossiers(id),
  type text NOT NULL CONSTRAINT mouvements_dossier_papier_type_check CHECK (type IN ('entree', 'sortie')),
  date timestamptz NOT NULL DEFAULT now(),
  par text NOT NULL,
  par_uid text NOT NULL,
  note text,
  annule boolean NOT NULL DEFAULT false,
  annule_par text,
  annule_par_uid text,
  annule_le timestamptz,
  local_id text UNIQUE
);
ALTER TABLE public.mouvements_dossier_papier ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS mouvements_dossier_papier_dossier_idx ON public.mouvements_dossier_papier (dossier_id, date);
