-- BUG CRITIQUE trouvé et corrigé le 27/08, en testant "rembourser et refacturer à un partenaire"
-- avec un dossier de test créé directement en base (jamais détecté avant : les tests du repo sont
-- des regex sur le code source, jamais une exécution réelle contre Supabase).
--
-- La contrainte de vérification paiements_mode_check n'a jamais inclus 'remboursement_patient'
-- (le mode créé le 25/08 pour la sortie de cash quand on rembourse un patient déjà encaissé —
-- voir server.js, POST /api/episodes/:id/transferer-partenaire et
-- POST /api/episodes/:id/rembourser-transferer-partenaire). Résultat concret : DEPUIS LE 25/08,
-- CHAQUE tentative réelle d'utiliser cette fonctionnalité en production aurait échoué avec une
-- violation de contrainte (23514), jamais un succès silencieux — donc probablement jamais
-- utilisée en vrai jusqu'ici, sans quoi l'erreur serait déjà remontée.
--
-- Déjà appliqué directement sur le projet Supabase (woghiwalsxusqtxvpzfo) via apply_migration —
-- ce fichier documente le changement pour qu'une future session (ou une recréation de la base
-- depuis zéro) sache pourquoi 'remboursement_patient' est une valeur autorisée.
--
-- À coller dans Supabase → SQL Editor si jamais la base est recréée depuis zéro.

ALTER TABLE paiements DROP CONSTRAINT paiements_mode_check;
ALTER TABLE paiements ADD CONSTRAINT paiements_mode_check
  CHECK (mode = ANY (ARRAY['cash'::text, 'ong'::text, 'credit'::text, 'depot'::text, 'exoneration'::text, 'remboursement_credit'::text, 'remboursement_patient'::text]));
