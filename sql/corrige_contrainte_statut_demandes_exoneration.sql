-- 2e bug trouvé le 29/08 par Esdras, juste après le premier (policy exoneration_reponse) :
-- "Erreur: new row violates check constraint 'demandes_exoneration_statut_check'" en cliquant
-- "Accepter". Une fois la policy RLS corrigée, l'UPDATE atteint enfin la contrainte CHECK de la
-- colonne statut — qui n'a jamais été mise à jour pour autoriser 'en_cours_de_traitement', la
-- valeur de verrou intermédiaire posée par claimerDemande() (Demandes.js) pour empêcher 2
-- personnes de la direction d'approuver la même demande en même temps (retour d'Esdras, audit
-- financier du 24/08). Ce verrou n'a donc probablement jamais fonctionné en conditions réelles
-- jusqu'ici — masqué par le bug de la policy RLS, qui bloquait la requête avant même d'atteindre
-- cette contrainte.
--
-- Les 4 valeurs réellement utilisées par le code (Demandes.js, CalculateurPanel.js,
-- NotificationBell.js) : en_attente, en_cours_de_traitement, accepte, refuse.
--
-- À exécuter dans le SQL Editor de Supabase (cette session n'a pas d'accès direct — voir
-- NOTES_POUR_PROCHAIN_CLAUDE.md, chf-app2), juste après corrige_policy_exoneration_reponse.sql.

ALTER TABLE demandes_exoneration DROP CONSTRAINT IF EXISTS demandes_exoneration_statut_check;
ALTER TABLE demandes_exoneration ADD CONSTRAINT demandes_exoneration_statut_check
  CHECK (statut IN ('en_attente', 'en_cours_de_traitement', 'accepte', 'refuse'));
