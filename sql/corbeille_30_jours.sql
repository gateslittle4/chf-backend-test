-- Retour d'Esdras (01/09) : "j'aime pas trop suppression irréversible, met une poubelle de 30
-- jours pour toute action de suppression, n'est-ce pas comment les grands app font ?"
--
-- Ce script prépare la partie de la corbeille qui a besoin d'une vraie colonne en base — les
-- dossiers/épisodes, les fiches, les paiements, les pièces jointes et les partenaires ONG, qui
-- sont des lignes de tables normales (contrairement aux médicaments/actes, un simple tableau
-- JSONB déjà modifiable sans migration — voir GrilleEdition.js et le cron dans server.js,
-- fonctionnel dès maintenant sans ce script).
--
-- SANS DANGER À COLLER : chaque colonne est nullable, sans valeur par défaut qui réécrirait les
-- lignes existantes, et rien dans le code déployé aujourd'hui ne lit ni n'écrit encore ces
-- colonnes — les coller ne change RIEN au comportement actuel de l'app. C'est la préparation ;
-- le code qui les utilise (routes de suppression/restauration, écran "Corbeille", purge à 30
-- jours) sera branché dans un second temps, une fois ces colonnes confirmées présentes.
--
-- À coller dans Supabase → SQL Editor, dans le VRAI projet CHF (pas un projet de test).

ALTER TABLE episodes        ADD COLUMN IF NOT EXISTS supprime_le timestamptz;
ALTER TABLE fiches          ADD COLUMN IF NOT EXISTS supprime_le timestamptz;
ALTER TABLE paiements       ADD COLUMN IF NOT EXISTS supprime_le timestamptz;
ALTER TABLE pieces_jointes  ADD COLUMN IF NOT EXISTS supprime_le timestamptz;
ALTER TABLE ong_partenaires ADD COLUMN IF NOT EXISTS supprime_le timestamptz;

-- Index partiels (seulement sur les lignes effectivement à la corbeille) — pour que le job de
-- purge quotidien retrouve vite les lignes à supprimer pour de bon, même quand les tables auront
-- des dizaines de milliers de lignes.
CREATE INDEX IF NOT EXISTS idx_episodes_supprime_le        ON episodes        (supprime_le) WHERE supprime_le IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fiches_supprime_le           ON fiches          (supprime_le) WHERE supprime_le IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paiements_supprime_le        ON paiements       (supprime_le) WHERE supprime_le IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pieces_jointes_supprime_le   ON pieces_jointes  (supprime_le) WHERE supprime_le IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ong_partenaires_supprime_le  ON ong_partenaires (supprime_le) WHERE supprime_le IS NOT NULL;
