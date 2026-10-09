#!/usr/bin/env python3
"""scripts/test-roles-personnalises-sql.py — teste sql/roles_personnalises.sql sur un Postgres 16 JETABLE (jamais sur la
vraie base) : scénarios, garde-fou roles_personnalises_actifs() (existence, valeur, droits des rôles anon /
authenticated / service_role), échec atomique dans les deux modes d'exécution (instruction par instruction / une seule
transaction, comme l'éditeur SQL de Supabase), rejeu, ancien script ajoute_role_*.sql recollé après coup, et accord exact
avec CLE_ROLE (utils/roles.js) sur 2 000 exemples aléatoires.

À relancer à chaque modification de sql/roles_personnalises.sql ou de CLE_ROLE / LONGUEUR_CLE (utils/roles.js) :
    python3 scripts/test-roles-personnalises-sql.py
    DROITS_PAR_DEFAUT=0 python3 scripts/test-roles-personnalises-sql.py   # cluster SANS les droits par défaut de Supabase

Prérequis : binaires PostgreSQL 16 dans /usr/lib/postgresql/16/bin (variable PG_BIN), exécution en root (le serveur
jetable tourne sous l'utilisateur système « postgres » dans /var/lib/postgresql, supprimé à la fin), et node.
Variables : SQL_A_TESTER (autre fichier SQL, pour vérifier qu'une variante cassée est bien détectée), PG_BIN, PG_PORT.
"""
import json, os, random, re, shutil, subprocess, sys

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FICHIER = os.environ.get("SQL_A_TESTER", os.path.join(RACINE, "sql", "roles_personnalises.sql"))
ANCIEN = os.path.join(RACINE, "sql", "ajoute_role_pharmacien_chef.sql")
ROLES_JS = os.path.join(RACINE, "utils", "roles.js")
D = "/var/lib/postgresql/chf-test-roles-personnalises"
B = os.environ.get("PG_BIN", "/usr/lib/postgresql/16/bin")
PORT = os.environ.get("PG_PORT", "54332")
PSQL = ["psql", "-h", "/tmp", "-p", PORT, "-U", "postgres", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=0"]

def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)

def pg(sql, db="chf", fichier=None, unique=False, role=None):
    cmd = PSQL + ["-d", db] + (["-1"] if unique else [])
    if fichier:
        cmd += ["-f", fichier]
    else:
        cmd += ["-c", (f"SET ROLE {role}; " if role else "") + sql]
    r = sh(cmd)
    return (r.stdout + r.stderr).strip()

def demarrer():
    shutil.rmtree(D, ignore_errors=True)
    os.makedirs(D); shutil.chown(D, "postgres", "postgres")
    sh(["su", "postgres", "-c", f"{B}/initdb -D {D}/data -A trust -E UTF8 >/dev/null"])
    sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -o '-p {PORT} -k /tmp' -l {D}/log.txt -w start >/dev/null"])
    pg("CREATE DATABASE chf", db="postgres")
    # Les rôles que Supabase fournit (cluster-level), et ses droits par défaut sur les fonctions de public.
    pg("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE pirate NOLOGIN;", db="chf")
    pg("GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, pirate;")
    # DROITS_PAR_DEFAUT=0 : cluster SANS les droits par défaut de Supabase (hypothèse la plus stricte : le GRANT du
    # script doit alors suffire à lui seul à laisser service_role appeler la fonction).
    if os.environ.get("DROITS_PAR_DEFAUT", "1") == "1":
        pg("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;")

def arreter():
    sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -m fast -w stop >/dev/null"])
    shutil.rmtree(D, ignore_errors=True)

LISTE10 = "'administrateur','direction','comptable','auditeur','lecteur','archiviste','infirmier','infirmier_chef','medecin','visiteur'"
LISTE12 = LISTE10 + ",'pharmacien','pharmacien_chef'"
ROLES12 = [r.strip("'") for r in LISTE12.split(",")]

def etat_depart(liste):
    pg("DROP FUNCTION IF EXISTS public.roles_personnalises_actifs();")
    pg(f"DROP TABLE IF EXISTS users; CREATE TABLE users (id text PRIMARY KEY, role text); "
       f"ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role = ANY (ARRAY[{liste}]::text[])); "
       f"INSERT INTO users VALUES ('u1','administrateur'),('u2','direction'),('u3','medecin'),('u4','infirmier');")

def accepte(role):
    sortie = pg("INSERT INTO users VALUES (gen_random_uuid()::text, $r$" + role + "$r$)")
    return "violates check constraint" not in sortie and "ERROR" not in sortie

def garde_fou(role=None):
    """Ce que verrait un appelant : 't', 'f', ou le texte de l'erreur."""
    return pg("SELECT public.roles_personnalises_actifs()", role=role)

ok_global = True
def verifie(libelle, condition, detail=""):
    global ok_global
    print(("  ✅ " if condition else "  ❌ ") + libelle + (f"  [{detail}]" if detail and not condition else ""))
    ok_global = ok_global and condition

texte_sql = open(FICHIER, encoding="utf-8").read()
etape1 = texte_sql[:texte_sql.index("-- 2)")]   # en-tête + fonction + droits, sans le changement de contrainte

demarrer()
try:
    for nom, liste in [("ancienne liste de 10 rôles (avant les scripts pharmacien)", LISTE10), ("ancienne liste de 12 rôles (après le script pharmacien en chef)", LISTE12)]:
        print(f"\n=== Départ : {nom}")
        etat_depart(liste)
        # --- Étape 1 seule : la fonction existe, répond « non » tant que la contrainte est l'ancienne liste fixe.
        open(D + "/etape1.sql", "w", encoding="utf-8").write(etape1)
        shutil.chown(D + "/etape1.sql", "postgres", "postgres")
        sortie = pg("", fichier=D + "/etape1.sql")
        verifie("étape 1 seule : s'exécute sans erreur", "ERROR" not in sortie, sortie)
        verifie("étape 1 seule : le garde-fou répond « non » (ancienne liste fixe)", garde_fou() == "f", garde_fou())
        verifie("étape 1 seule : un rôle créé est encore refusé par la base", not accepte("caissier_nuit"))
        # --- Script entier.
        sortie = pg("", fichier=FICHIER)
        verifie("le script entier s'exécute sans erreur", "ERROR" not in sortie, sortie)
        verifie("comptes d'origine intacts", pg("SELECT string_agg(role, ',' ORDER BY id) FROM users WHERE id IN ('u1','u2','u3','u4')") == "administrateur,direction,medecin,infirmier")
        etat = pg("SELECT count(*) FROM pg_constraint WHERE conname='users_role_check'")
        verifie("une seule contrainte users_role_check", etat == "1", etat)
        verifie("le garde-fou répond « oui » une fois la contrainte de format en place", garde_fou() == "t", garde_fou())
        verifie("le garde-fou lu comme le serveur (service_role) : « oui »", garde_fou(role="service_role") == "t", garde_fou(role="service_role"))
        for qui in ["anon", "authenticated", "pirate"]:
            sortie = garde_fou(role=qui)
            verifie(f"le garde-fou est INTERDIT à {qui}", "permission denied" in sortie, sortie)
        acl = pg("SELECT proacl::text FROM pg_proc WHERE proname='roles_personnalises_actifs'")
        verifie("droits enregistrés : uniquement le propriétaire et service_role (ni PUBLIC, ni anon, ni authenticated)",
                "service_role=X/" in acl and "anon" not in acl and "authenticated" not in acl and not re.search(r"(^|[{,])=X/", acl), acl)
        verifie("la fonction n'a pas de droits élevés (SECURITY INVOKER)", pg("SELECT prosecdef FROM pg_proc WHERE proname='roles_personnalises_actifs'") == "f")
        for r in ROLES12:
            verifie(f"rôle existant accepté : {r}", accepte(r))
        for r in ["caissier_nuit", "abc", "a" + "b" * 29, "chef_de_la_pharmacie_2", "a12", "role_2_b"]:
            verifie(f"rôle personnalisé accepté : {r}", accepte(r))
        for r in ["a1", "Caissier", "CAISSIER", "1caissier", "caissier_", "_caissier", "cais__sier", "ab", "a" * 31, "caissier nuit", "caissier-nuit", "caïssier", "é", "", " ", "caissier\n", "\ncaissier", "caissier\t", "caissier;drop", "../caissier", "İstanbul", "ǆabc", "caissier​"]:
            verifie(f"format invalide refusé : {r!r}", not accepte(r))
        verifie("valeur vide (NULL) toujours permise comme avant", "violates" not in pg("INSERT INTO users VALUES ('nul', NULL)"))

    print("\n=== Rejeu du fichier (idempotence)")
    sortie = pg("", fichier=FICHIER)
    verifie("rejeu sans erreur", "ERROR" not in sortie, sortie)
    verifie("toujours une seule contrainte", pg("SELECT count(*) FROM pg_constraint WHERE conname='users_role_check'") == "1")
    verifie("toujours une seule fonction", pg("SELECT count(*) FROM pg_proc WHERE proname='roles_personnalises_actifs'") == "1")
    verifie("le garde-fou répond toujours « oui »", garde_fou() == "t")
    sortie = pg("", fichier=FICHIER, unique=True)
    verifie("rejeu en une seule transaction (comme l'éditeur SQL) : sans erreur", "ERROR" not in sortie, sortie)
    verifie("dont le garde-fou répond « oui »", garde_fou() == "t")

    print("\n=== Échec atomique : un compte porte un rôle hors format (autorisé par l'ancienne liste)")
    for mode, unique in [("instruction par instruction (psql -f)", False), ("une seule transaction (éditeur SQL)", True)]:
        etat_depart(LISTE10 + ",'Caissier'")
        pg("INSERT INTO users VALUES ('u9','Caissier')")
        sortie = pg("", fichier=FICHIER, unique=unique)
        verifie(f"[{mode}] le script échoue", "is violated by some row" in sortie, sortie)
        verifie(f"[{mode}] l'ancienne contrainte est conservée (liste fixe, avec 'Caissier')", pg("SELECT pg_get_constraintdef(oid) LIKE '%Caissier%' FROM pg_constraint WHERE conname='users_role_check'") == "t")
        verifie(f"[{mode}] 'pharmacien' est donc toujours refusé : rien n'a changé", not accepte("pharmacien"))
        g = garde_fou()
        # Selon le mode, la fonction existe et dit « non » (f), ou a été annulée avec le reste (fonction absente).
        verifie(f"[{mode}] jamais « oui » : {'« non »' if g == 'f' else 'fonction annulée avec le reste'}",
                g == "f" or ("does not exist" in g and "ERROR" in g), g)
        verifie(f"[{mode}] aucun résidu de droits/fonction à moitié installée",
                pg("SELECT count(*) FROM pg_proc WHERE proname='roles_personnalises_actifs'") in ("0", "1"))

    print("\n=== Contrainte absente (supprimée à la main) : le script la recrée")
    etat_depart(LISTE12); pg("ALTER TABLE users DROP CONSTRAINT users_role_check")
    sortie = pg("", fichier=FICHIER)
    verifie("exécuté sans erreur", "ERROR" not in sortie, sortie)
    verifie("la contrainte existe de nouveau", pg("SELECT count(*) FROM pg_constraint WHERE conname='users_role_check'") == "1")
    verifie("le garde-fou répond « oui »", garde_fou() == "t")

    print("\n=== Un ancien script ajoute_role_*.sql recollé APRÈS (par erreur)")
    etat_depart(LISTE12); pg("", fichier=FICHIER)
    sortie = pg("", fichier=ANCIEN)
    verifie("sans rôle personnalisé attribué : l'ancien script passe et remet la liste fixe", "ERROR" not in sortie, sortie)
    verifie("…ce que le garde-fou voit aussitôt (« non ») : le serveur refusera de créer des rôles", garde_fou() == "f", garde_fou())
    etat_depart(LISTE12); pg("", fichier=FICHIER)
    pg("INSERT INTO users VALUES ('u8','caissier_nuit')")
    sortie = pg("", fichier=ANCIEN)
    verifie("avec un rôle personnalisé attribué : l'ancien script ÉCHOUE, rien ne change", "is violated by some row" in sortie, sortie)
    verifie("…le garde-fou répond toujours « oui »", garde_fou() == "t", garde_fou())

    print("\n=== Accord exact avec CLE_ROLE du serveur sur 2000 exemples")
    etat_depart(LISTE12); pg("", fichier=FICHIER); pg("TRUNCATE users")
    rnd = random.Random(20261009)
    lettres, chiffres = "abcdefghijklmnopqrstuvwxyz", "0123456789"
    bruit = list("ABCXYZ_-. éïçßàñ\n\t'\"`;/\\&<>İǆ ​")
    mots = lambda: "".join(rnd.choice(lettres + chiffres) for _ in range(rnd.randint(1, 8)))
    vecteurs = set()
    while len(vecteurs) < 2000:
        t = rnd.random()
        if t < 0.35:      # presque valides : mots reliés par des tirets bas, puis une petite altération
            s = "_".join(mots() for _ in range(rnd.randint(1, 4)))
            m = rnd.random()
            if m < .2: s = s + "_"
            elif m < .35: s = "_" + s
            elif m < .5: s = s.replace("_", "__", 1)
            elif m < .6: s = rnd.choice(chiffres) + s
            elif m < .7 and s: i = rnd.randrange(len(s)); s = s[:i] + s[i].upper() + s[i + 1:]
            elif m < .8: s = s[:rnd.randrange(len(s) + 1)] + rnd.choice(bruit) + s[rnd.randrange(len(s) + 1):]
        elif t < 0.6:     # entièrement aléatoire dans un alphabet bruité
            s = "".join(rnd.choice(lettres + chiffres + "".join(bruit)) for _ in range(rnd.randint(0, 35)))
        else:             # valide, de longueur variée
            s = rnd.choice(lettres) + "".join(rnd.choice(lettres + chiffres) for _ in range(rnd.randint(0, 40)))
        vecteurs.add(s)
    vecteurs = sorted(vecteurs)
    for aretes in ["abc", "ab", "abcd_efg", "a" * 30, "a" * 31, "a_b", "a_bc", "ab_", "_ab", "a__bc"]:
        if aretes not in vecteurs: vecteurs.append(aretes)
    pg("CREATE OR REPLACE FUNCTION essaie(v text) RETURNS boolean LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO users(id, role) VALUES (gen_random_uuid()::text, v); RETURN true; EXCEPTION WHEN check_violation THEN RETURN false; END $f$")
    pg_json = pg("SELECT jsonb_agg(jsonb_build_array(v, essaie(v))) FROM jsonb_array_elements_text($j$" + json.dumps(vecteurs) + "$j$::jsonb) AS t(v)")
    verdicts_pg = {v: ok for v, ok in json.loads(pg_json)}
    js = sh(["node", "-e", """
      const { CLE_ROLE, LONGUEUR_CLE } = require(process.argv[1]);
      const v = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      console.log(JSON.stringify(v.map(s => [s, CLE_ROLE.test(s) && s.length >= LONGUEUR_CLE.min && s.length <= LONGUEUR_CLE.max])));
    """, os.path.abspath(ROLES_JS)], input=json.dumps(vecteurs))
    verdicts_js = {v: ok for v, ok in json.loads(js.stdout)}
    ecarts = [v for v in vecteurs if verdicts_pg[v] != verdicts_js[v]]
    nb_ok = sum(verdicts_pg.values())
    verifie(f"{len(vecteurs)} exemples comparés ({nb_ok} acceptés, {len(vecteurs) - nb_ok} refusés) : aucun écart base ↔ serveur", not ecarts, f"écarts: {ecarts[:5]!r}")
    verifie("l'échantillon contient bien des deux sortes", 200 < nb_ok < len(vecteurs) - 200)
finally:
    arreter()
print("\nRÉSULTAT :", "TOUT EST BON" if ok_global else "ÉCHEC")
sys.exit(0 if ok_global else 1)
