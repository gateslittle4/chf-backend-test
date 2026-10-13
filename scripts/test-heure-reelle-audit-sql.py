#!/usr/bin/env python3
"""scripts/test-heure-reelle-audit-sql.py — teste sql/heure_reelle_audit.sql sur un Postgres JETABLE (jamais sur la vraie base) :
l'heure d'une ligne d'audit est celle de la base, quelle que soit la date envoyée par l'ordinateur ; le script se rejoue sans effet
(un seul déclencheur) et passe dans les deux modes (instruction par instruction / une seule transaction).

    python3 scripts/test-heure-reelle-audit-sql.py

Prérequis : binaires PostgreSQL (PG_BIN, défaut /usr/lib/postgresql/16/bin), exécution en root. Variables : PG_BIN, PG_PORT."""
import os, shutil, subprocess, sys

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FICHIER = os.path.join(RACINE, "sql", "heure_reelle_audit.sql")
D = "/var/lib/postgresql/chf-test-heure-reelle-audit"
B = os.environ.get("PG_BIN", "/usr/lib/postgresql/16/bin")
PORT = os.environ.get("PG_PORT", "54334")
PSQL = ["psql", "-h", "/tmp", "-p", PORT, "-U", "postgres", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=0"]
ECHECS = []

def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)

def pg(sql, db="chf", fichier=None, unique=False):
    cmd = PSQL + ["-d", db] + (["-1"] if unique else [])
    cmd += ["-f", fichier] if fichier else ["-c", sql]
    r = sh(cmd)
    return (r.stdout + r.stderr).strip()

def verifier(condition, message):
    print(("  ok   " if condition else "  ÉCHEC ") + message)
    if not condition:
        ECHECS.append(message)

def demarrer():
    shutil.rmtree(D, ignore_errors=True)
    os.makedirs(D); shutil.chown(D, "postgres", "postgres")
    sh(["su", "postgres", "-c", f"{B}/initdb -D {D}/data -A trust -E UTF8 >/dev/null"])
    sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -o '-p {PORT} -k /tmp' -l {D}/log.txt -w start >/dev/null"])

def arreter():
    sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -m fast stop >/dev/null"])
    shutil.rmtree(D, ignore_errors=True)

def base_neuve():
    pg("DROP DATABASE IF EXISTS chf", db="postgres")
    pg("CREATE DATABASE chf", db="postgres")
    # Même forme que la vraie table : date timestamptz DEFAULT now(), details jsonb.
    pg("CREATE TABLE audit_log (id text PRIMARY KEY, action text, details jsonb DEFAULT '{}'::jsonb, effectue_par text, effectue_par_uid text, date timestamptz DEFAULT now());"
       "INSERT INTO audit_log (id, action, date) VALUES ('ancien', 'avant_le_script', '2001-01-01');")

def scenario(unique):
    mode = "une seule transaction" if unique else "instruction par instruction"
    print(f"\n== Application ({mode}), puis rejeu ==")
    base_neuve()
    sortie = pg(None, fichier=FICHIER, unique=unique)
    verifier("ERROR" not in sortie and "ERREUR" not in sortie, f"le script passe sans erreur ({sortie[:200]!r})")
    sortie2 = pg(None, fichier=FICHIER, unique=unique)
    verifier("ERROR" not in sortie2 and "ERREUR" not in sortie2, f"rejouer le script passe aussi ({sortie2[:200]!r})")
    verifier(pg("SELECT count(*) FROM pg_trigger WHERE tgname='trg_audit_heure_serveur' AND NOT tgisinternal") == "1", "un seul déclencheur après rejeu")
    verifier(pg("SELECT date FROM audit_log WHERE id='ancien'").startswith("2001-01-01"), "les lignes d'avant le script gardent leur date")
    pg("INSERT INTO audit_log (id, action, date) VALUES ('faux-passe', 'x', '2001-01-01')")
    verifier(pg("SELECT date > now() - interval '1 minute' FROM audit_log WHERE id='faux-passe'") == "t", "une date ancienne envoyée par l'ordinateur est remplacée par l'heure de la base")
    pg("INSERT INTO audit_log (id, action, date) VALUES ('faux-futur', 'x', '2099-01-01')")
    verifier(pg("SELECT date <= now() FROM audit_log WHERE id='faux-futur'") == "t", "une date dans le futur est remplacée aussi")
    pg("INSERT INTO audit_log (id, action) VALUES ('sans-date', 'x')")
    verifier(pg("SELECT date > now() - interval '1 minute' FROM audit_log WHERE id='sans-date'") == "t", "sans date : heure de la base")
    verifier(pg("SELECT action FROM audit_log WHERE id='faux-passe'") == "x", "les autres colonnes ne sont pas touchées")

try:
    demarrer()
    scenario(False)
    scenario(True)
finally:
    arreter()

print()
if ECHECS:
    print(f"{len(ECHECS)} ÉCHEC(S)")
    sys.exit(1)
print("Tout est ok.")
