-- Bug bloquant trouvé le 29/08 par Esdras : "Erreur: new row violates row-level security policy
-- for table 'demandes_exoneration'" en cliquant "Accepter" sur une demande d'exonération —
-- BLOQUE TOUTE approbation, pour tout le monde, sans exception (RLS trouvée, jamais un problème
-- de rôle ou de compte précis).
--
-- Cause : la policy UPDATE (voir PLAN_RLS.md, GROUPE 4) n'avait qu'une clause USING, jamais de
-- WITH CHECK explicite :
--   CREATE POLICY exoneration_reponse ON demandes_exoneration FOR UPDATE
--     USING (mon_role_chf() IN ('direction','administrateur') AND statut = 'en_attente');
-- Sans WITH CHECK explicite, Postgres réutilise la clause USING pour valider aussi la ligne
-- APRÈS modification. Or claimerDemande() (Demandes.js) modifie justement statut pour le
-- sortir de 'en_attente' (vers 'en_cours_de_traitement' puis 'accepte'/'refuse') — la ligne
-- résultante ne vérifie donc plus jamais "statut = 'en_attente'", et Postgres refuse sa PROPRE
-- modification à chaque fois. Le USING (qui limite QUELLES lignes peuvent être ciblées) était
-- correct ; c'est son réemploi implicite comme WITH CHECK (qui valide le RÉSULTAT) qui ne l'était
-- pas — la même condition ne peut pas être vraie avant ET après un changement de statut.
--
-- Corrigé : USING inchangé (toujours restreint aux demandes encore en_attente, comme voulu),
-- WITH CHECK séparé qui ne revérifie que le rôle, pas le statut.
--
-- À exécuter dans le SQL Editor de Supabase (cette session n'a pas d'accès direct — voir
-- NOTES_POUR_PROCHAIN_CLAUDE.md, chf-app2).

DROP POLICY IF EXISTS exoneration_reponse ON demandes_exoneration;
CREATE POLICY exoneration_reponse ON demandes_exoneration FOR UPDATE
  USING (mon_role_chf() IN ('direction','administrateur') AND statut = 'en_attente')
  WITH CHECK (mon_role_chf() IN ('direction','administrateur'));
