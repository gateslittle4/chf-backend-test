-- Données synthétiques réalistes pour le test de restauration. Paramètres remplacés par le script : {{N_DOS}} dossiers, {{N_AUDIT}} lignes d'audit, {{N_SESSIONS}} sessions de caisse.
-- Pièges volontaires : accents, guillemets, antislash, emoji, retour à la ligne dans une adresse, dossiers fusionnés/mère-enfant qui pointent vers un dossier PLUS TARD
-- dans l'ordre de restauration, journal d'audit sur 5 ans, paiements annulés, partenaires, JSON imbriqués.
-- Chargement en masse : les déclencheurs sont suspendus (sinon l'un d'eux, rejoué ligne par ligne sur 160 000 paiements, rend la génération interminable à l'échelle « 5 ans »).
-- La RESTAURATION, elle, tourne avec tous les déclencheurs de la base cible : c'est elle qu'on teste.
SET session_replication_role = replica;
SET chf.restauration = 'on';  -- le journal d'audit garde ses dates d'origine (sinon le déclencheur les remplace par l'heure actuelle)

INSERT INTO ong_partenaires (id, nom, prochain_numero)
SELECT 'p-' || g, (ARRAY['AVSI','MSF','ALIMA','Croix-Rouge','Médecins du Monde','Partners In Health','UNICEF','OMS','Caritas','PAM','Fondation Espoir'])[g], 1 + g FROM generate_series(1, 11) g;

INSERT INTO users (id, display_name, role, active, email)
SELECT 'uid' || g, 'Utilisateur ' || g, (ARRAY['administrateur','direction','comptable','infirmier','medecin','pharmacien','lecteur'])[1 + g % 7], true, 'u' || g || '@chf.org' FROM generate_series(1, 14) g;

INSERT INTO dossiers (id, numero_dossier, nom, date_naissance, telephone, adresse, date_creation, sexe, poids, conjoint)
SELECT gen_random_uuid(), 'D' || g,
  CASE g % 7 WHEN 0 THEN 'O''Brien "Jean" \ é 日本 😀 ' || g WHEN 1 THEN 'Éloïse Saint-Preux ' || g ELSE 'Patient ' || md5(g::text) END,
  date '1950-01-01' + (random() * 25000)::int, '3' || lpad((random() * 9999999)::int::text, 7, '0'),
  E'Rue ' || g || E'\nPort-au-Prince, Haïti', now() - (random() * 1825) * interval '1 day', CASE WHEN random() < .5 THEN 'M' ELSE 'F' END,
  round((random() * 80)::numeric, 1), 'Conjoint ' || g
FROM generate_series(1, {{N_DOS}}) g;

WITH n AS (SELECT id, row_number() OVER (ORDER BY id) rn FROM dossiers)
UPDATE dossiers d SET fusionne_dans = t.id, fusionne_le = now(), fusionne_par = 'test', fusion_details = '{"raison":"doublon"}'::jsonb, anciens_noms = '["Ancien nom"]'::jsonb
FROM n s JOIN n t ON t.rn = ((s.rn + 7919) % {{N_DOS}}) + 1 WHERE d.id = s.id AND s.rn % 50 = 0 AND t.id <> s.id;
WITH n AS (SELECT id, row_number() OVER (ORDER BY id) rn FROM dossiers)
UPDATE dossiers d SET mere_dossier_id = t.id
FROM n s JOIN n t ON t.rn = ((s.rn + 104729) % {{N_DOS}}) + 1 WHERE d.id = s.id AND s.rn % 101 = 0 AND t.id <> s.id AND d.fusionne_dans IS NULL;

INSERT INTO episodes (id, dossier_id, voie_entree, service, type_consultation, type_patient, ong_partenaire, statut, est_hospitalisation, date_ouverture, date_fermeture, lit, mois_lot, dossier_complet)
SELECT gen_random_uuid(), d.id, (ARRAY['urgence','consultation','vente_comptoir'])[1 + (random() * 2)::int], 'Général', 'Général',
  CASE WHEN p.nom IS NULL THEN 'prive' ELSE 'partenaire' END, p.nom, CASE WHEN random() < .02 THEN 'ouvert' ELSE 'ferme' END, random() < .1,
  now() - (random() * 1825) * interval '1 day', now(), CASE WHEN random() < .1 THEN 'L' || (random() * 30)::int END, to_char(now() - (random() * 1825) * interval '1 day', 'YYYY-MM'), true
FROM dossiers d CROSS JOIN LATERAL generate_series(1, 1 + (random() * 1.5)::int) k
LEFT JOIN ong_partenaires p ON random() < .2 AND p.id = 'p-' || (1 + (random() * 10)::int);

INSERT INTO fiches (id, episode_id, numero_fiche, local_id, date_creation, cree_par, total_global, breakdown, mode_paiement, raw_state, cree_par_uid)
SELECT gen_random_uuid(), e.id, n, 'fl-' || e.id || '-' || n, e.date_ouverture, 'infirmier@chf.org', (random() * 5000)::int,
  jsonb_build_object('lignes', (SELECT jsonb_agg(jsonb_build_object('id', i, 'label', 'Acte ' || i, 'prix', (random() * 500)::int, 'qte', 1)) FROM generate_series(1, 6) i), 'note', 'été "ok"'),
  'cash', jsonb_build_object('note', repeat('x', 150)), 'uid1'
FROM episodes e CROSS JOIN LATERAL generate_series(1, 1 + (random() * 2.6)::int) n;

INSERT INTO paiements (id, fiche_id, episode_id, local_id, mode, montant, date_paiement, details, annule, annule_par, annule_le, motif_annulation, encaisse_par, patient_nom, ong_partenaire, exoneration)
SELECT gen_random_uuid(), f.id, e.id, 'pl-' || e.id || '-' || k, (ARRAY['cash','moncash','credit','ong','depot','cash','cash'])[1 + (random() * 6)::int], (random() * 3000)::numeric(12,2),
  e.date_ouverture + interval '10 minutes', jsonb_build_object('note', repeat('y', 120)), a.annule, CASE WHEN a.annule THEN 'direction@chf.org' END, CASE WHEN a.annule THEN now() END,
  CASE WHEN a.annule THEN 'erreur de saisie' END, 'caisse@chf.org', 'Patient X', e.ong_partenaire, CASE WHEN random() < .05 THEN '{"pourcentage":50}'::jsonb END
FROM episodes e CROSS JOIN LATERAL generate_series(1, 1 + (random() * 1.9)::int) k
CROSS JOIN LATERAL (SELECT random() < .03 AS annule) a
LEFT JOIN LATERAL (SELECT id FROM fiches WHERE fiches.episode_id = e.id ORDER BY id LIMIT 1) f ON true;

INSERT INTO audit_log (id, action, details, effectue_par, effectue_par_uid, date)
SELECT gen_random_uuid(), 'action_' || (g % 25), jsonb_build_object('k', repeat('z', 60), 'g', g), 'user' || (g % 14) || '@chf.org', 'uid' || (g % 14), now() - (random() * 1825) * interval '1 day'
FROM generate_series(1, {{N_AUDIT}}) g;

INSERT INTO catalog (type, items) VALUES
 ('medicaments', (SELECT jsonb_agg(jsonb_build_object('id', 'm' || g, 'nom', 'Médicament ' || g, 'prix', (g % 90) + 5, 'quantite', g % 200, 'seuilAlerte', 10, 'donsParOng', jsonb_build_object('AVSI', g % 7, 'MSF', g % 5))) FROM generate_series(1, 341) g)),
 ('actes', (SELECT jsonb_agg(jsonb_build_object('id', 'a' || g, 'nom', 'Acte ' || g, 'prix', g * 10)) FROM generate_series(1, 175) g)),
 ('permissions', (SELECT jsonb_agg(jsonb_build_object('role', 'role' || g, 'permissions', jsonb_build_array('a', 'b'))) FROM generate_series(1, 12) g)),
 ('sessions_caisse', (SELECT jsonb_agg(jsonb_build_object('id', 's' || g, 'uid', 'uid' || (g % 14), 'nom', 'Caissier ' || g, 'statut', CASE WHEN g % 500 = 0 THEN 'ouverte' ELSE 'fermee' END, 'poste', 'jour', 'ouvertureISO', (now() - (g || ' hours')::interval)::text)) FROM generate_series(1, {{N_SESSIONS}}) g));

INSERT INTO cloture_caisse (id, date, solde_ouverture, comptant_remis, fond_conserve, statut, cloturee_par, date_cloture, cloturee_par_uid)
SELECT 'c' || g, to_char(now() - (g || ' days')::interval, 'YYYY-MM-DD'), 1000, 500, 500, 'cloturee', 'Caissier', now() - (g || ' days')::interval, 'uid' || (g % 14) FROM generate_series(1, GREATEST({{N_DOS}} / 100, 3)) g;
INSERT INTO depenses_caisse (motif, montant, demandeur, demandeur_uid, local_id) SELECT 'Dépense ' || g, 100 + g, 'Demandeur', 'uid1', 'dl-' || g FROM generate_series(1, GREATEST({{N_DOS}} / 50, 3)) g;
INSERT INTO requisitions (service_demandeur, lignes, demande_par, local_id) SELECT 'Pharmacie', '[{"id":"m1","qte":2}]'::jsonb, 'Infirmier', 'rl-' || g FROM generate_series(1, GREATEST({{N_DOS}} / 80, 3)) g;
INSERT INTO transferts_service (episode_id, ancien_service, nouveau_service, motif) SELECT id, 'Général', 'Pédiatrie', 'transfert' FROM episodes WHERE random() < .02;
INSERT INTO demandes_exoneration (episode_id, patient_nom, montant_total, pourcentage_demande, montant_exonere, demandeur, demandeur_uid, statut, fiche_snapshot) SELECT id, 'Patient', 1000, 50, 500, 'Demandeur', 'uid1', 'accepte', '{"a":1}'::jsonb FROM episodes WHERE random() < .01;
INSERT INTO pieces_jointes (dossier_id, storage_path, nom_original, type_document, taille_octets) SELECT id, 'dossier/' || id || '/radio.pdf', 'radio.pdf', 'radio', 1234 FROM dossiers WHERE random() < .005;
INSERT INTO invitations (token, role, date_expiration) SELECT 'tok' || g, 'infirmier', now() + interval '7 days' FROM generate_series(1, 20) g;
INSERT INTO salaires_service (id, montant_mensuel) VALUES ('Pharmacie', 50000), ('Laboratoire', 40000);
INSERT INTO decrements_stock_appliques (local_id) SELECT 'dec-' || g FROM generate_series(1, GREATEST({{N_DOS}} / 10, 3)) g;
INSERT INTO doublons_ignores (dossier_a, dossier_b, ignore_par)
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'direction' FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM dossiers) a JOIN (SELECT id, row_number() OVER (ORDER BY id) rn FROM dossiers) b ON b.rn = a.rn + 1 WHERE a.rn % 97 = 0;
INSERT INTO migrations_appliquees (nom, somme_controle, applique_par, remarque) SELECT 'script_' || g || '.sql', md5(g::text), 'test', 'essai' FROM generate_series(1, 5) g;
-- Ce que le déclencheur rattacher_partenaire_id fait à chaque insertion (suspendu pendant ce chargement en masse) : l'identifiant du partenaire d'après son nom.
UPDATE episodes SET ong_partenaire_id = public.id_partenaire_par_nom(ong_partenaire) WHERE ong_partenaire IS NOT NULL;
UPDATE paiements SET ong_partenaire_id = public.id_partenaire_par_nom(ong_partenaire) WHERE ong_partenaire IS NOT NULL;
ANALYZE;

-- Compteur des numéros de dossier : la base source est « en service » (dernier numéro donné : 1500) ; la base cible, fraîche, a seulement la ligne de départ (0) créée par les scripts.
INSERT INTO compteurs (id, derniernumero, updated_at) VALUES ('dossiers', 1500, '2026-10-16 10:00:00+00')
ON CONFLICT (id) DO UPDATE SET derniernumero = 1500, updated_at = '2026-10-16 10:00:00+00';
