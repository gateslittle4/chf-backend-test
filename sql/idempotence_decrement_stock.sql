-- Audit hors ligne du 01/09 (Esdras : "je suis très très strict pour le hors ligne, vérifie que ça
-- marche bien", puis "fais la protection sur le stock aussi").
--
-- CONTEXTE. Depuis le même audit, syncPending() (chf-app2/api/supabase.js) garde les opérations
-- "en vol" tant que le serveur ne les a pas confirmées, pour qu'une tablette qui meurt en pleine
-- synchronisation (coupure de courant, batterie, onglet fermé) ne perde plus les encaissements —
-- elles sont récupérées et rejouées au démarrage suivant. Contrepartie : une opération partie mais
-- dont la confirmation s'est perdue est REJOUÉE une fois.
--
-- Ce rejeu est sans danger pour les dossiers, épisodes, fiches et paiements : leur route serveur
-- reconnaît le `local_id` déjà vu et renvoie la ligne existante au lieu d'en créer une 2e.
-- /api/stock/decrementer et /api/stock/decrementer-dons étaient les DEUX SEULES routes d'écriture
-- de la file hors ligne sans cette protection : un rejeu aurait déduit le stock deux fois pour une
-- seule vente (pharmacie sous-évaluée, sans rien pour l'expliquer).
--
-- MÉCANISME. Une table de traces (`decrements_stock_appliques`) + une SURCHARGE des 2 fonctions
-- existantes prenant un `p_local_id` en plus. Les fonctions à 1 seul argument sont conservées
-- telles quelles : les réquisitions (POST /api/requisitions) les utilisent toujours et n'ont pas
-- besoin d'idempotence (elles ne passent jamais par la file hors ligne).
--
-- Trois points de conception, chacun voulu :
--   1. La trace est posée dans la MÊME TRANSACTION que le décrément (une fonction plpgsql = une
--      transaction) : les deux réussissent, ou aucun. Impossible de marquer "déjà appliqué" un
--      décrément qui n'a pas eu lieu.
--   2. Le verrou `FOR UPDATE` sur la ligne catalog est pris AVANT de consulter la table de traces :
--      deux appels simultanés portant le même local_id sont sérialisés, donc le second voit
--      forcément la trace du premier.
--   3. Un stock insuffisant (succes=false) ne laisse AUCUNE trace : ce n'est pas un décrément
--      appliqué, et un réessai plus tard (stock réapprovisionné) doit pouvoir aboutir normalement.
--
-- Côté navigateur, chaque appel envoie un identifiant stable et DISTINCT par nature d'opération
-- (`<idLocalDeLaVente>-stock`, `-stock-dons`, `-stock-annule`, `-stock-dons-annule`,
-- `restitution-<ids des fiches>`) — une vente et la restauration qui l'annule ne doivent surtout
-- pas partager le même, sinon l'idempotence ferait ignorer la seconde.
--
-- ✅ APPLIQUÉ le 01/09 en production (accès Supabase direct de cette session) et vérifié sur une
-- vraie ligne de stock : 2 appels successifs avec le même local_id → une seule déduction, le 2e
-- répondant `deja_applique: true` (données de test remises à leur valeur d'origine ensuite).

CREATE TABLE IF NOT EXISTS decrements_stock_appliques (
  local_id    text PRIMARY KEY,
  applique_le timestamptz NOT NULL DEFAULT now()
);
-- RLS activée sans aucune policy : même principe que les tables du "GROUPE 1" (episodes, dossiers,
-- fiches, paiements...) — personne n'y accède depuis le navigateur, seul le backend le fait avec
-- la clé service_role, qui contourne RLS.
ALTER TABLE decrements_stock_appliques ENABLE ROW LEVEL SECURITY;
-- Pour la purge quotidienne des traces anciennes (voir purgerTracesDecrementStock, server.js).
CREATE INDEX IF NOT EXISTS idx_decrements_stock_appliques_date ON decrements_stock_appliques (applique_le);

-- Les corps complets des 2 fonctions surchargées sont volontairement gardés à l'identique de leur
-- version d'origine (fonction_decrementer_stock_et_numerotation_lots.sql, fonction_stock_dons.sql),
-- à l'exception des 2 blocs marqués "Idempotence" — pour qu'une divergence de comportement entre
-- la version avec et sans local_id soit impossible.
-- Le texte exact appliqué en production est récupérable à tout moment par :
--   SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname IN ('decrementer_stock_medicaments', 'decrementer_stock_dons');
--
-- decrementer_stock_medicaments(p_decrements jsonb, p_local_id text) :
--   ... SELECT items INTO v_items FROM catalog WHERE type='medicaments' FOR UPDATE;   -- verrou d'abord
--   IF p_local_id IS NOT NULL AND EXISTS (SELECT 1 FROM decrements_stock_appliques WHERE local_id = p_local_id)
--   THEN RETURN jsonb_build_object('succes', true, 'deja_applique', true, 'items', v_items); END IF;
--   ... (vérification + décrément, identiques à la version d'origine) ...
--   IF p_local_id IS NOT NULL THEN
--     INSERT INTO decrements_stock_appliques (local_id) VALUES (p_local_id) ON CONFLICT DO NOTHING;
--   END IF;
--
-- decrementer_stock_dons(p_decrements jsonb, p_local_id text) : mêmes 2 blocs, au même endroit.
