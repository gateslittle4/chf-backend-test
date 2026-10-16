#!/usr/bin/env python3
"""scripts/test-numero-dossier-sql.py — teste sql/numero_dossier_compteur.sql sur un Postgres JETABLE (jamais sur la vraie base).

  - le script se rejoue sans erreur ; le compteur 'dossiers' est créé une seule fois ;
  - numero_dossier_propose() donne le prochain numéro LIBRE (saute les numéros déjà pris, même tapés à la main) ;
  - attribuer_numero_dossier() donne le numéro, refuse un numéro pris / vide / un dossier inconnu, et ne fait avancer le compteur que pour le numéro PROPOSÉ ;
  - l'administrateur choisit le numéro de départ ; increment_counter() fonctionne enfin ; tout est réservé au serveur.

    python3 scripts/test-numero-dossier-sql.py

Prérequis : binaires PostgreSQL (PG_BIN, défaut /usr/lib/postgresql/16/bin), exécution en root. Variables : PG_BIN, PG_PORT."""
import os, shutil, subprocess, sys

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FICHIER = os.path.join(RACINE, "sql", "numero_dossier_compteur.sql")
D = "/var/lib/postgresql/chf-test-numero-dossier"
B = os.environ.get("PG_BIN", "/usr/lib/postgresql/16/bin")
PORT = os.environ.get("PG_PORT", "54341")
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
CREATE TABLE compteurs (id text PRIMARY KEY, derniernumero integer DEFAULT 0, updated_at timestamptz DEFAULT now());
INSERT INTO compteurs (id, derniernumero) VALUES ('fiches', 0);
CREATE TABLE dossiers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), numero_dossier text NOT NULL UNIQUE, nom text);
INSERT INTO dossiers (id, numero_dossier, nom) VALUES ('00000000-0000-0000-0000-00000000000a', 'EN-ATTENTE-AAAAAAAAAA', 'Marie'), ('00000000-0000-0000-0000-00000000000b', 'EN-ATTENTE-BBBBBBBBBB', 'Jean');
"""
def appel(sql): return pg(sql)
def erreur(sql): return pg(sql)
ID_A = "00000000-0000-0000-0000-00000000000a"; ID_B = "00000000-0000-0000-0000-00000000000b"

demarrer()
try:
    pg("CREATE DATABASE chf", db="postgres")
    pg(SCHEMA)
    sortie = pg("", fichier=FICHIER)
    verifier("ERROR" not in sortie and "ERREUR" not in sortie, "le script s'applique sans erreur : " + sortie[:200].replace("\n", " | "))
    sortie = pg("", fichier=FICHIER)
    verifier("ERROR" not in sortie and "ERREUR" not in sortie, "…et se rejoue sans erreur")
    verifier(pg("SELECT count(*) FROM compteurs WHERE id = 'dossiers'") == "1", "une seule ligne de compteur « dossiers »")

    verifier(pg("SELECT public.numero_dossier_propose()") == "1", "compteur à 0 : le premier numéro proposé est 1")
    verifier(pg("SELECT public.numero_dossier_depart()") == "1", "…et le numéro de départ affiché est 1")
    verifier(pg("SELECT public.definir_numero_dossier_depart(5000)") == "5000", "l'administrateur choisit 5000 comme prochain numéro")
    verifier(pg("SELECT public.numero_dossier_propose()") == "5000" and pg("SELECT public.numero_dossier_depart()") == "5000", "le site propose maintenant 5000")
    pg("INSERT INTO dossiers (numero_dossier, nom) VALUES ('5000', 'Pris à la main'), ('5001', 'Pris à la main 2'), ('5003', 'Pris 3')")
    verifier(pg("SELECT public.numero_dossier_propose()") == "5002", "les numéros déjà pris (même tapés à la main) sont sautés : 5000 et 5001 pris → 5002")

    r = pg(f"SELECT public.attribuer_numero_dossier('{ID_A}', '5002')")
    verifier('"automatique": true' in r and '"numero": "5002"' in r and '"ancien": "EN-ATTENTE-AAAAAAAAAA"' in r, f"le numéro PROPOSÉ est donné, le dossier passe de « en attente » à 5002 : {r}")
    verifier(pg("SELECT numero_dossier FROM dossiers WHERE id = '" + ID_A + "'") == "5002", "le dossier porte bien son numéro")
    verifier(pg("SELECT derniernumero FROM compteurs WHERE id = 'dossiers'") == "5002", "le compteur a avancé jusqu'à 5002")
    verifier(pg("SELECT public.numero_dossier_propose()") == "5004", "prochain numéro libre : 5004 (5003 est pris)")

    r = pg(f"SELECT public.attribuer_numero_dossier('{ID_B}', '777')")
    verifier('"automatique": false' in r, f"un numéro MODIFIÉ à la main est accepté, sans faire avancer le compteur : {r}")
    verifier(pg("SELECT derniernumero FROM compteurs WHERE id = 'dossiers'") == "5002", "le compteur n'a pas bougé (777 n'était pas le numéro proposé)")
    r = pg(f"SELECT public.attribuer_numero_dossier('{ID_B}', '777')")
    verifier('"inchange": true' in r, "redonner le même numéro ne fait rien")
    r = pg(f"SELECT public.attribuer_numero_dossier('{ID_B}', 'A-12/b')")
    verifier('"numero": "A-12/b"' in r, "un numéro d'archive non numérique est accepté tel quel")
    verifier(pg("SELECT derniernumero FROM compteurs WHERE id = 'dossiers'") == "5002", "…sans toucher au compteur")

    verifier("déjà utilisé" in pg(f"SELECT public.attribuer_numero_dossier('{ID_B}', '5002')"), "un numéro déjà pris par un autre dossier est refusé")
    verifier(pg("SELECT numero_dossier FROM dossiers WHERE id = '" + ID_B + "'") == "A-12/b", "…et le dossier garde son numéro")
    verifier("requis" in pg(f"SELECT public.attribuer_numero_dossier('{ID_B}', '   ')"), "un numéro vide est refusé")
    verifier("introuvable" in pg("SELECT public.attribuer_numero_dossier('00000000-0000-0000-0000-0000000000ff', '9')"), "un dossier inconnu est refusé")
    verifier("entre 1 et" in pg("SELECT public.definir_numero_dossier_depart(0)") and "entre 1 et" in pg("SELECT public.definir_numero_dossier_depart(NULL)"), "un numéro de départ invalide est refusé")

    verifier(pg("SELECT public.increment_counter('essai')") == "1" and pg("SELECT public.increment_counter('essai')") == "2", "increment_counter fonctionne (crée puis incrémente)")
    verifier(pg("SELECT public.increment_counter('fiches')") == "1", "…et sur un compteur existant")

    for f in ("numero_dossier_propose()", "attribuer_numero_dossier(uuid,text)", "numero_dossier_depart()", "definir_numero_dossier_depart(bigint)"):
        droits = pg(f"SELECT has_function_privilege('anon', 'public.{f}', 'execute'), has_function_privilege('authenticated', 'public.{f}', 'execute'), has_function_privilege('service_role', 'public.{f}', 'execute')")
        verifier(droits == "f|f|t", f"{f} : seul le serveur peut l'appeler ({droits})")
finally:
    arreter()

print()
if ECHECS:
    print(f"{len(ECHECS)} ÉCHEC(S)"); sys.exit(1)
print("Tous les contrôles passent.")
