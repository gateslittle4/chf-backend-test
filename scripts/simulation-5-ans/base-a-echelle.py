#!/usr/bin/env python3
"""Simulation 5 ans : base PostgreSQL JETABLE à l'échelle (40 000 dossiers par défaut), requêtes réelles du serveur CHF, avec/sans les index de sql/croissance_index_et_postes_ouverts.sql.
   N_DOS=100000 N_AU=1800000 python3 scripts/simulation-5-ans/base-a-echelle.py   (scénario lourd). Jamais sur la vraie base."""
import os, shutil, subprocess, sys, time, json
D="/var/lib/postgresql/chf-bench-5ans"; B="/usr/lib/postgresql/16/bin"; PORT="54339"
N_DOS=int(os.environ.get("N_DOS","40000")); RATIO=float(os.environ.get("RATIO_EP","1.75"))
N_EP=int(N_DOS*RATIO); N_FI=int(N_EP*2.3); N_PA=int(N_EP*1.5); N_AU=int(os.environ.get("N_AU","730000"))
PSQL=["psql","-h","/tmp","-p",PORT,"-U","postgres","-X","-q","-t","-A","-v","ON_ERROR_STOP=1","-d","chf"]
def sh(c): return subprocess.run(c,capture_output=True,text=True)
def pg(sql):
    r=sh(PSQL+["-c",sql])
    if r.returncode!=0: print("ERREUR SQL:",r.stderr[:400]); sys.exit(1)
    return r.stdout.strip()
BASE_PSQL=[0.0]
def temps(sql, n=1):
    t=time.time()
    for _ in range(n): pg(sql)
    return max(0.0,(time.time()-t)/n-BASE_PSQL[0])
shutil.rmtree(D,ignore_errors=True); os.makedirs(D); shutil.chown(D,"postgres","postgres")
sh(["su","postgres","-c",f"{B}/initdb -D {D}/data -A trust -E UTF8 >/dev/null"])
sh(["su","postgres","-c",f"{B}/pg_ctl -D {D}/data -o '-p {PORT} -k /tmp -c shared_buffers=128MB -c fsync=off' -l {D}/log.txt -w start >/dev/null"])
try:
    sh(PSQL[:-2]+["-d","postgres","-c","CREATE DATABASE chf"])
    pg("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    pg("""
CREATE TABLE dossiers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), numero_dossier text UNIQUE, nom text, date_naissance date, telephone text, adresse text, date_creation timestamptz, sexe text, modifie_le timestamptz DEFAULT now());
CREATE TABLE episodes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dossier_id uuid, voie_entree text, service text, type_consultation text, type_patient text, ong_partenaire text, statut text, est_hospitalisation boolean, date_ouverture timestamptz, date_fermeture timestamptz, supprime_le timestamptz, modifie_le timestamptz DEFAULT now(), lit text, mois_lot text, numero_lot int, ong_partenaire_id text);
CREATE TABLE fiches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), episode_id uuid, numero_fiche bigint, date_creation timestamptz, cree_par text, total_global numeric, breakdown jsonb, mode_paiement text, raw_state jsonb, supprime_le timestamptz, modifie_le timestamptz DEFAULT now(), UNIQUE(episode_id, numero_fiche));
CREATE TABLE paiements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), numero_paiement bigserial UNIQUE, fiche_id uuid, episode_id uuid, mode text, montant numeric, date_paiement timestamptz, details jsonb, annule boolean DEFAULT false, encaisse_par text, patient_nom text, ong_partenaire text, supprime_le timestamptz, modifie_le timestamptz DEFAULT now(), ong_partenaire_id text);
CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text, details jsonb, effectue_par text, effectue_par_uid text, date timestamptz);
""")
    t=time.time()
    pg(f"""
INSERT INTO dossiers (numero_dossier, nom, date_naissance, telephone, adresse, date_creation, sexe)
SELECT 'D'||g, 'Patient '||md5(g::text), date '1950-01-01' + (random()*25000)::int, '3'||lpad((random()*9999999)::int::text,7,'0'), 'Adresse '||(g%900), now() - (random()*1825||' days')::interval, CASE WHEN random()<.5 THEN 'M' ELSE 'F' END FROM generate_series(1,{N_DOS}) g;
INSERT INTO episodes (dossier_id, voie_entree, service, type_consultation, type_patient, ong_partenaire, statut, est_hospitalisation, date_ouverture, mois_lot)
SELECT (SELECT id FROM dossiers WHERE numero_dossier='D'||(1+(random()*{N_DOS-1})::int)), 'consultation','General','General', CASE WHEN random()<.2 THEN 'partenaire' ELSE 'prive' END, CASE WHEN random()<.2 THEN 'ONG'||(g%9) END, CASE WHEN g%200=0 THEN 'ouvert' ELSE 'ferme' END, random()<.1, now() - (random()*1825||' days')::interval, to_char(now() - (random()*1825||' days')::interval,'YYYY-MM') FROM generate_series(1,{N_EP}) g;
""")
    pg(f"""
INSERT INTO fiches (episode_id, numero_fiche, date_creation, cree_par, total_global, breakdown, mode_paiement, raw_state)
SELECT e.id, row_number() OVER (PARTITION BY e.id ORDER BY g), e.date_ouverture, 'infirmier@chf.org', (random()*5000)::int, jsonb_build_object('lignes', (SELECT jsonb_agg(jsonb_build_object('id',i,'label','Acte '||i,'prix',(random()*500)::int,'qte',1)) FROM generate_series(1,6) i)), 'cash', jsonb_build_object('note', repeat('x', 150))
FROM (SELECT id, date_ouverture, generate_series(1, 1 + (random()*2.6)::int) g FROM episodes) e;
INSERT INTO paiements (fiche_id, episode_id, mode, montant, date_paiement, details, encaisse_par, patient_nom, ong_partenaire)
SELECT NULL, e.id, 'cash', (random()*3000)::int, e.date_ouverture + interval '10 minutes', jsonb_build_object('note', repeat('y',120)), 'caisse@chf.org', 'Patient X', e.ong_partenaire
FROM (SELECT id, date_ouverture, ong_partenaire, generate_series(1, 1 + (random()*1.9)::int) FROM episodes) e;
INSERT INTO audit_log (action, details, effectue_par, effectue_par_uid, date)
SELECT 'action_'||(g%25), jsonb_build_object('k', repeat('z',60)), 'user'||(g%14)||'@chf.org', 'uid'||(g%14), now() - (random()*1825||' days')::interval FROM generate_series(1,{N_AU}) g;
CREATE INDEX idx_episodes_modifie_le ON episodes(modifie_le); CREATE INDEX idx_fiches_episode ON fiches(episode_id); CREATE INDEX idx_fiches_modifie_le ON fiches(modifie_le);
CREATE INDEX idx_paiements_episode ON paiements(episode_id); CREATE INDEX idx_paiements_fiche ON paiements(fiche_id); CREATE INDEX idx_paiements_modifie_le ON paiements(modifie_le);
CREATE INDEX idx_dossiers_modifie_le ON dossiers(modifie_le); CREATE INDEX idx_episodes_dossier_ouvert ON episodes(dossier_id) WHERE statut='ouvert';
CREATE INDEX idx_episodes_supprime_le ON episodes(supprime_le) WHERE supprime_le IS NOT NULL;
ANALYZE;
""")
    n=pg("select (select count(*) from dossiers)||' dossiers, '||(select count(*) from episodes)||' épisodes, '||(select count(*) from fiches)||' fiches, '||(select count(*) from paiements)||' paiements, '||(select count(*) from audit_log)||' audit'")
    taille=pg("select pg_size_pretty(pg_database_size('chf'))")
    print(f"BASE ({time.time()-t:.0f}s) : {n} — {taille}")
    tab=pg("select string_agg(relname||'='||pg_size_pretty(pg_total_relation_size(oid)), ', ') from pg_class where relname in ('dossiers','episodes','fiches','paiements','audit_log') and relkind='r'")
    print("TAILLES :", tab)

    t=time.time()
    for _ in range(10): pg("select 1")
    BASE_PSQL[0]=(time.time()-t)/10
    print(f"(démarrage d'un appel psql, retranché de chaque mesure : {BASE_PSQL[0]*1000:.0f} ms)")
    def lecture_complete(table, ordre, sel="*"):
        """Reproduit lireToutesLesPages : pages de 500, tri complet, jusqu'à la fin."""
        total=int(pg(f"select count(*) from {table} where supprime_le is null")); t0=time.time(); pages=0
        # on ne mesure que ~12 pages réparties (début → fin) puis on extrapole le total : les pages lointaines sont les plus chères
        offs=sorted(set(int(total*k/12)//500*500 for k in range(12)))
        mesures=[]
        for off in offs:
            a=time.time(); pg(f"select {sel} from {table} where supprime_le is null order by {ordre} limit 500 offset {off}"); mesures.append(max(0.0,time.time()-a-BASE_PSQL[0]))
        # interpolation linéaire par morceaux du coût d'une page selon l'offset
        import bisect
        npages=(total+499)//500; cout=0
        for p in range(npages):
            off=p*500; i=bisect.bisect_right(offs,off)-1; i=max(0,min(i,len(offs)-1)); cout+=mesures[i]
        return total, npages, cout, max(mesures)
    print("\n--- LECTURE COMPLÈTE D'UNE LISTE (côté base seulement, sans le réseau) ---")
    for nom,table,ordre in [("épisodes","episodes","date_ouverture desc, id"),("paiements","paiements","date_paiement desc, id")]:
        tot,np_,c,m=lecture_complete(table,ordre)
        print(f"SANS index  {nom:10} {tot:>7} lignes, {np_:>4} pages : ~{c:6.1f} s au total (page la plus lente {m*1000:.0f} ms)")
    pg("CREATE INDEX idx_episodes_date_ouverture ON episodes(date_ouverture DESC, id) WHERE supprime_le IS NULL; CREATE INDEX idx_paiements_date_paiement ON paiements(date_paiement DESC, id) WHERE supprime_le IS NULL; ANALYZE;")
    for nom,table,ordre in [("épisodes","episodes","date_ouverture desc, id"),("paiements","paiements","date_paiement desc, id")]:
        tot,np_,c,m=lecture_complete(table,ordre)
        print(f"AVEC index  {nom:10} {tot:>7} lignes, {np_:>4} pages : ~{c:6.1f} s au total (page la plus lente {m*1000:.0f} ms)")
    # fiches par lots de 200 épisodes (in) : coût d'un lot
    lot=pg("select string_agg(quote_literal(id::text)||'::uuid', ',') from (select id from episodes order by random() limit 200) x")
    t_fi=temps(f"select * from fiches where episode_id in ({lot}) and supprime_le is null order by date_creation, id limit 500")
    lots=(N_EP+199)//200
    print(f"fiches : un lot de 200 épisodes = {t_fi*1000:.0f} ms × {lots} lots = ~{t_fi*lots:.0f} s (hors réseau) — et autant pour les paiements annulés")
    print("\n--- AUTRES LECTURES COURANTES ---")
    Q_DELTA = "select id from episodes where modifie_le >= now() - interval '3 minutes' order by id"
    Q_AUDIT = "select * from audit_log order by date desc limit 300"
    Q_MOIS = "select * from paiements where date_paiement >= now() - interval '60 days' and date_paiement < now() - interval '30 days' order by id"
    Q_OUVERT = "select * from episodes where statut='ouvert' and dossier_id=(select id from dossiers limit 1)"
    Q_NUM = "select * from dossiers where numero_dossier='D777'"
    Q_FLOU = "select id from dossiers where similarity(nom,'patient 12ab') > 0.25"
    def ligne(libelle, sql, n=3):
        print(f"{libelle:66}: {temps(sql, n)*1000:8.1f} ms")
    ligne("mise à jour incrémentale (delta, 3 min)", Q_DELTA)
    ligne("journal d'audit (300 dernières lignes), SANS index sur la date", Q_AUDIT)
    ligne("rapport mensuel des paiements, SANS index sur la date", Q_MOIS)
    pg("CREATE INDEX idx_audit_log_date ON audit_log(date DESC)")
    ligne("journal d'audit (300 dernières lignes), AVEC index", Q_AUDIT)
    ligne("rapport mensuel des paiements, AVEC index (date_paiement)", Q_MOIS)
    ligne("ouvrir un dossier : ses épisodes ouverts (index partiel)", Q_OUVERT)
    ligne("recherche par numéro de dossier", Q_NUM)
    ligne("recherche floue par nom (fonction actuelle, scan complet)", Q_FLOU)
finally:
    sh(["su","postgres","-c",f"{B}/pg_ctl -D {D}/data -m fast stop >/dev/null"]); shutil.rmtree(D,ignore_errors=True)
