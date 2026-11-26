-- 26/11 (Esdras) : onglet « À commander » de la Pharmacie — la pharmacienne en chef envoie à la direction la liste des médicaments à commander (quantités comprises).
-- Additif, sans risque : UNE nouvelle table. Rien d'existant n'est modifié ni supprimé. L'accès passe par le serveur (RLS activée, aucune politique : même schéma que receptions_medicaments).
CREATE TABLE IF NOT EXISTS public.demandes_commande (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  lignes jsonb NOT NULL CONSTRAINT demandes_commande_lignes_tableau CHECK (jsonb_typeof(lignes) = 'array' AND jsonb_array_length(lignes) BETWEEN 1 AND 200),
  note text,
  statut text NOT NULL DEFAULT 'envoyee' CONSTRAINT demandes_commande_statut_check CHECK (statut IN ('envoyee', 'commandee')),
  envoyee_par text NOT NULL,
  envoyee_par_uid text NOT NULL,
  date_envoi timestamptz NOT NULL DEFAULT now(),
  traitee_par text,
  traitee_par_uid text,
  traitee_le timestamptz,
  local_id text UNIQUE
);
ALTER TABLE public.demandes_commande ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS demandes_commande_date_idx ON public.demandes_commande (date_envoi);
