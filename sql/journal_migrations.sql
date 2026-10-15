-- sql/journal_migrations.sql — journal des scripts SQL appliqués en production (15/10).
-- Pourquoi : les scripts de sql/ sont collés À LA MAIN dans l'éditeur SQL de Supabase ; rien ne note lesquels l'ont été. Dans deux ans, la base de production et ce dépôt
-- ne se correspondraient plus, et reconstruire la base (restauration, nouveau projet) échouerait. Ce journal garde une ligne par script appliqué.
-- ÉTAT : PRÉPARÉ, PAS ENCORE APPLIQUÉ (décision d'Esdras, 15/10). Rien dans le site ne le lit : le coller ne change aucun écran.
--
-- Après l'avoir collé : `node scripts/verifier-sql.js` compare le dépôt au journal ; `node scripts/verifier-sql.js --sql` écrit les lignes à coller pour noter
-- les scripts déjà appliqués avant le journal (à CONFIRMER un par un avant de les coller : le script ne devine pas ce qui est appliqué).
-- Ensuite, à chaque nouveau script collé en production : ajouter sa ligne au journal (le script de vérification l'écrit).
CREATE TABLE IF NOT EXISTS public.migrations_appliquees (
  nom text PRIMARY KEY,              -- nom du fichier de sql/ (ex. etat_systeme.sql)
  somme_controle text,               -- empreinte SHA-256 du fichier au moment où il a été appliqué
  applique_le timestamptz NOT NULL DEFAULT now(),
  applique_par text,
  remarque text
);
-- Aucune lecture par le public : la clé de service (serveur, scripts) y accède, personne d'autre.
ALTER TABLE public.migrations_appliquees ENABLE ROW LEVEL SECURITY;
