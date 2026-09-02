-- Retour d'Esdras (02/09) : le rapport MSPP répartit déjà les examens de laboratoire par tranche
-- d'âge (voir components/RapportCHF.js, chf-app2) — Esdras a aussi demandé une répartition
-- homme/femme, restée sans suite faute de champ sexe/genre nulle part dans l'app (ni au dossier,
-- ni sur le formulaire Fiche Patient). Confirmé le 02/09 : "oui, ajoute le champ sexe".
--
-- sexe en texte, avec une CONTRAINTE contrairement à poids/conjoint (texte libre) : c'est la
-- seule colonne de cette table dont la VALEUR EXACTE alimente directement un calcul (le tri
-- homme/femme du rapport MSPP) plutôt qu'un simple affichage — une faute de frappe ('m' au lieu
-- de 'M', 'Homme' au lieu de 'M'...) ferait disparaître silencieusement des patients du tableau
-- au lieu de les compter dans la bonne colonne. NULL reste autorisé et restera la valeur de TOUS
-- les dossiers déjà enregistrés : rien de rétroactif n'est possible, et rien ne doit être deviné.
--
-- ✅ APPLIQUÉ le 02/09 en production (accès Supabase direct de cette session).

ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS sexe text;
ALTER TABLE dossiers ADD CONSTRAINT dossiers_sexe_valide CHECK (sexe IS NULL OR sexe IN ('M', 'F'));
