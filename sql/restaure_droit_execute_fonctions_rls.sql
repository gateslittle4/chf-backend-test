-- Incident du 08/10 : « L'app ne se charge plus » — écran « Chargement… » sans fin après connexion.
--
-- Capture d'Esdras de l'écran de diagnostic (chf-app2, PR #48), version de l'app faa71fa :
--     Lecture du profil : permission denied for function mon_role_chf (42501)
--     Lecture du rôle   : permission denied for function mon_role_chf (42501)
--
-- CAUSE : la base refuse au rôle qui exécute les requêtes de l'app (Postgres) le droit EXECUTE sur la
-- fonction mon_role_chf(). Or les policies RLS de la table users (et de plusieurs autres : audit_log,
-- demandes d'exonération, ong_partenaires, salaires, clôture de caisse...) l'appellent : sans ce droit,
-- TOUTE lecture de users par le navigateur échoue — donc ni profil, ni rôle, donc loadData() ne démarre
-- jamais (AppHospitaliere attend le rôle) et l'écran reste sur « Chargement… ».
--
-- Ce droit fait partie de la conception documentée dans PLAN_RLS.md (« mon_role_chf() n'est plus
-- appelable directement par anon, seulement par authenticated (dont mes policies) »). Il a été retiré
-- APRÈS COUP, et la cause est DOCUMENTÉE : la PR #46 de chf-app2 (audit de sécurité du 08/10), section
-- « À faire côté tableau de bord », item Supabase, recommandait : « mon_role_chf() est en SECURITY
-- DEFINER appelable par tout utilisateur connecté → révoquer EXECUTE ou passer en SECURITY INVOKER ».
-- Appliquer cette recommandation (non vérifié : personne n'a pu lire la base du CHF depuis une session)
-- casse TOUTES les policies RLS qui appellent la fonction.
--
-- VÉRIFIÉ sur un Postgres 16 jetable (rôles anon/authenticated, auth.jwt() simulé, définitions et policies
-- de PLAN_RLS.md reconstituées — PAS sur la vraie base du CHF) :
--   • `REVOKE EXECUTE ON FUNCTION mon_role_chf() FROM authenticated` reproduit EXACTEMENT l'erreur de la capture
--     (`ERROR: 42501: permission denied for function mon_role_chf`), même pour une personne qui ne lit que SA
--     propre ligne ; ce script la répare (le texte collé dans le chat et ce fichier), et se rejoue sans erreur ;
--   • une requête exécutée en `anon` (jeton sans la revendication role='authenticated') donne le MÊME message :
--     ce script ne la répare pas (voulu) — voir plus bas ;
--   • `SECURITY INVOKER` (l'autre moitié de la recommandation de l'audit) : PLAN_RLS.md le déconseille en
--     invoquant une boucle sur users, mais le test N'A PAS reproduit de boucle (compte existant, compte sans
--     ligne dans users). Ce n'est donc PAS démontré dangereux ; ce n'est simplement ni nécessaire ni testé sur
--     la vraie base : ne pas y toucher pour débloquer l'app ;
--   • déplacer les 2 fonctions dans un schéma non exposé (ex. `private`) fonctionne, MAIS exige
--     `ALTER FUNCTION private.mon_role_chf() SET search_path = public, private` (elle appelle mon_uid() sans
--     préfixe) : sans cela, une personne normale passe encore, et c'est l'ADMINISTRATEUR qui casse
--     (« function mon_uid() does not exist »). Toujours tester un compte administrateur ET un non-administrateur.
--
-- CE QUE FAIT CE SCRIPT : redonne le droit EXECUTE au rôle `authenticated` (les personnes connectées) sur
-- les 2 petites fonctions qui servent aux policies. Rien d'autre :
--   • aucune donnée lue ni modifiée, aucune table, aucune policy touchée ;
--   • idempotent : sans effet si le droit existe déjà ;
--   • `anon` n'est PAS rétabli — voulu par PLAN_RLS.md (REVOKE ... FROM anon, public) ;
--   • annulable : REVOKE EXECUTE ON FUNCTION public.mon_role_chf() FROM authenticated;
--
-- ⚠️ À COLLER par un humain dans Supabase → SQL Editor, dans le VRAI projet CHF (règle du projet : on
-- ne modifie jamais la base sans Esdras). Statut : PAS ENCORE CONFIRMÉ APPLIQUÉ.
--
-- SI L'APP RESTE BLOQUÉE APRÈS CE SCRIPT (le tableau du bas montre `true` partout) : la requête ne
-- s'exécute probablement pas en tant que `authenticated` (jeton Firebase sans la revendication
-- role='authenticated' → exécutée en `anon`, qui n'a volontairement pas le droit). Dans ce cas, la
-- nouvelle capture de l'écran d'aide dira quoi ; ne PAS accorder le droit à anon pour « faire passer ».

GRANT EXECUTE ON FUNCTION public.mon_uid()      TO authenticated;
GRANT EXECUTE ON FUNCTION public.mon_role_chf() TO authenticated;

-- Vérification : `connectes_peuvent` doit valoir true sur les 2 lignes ; `anon_peut` doit rester false
-- pour mon_role_chf (jamais appelable directement par un visiteur sans compte).
SELECT p.proname AS fonction,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS connectes_peuvent,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_peut
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('mon_uid', 'mon_role_chf');
