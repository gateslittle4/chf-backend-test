#!/usr/bin/env python3
"""scripts/test-renommer-partenaire-sql.py — teste sql/renommer_partenaire_avec_dons.sql (après partenaires_identifiant_stable.sql) sur un Postgres JETABLE (jamais sur la vraie base).

  - renommer un partenaire change son nom, celui de ses épisodes / paiements (rattachés par identifiant OU encore sans identifiant mais au même nom) et la clé de ses dons dans le stock (donsParOng) ;
  - si le nouveau nom existait déjà comme clé de dons, les quantités s'additionnent ; aucune autre donnée du catalogue ne bouge ;
  - un renommage refusé ne change rien ; renommer avec le même nom ne double rien ; seul service_role peut l'appeler.

    python3 scripts/test-renommer-partenaire-sql.py

Prérequis : binaires PostgreSQL (PG_BIN, défaut /usr/lib/postgresql/16/bin), exécution en root. Variables : PG_BIN, PG_PORT."""
import os, shutil, subprocess, sys

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FICHIER1 = os.path.join(RACINE, "sql", "partenaires_identifiant_stable.sql")
FICHIER2 = os.path.join(RACINE, "sql", "renommer_partenaire_avec_dons.sql")
D = "/var/lib/postgresql/chf-test-renommer-partenaire"
B = os.environ.get("PG_BIN", "/usr/lib/postgresql/16/bin")
PORT = os.environ.get("PG_PORT", "54338")
PSQL = ["psql", "-h", "/tmp", "-p", PORT, "-U", "postgres", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=0"]
ECHECS = []

def sh(cmd): return subprocess.run(cmd, capture_output=True, text=True)
def pg(sql, db="chf", fichier=None):
    cmd = PSQL + ["-d", db] + (["-f", fichier] if fichier else ["-c", sql])
    r = sh(cmd); return (r.stdout + r.stderr).strip()
def verifier(cond, msg):
    print(("  ok   " if cond else "  ÉCHEC ") + msg)
    if not cond: ECHECS.append(msg)
def demarrer():
    shutil.rmtree(D, ignore_errors=True); os.makedirs(D); shutil.chown(D, "postgres", "postgres")
    sh(["su", "postgres", "-c", f"{B}/initdb -D {D}/data -A trust -E UTF8 >/dev/null"])
    sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -o '-p {PORT} -k /tmp' -l {D}/log.txt -w start >/dev/null"])
def arreter():
    sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -m fast stop >/dev/null"]); shutil.rmtree(D, ignore_errors=True)

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE ong_partenaires (id text PRIMARY KEY, nom text NOT NULL, supprime_le timestamptz);
CREATE TABLE episodes  (id serial PRIMARY KEY, ong_partenaire text, statut text DEFAULT 'ouvert');
CREATE TABLE paiements (id serial PRIMARY KEY, ong_partenaire text, montant numeric DEFAULT 0);
CREATE TABLE catalog (type text PRIMARY KEY, items jsonb, updated_at timestamptz);
INSERT INTO ong_partenaires VALUES ('p-avsi', 'AVSI', NULL), ('p-msf', 'MSF', NULL), ('p-vieux', 'Ancien', now());
INSERT INTO episodes (ong_partenaire) VALUES ('AVSI'), ('MSF');
INSERT INTO paiements (ong_partenaire, montant) VALUES ('AVSI', 100), ('MSF', 50);
INSERT INTO catalog VALUES ('medicaments', '[
  {"id":"m1","nom":"Paracétamol","quantite":120,"seuilAlerte":10,"donsParOng":{"AVSI":40,"MSF":10}},
  {"id":"m2","nom":"Amoxicilline","quantite":7,"donsParOng":{"avsi ":5,"Avsi Haïti":3}},
  {"id":"m3","nom":"Sérum","quantite":0,"donsParOng":{}},
  {"id":"m4","nom":"Gants","quantite":50},
  {"id":"m5","nom":"Seringue","quantite":9,"donsParOng":{"MSF":2}}
]', now());
"""

def dons(): return pg("SELECT jsonb_path_query_array(items, '$[*].donsParOng') FROM catalog WHERE type='medicaments'")

demarrer()
try:
    pg("CREATE DATABASE chf", db="postgres")
    pg(SCHEMA)
    pg("", fichier=FICHIER1)
    # lignes « anciennes » sans identifiant (déclencheur coupé le temps de l'insertion), même nom que le partenaire
    pg("ALTER TABLE episodes DISABLE TRIGGER rattacher_partenaire_id; INSERT INTO episodes (ong_partenaire) VALUES (' avsi'); ALTER TABLE episodes ENABLE TRIGGER rattacher_partenaire_id;")
    verifier(pg("SELECT count(*) FROM episodes WHERE ong_partenaire_id IS NULL") == "1", "mise en place : un épisode au nom de l'ancien partenaire sans identifiant")
    sortie = pg("", fichier=FICHIER2)
    verifier("ERROR" not in sortie and "ERREUR" not in sortie, "le script s'applique sans erreur : " + sortie[:200].replace("\n", " | "))
    sortie = pg("", fichier=FICHIER2)
    verifier("ERROR" not in sortie and "ERREUR" not in sortie, "…et se rejoue sans erreur")
    catalogue_avant = pg("SELECT items - 'x' FROM catalog WHERE type='medicaments'")
    autres_avant = pg("SELECT jsonb_agg(elem - 'donsParOng') FROM catalog, jsonb_array_elements(items) elem WHERE type='medicaments'")

    r = pg("SELECT public.renommer_partenaire('p-avsi', 'Avsi Haïti')")
    verifier('"episodes": 2' in r and '"paiements": 1' in r and '"dons": 2' in r, f"renvoie 2 épisodes (dont celui sans identifiant), 1 paiement, 2 médicaments à dons : {r}")
    verifier(pg("SELECT nom FROM ong_partenaires WHERE id='p-avsi'") == "Avsi Haïti", "le nom du partenaire est changé")
    verifier(pg("SELECT string_agg(DISTINCT ong_partenaire, ',') FROM episodes WHERE ong_partenaire ILIKE '%avsi%'") == "Avsi Haïti", "TOUS ses épisodes portent le nouveau nom, y compris celui qui n'avait pas d'identifiant")
    verifier(pg("SELECT count(*) FROM episodes WHERE ong_partenaire_id='p-avsi'") == "2", "…et le déclencheur lui a remis son identifiant")
    verifier(pg("SELECT ong_partenaire FROM paiements WHERE id=1") == "Avsi Haïti", "son paiement suit")
    verifier(pg("SELECT ong_partenaire FROM episodes WHERE ong_partenaire='MSF'") == "MSF", "un autre partenaire ne bouge pas")
    verifier(pg("SELECT items->0->'donsParOng' FROM catalog WHERE type='medicaments'") == '{"MSF": 10, "Avsi Haïti": 40}' or pg("SELECT (items->0->'donsParOng'->>'Avsi Haïti')::int FROM catalog WHERE type='medicaments'") == "40", "dons m1 : la clé « AVSI » devient « Avsi Haïti » (40)")
    verifier(pg("SELECT (items->0->'donsParOng'->>'MSF')::int FROM catalog WHERE type='medicaments'") == "10", "dons m1 : MSF garde sa quantité")
    verifier(pg("SELECT (items->1->'donsParOng'->>'Avsi Haïti')::numeric FROM catalog WHERE type='medicaments'") == "8", "dons m2 : « avsi  » (5) et « Avsi Haïti » (3) s'additionnent → 8")
    verifier(pg("SELECT jsonb_object_keys(items->1->'donsParOng') FROM catalog WHERE type='medicaments'") == "Avsi Haïti", "dons m2 : une seule clé reste")
    verifier(pg("SELECT items->2->'donsParOng' FROM catalog WHERE type='medicaments'") == "{}", "dons m3 (vide) reste vide")
    verifier(pg("SELECT items->3 ? 'donsParOng' FROM catalog WHERE type='medicaments'") == "f", "m4 (sans dons) n'en reçoit pas")
    verifier(pg("SELECT items->4->'donsParOng' FROM catalog WHERE type='medicaments'") == '{"MSF": 2}', "m5 (dons d'un autre partenaire) intact")
    autres_apres = pg("SELECT jsonb_agg(elem - 'donsParOng') FROM catalog, jsonb_array_elements(items) elem WHERE type='medicaments'")
    verifier(autres_avant == autres_apres, "quantités, noms, seuils et ordre des médicaments identiques")

    r = pg("SELECT public.renommer_partenaire('p-avsi', 'Avsi Haïti')")
    verifier("inchange" in r, f"renommer avec le même nom ne fait rien : {r}")
    verifier(pg("SELECT (items->1->'donsParOng'->>'Avsi Haïti')::numeric FROM catalog WHERE type='medicaments'") == "8", "…et ne double aucun don")

    # renommage de pure casse : « MSF » → « Msf »
    r = pg("SELECT public.renommer_partenaire('p-msf', 'Msf')")
    verifier('"dons": 2' in r, f"renommer MSF → Msf touche ses 2 médicaments à dons : {r}")
    verifier(pg("SELECT (items->0->'donsParOng'->>'Msf')::int FROM catalog WHERE type='medicaments'") == "10", "dons m1 : la clé suit (10)")
    verifier(pg("SELECT (items->4->'donsParOng'->>'Msf')::int FROM catalog WHERE type='medicaments'") == "2", "dons m5 : la clé suit (2)")

    avant_refus = pg("SELECT nom FROM ong_partenaires ORDER BY id") + dons()
    verifier("déjà ce nom" in pg("SELECT public.renommer_partenaire('p-msf', 'avsi haïti')"), "refus d'un nom déjà pris")
    verifier("vide" in pg("SELECT public.renommer_partenaire('p-msf', '  ')"), "refus d'un nom vide")
    verifier("introuvable" in pg("SELECT public.renommer_partenaire('p-vieux', 'X')"), "refus d'un partenaire supprimé")
    verifier("introuvable" in pg("SELECT public.renommer_partenaire('p-nope', 'X')"), "refus d'un partenaire inconnu")
    verifier(avant_refus == pg("SELECT nom FROM ong_partenaires ORDER BY id") + dons(), "un renommage refusé ne change rien (ni noms, ni dons)")

    pg("DELETE FROM catalog")
    r = pg("SELECT public.renommer_partenaire('p-msf', 'MSF France')")
    verifier('"dons": 0' in r, f"sans catalogue de médicaments, le renommage marche quand même : {r}")
    droits = pg("SELECT has_function_privilege('anon', 'public.renommer_partenaire(text,text)', 'execute'), has_function_privilege('authenticated', 'public.renommer_partenaire(text,text)', 'execute'), has_function_privilege('service_role', 'public.renommer_partenaire(text,text)', 'execute')")
    verifier(droits == "f|f|t", f"seul le serveur (service_role) peut renommer : {droits}")
finally:
    arreter()

print()
if ECHECS:
    print(f"{len(ECHECS)} ÉCHEC(S)"); sys.exit(1)
print("Tous les contrôles passent.")
