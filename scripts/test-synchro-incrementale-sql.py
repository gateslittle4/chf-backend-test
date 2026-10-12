#!/usr/bin/env python3
"""scripts/test-synchro-incrementale-sql.py — teste sql/synchro_incrementale.sql sur un Postgres 16 JETABLE (jamais sur
la vraie base) : colonne modifie_le posée et mise à jour par la base (jamais par l'app), trace des suppressions
définitives (avec l'épisode à rafraîchir pour une fiche ou un paiement), droits (rien pour anon / authenticated,
lecture et ménage pour service_role), rejeu du script, et les deux modes d'exécution (instruction par instruction /
une seule transaction, comme l'éditeur SQL de Supabase).

    python3 scripts/test-synchro-incrementale-sql.py
    DROITS_PAR_DEFAUT=0 python3 scripts/test-synchro-incrementale-sql.py   # cluster SANS les droits par défaut de Supabase

Prérequis : binaires PostgreSQL 16 (PG_BIN, défaut /usr/lib/postgresql/16/bin), exécution en root (le serveur jetable
tourne sous l'utilisateur système « postgres », dossier supprimé à la fin). Variables : SQL_A_TESTER, PG_BIN, PG_PORT.
"""
import os, shutil, subprocess, sys, time

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FICHIER = os.environ.get("SQL_A_TESTER", os.path.join(RACINE, "sql", "synchro_incrementale.sql"))
D = "/var/lib/postgresql/chf-test-synchro-incrementale"
B = os.environ.get("PG_BIN", "/usr/lib/postgresql/16/bin")
PORT = os.environ.get("PG_PORT", "54333")
PSQL = ["psql", "-h", "/tmp", "-p", PORT, "-U", "postgres", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=0"]
ECHECS = []

def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)

def pg(sql, db="chf", fichier=None, unique=False, role=None):
    cmd = PSQL + ["-d", db] + (["-1"] if unique else [])
    cmd += ["-f", fichier] if fichier else ["-c", (f"SET ROLE {role}; " if role else "") + sql]
    r = sh(cmd)
    return (r.stdout + r.stderr).strip()

def verifier(condition, message):
    print(("  ok   " if condition else "  ÉCHEC ") + message)
    if not condition:
        ECHECS.append(message)

SCHEMA = """
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE dossiers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nom text NOT NULL, numero_dossier text UNIQUE);
CREATE TABLE episodes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dossier_id uuid REFERENCES dossiers(id),
  statut text DEFAULT 'ouvert', date_ouverture timestamptz DEFAULT now(), supprime_le timestamptz);
CREATE TABLE fiches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), episode_id uuid REFERENCES episodes(id) ON DELETE CASCADE,
  total_global numeric DEFAULT 0, supprime_le timestamptz);
CREATE TABLE paiements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), episode_id uuid REFERENCES episodes(id) ON DELETE CASCADE,
  fiche_id uuid, montant numeric DEFAULT 0, annule boolean DEFAULT false, supprime_le timestamptz);
ALTER TABLE dossiers ENABLE ROW LEVEL SECURITY; ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiches ENABLE ROW LEVEL SECURITY; ALTER TABLE paiements ENABLE ROW LEVEL SECURITY;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
"""

def demarrer():
    shutil.rmtree(D, ignore_errors=True)
    os.makedirs(D); shutil.chown(D, "postgres", "postgres")
    sh(["su", "postgres", "-c", f"{B}/initdb -D {D}/data -A trust -E UTF8 >/dev/null"])
    sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -o '-p {PORT} -k /tmp' -l {D}/log.txt -w start >/dev/null"])

def base_neuve():
    pg("DROP DATABASE IF EXISTS chf", db="postgres")
    pg("CREATE DATABASE chf", db="postgres")
    pg("DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;"
       "DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;"
       "DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;")
    pg("GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;")
    if os.environ.get("DROITS_PAR_DEFAUT", "1") == "1":
        # Droits par défaut de Supabase sur ce que l'on crée dans public.
        pg("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;"
           "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;"
           "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;")
    pg(SCHEMA)
    # Données d'AVANT le script : elles doivent recevoir une date à l'application.
    pg("INSERT INTO dossiers (id, nom, numero_dossier) VALUES ('00000000-0000-0000-0000-0000000000d1', 'Ancien', 'A-1');"
       "INSERT INTO episodes (id, dossier_id) VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1');"
       "INSERT INTO fiches (id, episode_id) VALUES ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1');"
       "INSERT INTO paiements (id, episode_id) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1');")

def scenario(unique):
    mode = "une seule transaction" if unique else "instruction par instruction"
    print(f"\n== Application ({mode}), puis rejeu ==")
    base_neuve()
    sortie = pg(None, fichier=FICHIER, unique=unique)
    verifier("ERROR" not in sortie and "ERREUR" not in sortie, f"le script passe sans erreur ({sortie[:200]!r})")
    sortie2 = pg(None, fichier=FICHIER, unique=unique)
    verifier("ERROR" not in sortie2 and "ERREUR" not in sortie2, f"rejouer le script passe aussi ({sortie2[:200]!r})")

    for t in ["episodes", "dossiers", "fiches", "paiements"]:
        verifier(pg(f"SELECT count(*) FROM {t} WHERE modifie_le IS NULL") == "0", f"{t} : aucune ligne existante sans modifie_le")
        verifier(pg(f"SELECT is_nullable FROM information_schema.columns WHERE table_name='{t}' AND column_name='modifie_le'") == "NO",
                 f"{t}.modifie_le NOT NULL")
        verifier(pg(f"SELECT count(*) FROM pg_indexes WHERE tablename='{t}' AND indexname='idx_{t}_modifie_le'") == "1", f"index sur {t}.modifie_le")
    verifier(pg("SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_%_modifie_le' AND NOT tgisinternal") == "4", "4 déclencheurs modifie_le (pas de doublon après rejeu)")
    verifier(pg("SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_%_efface' AND NOT tgisinternal") == "3", "3 déclencheurs de trace (pas de doublon après rejeu)")

    print("-- modifie_le tenu par la BASE")
    pg("INSERT INTO dossiers (id, nom, numero_dossier, modifie_le) VALUES ('00000000-0000-0000-0000-0000000000d2', 'Neuf', 'N-1', '2001-01-01')", role="service_role")
    verifier(pg("SELECT modifie_le > now() - interval '1 minute' FROM dossiers WHERE numero_dossier='N-1'") == "t",
             "une valeur ancienne envoyée à la création est remplacée par l'heure de la base")
    avant = pg("SELECT modifie_le FROM episodes WHERE id='00000000-0000-0000-0000-0000000000e1'")
    time.sleep(0.05)
    pg("UPDATE episodes SET statut='ferme' WHERE id='00000000-0000-0000-0000-0000000000e1'", role="service_role")
    verifier(pg(f"SELECT modifie_le > '{avant}'::timestamptz FROM episodes WHERE id='00000000-0000-0000-0000-0000000000e1'") == "t",
             "une modification avance modifie_le")
    time.sleep(0.05)
    avant_p = pg("SELECT modifie_le FROM paiements WHERE id='00000000-0000-0000-0000-0000000000a1'")
    pg("UPDATE paiements SET annule=true, modifie_le='2001-01-01' WHERE id='00000000-0000-0000-0000-0000000000a1'", role="service_role")
    verifier(pg(f"SELECT modifie_le > '{avant_p}'::timestamptz FROM paiements WHERE id='00000000-0000-0000-0000-0000000000a1'") == "t",
             "une annulation de paiement avance modifie_le, même si une vieille date est envoyée")

    print("-- trace des suppressions définitives")
    pg("DELETE FROM fiches WHERE id='00000000-0000-0000-0000-0000000000f1'", role="service_role")
    verifier(pg("SELECT table_nom || ',' || episode_id FROM lignes_effacees WHERE ligne_id='00000000-0000-0000-0000-0000000000f1'")
             == "fiches,00000000-0000-0000-0000-0000000000e1", "fiche effacée : trace avec son épisode")
    pg("DELETE FROM episodes WHERE id='00000000-0000-0000-0000-0000000000e1'", role="service_role")
    verifier(pg("SELECT count(*) FROM lignes_effacees WHERE table_nom='episodes' AND ligne_id='00000000-0000-0000-0000-0000000000e1' AND episode_id IS NULL") == "1",
             "épisode effacé : trace (sans episode_id)")
    verifier(pg("SELECT count(*) FROM lignes_effacees WHERE table_nom='paiements' AND ligne_id='00000000-0000-0000-0000-0000000000a1'") == "1",
             "paiement effacé en cascade avec son épisode : trace aussi")

    print("-- droits")
    for role in ["anon", "authenticated"]:
        r = pg("SELECT count(*) FROM public.lignes_effacees", role=role)
        verifier("denied" in r or "refus" in r or r == "0", f"{role} ne lit pas lignes_effacees ({r[:80]!r})")
        for f in ["marquer_modifie_le", "noter_ligne_effacee"]:
            verifier(pg(f"SELECT has_function_privilege('{role}', 'public.{f}()', 'EXECUTE')") == "f", f"{role} ne peut pas appeler {f}()")
    verifier(pg("SELECT count(*) > 0 FROM public.lignes_effacees", role="service_role") == "t", "service_role lit lignes_effacees")
    verifier("ERROR" not in pg("DELETE FROM public.lignes_effacees WHERE efface_le < now() - interval '2 days'", role="service_role"),
             "service_role peut faire le ménage de lignes_effacees")
    verifier(pg("SELECT relrowsecurity FROM pg_class WHERE relname='lignes_effacees'") == "t", "RLS activée sur lignes_effacees")

def main():
    if os.geteuid() != 0:
        sys.exit("À lancer en root (serveur Postgres jetable sous l'utilisateur système postgres).")
    demarrer()
    try:
        scenario(unique=False)
        scenario(unique=True)
    finally:
        sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -m fast -w stop >/dev/null"])
        shutil.rmtree(D, ignore_errors=True)
    print(f"\n{'TOUT EST BON' if not ECHECS else str(len(ECHECS)) + ' ÉCHEC(S)'}")
    sys.exit(1 if ECHECS else 0)

main()
