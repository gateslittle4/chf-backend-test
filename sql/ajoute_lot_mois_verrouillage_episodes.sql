-- Lots & Facturation (version chf-demo2, portée dans chf-app2) : deux nouveaux champs sur
-- episodes.
--   - mois_lot (text, "AAAA-MM") : mois facturé par ce lot, choisi/ajusté à la génération,
--     affiché comme badge sur le lot dans Archives > Lots.
--   - lot_verrouille (boolean) : verrouillage d'un lot déjà approuvé par le partenaire —
--     distinct de verrouille_facture (qui protège un dossier individuel contre modif/suppression) :
--     lot_verrouille bloque l'AJOUT d'un nouveau dossier à un lot déjà envoyé/approuvé.
-- Nullable / valeur par défaut : aucun impact sur les lots déjà existants (mois_lot restera NULL
-- pour eux — affiché "Mois non défini" côté écran ; lot_verrouille par défaut false).
--
-- ✅ APPLIQUÉ EN PRODUCTION (08/09, accès Supabase MCP direct de cette session, projet
-- chf-backend-test / woghiwalsxusqtxvpzfo) — conservé ici pour la trace, comme les autres
-- scripts sql/ du projet.
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS mois_lot text;
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS lot_verrouille boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN episodes.mois_lot IS 'Mois facturé par le lot (format AAAA-MM), affiché sur Archives > Lots. NULL pour les lots générés avant ce champ.';
COMMENT ON COLUMN episodes.lot_verrouille IS 'Lot approuvé par le partenaire et verrouillé : bloque l''ajout d''un nouveau dossier à ce lot (distinct de verrouille_facture, qui protège un dossier individuel).';
