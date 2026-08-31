-- Retour d'Esdras (31/08) : "on a l'habitude de retirer de l'argent à la caisse pour faire des
-- achats" — une pratique réelle jamais tracée nulle part. La table depenses_caisse existait déjà
-- (id, motif, montant, validepar, date) mais n'était branchée à AUCUN écran ni AUCUNE route —
-- confirmé par recherche dans les deux dépôts avant de commencer.
--
-- 3 ajustements nécessaires avant de la brancher :
-- 1. `id` n'avait aucune valeur par défaut — le serveur doit pouvoir insérer sans en fournir un.
-- 2. Aucune colonne ne rattache une dépense à SON caissier — nécessaire pour que la fiche de
--    caisse journalière (DashboardCaisse.js) ne compte que les dépenses du caissier qui clôture,
--    même principe que `traite_par_uid` sur paiements et `cloturee_par_uid` sur cloture_caisse.
-- 3. Aucune colonne d'idempotence (`local_id`) — nécessaire pour que la file hors ligne
--    (api/supabase.js) puisse rejouer une création sans la dupliquer si la confirmation du 1er
--    essai s'est perdue en route, même principe que dossiers/episodes/fiches/paiements.
--
-- Déjà appliqué en production le 31/08 (accès Supabase direct de cette session) — gardé ici pour
-- une future recréation de la base depuis zéro, et pour que le geste soit documenté dans le dépôt.

ALTER TABLE depenses_caisse ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE depenses_caisse ADD COLUMN IF NOT EXISTS caissier_uid text;
ALTER TABLE depenses_caisse ADD COLUMN IF NOT EXISTS local_id text;
ALTER TABLE depenses_caisse ADD CONSTRAINT depenses_caisse_local_id_unique UNIQUE (local_id);
