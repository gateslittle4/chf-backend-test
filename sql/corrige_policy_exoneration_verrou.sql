-- ⚠️ BUG BLOQUANT — À APPLIQUER AVANT LE LANCEMENT (trouvé le 31/08, audit du chemin de l'argent)
--
-- Symptôme exact rapporté par Esdras le 29/08, jamais élucidé jusqu'ici :
--   "j'ai vu le message envoyé, mais la page de la caissière ne refresh pas automatiquement
--    pour dire que la demande d'exonération a été acceptée"
-- Ce n'était PAS un problème de temps réel. Voici la vraie cause.
--
-- APPROUVER une exonération se fait en DEUX écritures successives (Demandes.js) :
--   1. claimerDemande()  : statut 'en_attente'            -> 'en_cours_de_traitement'
--      (verrou anti-course : deux personnes qui approuvent en même temps, une seule gagne)
--   2. fin de repondre() : statut 'en_cours_de_traitement' -> 'accepte'
--
-- Or la policy corrigée le 29/08 (corrige_policy_exoneration_reponse.sql) garde dans son USING :
--     statut = 'en_attente'
-- USING décide QUELLES LIGNES peuvent être ciblées par un UPDATE. Après l'étape 1, la ligne n'est
-- justement plus 'en_attente' : l'étape 2 ne cible donc PLUS AUCUNE LIGNE.
--
-- Et ça échoue EN SILENCE : PostgREST ne renvoie pas d'erreur pour un UPDATE qui ne touche aucune
-- ligne — il renvoie une liste vide. Le code croit donc avoir réussi. Résultat concret :
--   - l'argent EST bien enregistré (fiche + paiement créés entre les deux étapes) ;
--   - mais la demande reste bloquée sur 'en_cours_de_traitement' POUR TOUJOURS ;
--   - elle disparaît de la liste des demandes en attente (filtrée sur 'en_attente') ;
--   - elle n'apparaît pas non plus dans l'historique (filtré sur 'accepte'/'refuse') ;
--   - l'écran de la caissière n'est jamais prévenu -> exactement le symptôme signalé.
-- La demande devient invisible et impossible à traiter depuis l'application.
--
-- (Le REFUS, lui, fonctionne : il ne passe pas par claimerDemande, la ligne est donc encore
--  'en_attente' au moment de l'écriture.)
--
-- CORRECTIF : autoriser aussi le ciblage des lignes déjà verrouillées, pour que la 2e écriture
-- de la MÊME opération puisse aboutir.
--
-- Le verrou anti-course n'est PAS affaibli : il ne repose pas sur la RLS mais sur le
-- `.eq('statut', 'en_attente')` présent dans la requête de claimerDemande() elle-même. Deux
-- approbations simultanées continuent donc de se départager — une seule voit une ligne modifiée.
-- Le contrôle de rôle reste identique : direction/administrateur uniquement, avant comme après.
--
-- PRÉREQUIS : corrige_contrainte_statut_demandes_exoneration.sql doit AUSSI être appliqué (il
-- ajoute 'en_cours_de_traitement' aux valeurs autorisées par la contrainte CHECK). Sans lui,
-- l'étape 1 échoue déjà. Les deux fichiers sont nécessaires, dans n'importe quel ordre.
--
-- À exécuter dans Supabase -> SQL Editor (cette session n'a aucun accès direct à la base).

DROP POLICY IF EXISTS exoneration_reponse ON demandes_exoneration;
CREATE POLICY exoneration_reponse ON demandes_exoneration FOR UPDATE
  USING (
    mon_role_chf() IN ('direction','administrateur')
    AND statut IN ('en_attente', 'en_cours_de_traitement')
  )
  WITH CHECK (mon_role_chf() IN ('direction','administrateur'));

-- ── Réparation des demandes déjà bloquées ────────────────────────────────────────────────────
-- Si des exonérations ont été approuvées avant ce correctif, elles sont restées sur
-- 'en_cours_de_traitement'. Leur fiche et leur paiement ONT bien été créés : il ne manque que le
-- statut final. Cette requête les termine proprement.
-- À lancer APRÈS la policy ci-dessus. Vérifie d'abord ce qu'elle va toucher :
--
--   SELECT id, patient_nom, montant_exonere, date_demande
--   FROM demandes_exoneration WHERE statut = 'en_cours_de_traitement';
--
-- Si la liste correspond bien à des exonérations réellement accordées, décommente puis exécute :
--
-- UPDATE demandes_exoneration
--    SET statut = 'accepte',
--        date_reponse = COALESCE(date_reponse, now()),
--        reponse_par = COALESCE(reponse_par, 'régularisé après correctif du 31/08')
--  WHERE statut = 'en_cours_de_traitement';
