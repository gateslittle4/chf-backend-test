#!/usr/bin/env python3
"""scripts/test-solde-atomique-sql.py — teste sql/solde_atomique.sql sur un Postgres JETABLE (jamais sur la vraie base).

Le point central : des paiements du MÊME épisode arrivant en même temps ne doivent jamais partir du même ancien solde.
  - 20 crédits simultanés de 100 → les 20 soldes sont 100, 200 ... 2000, aucun doublon, le dernier vaut 2000 ;
  - 20 remboursements simultanés de 100 sur une dette de 1000 → exactement 10 passent, 10 sont refusés, le solde finit à 0, jamais négatif ;
  - la même épreuve contre une version NAÏVE (lecture puis écriture, sans verrou) ÉCHOUE — preuve que le test voit le défaut qu'il doit voir ;
  - deux épisodes différents ne s'attendent pas.
Puis la règle de solde elle-même (report, crédit, partiel, remboursement, refus CHF01/02/03, annulé / supprimé ignorés, valeurs par défaut) et le rejeu du script.

    python3 scripts/test-solde-atomique-sql.py

Prérequis : binaires PostgreSQL (PG_BIN, défaut /usr/lib/postgresql/16/bin), exécution en root. Variables : PG_BIN, PG_PORT."""
import json, os, shutil, subprocess, sys, time

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FICHIER = os.path.join(RACINE, "sql", "solde_atomique.sql")
D = "/var/lib/postgresql/chf-test-solde-atomique"
B = os.environ.get("PG_BIN", "/usr/lib/postgresql/16/bin")
PORT = os.environ.get("PG_PORT", "54336")
PSQL = ["psql", "-h", "/tmp", "-p", PORT, "-U", "postgres", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=0"]
ECHECS = []
EP1 = "00000000-0000-0000-0000-0000000000a1"
EP2 = "00000000-0000-0000-0000-0000000000a2"
EP3 = "00000000-0000-0000-0000-0000000000a3"
EP4 = "00000000-0000-0000-0000-0000000000a4"

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
    sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -o '-p {PORT} -k /tmp -c max_connections=100' -l {D}/log.txt -w start >/dev/null"])

def arreter():
    sh(["su", "postgres", "-c", f"{B}/pg_ctl -D {D}/data -m fast stop >/dev/null"])
    shutil.rmtree(D, ignore_errors=True)

# Forme de la vraie table (colonnes et valeurs par défaut relevées sur la base de production le 13/10).
SCHEMA = """
CREATE TABLE paiements (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  numero_paiement bigserial NOT NULL UNIQUE,
  fiche_id uuid, episode_id uuid, local_id text UNIQUE,
  mode text NOT NULL, montant numeric NOT NULL,
  date_paiement timestamptz NOT NULL DEFAULT now(),
  details jsonb DEFAULT '{}'::jsonb,
  annule boolean NOT NULL DEFAULT false, encaisse_par text, patient_nom text, solde_restant numeric,
  supprime_le timestamptz, modifie_le timestamptz NOT NULL DEFAULT now()
);
"""

# Version NAÏVE : lecture, petite pause (la fenêtre de la course), puis écriture — comme l'ancien chemin du serveur, sans verrou.
NAIVE = """
CREATE FUNCTION public.paiement_naif(p_episode uuid, p_ajout numeric, p_rembourse boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_solde numeric; v_new numeric; v_res jsonb;
BEGIN
  SELECT coalesce(solde_restant, 0) INTO v_solde FROM paiements WHERE episode_id = p_episode AND (annule = false OR annule IS NULL) AND supprime_le IS NULL ORDER BY date_paiement DESC LIMIT 1;
  v_solde := coalesce(v_solde, 0);
  PERFORM pg_sleep(0.05);
  IF p_rembourse THEN
    IF v_solde < 100 THEN RAISE EXCEPTION 'refus' USING errcode = 'CHF03'; END IF;
    v_new := v_solde - 100;
  ELSE v_new := v_solde + p_ajout; END IF;
  INSERT INTO paiements (episode_id, mode, montant, solde_restant) VALUES (p_episode, CASE WHEN p_rembourse THEN 'remboursement_credit' ELSE 'credit' END, 100, v_new) RETURNING to_jsonb(paiements.*) INTO v_res;
  RETURN v_res;
END $$;
"""

def appel(episode, mode="credit", montant=100, ajout=100, rembourse=False, extra=None):
    corps = {"episode_id": episode, "mode": mode, "montant": montant}
    corps.update(extra or {})
    return f"SELECT public.enregistrer_paiement_atomique('{json.dumps(corps)}'::jsonb, {ajout}, {'true' if rembourse else 'false'})"

def soldes(episode):
    sortie = pg(f"SELECT string_agg(solde_restant::text, ',' ORDER BY numero_paiement) FROM paiements WHERE episode_id='{episode}'")
    return [float(x) for x in sortie.split(",") if x] if sortie else []

def en_parallele(requetes):
    """Lance toutes les requêtes en même temps (une session chacune) ; renvoie les sorties."""
    procs = [subprocess.Popen(PSQL + ["-d", "chf", "-c", r], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True) for r in requetes]
    return [p.communicate()[0].strip() for p in procs]

def base_neuve():
    pg("DROP DATABASE IF EXISTS chf", db="postgres")
    pg("CREATE DATABASE chf", db="postgres")
    pg(SCHEMA)

def scenario(unique):
    mode = "une seule transaction" if unique else "instruction par instruction"
    print(f"\n== Application ({mode}), puis rejeu ==")
    base_neuve()
    sortie = pg(None, fichier=FICHIER, unique=unique)
    verifier("ERROR" not in sortie and "ERREUR" not in sortie, f"le script passe sans erreur ({sortie[:200]!r})")
    sortie2 = pg(None, fichier=FICHIER, unique=unique)
    verifier("ERROR" not in sortie2 and "ERREUR" not in sortie2, f"rejouer le script passe aussi ({sortie2[:200]!r})")
    verifier(pg("SELECT count(*) FROM pg_proc WHERE proname='enregistrer_paiement_atomique'") == "1", "une seule fonction après rejeu")

    print("-- règle de solde (identique à l'ancien chemin du serveur)")
    verifier(pg(appel(EP1, "cash", 60, 0)) != "" and soldes(EP1) == [0.0], "épisode sans dette : un paiement comptant laisse 0")
    pg(appel(EP1, "credit", 0, 100)); verifier(soldes(EP1)[-1] == 100.0, "une vente à crédit de 100 → dette 100")
    pg(appel(EP1, "cash", 60, 0)); verifier(soldes(EP1)[-1] == 100.0, "un paiement comptant ensuite REPORTE la dette (elle ne disparaît pas)")
    pg(appel(EP1, "depot", 30, 0)); verifier(soldes(EP1)[-1] == 100.0, "un dépôt aussi")
    pg(appel(EP1, "cash", 40, 50, extra={"details": {"paiement_partiel": True, "reste": 50}})); verifier(soldes(EP1)[-1] == 150.0, "un paiement partiel ajoute son reste (100 + 50)")
    pg(appel(EP1, "remboursement_credit", 40, 0, rembourse=True)); verifier(soldes(EP1)[-1] == 110.0, "un remboursement de 40 → 110")
    for libelle, montant, code in [("rien à rembourser", 10, "CHF01"), ("montant nul", 0, "CHF02"), ("dépasse la dette", 500, "CHF03")]:
        ep = EP2 if code == "CHF01" else EP1
        s = pg(appel(ep, "remboursement_credit", montant, 0, rembourse=True))
        verifier(code in s or "Aucun solde" in s or "supérieur à 0" in s or "dépasse" in s, f"remboursement refusé ({libelle})")
    verifier("Aucun solde de crédit à rembourser pour cet épisode." in pg(appel(EP2, "remboursement_credit", 10, 0, rembourse=True)), "message CHF01 en français")
    verifier("dépasse le solde restant" in pg(appel(EP1, "remboursement_credit", 500, 0, rembourse=True)), "message CHF03 en français")
    verifier(soldes(EP1)[-1] == 110.0, "un refus n'écrit rien")

    print("-- annulés et supprimés ignorés ; valeurs par défaut")
    pg(appel(EP3, "credit", 0, 300)); pg(appel(EP3, "credit", 0, 100))
    pg(f"UPDATE paiements SET annule=true WHERE episode_id='{EP3}' AND solde_restant=400")
    pg(appel(EP3, "cash", 10, 0)); verifier(soldes(EP3)[-1] == 300.0, "le dernier paiement ANNULÉ ne sert plus de référence (300, pas 400)")
    pg(f"UPDATE paiements SET supprime_le=now() WHERE episode_id='{EP3}' AND solde_restant=300")
    pg(appel(EP3, "cash", 10, 0)); verifier(soldes(EP3)[-1] == 0.0, "les paiements supprimés (corbeille) ne comptent plus")
    ligne = pg(f"SELECT numero_paiement IS NOT NULL AND id IS NOT NULL AND annule = false AND date_paiement > now() - interval '1 minute' FROM paiements WHERE episode_id='{EP1}' ORDER BY numero_paiement LIMIT 1")
    verifier(ligne == "t", "identifiant, numéro de paiement, annule=false et date viennent des valeurs par défaut")
    # (p_heure_serveur faux = rejeu hors ligne : la date envoyée est gardée ; en direct, la base date elle-même l'écriture)
    pg(appel(EP4, "cash", 5, 0, extra={"date_paiement": "2026-10-13T10:00:00Z", "encaisse_par": "Marie", "patient_nom": "X", "details": {"a": 1}, "colonne_inconnue": "ignorée"}).replace("false)", "false, false)"))
    verifier(pg(f"SELECT date_paiement = '2026-10-13T10:00:00Z' AND encaisse_par = 'Marie' AND details = '{{\"a\": 1}}'::jsonb FROM paiements WHERE episode_id='{EP4}'") == "t", "les colonnes envoyées sont écrites telles quelles, les inconnues ignorées")
    s = pg("SELECT public.enregistrer_paiement_atomique('{\"mode\":\"cash\",\"montant\":7,\"solde_restant\":3}'::jsonb, 0, false)")
    verifier(pg("SELECT count(*) FROM paiements WHERE episode_id IS NULL AND montant=7 AND solde_restant=3") == "1", "sans épisode : écrit tel quel, solde envoyé conservé")
    pg(appel(EP4, "cash", 5, 0, extra={"local_id": "L-1"}))
    s = pg(appel(EP4, "cash", 5, 0, extra={"local_id": "L-1"}))
    verifier("duplicate key" in s or "23505" in s or "unique" in s.lower(), "même local_id deux fois : refusé par la base (le serveur renvoie alors le paiement existant)")
    verifier(pg(f"SELECT count(*) FROM paiements WHERE local_id='L-1'") == "1", "une seule ligne pour ce local_id")

def concurrence():
    print("\n== Concurrence : paiements simultanés du même épisode ==")
    base_neuve()
    pg(None, fichier=FICHIER)
    pg(NAIVE)

    # Plusieurs tours : la course est INTERMITTENTE (un premier jet n'échouait qu'une fois sur trois — le test doit la voir à coup sûr).
    for tour in range(8):
        ep = f"00000000-0000-0000-0000-00000000c0{tour:02d}"
        en_parallele([appel(ep, "credit", 0, 100) for _ in range(20)])
        s = soldes(ep)
        verifier(len(s) == 20 and s == [100.0 * i for i in range(1, 21)], f"tour {tour + 1}/8 — 20 crédits simultanés : soldes 100…2000 dans l'ordre d'écriture, sans doublon ({s[:3]}…{s[-3:]})")
    verifier(pg(f"SELECT bool_and(d_prec <= d) FROM (SELECT date_paiement d, lag(date_paiement) OVER (ORDER BY numero_paiement) d_prec FROM paiements WHERE episode_id='00000000-0000-0000-0000-00000000c000') x WHERE d_prec IS NOT NULL") == "t",
             "les dates suivent l'ordre d'écriture (la date est prise sous le verrou)")
    pg(appel(EP3, "credit", 0, 50, extra={"date_paiement": "2026-10-13T08:00:00Z"}).replace("false)", "false, false)"))
    verifier(pg(f"SELECT date_paiement = '2026-10-13T08:00:00Z' FROM paiements WHERE episode_id='{EP3}'") == "t", "rejeu hors ligne (p_heure_serveur faux) : la date de l'appareil est gardée")
    pg(f"DELETE FROM paiements WHERE episode_id='{EP3}'")

    pg(appel(EP2, "credit", 0, 1000))
    sorties = en_parallele([appel(EP2, "remboursement_credit", 100, 0, rembourse=True) for _ in range(20)])
    reussis = sum(1 for o in sorties if "numero_paiement" in o)
    s = soldes(EP2)
    verifier(reussis == 10, f"20 remboursements de 100 sur une dette de 1000 : exactement 10 passent ({reussis})")
    verifier(s[-1] == 0.0 and min(s) >= 0, f"le solde finit à 0 et ne devient jamais négatif (min {min(s)})")
    verifier(all(("CHF01" in o or "CHF03" in o or "Aucun solde" in o or "dépasse" in o) for o in sorties if "numero_paiement" not in o), "les 10 autres sont refusés proprement")

    print("-- la même épreuve contre la version NAÏVE doit ÉCHOUER (le test voit le défaut)")
    en_parallele([f"SELECT public.paiement_naif('{EP3}', 100, false)" for _ in range(20)])
    s3 = soldes(EP3)
    verifier(len(set(s3)) < 20 or (s3 and s3[-1] < 2000.0), f"version naïve : des paiements partent du même ancien solde (soldes distincts : {len(set(s3))} sur 20, dernier {s3[-1] if s3 else None})")
    pg(f"SELECT public.paiement_naif('{EP4}', 1000, false)")
    en_parallele([f"SELECT public.paiement_naif('{EP4}', 0, true)" for _ in range(20)])
    s4 = soldes(EP4)
    verifier(sum(1 for x in s4 if x is not None) - 1 > 10 or min(s4) < 0, f"version naïve : trop de remboursements passent ou le solde devient négatif ({s4[-1]}, {len(s4) - 1} réussis)")

    print("-- deux épisodes différents ne s'attendent pas")
    bloqueur = subprocess.Popen(PSQL + ["-d", "chf", "-c", f"BEGIN; {appel('00000000-0000-0000-0000-0000000000b1', 'credit', 0, 10)}; SELECT pg_sleep(2); COMMIT;"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(0.5)
    t0 = time.time(); pg(appel("00000000-0000-0000-0000-0000000000b2", "credit", 0, 10)); autre = time.time() - t0
    t0 = time.time(); pg(appel("00000000-0000-0000-0000-0000000000b1", "credit", 0, 10)); meme = time.time() - t0
    bloqueur.communicate()
    verifier(autre < 1.0, f"un autre épisode n'attend pas ({autre:.2f} s)")
    verifier(meme > 1.0, f"le même épisode attend la fin du premier paiement ({meme:.2f} s)")
    verifier(soldes("00000000-0000-0000-0000-0000000000b1") == [10.0, 20.0], "et le solde final est juste (10 puis 20)")

try:
    demarrer()
    scenario(False)
    scenario(True)
    concurrence()
finally:
    arreter()

print()
if ECHECS:
    print(f"{len(ECHECS)} ÉCHEC(S)")
    sys.exit(1)
print("Tout est ok.")
