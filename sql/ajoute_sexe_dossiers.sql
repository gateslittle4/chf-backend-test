-- Retour d'Esdras (02/09) : "on ajoute F/M dans le formulaire aussi" — dans le cadre du chantier
-- Rapport MSPP (VIH facturé, accouchements/césariennes par âge de la mère), pour permettre plus
-- tard une ventilation homme/femme comme sur le vrai formulaire papier.
--
-- sexe est optionnel (nullable) — les dossiers déjà existants n'ont jamais eu cette information,
-- pas question de forcer une valeur inventée. server.js (POST /api/dossiers, PUT
-- /api/dossiers/:id) gère déjà le cas où cette colonne n'existe pas encore côté Supabase (repli
-- sur l'ancien insert/update, error.code 42703) — coller ce script active la fonctionnalité, ne
-- casse rien avant.
--
-- SANS DANGER À COLLER : colonne nullable, aucune valeur par défaut qui bloquerait, aucun
-- backfill nécessaire (rien à déduire rétroactivement du sexe d'un dossier existant).
--
-- À coller dans Supabase → SQL Editor, dans le VRAI projet CHF (pas un projet de test).

ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS sexe text;

-- Contrainte souple : NULL (inconnu/pas encore renseigné) ou 'F'/'M' uniquement — empêche une
-- faute de frappe ("f", "Femme", "Masculin"...) de rendre la donnée inexploitable plus tard pour
-- une ventilation homme/femme dans le Rapport MSPP.
ALTER TABLE dossiers DROP CONSTRAINT IF EXISTS dossiers_sexe_valide;
ALTER TABLE dossiers ADD CONSTRAINT dossiers_sexe_valide CHECK (sexe IS NULL OR sexe IN ('F', 'M'));
