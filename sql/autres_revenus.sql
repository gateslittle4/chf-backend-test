-- 20/10 (Esdras) : « Ajoute autre revenu, car on peut payer autre chose à la caisse. » Un autre revenu = de l'argent encaissé à la caisse qui ne concerne AUCUN patient (certificat, location, don...).
-- Table à part : jamais mélangé aux revenus des soins (paiements). Compté en ESPÈCES dans le tiroir (fiche du jour, clôture, rapprochement).
-- Additif, sans risque : une nouvelle table, rien d'existant touché. RLS activé sans règle (comme les autres tables) : seul le serveur y accède.
CREATE TABLE IF NOT EXISTS public.autres_revenus (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  montant numeric NOT NULL CONSTRAINT autres_revenus_montant_borne CHECK (montant > 0 AND montant <= 100000000),
  motif text NOT NULL CONSTRAINT autres_revenus_motif_long CHECK (char_length(btrim(motif)) BETWEEN 3 AND 300),
  payeur text,
  caissier text NOT NULL,
  caissier_uid text NOT NULL,
  date_revenu timestamptz NOT NULL DEFAULT now(),
  local_id text UNIQUE,
  annule boolean NOT NULL DEFAULT false,
  annule_par text,
  annule_par_uid text,
  annule_le timestamptz,
  motif_annulation text
);
ALTER TABLE public.autres_revenus ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS autres_revenus_date_idx ON public.autres_revenus (date_revenu);
