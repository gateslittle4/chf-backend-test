#!/usr/bin/env python3
"""scripts/test-controles-montants-sql.py — teste sql/controles_montants.sql sur un Postgres JETABLE (jamais la vraie base) :
la contrainte refuse un montant négatif ou démesuré, accepte 0 et les montants normaux, laisse intactes les lignes existantes,
et le script se rejoue sans effet (une seule contrainte).

    python3 scripts/test-controles-montants-sql.py

Prérequis : binaires PostgreSQL (PG_BIN, défaut /usr/lib/postgresql/16/bin), exécution en root. Variables : PG_BIN, PG_PORT."""
import os, shutil, subprocess, sys

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FICHIER = os.path.join(RACINE, "sql", "controles_montants.sql")
D = "/var/lib/postgresql/chf-test-controles-montants"
B = os.environ.get("PG_BIN", "/usr/lib/postgresql/16/bin")
PORT = os.environ.get("PG_PORT", "54335")
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
    pg("CREATE TABLE paiements (id serial PRIMARY KEY, mode text, montant numeric(12,2) NOT NULL, solde_restant numeric);"
       "INSERT INTO paiements (mode, montant) VALUES ('cash', 0), ('cash', 60), ('credit', 0), ('moncash', 1222222);")

def scenario(unique):
    mode = "une seule transaction" if unique else "instruction par instruction"
    print(f"\n== Application ({mode}), puis rejeu ==")
    base_neuve()
    sortie = pg(None, fichier=FICHIER, unique=unique)
    verifier("ERROR" not in sortie and "ERREUR" not in sortie, f"le script passe sans erreur ({sortie[:200]!r})")
    sortie2 = pg(None, fichier=FICHIER, unique=unique)
    verifier("ERROR" not in sortie2 and "ERREUR" not in sortie2, f"rejouer le script passe aussi ({sortie2[:200]!r})")
    verifier(pg("SELECT count(*) FROM pg_constraint WHERE conname='paiements_montant_borne'") == "1", "une seule contrainte après rejeu")
    verifier(pg("SELECT count(*) FROM paiements") == "4", "les lignes existantes sont intactes")
    for montant, attendu, texte in [("-1", False, "négatif"), ("-0.01", False, "un centime négatif"), ("100000000.01", False, "au-dessus du plafond"), ("999999999.99", False, "démesuré"),
                                    ("0", True, "zéro"), ("60.50", True, "montant normal"), ("100000000", True, "pile le plafond")]:
        sortie = pg(f"INSERT INTO paiements (mode, montant) VALUES ('cash', {montant})")
        refuse = "paiements_montant_borne" in sortie
        verifier(refuse == (not attendu), f"{texte} ({montant}) : {'refusé' if not attendu else 'accepté'}")
    verifier(pg("SELECT count(*) FROM paiements WHERE montant < 0 OR montant > 100000000") == "0", "aucune ligne hors limites n'est entrée")

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
