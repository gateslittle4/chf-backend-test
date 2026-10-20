-- 20/10 (Esdras) : « Partenaire 2 » — une catégorie de partenaires à part (groupes particuliers : prix, exonération et crédit à définir avec la direction). Additif, sans risque :
-- une colonne avec valeur par défaut, tous les partenaires existants restent « partenaire ». Rien d'autre ne change (facturation, lots, rapports).
ALTER TABLE public.ong_partenaires ADD COLUMN IF NOT EXISTS categorie text NOT NULL DEFAULT 'partenaire';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ong_partenaires_categorie_check') THEN
    ALTER TABLE public.ong_partenaires ADD CONSTRAINT ong_partenaires_categorie_check CHECK (categorie IN ('partenaire', 'partenaire2'));
  END IF;
END $$;
