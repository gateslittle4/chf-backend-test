-- Retour d'Esdras (29/08) : deux informations personnelles à ajouter à la Fiche Patient — le
-- poids de la personne et le nom de son conjoint. (L'âge, lui, ne se stocke pas : il est calculé
-- automatiquement à partir de date_naissance, déjà présente — voir utils/helpers.js::calculerAge
-- côté chf-app2.)
--
-- poids en kilogrammes (numeric, pas integer : un poids peut avoir une décimale, ex. 62.5 kg).
-- conjoint en texte libre (nom complet), comme les autres champs d'identité de cette table.
-- Aucune contrainte d'unicité ni NOT NULL sur les deux — comme telephone/adresse, une information
-- manquante reste possible sans bloquer la création/modification du dossier.
--
-- À exécuter dans le SQL Editor de Supabase (cette session n'a pas d'accès direct à la vraie base
-- — voir NOTES_POUR_PROCHAIN_CLAUDE.md, chf-app2).

ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS poids numeric;
ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS conjoint text;
