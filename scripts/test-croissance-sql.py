#!/usr/bin/env python3
"""scripts/test-croissance-sql.py — teste sql/croissance_index_et_postes_ouverts.sql sur un Postgres JETABLE (jamais sur la vraie base).

  - le script se rejoue sans erreur et ne modifie aucune donnée ;
  - les 3 index sont créés ET utilisés par les requêtes du serveur (journal d'audit, listes d'épisodes et de paiements) ;
  - sessions_caisse_ouvertes() ne renvoie que les postes ouverts, ne plante ni sans ligne « sessions_caisse » ni sur un contenu qui n'est pas une liste, et n'est appelable que par le serveur.

    python3 scripts/test-croissance-sql.py

Prérequis : binaires PostgreSQL (PG_BIN, défaut /usr/lib/postgresql/16/bin), exécution en root. Variables : PG_BIN, PG_PORT."""
import os, shutil, subprocess, sys

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FICHIER = os.path.join(RACINE, "sql", "croissance_index_et_postes_ouverts.sql")
D = "/var/lib/postgresql/chf-test-croissance"
B = os.environ.get("PG_BIN", "/usr/lib/postgresql/16/bin")
PORT = os.environ.get("PG_PORT", "54340")
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
CREATE TABLE audit_log (id serial PRIMARY KEY, action text, date timestamptz);
CREATE TABLE episodes (id serial PRIMARY KEY, date_ouverture timestamptz, supprime_le timestamptz);
CREATE TABLE paiements (id serial PRIMARY KEY, date_paiement timestamptz, supprime_le timestamptz);
CREATE TABLE catalog (type text PRIMARY KEY, items jsonb);
INSERT INTO audit_log (action, date) SELECT 'a', now() - (g || ' minutes')::interval FROM generate_series(1, 50000) g;
INSERT INTO episodes (date_ouverture) SELECT now() - (g || ' minutes')::interval FROM generate_series(1, 30000) g;
INSERT INTO paiements (date_paiement) SELECT now() - (g || ' minutes')::interval FROM generate_series(1, 30000) g;
"""
OUVERTES = "SELECT coalesce(string_agg(e->>'id', ',' ORDER BY e->>'id'), '') FROM jsonb_array_elements(public.sessions_caisse_ouvertes()) e"

demarrer()
try:
    pg("CREATE DATABASE chf", db="postgres")
    pg(SCHEMA)
    avant = pg("SELECT count(*), sum(id) FROM audit_log") + pg("SELECT count(*), sum(id) FROM episodes") + pg("SELECT count(*), sum(id) FROM paiements")
    sortie = pg("", fichier=FICHIER)
    verifier("ERROR" not in sortie and "ERREUR" not in sortie, "le script s'applique sans erreur : " + sortie[:200].replace("\n", " | "))
    sortie = pg("", fichier=FICHIER)
    verifier("ERROR" not in sortie and "ERREUR" not in sortie, "…et se rejoue sans erreur")
    verifier(avant == pg("SELECT count(*), sum(id) FROM audit_log") + pg("SELECT count(*), sum(id) FROM episodes") + pg("SELECT count(*), sum(id) FROM paiements"), "aucune donnée modifiée")
    verifier(pg("SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_audit_log_date','idx_episodes_date_ouverture','idx_paiements_date_paiement')") == "3", "les 3 index existent")
    pg("ANALYZE")
    verifier("idx_audit_log_date" in pg("EXPLAIN SELECT * FROM audit_log ORDER BY date DESC LIMIT 300"), "le journal d'audit (300 dernières lignes) utilise l'index de date")
    verifier("idx_episodes_date_ouverture" in pg("EXPLAIN SELECT * FROM episodes WHERE supprime_le IS NULL ORDER BY date_ouverture DESC, id LIMIT 500 OFFSET 20000"), "la lecture paginée des épisodes utilise l'index")
    verifier("idx_paiements_date_paiement" in pg("EXPLAIN SELECT * FROM paiements WHERE supprime_le IS NULL ORDER BY date_paiement DESC, id LIMIT 500 OFFSET 20000"), "la lecture paginée des paiements utilise l'index")

    verifier(pg(OUVERTES) == "", "sans ligne « sessions_caisse » : liste vide, pas d'erreur")
    pg("""INSERT INTO catalog VALUES ('sessions_caisse', '[{"id":"a","statut":"fermee"},{"id":"b","statut":"ouverte"},{"id":"c","statut":"ouverte"},{"id":"d"},{"id":"e","statut":"fermee"}]')""")
    verifier(pg(OUVERTES) == "b,c", "seuls les postes ouverts sont renvoyés (b, c)")
    verifier(pg("SELECT jsonb_array_length(public.sessions_caisse_ouvertes())") == "2", "…et rien d'autre")
    pg("""UPDATE catalog SET items = '{"pas":"une liste"}' WHERE type = 'sessions_caisse'""")
    verifier(pg("SELECT public.sessions_caisse_ouvertes()") == "[]", "contenu qui n'est pas une liste : liste vide, pas d'erreur")
    pg("""UPDATE catalog SET items = '[]' WHERE type = 'sessions_caisse'""")
    verifier(pg("SELECT public.sessions_caisse_ouvertes()") == "[]", "liste vide : liste vide")
    droits = pg("SELECT has_function_privilege('anon', 'public.sessions_caisse_ouvertes()', 'execute'), has_function_privilege('authenticated', 'public.sessions_caisse_ouvertes()', 'execute'), has_function_privilege('service_role', 'public.sessions_caisse_ouvertes()', 'execute')")
    verifier(droits == "f|f|t", f"seul le serveur (service_role) peut l'appeler : {droits}")
finally:
    arreter()

print()
if ECHECS:
    print(f"{len(ECHECS)} ÉCHEC(S)"); sys.exit(1)
print("Tous les contrôles passent.")
