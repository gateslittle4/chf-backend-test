#!/usr/bin/env python3
"""scripts/bench-recherche-dossiers-sql.py — mesure la recherche de dossiers par nom sur un Postgres JETABLE (jamais sur la vraie base) avec 5 000, 50 000 puis 200 000 dossiers
fictifs, ANCIENNE fonction contre NOUVELLE (sql/recherche_dossiers_grands_volumes.sql), et vérifie que les deux renvoient les mêmes dossiers.

    python3 scripts/bench-recherche-dossiers-sql.py [nombres de dossiers, ex. 5000 50000]

Prérequis : binaires PostgreSQL (PG_BIN, défaut /usr/lib/postgresql/16/bin), exécution en root. Variables : PG_BIN, PG_PORT. Code de sortie 1 si les résultats diffèrent."""
import os, re, shutil, subprocess, sys, time

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
NOUVELLE = os.path.join(RACINE, "sql", "recherche_dossiers_grands_volumes.sql")
D = "/var/lib/postgresql/chf-bench-recherche"; B = os.environ.get("PG_BIN", "/usr/lib/postgresql/16/bin"); PORT = os.environ.get("PG_PORT", "54338")
PSQL = ["psql", "-h", "/tmp", "-p", PORT, "-U", "postgres", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"]
NOMBRES = [int(x) for x in sys.argv[1:]] or [5000, 50000, 200000]
REQUETES = ["Marie Josef", "Marie", "Jean Baptist", "joseph marie", "Michaël Pierre", "Sophia", "Saint Georges", "Esther Alexis", "Wilson Jean 42", "Roseline Pierre"]
ECHECS = []

def sh(c): return subprocess.run(c, capture_output=True, text=True)
def pg(sql, db="chf"):
    r = sh(PSQL + ["-d", db, "-c", sql]); return (r.stdout + r.stderr).strip()

ANCIENNE = """
CREATE OR REPLACE FUNCTION rechercher_dossiers_ancien(p_nom text) RETURNS SETOF dossiers LANGUAGE sql STABLE AS $$
  SELECT * FROM dossiers WHERE fusionne_dans IS NULL
    AND (similarity(nom, p_nom) > 0.25 OR nom ILIKE '%' || p_nom || '%' OR similarity(nom_origine, p_nom) > 0.25 OR nom_origine ILIKE '%' || p_nom || '%' OR anciens_noms::text ILIKE '%' || p_nom || '%')
  ORDER BY GREATEST(similarity(nom, p_nom), similarity(nom_origine, p_nom)) DESC, id LIMIT 20;
$$;"""

shutil.rmtree(D, ignore_errors=True); os.makedirs(D); shutil.chown(D, "postgres", "postgres")
sh(["su", "postgres", "-c", f"{B}/initdb -D {D}/data -A trust -E UTF8 >/dev/null"])
sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -o '-p {PORT} -k /tmp' -l {D}/log.txt -w start >/dev/null"])
try:
    pg("CREATE DATABASE chf", db="postgres")
    print(pg("""CREATE EXTENSION pg_trgm;
CREATE TABLE dossiers (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, numero_dossier text UNIQUE, nom text, nom_origine text, date_naissance date, telephone text, sexe text, anciens_noms jsonb, fusionne_dans uuid, modifie_le timestamptz DEFAULT now());
CREATE INDEX idx_dossiers_nom_trgm ON dossiers USING gin (nom gin_trgm_ops);
CREATE INDEX idx_dossiers_nom_origine_trgm ON dossiers USING gin (nom_origine gin_trgm_ops);""") or "")
    pg(ANCIENNE)
    r = sh(PSQL + ["-d", "chf", "-f", NOUVELLE]); sortie = r.stdout + r.stderr
    if "ERROR" in sortie: print("ÉCHEC du script :", sortie); sys.exit(1)
    for n in NOMBRES:
        pg("TRUNCATE dossiers")
        pg(f"""INSERT INTO dossiers (numero_dossier, nom, date_naissance, telephone, sexe)
SELECT (100000000+g)::text,
  (ARRAY['Marie','Jean','Joseph','Rose','Paul','Esther','Pierre','Anne','Louis','Claire','Michel','Sophia','Wilson','Nadège','Frantz','Carline','Jacques','Fabiola','Kervens','Guerline','Michaël','Roseline'])[1+floor(random()*22)::int] || ' ' ||
  (ARRAY['Joseph','Pierre','Jean','Louis','Baptiste','Charles','Alexis','Saint Georges','Paul','Jeune','Michel','Etienne','Francois','Desir','Noel','Exantus','Dorcelus','Toussaint','Cadet','Petit Frere'])[1+floor(random()*20)::int] || ' ' || g::text,
  date '1940-01-01' + floor(random()*29000)::int, '3'||lpad(floor(random()*10000000)::int::text,7,'0'), CASE WHEN random()<.5 THEN 'M' ELSE 'F' END
FROM generate_series(1,{n}) g;
UPDATE dossiers SET nom_origine = nom;
UPDATE dossiers SET anciens_noms = jsonb_build_array(jsonb_build_object('nom', 'Bébé ' || nom)) WHERE random() < 0.02;
UPDATE dossiers SET fusionne_dans = id WHERE random() < 0.01;
ANALYZE dossiers;""")
        ta = tn = 0.0; difference = 0
        for q in REQUETES:
            t = time.time(); ancien = pg(f"SELECT string_agg(id::text, ',' ORDER BY GREATEST(similarity(nom,'{q}'), similarity(nom_origine,'{q}')) DESC, id) FROM rechercher_dossiers_ancien('{q}')"); ta += time.time() - t
            t = time.time(); nouveau = pg(f"SELECT string_agg(id::text, ',' ORDER BY GREATEST(similarity(nom,'{q}'), similarity(nom_origine,'{q}')) DESC, id) FROM rechercher_dossiers_flou('{q}')"); tn += time.time() - t
            # mêmes dossiers (l'ordre des ex æquo peut différer : on compare les ensembles de 20)
            if set(ancien.split(",")) != set(nouveau.split(",")):
                # tolérance : les deux listes sont des « 20 meilleurs » ; une différence n'est admise que sur des ex æquo de score
                sa = pg(f"SELECT min(s) FROM (SELECT GREATEST(similarity(nom,'{q}'), similarity(nom_origine,'{q}')) s FROM dossiers WHERE id = ANY(string_to_array('{ancien}', ',')::uuid[])) x")
                sn = pg(f"SELECT min(s) FROM (SELECT GREATEST(similarity(nom,'{q}'), similarity(nom_origine,'{q}')) s FROM dossiers WHERE id = ANY(string_to_array('{nouveau}', ',')::uuid[])) x")
                if sa != sn: difference += 1; ECHECS.append(f"{n} dossiers, « {q} » : résultats différents (score du 20e : ancien {sa}, nouveau {sn})")
        plan = pg("EXPLAIN SELECT d.* FROM dossiers d WHERE d.fusionne_dans IS NULL AND (d.nom % 'Marie Josef' OR d.nom ILIKE '%Marie Josef%' OR d.nom_origine % 'Marie Josef' OR d.nom_origine ILIKE '%Marie Josef%' OR (d.anciens_noms IS NOT NULL AND d.anciens_noms::text ILIKE '%Marie Josef%'))")
        indexe = "Bitmap" in plan or "Index" in plan
        print(f"{n:>7} dossiers : ancienne {ta / len(REQUETES) * 1000:6.0f} ms/recherche — nouvelle {tn / len(REQUETES) * 1000:6.0f} ms/recherche — {'index utilisé' if indexe else 'LECTURE COMPLÈTE'} — {'mêmes résultats' if difference == 0 else str(difference) + ' différence(s)'}")
finally:
    sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -m fast stop >/dev/null"]); shutil.rmtree(D, ignore_errors=True)
print()
if ECHECS:
    print("\n".join(ECHECS)); sys.exit(1)
print("Mesure terminée : résultats identiques.")
