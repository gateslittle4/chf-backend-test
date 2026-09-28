-- Écritures idempotentes par clé (audit hors ligne du 28/09) — voir utils/idempotence.js.
-- L'app coupe toute écriture sans réponse après 15 s et la rejoue plus tard avec la MÊME clé
-- (en-tête Idempotency-Key) : cette table retient la réponse de la 1re exécution pour la renvoyer
-- au rejeu, sans exécuter la route une 2e fois.
--
-- SANS DANGER : nouvelle table, rien d'existant n'est modifié. Tant qu'elle n'existe pas, le
-- serveur exécute simplement les routes comme avant (erreur 42P01 ignorée).
-- RLS activé SANS aucune policy : seul le serveur (clé service_role, qui contourne RLS) y accède ;
-- la clé anon du navigateur n'y voit rien.

CREATE TABLE IF NOT EXISTS public.requetes_idempotentes (
  cle      text PRIMARY KEY,           -- "<uid>:<Idempotency-Key>"
  methode  text NOT NULL,
  chemin   text NOT NULL,
  uid      text NOT NULL,
  statut   integer,                    -- NULL tant que la 1re exécution n'est pas terminée
  reponse  jsonb,
  cree_le  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_requetes_idempotentes_cree_le ON public.requetes_idempotentes (cree_le);

ALTER TABLE public.requetes_idempotentes ENABLE ROW LEVEL SECURITY;
