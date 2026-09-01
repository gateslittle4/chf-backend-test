-- Retour d'Esdras (01/09) : "lorsque le bb est dans le neo, on lui donne le nom de la mère + bb
-- devant, mais quand il revient, on lui donne un autre nom, mais on veut pas perdre le premier
-- dossier [...] je ne veux pas oublier la racine de l'enfant, voilà pourquoi les deux noms
-- doivent être là, bb tel tel personne, ensuite le nouveau nom donné par la mère."
--
-- nom_origine fige le nom du dossier à sa CRÉATION, pour toujours — server.js (POST
-- /api/dossiers) l'enregistre automatiquement à chaque nouveau dossier, et PUT /api/dossiers/:id
-- (renommage, écran Fiche Patient) ne le touche jamais. Le nom "actuel" (`nom`) peut donc changer
-- librement (le vrai prénom donné par la mère au retour), sans jamais perdre trace du nom
-- d'origine (le nom temporaire du néonat).
--
-- SANS DANGER À COLLER : colonne nullable, aucune valeur par défaut qui bloquerait, le backfill
-- ci-dessous ne fait que copier une valeur déjà là (nom → nom_origine) pour les dossiers déjà
-- existants (sinon leur nom_origine resterait vide pour toujours, faute d'avoir existé à leur
-- création). server.js gère déjà le cas où cette colonne n'existe pas encore (repli sur l'ancien
-- insert, error.code 42703) — coller ce script active la fonctionnalité, ne casse rien avant.
--
-- À coller dans Supabase → SQL Editor, dans le VRAI projet CHF (pas un projet de test).

ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS nom_origine text;

-- Backfill : les dossiers créés AVANT ce script n'ont pas de nom_origine — on prend leur nom
-- actuel comme origine (le mieux qu'on puisse faire rétroactivement ; ça ne change rien pour eux
-- tant que personne ne les renomme, et évite un nom_origine vide qui afficherait mal côté écran).
UPDATE dossiers SET nom_origine = nom WHERE nom_origine IS NULL;

-- Étend la recherche floue existante (fonction_recherche_floue_dossiers.sql) pour matcher aussi
-- nom_origine — sinon, une fois le vrai prénom donné, "Bébé Marie Joseph" ne retrouve plus jamais
-- ce dossier alors que c'est exactement le cas qu'on veut couvrir. CREATE OR REPLACE : remplace
-- la fonction existante sans rien casser pour les appels déjà en place (même signature).
CREATE OR REPLACE FUNCTION rechercher_dossiers_flou(p_nom text)
RETURNS SETOF dossiers
LANGUAGE sql STABLE
AS $$
  SELECT * FROM dossiers
  WHERE similarity(nom, p_nom) > 0.25 OR nom ILIKE '%' || p_nom || '%'
     OR similarity(nom_origine, p_nom) > 0.25 OR nom_origine ILIKE '%' || p_nom || '%'
  ORDER BY GREATEST(similarity(nom, p_nom), similarity(nom_origine, p_nom)) DESC
  LIMIT 20;
$$;

-- Index trigram sur nom_origine, même principe que idx_dossiers_nom_trgm (déjà posé par
-- fonction_recherche_floue_dossiers.sql) — sans lui, chaque recherche floue redevient un scan
-- complet de la table dès que nom_origine entre dans le OR ci-dessus.
CREATE INDEX IF NOT EXISTS idx_dossiers_nom_origine_trgm ON dossiers USING gin (nom_origine gin_trgm_ops);
