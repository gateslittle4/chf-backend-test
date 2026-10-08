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
-- appelable directement par anon, seulement par authenticated (dont mes policies) »). Il a donc été
-- retiré APRÈS COUP — probablement par un durcissement de l'audit de sécurité des 06-08/10 (ce type de
-- « correctif » est suggéré par le linter de sécurité Supabase pour les fonctions SECURITY DEFINER,
-- sans tenir compte du fait que les policies RLS ont besoin de les appeler). Non prouvé : cette session
-- n'a pas accès à la base du CHF.
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
