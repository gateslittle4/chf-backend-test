#!/usr/bin/env python3
"""scripts/test-partenaires-identifiant-sql.py — teste sql/partenaires_identifiant_stable.sql sur un Postgres JETABLE (jamais sur la vraie base).

  - le script se rejoue sans erreur ni changement (idempotent) et n'enlève ni ne modifie aucune donnée existante ;
  - l'historique est rattaché : nom identique (majuscules / espaces ignorés) à UN SEUL partenaire ; nom inconnu, nom ambigu (2 partenaires) ou partenaire supprimé → vide ;
  - un épisode ou un paiement NEUF est rattaché tout seul ; changer le nom suit ; vider le nom efface l'identifiant ;
  - renommer_partenaire() change le nom du partenaire ET de tous ses épisodes / paiements ; refuse un nom vide, un partenaire inconnu, un nom déjà pris ; ne touche pas aux autres partenaires.

    python3 scripts/test-partenaires-identifiant-sql.py

Prérequis : binaires PostgreSQL (PG_BIN, défaut /usr/lib/postgresql/16/bin), exécution en root. Variables : PG_BIN, PG_PORT."""
import os, shutil, subprocess, sys

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FICHIER = os.path.join(RACINE, "sql", "partenaires_identifiant_stable.sql")
D = "/var/lib/postgresql/chf-test-partenaires-id"
B = os.environ.get("PG_BIN", "/usr/lib/postgresql/16/bin")
PORT = os.environ.get("PG_PORT", "54337")
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
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;  -- rôles que Supabase fournit déjà
CREATE TABLE ong_partenaires (id text PRIMARY KEY, nom text NOT NULL, supprime_le timestamptz);
CREATE TABLE episodes  (id serial PRIMARY KEY, ong_partenaire text, statut text DEFAULT 'ouvert');
CREATE TABLE paiements (id serial PRIMARY KEY, ong_partenaire text, montant numeric DEFAULT 0);
INSERT INTO ong_partenaires VALUES ('p-avsi', 'AVSI', NULL), ('p-msf', 'MSF', NULL), ('p-dup1', 'Doublon', NULL), ('p-dup2', ' doublon ', NULL), ('p-vieux', 'Ancien', now());
INSERT INTO episodes (ong_partenaire) VALUES ('AVSI'), ('avsi '), ('MSF'), ('Inconnu'), ('Doublon'), ('Ancien'), (NULL), ('');
INSERT INTO paiements (ong_partenaire, montant) VALUES ('AVSI', 100), ('MSF', 50), ('Inconnu', 10);
"""

demarrer()
try:
    pg("CREATE DATABASE chf", db="postgres")
    pg(SCHEMA)
    avant = pg("SELECT id, ong_partenaire, statut FROM episodes ORDER BY id") + pg("SELECT id, ong_partenaire, montant FROM paiements ORDER BY id")

    sortie = pg("", fichier=FICHIER)
    verifier("ERROR" not in sortie and "ERREUR" not in sortie, "le script s'applique sans erreur : " + sortie[:200].replace("\n", " | "))
    sortie2 = pg("", fichier=FICHIER)
    verifier("ERROR" not in sortie2 and "ERREUR" not in sortie2, "…et se rejoue sans erreur")
    apres = pg("SELECT id, ong_partenaire, statut FROM episodes ORDER BY id") + pg("SELECT id, ong_partenaire, montant FROM paiements ORDER BY id")
    verifier(avant == apres, "aucune donnée existante n'est modifiée ni supprimée (noms, statuts, montants identiques)")

    ids = pg("SELECT string_agg(coalesce(ong_partenaire_id, '∅'), ',' ORDER BY id) FROM episodes")
    verifier(ids == "p-avsi,p-avsi,p-msf,∅,∅,∅,∅,∅", f"historique des épisodes rattaché (nom identique, majuscules/espaces ignorés ; inconnu, ambigu, supprimé, vide → vide) : {ids}")
    ids = pg("SELECT string_agg(coalesce(ong_partenaire_id, '∅'), ',' ORDER BY id) FROM paiements")
    verifier(ids == "p-avsi,p-msf,∅", f"historique des paiements rattaché : {ids}")

    pg("INSERT INTO episodes (ong_partenaire) VALUES ('MSF')")
    verifier(pg("SELECT ong_partenaire_id FROM episodes ORDER BY id DESC LIMIT 1") == "p-msf", "un épisode NEUF est rattaché tout seul")
    pg("INSERT INTO paiements (ong_partenaire, montant) VALUES ('avsi', 5)")
    verifier(pg("SELECT ong_partenaire_id FROM paiements ORDER BY id DESC LIMIT 1") == "p-avsi", "un paiement NEUF est rattaché tout seul (majuscules ignorées)")
    pg("UPDATE episodes SET ong_partenaire = 'AVSI' WHERE id = (SELECT max(id) FROM episodes)")
    verifier(pg("SELECT ong_partenaire_id FROM episodes ORDER BY id DESC LIMIT 1") == "p-avsi", "changer le nom d'un épisode fait suivre l'identifiant")
    pg("UPDATE episodes SET ong_partenaire = NULL WHERE id = (SELECT max(id) FROM episodes)")
    verifier(pg("SELECT coalesce(ong_partenaire_id, '∅') FROM episodes ORDER BY id DESC LIMIT 1") == "∅", "vider le nom efface l'identifiant")
    pg("UPDATE episodes SET statut = 'ferme' WHERE ong_partenaire = 'AVSI'")
    verifier(pg("SELECT count(*) FROM episodes WHERE ong_partenaire_id = 'p-avsi'") == "2", "modifier une autre colonne ne change pas l'identifiant")

    r = pg("SELECT public.renommer_partenaire('p-avsi', 'Avsi Haïti')")
    verifier('"episodes": 2' in r.replace('"episodes":', '"episodes": ').replace('  ', ' ') or '"episodes": 2' in r, f"renommer_partenaire renvoie le nombre d'épisodes suivis : {r}")
    verifier(pg("SELECT nom FROM ong_partenaires WHERE id = 'p-avsi'") == "Avsi Haïti", "le nom du partenaire est changé")
    verifier(pg("SELECT string_agg(DISTINCT ong_partenaire, ',') FROM episodes WHERE ong_partenaire_id = 'p-avsi'") == "Avsi Haïti", "TOUS ses épisodes portent le nouveau nom : l'historique n'est pas coupé")
    verifier(pg("SELECT string_agg(DISTINCT ong_partenaire, ',') FROM paiements WHERE ong_partenaire_id = 'p-avsi'") == "Avsi Haïti", "…et tous ses paiements")
    verifier(pg("SELECT string_agg(DISTINCT ong_partenaire, ',') FROM episodes WHERE ong_partenaire_id = 'p-msf'") == "MSF", "les autres partenaires ne bougent pas")
    verifier(pg("SELECT count(*) FROM episodes WHERE ong_partenaire = 'Inconnu'") == "1", "un épisode sans identifiant garde son nom tel quel")

    verifier("CHF20" in pg("SELECT public.renommer_partenaire('p-msf', '  ')") or "vide" in pg("SELECT public.renommer_partenaire('p-msf', '  ')"), "refus d'un nouveau nom vide")
    verifier("introuvable" in pg("SELECT public.renommer_partenaire('p-inexistant', 'X')"), "refus d'un partenaire inconnu")
    verifier("introuvable" in pg("SELECT public.renommer_partenaire('p-vieux', 'X')"), "refus d'un partenaire supprimé")
    verifier("déjà ce nom" in pg("SELECT public.renommer_partenaire('p-msf', 'avsi haïti')"), "refus d'un nom déjà pris par un autre partenaire (majuscules ignorées)")
    verifier(pg("SELECT nom FROM ong_partenaires WHERE id = 'p-msf'") == "MSF", "un refus ne change rien")
    verifier(pg("SELECT public.renommer_partenaire('p-msf', 'MSF')").count("episodes") == 1, "renommer en gardant le même nom reste permis")
    droits = pg("SELECT has_function_privilege('anon', 'public.renommer_partenaire(text,text)', 'execute'), has_function_privilege('authenticated', 'public.renommer_partenaire(text,text)', 'execute'), has_function_privilege('service_role', 'public.renommer_partenaire(text,text)', 'execute')")
    verifier(droits == "f|f|t", f"seul le serveur (service_role) peut renommer : {droits}")
finally:
    arreter()

print()
if ECHECS:
    print(f"{len(ECHECS)} ÉCHEC(S)"); sys.exit(1)
print("Tous les contrôles passent.")
