#!/usr/bin/env python3
"""scripts/test-naissance-fusion-sql.py — teste sql/dossiers_naissance_fusion.sql et sql/etat_systeme.sql sur un Postgres JETABLE (jamais sur la vraie base).

Ce qui est vérifié :
  - les deux scripts passent (instruction par instruction ET en une transaction) et se rejouent sans erreur ;
  - naissance : mere_dossier_id (pas soi-même, SET NULL si la mère disparaît), anciens_noms ;
  - fusion : épisodes, pièces jointes et enfants passent à la cible, les trous de la cible sont comblés (sans écraser ses valeurs),
    la source reste en base mais cachée de la recherche, ses noms restent retrouvables par la cible ; refus (soi-même, déjà fusionné,
    cible fusionnée, cycle mère/enfant) ; ANNULATION qui remet tout, y compris quand la cible a changé un champ entre-temps ;
  - recherche floue : ne renvoie jamais un dossier fusionné ; retrouve un dossier par un ancien nom ;
  - doublons_ignores : paire ordonnée ;
  - état du système : une erreur répétée = une ligne avec compteur, postes distincts, statut « résolu » qui repasse à « nouveau » ;
    nettoyage ; tables en RLS sans policy ; fonctions non appelables par anon/authenticated.

    python3 scripts/test-naissance-fusion-sql.py

Prérequis : binaires PostgreSQL (PG_BIN, défaut /usr/lib/postgresql/16/bin), exécution en root. Variables : PG_BIN, PG_PORT."""
import os, shutil, subprocess, sys

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FICHIERS = [os.path.join(RACINE, "sql", "dossiers_naissance_fusion.sql"), os.path.join(RACINE, "sql", "etat_systeme.sql")]
D = "/var/lib/postgresql/chf-test-naissance-fusion"
B = os.environ.get("PG_BIN", "/usr/lib/postgresql/16/bin")
PORT = os.environ.get("PG_PORT", "54337")
PSQL = ["psql", "-h", "/tmp", "-p", PORT, "-U", "postgres", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=0"]
ECHECS = []
U = lambda n: f"00000000-0000-0000-0000-{n:012d}"
MERE, BEBE, DOUBLON, AUTRE, ENFANT2 = U(1), U(2), U(3), U(4), U(5)

def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)

def pg(sql, db="chf", fichier=None, unique=False, role=None):
    cmd = PSQL + ["-d", db] + (["-1"] if unique else [])
    if role: sql = f"SET ROLE {role}; " + (sql or "")
    cmd += ["-f", fichier] if fichier else ["-c", sql]
    r = sh(cmd)
    return (r.stdout + r.stderr).strip()

def sqlstate(appel):
    """Exécute `appel` (une expression SELECT) et renvoie le SQLSTATE de l'erreur levée, ou 'OK' — c'est CE code que le serveur lit."""
    corps = appel.replace("SELECT ", "PERFORM ", 1)
    sortie = pg(f"DO $$ BEGIN {corps}; RAISE NOTICE 'OK'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE '%', SQLSTATE; END $$")
    return sortie.replace("NOTICE:", "").strip().splitlines()[-1].strip() if sortie else "?"

def verifier(condition, message):
    print(("  ok   " if condition else "  ÉCHEC ") + message)
    if not condition:
        ECHECS.append(message)

def demarrer():
    shutil.rmtree(D, ignore_errors=True)
    os.makedirs(D); shutil.chown(D, "postgres", "postgres")
    sh(["su", "postgres", "-c", f"{B}/initdb -D {D}/data -A trust -E UTF8 >/dev/null"])
    sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -o '-p {PORT} -k /tmp -c max_connections=50' -l {D}/log.txt -w start >/dev/null"])

def arreter():
    sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -m fast stop >/dev/null"])
    shutil.rmtree(D, ignore_errors=True)

# Forme des vraies tables (colonnes relevées sur la base de production le 14/10) + les rôles de Supabase.
SCHEMA = """
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE dossiers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, numero_dossier text NOT NULL UNIQUE, nom text NOT NULL,
  date_naissance date, telephone text, adresse text, date_creation timestamptz NOT NULL DEFAULT now(), local_id text UNIQUE,
  poids numeric, conjoint text, sexe text, nom_origine text, modifie_le timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE episodes (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, dossier_id uuid NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  statut text NOT NULL DEFAULT 'ouvert', supprime_le timestamptz);
CREATE TABLE pieces_jointes (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, dossier_id uuid NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  storage_path text NOT NULL DEFAULT 'x', nom_original text NOT NULL DEFAULT 'x.pdf');
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
"""

def base_neuve():
    pg("DROP DATABASE IF EXISTS chf", db="postgres")
    pg("CREATE DATABASE chf", db="postgres")
    pg(SCHEMA)

def donnees():
    pg(f"""INSERT INTO dossiers (id, numero_dossier, nom, nom_origine, date_naissance, telephone, sexe) VALUES
      ('{MERE}', 'N-1', 'Marie Joseph', 'Marie Joseph', '1995-03-02', '34567890', 'F'),
      ('{DOUBLON}', 'N-3', 'Marie Josef', 'Marie Josef', NULL, '34567890', NULL),
      ('{AUTRE}', 'N-4', 'Paul Louis', 'Paul Louis', '1980-01-01', NULL, 'M');
      INSERT INTO dossiers (id, numero_dossier, nom, nom_origine, mere_dossier_id, sexe) VALUES ('{BEBE}', 'N-2', 'Bébé Marie Joseph', 'Bébé Marie Joseph', '{MERE}', 'M');
      INSERT INTO episodes (id, dossier_id, statut) VALUES ('{U(11)}', '{MERE}', 'ouvert'), ('{U(12)}', '{DOUBLON}', 'ouvert'), ('{U(13)}', '{DOUBLON}', 'ferme');
      INSERT INTO pieces_jointes (id, dossier_id) VALUES ('{U(21)}', '{DOUBLON}');""")

def scenario(unique):
    mode = "une seule transaction" if unique else "instruction par instruction"
    print(f"\n== Application ({mode}), puis rejeu ==")
    base_neuve()
    for f in FICHIERS:
        nom = os.path.basename(f)
        s1 = pg(None, fichier=f, unique=unique)
        verifier("ERROR" not in s1 and "ERREUR" not in s1, f"{nom} passe sans erreur ({s1[:200]!r})")
        s2 = pg(None, fichier=f, unique=unique)
        verifier("ERROR" not in s2 and "ERREUR" not in s2, f"{nom} se rejoue sans erreur ({s2[:200]!r})")
    verifier(pg("SELECT count(*) FROM pg_proc WHERE proname IN ('fusionner_dossiers','defusionner_dossiers','signaler_erreur_client','nettoyer_etat_systeme','rechercher_dossiers_flou')") == "5", "une seule version de chaque fonction après rejeu")

def tests():
    base_neuve()
    for f in FICHIERS: pg(None, fichier=f)
    donnees()

    print("\n-- naissance")
    verifier(pg(f"SELECT mere_dossier_id = '{MERE}' FROM dossiers WHERE id='{BEBE}'") == "t", "le bébé est lié à sa mère")
    verifier("dossiers_mere_pas_soi" in pg(f"UPDATE dossiers SET mere_dossier_id = id WHERE id='{BEBE}'"), "un dossier ne peut pas être sa propre mère")
    verifier(pg("SELECT anciens_noms FROM dossiers WHERE numero_dossier='N-1'") == "[]", "anciens_noms vide par défaut")

    print("\n-- recherche floue")
    verifier("Bébé Marie Joseph" in pg("SELECT string_agg(nom, '|') FROM rechercher_dossiers_flou('Bébé Marie')"), "la recherche retrouve le bébé")
    pg(f"UPDATE dossiers SET nom='Marie Louise Joseph', anciens_noms = anciens_noms || '[{{\"nom\":\"Bébé Marie Joseph\",\"origine\":\"renommage\"}}]'::jsonb WHERE id='{BEBE}'")
    verifier("Marie Louise Joseph" in pg("SELECT string_agg(nom, '|') FROM rechercher_dossiers_flou('Bébé Marie Joseph')"), "un dossier renommé reste retrouvable par son ancien nom")

    print("\n-- fusion")
    r = pg(f"SELECT fusionner_dossiers('{DOUBLON}', '{MERE}', 'Esdras')")
    verifier('"episodes_deplaces": 2' in r and '"pieces_deplacees": 1' in r, f"2 épisodes et 1 pièce déplacés ({r[:160]})")
    verifier(pg(f"SELECT count(*) FROM episodes WHERE dossier_id='{MERE}'") == "3", "la cible a maintenant 3 épisodes")
    verifier(pg(f"SELECT count(*) FROM episodes WHERE dossier_id='{DOUBLON}'") == "0", "la source n'en a plus")
    verifier(pg(f"SELECT fusionne_dans = '{MERE}' AND fusionne_par = 'Esdras' AND fusionne_le IS NOT NULL FROM dossiers WHERE id='{DOUBLON}'") == "t", "la source est marquée fusionnée (et reste en base)")
    verifier(pg(f"SELECT telephone = '34567890' AND date_naissance = '1995-03-02' AND sexe = 'F' FROM dossiers WHERE id='{MERE}'") == "t", "la cible garde ses propres valeurs")
    verifier("Marie Josef" not in pg("SELECT string_agg(nom, '|') FROM rechercher_dossiers_flou('Marie Josef')").split("|")[0:0] and
             pg("SELECT count(*) FROM rechercher_dossiers_flou('Marie Josef') WHERE id='%s'" % DOUBLON) == "0", "la recherche ne renvoie plus le dossier fusionné")
    verifier(pg("SELECT count(*) FROM rechercher_dossiers_flou('Marie Josef') WHERE id='%s'" % MERE) == "1", "mais retrouve la cible par l'ancien nom de la source")
    verifier(pg(f"SELECT anciens_noms->0->>'origine' FROM dossiers WHERE id='{MERE}'") == "fusion", "l'ancien nom est gardé sur la cible")
    for sql, code, texte in [
        (f"SELECT fusionner_dossiers('{MERE}', '{MERE}', 'x')", "CHF12", "soi-même"),
        (f"SELECT fusionner_dossiers('{DOUBLON}', '{AUTRE}', 'x')", "CHF13", "source déjà fusionnée"),
        (f"SELECT fusionner_dossiers('{AUTRE}', '{DOUBLON}', 'x')", "CHF14", "cible déjà fusionnée"),
        (f"SELECT fusionner_dossiers('{MERE}', '{BEBE}', 'x')", "CHF15", "cible = enfant de la source"),
        (f"SELECT fusionner_dossiers('{U(99)}', '{MERE}', 'x')", "CHF11", "dossier introuvable"),
    ]:
        etat = sqlstate(sql)
        verifier(etat == code, f"refus {code} ({texte}) : SQLSTATE reçu {etat}")

    print("\n-- annulation d'une fusion (avec un champ changé entre-temps)")
    pg(f"UPDATE dossiers SET telephone = '99999999' WHERE id='{MERE}'")
    r = pg(f"SELECT defusionner_dossiers('{DOUBLON}', 'Esdras')")
    verifier('"episodes_remis": 2' in r and '"pieces_remises": 1' in r, f"2 épisodes et 1 pièce remis ({r[:160]})")
    verifier(pg(f"SELECT count(*) FROM episodes WHERE dossier_id='{DOUBLON}'") == "2" and pg(f"SELECT count(*) FROM episodes WHERE dossier_id='{MERE}'") == "1", "chaque dossier retrouve ses épisodes")
    verifier(pg(f"SELECT fusionne_dans IS NULL AND fusion_details IS NULL FROM dossiers WHERE id='{DOUBLON}'") == "t", "la source n'est plus fusionnée")
    verifier(pg(f"SELECT anciens_noms = '[]'::jsonb FROM dossiers WHERE id='{MERE}'") == "t", "l'ancien nom ajouté par la fusion est retiré de la cible")
    verifier(pg(f"SELECT telephone FROM dossiers WHERE id='{MERE}'") == "99999999", "un champ modifié entre-temps n'est pas écrasé")
    verifier(pg("SELECT count(*) FROM rechercher_dossiers_flou('Marie Josef') WHERE id='%s'" % DOUBLON) == "1", "la source redevient retrouvable")
    etat = sqlstate(f"SELECT defusionner_dossiers('{DOUBLON}', 'x')")
    verifier(etat == "CHF16", f"annuler une fusion qui n'existe pas est refusé (CHF16) : SQLSTATE reçu {etat}")

    print("\n-- champs comblés par la fusion, puis annulés")
    pg(f"UPDATE dossiers SET telephone='55555555', date_naissance='1990-01-01', sexe='F', adresse='Rue 5' WHERE id='{DOUBLON}'")
    pg(f"UPDATE dossiers SET telephone=NULL, date_naissance=NULL, sexe=NULL, adresse=NULL WHERE id='{AUTRE}'")
    r = pg(f"SELECT fusionner_dossiers('{DOUBLON}', '{AUTRE}', 'Esdras')")
    verifier(pg(f"SELECT telephone='55555555' AND date_naissance='1990-01-01' AND sexe='F' AND adresse='Rue 5' FROM dossiers WHERE id='{AUTRE}'") == "t", "les trous de la cible sont comblés par la source")
    pg(f"SELECT defusionner_dossiers('{DOUBLON}', 'Esdras')")
    verifier(pg(f"SELECT telephone IS NULL AND date_naissance IS NULL AND sexe IS NULL AND adresse IS NULL FROM dossiers WHERE id='{AUTRE}'") == "t", "l'annulation vide à nouveau ce qui avait été comblé")

    print("\n-- enfants rattachés puis remis")
    pg(f"INSERT INTO dossiers (id, numero_dossier, nom, mere_dossier_id) VALUES ('{ENFANT2}', 'N-5', 'Bébé Paul', '{DOUBLON}')")
    pg(f"SELECT fusionner_dossiers('{DOUBLON}', '{AUTRE}', 'x')")
    verifier(pg(f"SELECT mere_dossier_id = '{AUTRE}' FROM dossiers WHERE id='{ENFANT2}'") == "t", "l'enfant de la source est rattaché à la cible")
    pg(f"SELECT defusionner_dossiers('{DOUBLON}', 'x')")
    verifier(pg(f"SELECT mere_dossier_id = '{DOUBLON}' FROM dossiers WHERE id='{ENFANT2}'") == "t", "l'annulation le remet à sa mère d'origine")
    pg(f"DELETE FROM dossiers WHERE id='{MERE}'")
    verifier(pg(f"SELECT mere_dossier_id IS NULL FROM dossiers WHERE id='{BEBE}'") == "t", "si la mère disparaît, le bébé garde son dossier (lien remis à vide)")

    print("\n-- doublons ignorés")
    verifier("ERROR" not in pg(f"INSERT INTO doublons_ignores (dossier_a, dossier_b) VALUES ('{U(3)}', '{U(4)}')"), "une paire ordonnée est acceptée")
    verifier("check" in pg(f"INSERT INTO doublons_ignores (dossier_a, dossier_b) VALUES ('{U(4)}', '{U(3)}')").lower(), "la paire inverse est refusée (toujours dans le même ordre)")

    print("\n-- erreurs des postes")
    for i in range(3):
        pg("SELECT signaler_erreur_client('abc123', 'TypeError: x is undefined', 'pile', 'js', 'calcul', 'v1', 'poste-" + str(i % 2) + "', 'Marie')")
    ligne = pg("SELECT nombre || '|' || array_length(postes,1) || '|' || array_length(utilisateurs,1) || '|' || statut FROM erreurs_client WHERE empreinte='abc123'")
    verifier(ligne == "3|2|1|nouveau", f"3 occurrences = 1 ligne, 2 postes, 1 utilisateur ({ligne})")
    pg("UPDATE erreurs_client SET statut='resolu', traite_par='Esdras', traite_le=now() WHERE empreinte='abc123'")
    pg("SELECT signaler_erreur_client('abc123', 'TypeError: x is undefined', 'pile', 'js', 'calcul', 'v2', 'poste-9', 'Jean')")
    ligne = pg("SELECT statut || '|' || coalesce(traite_par,'-') || '|' || version_app FROM erreurs_client WHERE empreinte='abc123'")
    verifier(ligne == "nouveau|-|v2", f"une erreur résolue qui REVIENT repasse à « nouveau » ({ligne})")
    verifier("check" in pg("SELECT signaler_erreur_client('zzz', 'm', 'p', 'inconnue', NULL, NULL, NULL, NULL)").lower(), "une source inconnue est refusée")
    pg("SELECT signaler_erreur_client('long', repeat('m', 2000), repeat('p', 9000), 'js', NULL, NULL, NULL, NULL, 500)")
    ligne = pg("SELECT length(message) || '|' || length(pile) || '|' || nombre FROM erreurs_client WHERE empreinte='long'")
    verifier(ligne == "500|4000|50", f"message, pile et compteur sont plafonnés ({ligne})")

    print("\n-- postes et ménage")
    pg("INSERT INTO postes_etat (poste_id, utilisateur, vu_le) VALUES ('poste-recent-1', 'A', now()), ('poste-vieux-001', 'B', now() - interval '100 days')")
    pg("UPDATE erreurs_client SET statut='resolu', derniere_le = now() - interval '100 days' WHERE empreinte='long'")
    verifier(pg("SELECT nettoyer_etat_systeme()") == "2", "le ménage retire 1 erreur résolue ancienne + 1 poste jamais revu")
    verifier(pg("SELECT count(*) FROM postes_etat") == "1" and pg("SELECT count(*) FROM erreurs_client") == "1", "et garde le reste")
    verifier("check" in pg("INSERT INTO postes_etat (poste_id) VALUES ('court')").lower(), "un identifiant de poste trop court est refusé")

    print("\n-- sécurité : RLS sans policy et fonctions réservées au serveur")
    for t in ("postes_etat", "erreurs_client", "doublons_ignores"):
        verifier(pg(f"SELECT relrowsecurity FROM pg_class WHERE relname='{t}'") == "t" and pg(f"SELECT count(*) FROM pg_policy WHERE polrelid='{t}'::regclass") == "0", f"{t} : RLS activée, aucune policy")
    for fn in ("fusionner_dossiers(uuid,uuid,text)", "defusionner_dossiers(uuid,text)", "nettoyer_etat_systeme()"):
        verifier("permission denied" in pg(f"SELECT 1 FROM {fn.split('(')[0]}", role="anon") or "permission denied" in pg(f"SELECT has_function_privilege('anon', '{fn}', 'execute')", role=None) or pg(f"SELECT has_function_privilege('anon', '{fn}', 'execute')") == "f", f"anon ne peut pas exécuter {fn}")
        verifier(pg(f"SELECT has_function_privilege('authenticated', '{fn}', 'execute')") == "f", f"authenticated non plus ({fn})")
        verifier(pg(f"SELECT has_function_privilege('service_role', '{fn}', 'execute')") == "t", f"mais le serveur (service_role) le peut ({fn})")

if __name__ == "__main__":
    if os.geteuid() != 0:
        print("À lancer en root."); sys.exit(2)
    demarrer()
    try:
        scenario(False)
        scenario(True)
        print("\n== Comportement ==")
        tests()
    finally:
        arreter()
    print()
    if ECHECS:
        print(f"{len(ECHECS)} ÉCHEC(S) :"); [print(" -", e) for e in ECHECS]; sys.exit(1)
    print("Tout est vert.")
