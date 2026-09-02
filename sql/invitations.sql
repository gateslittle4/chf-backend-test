-- Liens d'invitation (retour d'Esdras, 02/09) : "la possibilité de générer un lien temporaire à
-- envoyer à quelqu'un pour qu'elle crée un nouveau compte toute seule, et je prédéfinis le rôle
-- dès le départ."
--
-- L'administrateur génère le lien depuis Gestion des utilisateurs et le transmet lui-même
-- (WhatsApp, en personne) — aucun email ne part d'ici, pour la même raison que le lien de
-- réinitialisation : identifiant@chf.com n'est pas une vraie boîte mail.
--
-- Les 2 routes qui lisent cette table côté invité (GET /invitation/:token et
-- POST /invitation/:token/creer-compte, voir server.js) sont PUBLIQUES — hors /api, donc hors
-- verifyToken : la personne invitée n'a par définition pas encore de compte. C'est le 2e accès
-- public de tout ce backend après le portail patient, et le plus sensible des deux puisqu'il CRÉE
-- un compte. Quatre garde-fous, chacun voulu :
--   1. `token` = 32 octets tirés de crypto.randomBytes (43 caractères base64url) — impossible à
--      deviner ou à énumérer, et c'est la clé primaire donc jamais deux fois le même.
--   2. USAGE UNIQUE, réservé de façon ATOMIQUE avant la création du compte :
--      UPDATE invitations SET utilise_le = now() WHERE token = ? AND utilise_le IS NULL
--      — la condition est évaluée par Postgres, pas par le serveur : deux personnes qui ouvrent le
--      même lien en même temps, une seule passe. Le lien est RELÂCHÉ (utilise_le remis à NULL) si
--      la création échoue ensuite (identifiant déjà pris), sinon une faute de frappe brûlerait
--      l'invitation.
--   3. `date_expiration` obligatoire (NOT NULL), revérifiée dans la clause WHERE de la réservation
--      et pas seulement à l'affichage — un lien qui expire pile entre les deux ne passe pas.
--   4. Le rôle vient TOUJOURS de cette ligne, jamais du corps de la requête de l'invité — sinon il
--      suffirait de changer un champ pour se donner le rôle de son choix. Et 'administrateur' est
--      refusé à la CRÉATION du lien (ROLES_INVITABLES, server.js) : un lien traîne dans une
--      conversation WhatsApp et se transfère en un geste ; les pleins pouvoirs se donnent à la
--      main, avec un mot de passe que l'administrateur en place choisit lui-même.
--
-- La ligne n'est jamais supprimée à l'usage ni à la révocation : c'est la trace de qui a invité
-- qui, avec quel rôle. Purge à 90 jours (purgerInvitationsAnciennes, cron 6h UTC) ; au-delà,
-- l'information utile vit dans audit_log ('creation_compte_par_invitation'), jamais purgé.
--
-- ✅ APPLIQUÉ le 02/09 en production (accès Supabase direct de cette session).

CREATE TABLE IF NOT EXISTS invitations (
  token             text PRIMARY KEY,
  role              text NOT NULL,
  note              text,          -- libellé interne de l'administrateur ("nouveau caissier de nuit"),
                                   -- jamais renvoyé à la personne invitée
  cree_par_uid      text,
  cree_par_email    text,
  date_creation     timestamptz NOT NULL DEFAULT now(),
  date_expiration   timestamptz NOT NULL,
  revoque           boolean NOT NULL DEFAULT false,
  utilise_le        timestamptz,   -- NULL = encore disponible ; c'est le verrou d'usage unique
  utilise_par_uid   text,
  utilise_par_email text
);

-- RLS activée sans aucune policy : même principe que decrements_stock_appliques et les tables du
-- "GROUPE 1" — personne n'y accède depuis le navigateur, seul le backend le fait avec la clé
-- service_role, qui contourne RLS. C'est ESSENTIEL ici : un SELECT possible depuis le navigateur
-- laisserait n'importe quel visiteur lire tous les jetons ouverts et créer des comptes.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;

-- Liste des invitations récentes dans Gestion des utilisateurs (50 dernières, plus récentes d'abord).
CREATE INDEX IF NOT EXISTS idx_invitations_date_creation ON invitations (date_creation DESC);
