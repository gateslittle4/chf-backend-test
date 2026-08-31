-- Retour d'Esdras (31/08) : "on a l'habitude de retirer de l'argent à la caisse pour faire des
-- achats" — une pratique réelle jamais tracée nulle part. La table depenses_caisse existait déjà
-- (id, motif, montant, validepar, date) mais n'était branchée à AUCUN écran ni AUCUNE route —
-- confirmé par recherche dans les deux dépôts avant de commencer.
--
-- Corrigé le même soir : Esdras a précisé le vrai flux — "c'est la direction qui fait la demande
-- à la caisse, et la caisse, si elle a l'argent, le donne". Ce n'est donc PAS un simple journal
-- alimenté par le caissier (ma première version), mais une demande/réponse, exactement comme
-- demandes_exoneration (Demandes.js) : la direction crée la demande, le caissier l'accorde ou la
-- refuse selon ce qu'il a en caisse. Toute cette migration reflète directement ce second schéma
-- (table encore vide au moment du changement — aucune conversion de données nécessaire).
--
-- Colonnes finales, alignées sur la convention déjà en place pour demandes_exoneration :
-- - id            : text, valeur par défaut gen_random_uuid()::text (le serveur insère sans en fournir un)
-- - motif         : text, obligatoire (raison de la demande)
-- - montant       : numeric, obligatoire
-- - demandeur / demandeur_uid : qui a fait la demande (la direction)
-- - statut        : 'en_attente' | 'accorde' | 'refuse'
-- - caissier / caissier_uid   : qui a répondu (rempli seulement à la réponse, pas à la création)
-- - date_demande  : quand la demande a été créée (ancienne colonne `date`, renommée)
-- - date_reponse  : quand le caissier a répondu
-- - local_id      : idempotence pour la file hors ligne (api/supabase.js), même principe que
--                   dossiers/episodes/fiches/paiements — une confirmation perdue en route ne doit
--                   pas dupliquer la demande.
--
-- Déjà appliqué en production le 31/08 (accès Supabase direct de cette session) — gardé ici pour
-- une future recréation de la base depuis zéro, et pour que le geste soit documenté dans le dépôt.

ALTER TABLE depenses_caisse ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE depenses_caisse ADD COLUMN IF NOT EXISTS caissier_uid text;
ALTER TABLE depenses_caisse ADD COLUMN IF NOT EXISTS local_id text;
ALTER TABLE depenses_caisse ADD CONSTRAINT depenses_caisse_local_id_unique UNIQUE (local_id);

-- Deuxième passe (même soir, après la correction du flux ci-dessus) :
ALTER TABLE depenses_caisse RENAME COLUMN date TO date_demande;
ALTER TABLE depenses_caisse DROP COLUMN validepar;
ALTER TABLE depenses_caisse ADD COLUMN demandeur text NOT NULL DEFAULT '';
ALTER TABLE depenses_caisse ALTER COLUMN demandeur DROP DEFAULT;
ALTER TABLE depenses_caisse ADD COLUMN demandeur_uid text NOT NULL DEFAULT '';
ALTER TABLE depenses_caisse ALTER COLUMN demandeur_uid DROP DEFAULT;
ALTER TABLE depenses_caisse ADD COLUMN statut text NOT NULL DEFAULT 'en_attente';
ALTER TABLE depenses_caisse ADD COLUMN caissier text;
ALTER TABLE depenses_caisse ADD COLUMN date_reponse timestamptz;
