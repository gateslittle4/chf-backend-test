#!/usr/bin/env node
// scripts/restauration/essai-restauration.js — TEST DE RESTAURATION DE BOUT EN BOUT, sur deux bases PostgreSQL jetables (jamais sur la vraie base).
//
// Ce que ça prouve, étape par étape :
//   1. le dépôt sait RECONSTRUIRE la base : schema-reference.sql (tables) + les scripts du dossier sql/ rejoués → fonctions, déclencheurs, règles de sécurité ;
//   2. on remplit la base « source » de données réalistes à l'échelle voulue (accents, dossiers fusionnés, journal d'audit sur 5 ans...) ;
//   3. le VRAI code de sauvegarde (utils/sauvegardeServeur.js) sauvegarde la source dans des fichiers compressés, avec mesure du temps et de la mémoire ;
//   4. le VRAI code de restauration relit ces fichiers dans une base « cible » VIDE ;
//   5. comparaison table par table (nombre de lignes + empreinte du contenu, dates du journal d'audit comprises) ;
//   6. une 2e restauration n'ajoute rien ; le premier paiement après restauration reçoit un numéro NEUF ; un fichier abîmé est refusé AVANT toute écriture.
//
//   node scripts/restauration/essai-restauration.js                 # petite échelle (≈ 1 min)
//   ECHELLE=1an node scripts/restauration/essai-restauration.js     # 8 000 dossiers
//   ECHELLE=5ans node scripts/restauration/essai-restauration.js    # 40 000 dossiers (long)
// Prérequis : binaires PostgreSQL 16 (PG_BIN), exécution en root (comme les autres scripts de simulation).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { creerClientPg, creerStockageFichiers } = require('./adaptateur-pg');
const { creerServiceSauvegarde } = require('../../utils/sauvegardeServeur');

const RACINE = path.join(__dirname, '..', '..');
const PG_BIN = process.env.PG_BIN || '/usr/lib/postgresql/16/bin';
const PORT = Number(process.env.PG_PORT || 54351);
const DOSSIER_PG = '/var/lib/postgresql/chf-essai-restauration';
const ECHELLES = { petite: { dos: 1500, audit: 20000, sessions: 400 }, '1an': { dos: 8000, audit: 150000, sessions: 1100 }, '5ans': { dos: 40000, audit: 730000, sessions: 5500 } };
const echelle = ECHELLES[process.env.ECHELLE || 'petite'];
if (!echelle) { console.error('ECHELLE inconnue'); process.exit(2); }

const ECHECS = [];
const verifier = (cond, msg) => { console.log((cond ? '  ok   ' : '  ÉCHEC ') + msg); if (!cond) ECHECS.push(msg); };
const sh = (cmd) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
const psqlAdmin = (base, args) => spawnSync('psql', ['-h', '/tmp', '-p', String(PORT), '-U', 'postgres', '-X', '-q', '-t', '-A', '-d', base, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
const json = (base, sql) => { const r = psqlAdmin(base, ['-c', `select coalesce(to_json((${sql})), 'null'::json)`]); if (r.status !== 0) throw new Error(r.stderr); return JSON.parse(r.stdout.trim()); };
const mo = (o) => (o / 1048576).toFixed(0) + ' Mo';
let picMemoire = 0;
const surveiller = () => { picMemoire = Math.max(picMemoire, process.memoryUsage().rss); };

// ong_partenaires AVANT episodes et paiements : un déclencheur (rattacher_partenaire_id) retrouve l'identifiant du partenaire À PARTIR DU NOM à chaque insertion ; si le partenaire n'est
// pas encore restauré, l'identifiant resterait vide (constaté par cet essai le 16/10) et les lots par partenaire perdraient le lien.
const TABLES = ['ong_partenaires', 'dossiers', 'episodes', 'fiches', 'paiements', 'pieces_jointes', 'transferts_service', 'demandes_exoneration', 'catalog', 'cloture_caisse', 'users',
  'audit_log', 'requisitions', 'salaires_service', 'depenses_caisse', 'decrements_stock_appliques', 'invitations', 'compteurs', 'doublons_ignores', 'migrations_appliquees'];
const CLES = { catalog: 'type', decrements_stock_appliques: 'local_id', invitations: 'token', doublons_ignores: 'dossier_a,dossier_b', migrations_appliquees: 'nom' };
const ORDRE = TABLES.map(t => [t, CLES[t] || 'id']);
// Ces colonnes sont, par conception, remises à l'heure de la base à chaque insertion (déclencheurs) : elles ne se comparent pas.
const IGNOREES = ['modifie_le'];

function demarrer() {
  sh(`rm -rf ${DOSSIER_PG}; mkdir -p ${DOSSIER_PG}; chown postgres:postgres ${DOSSIER_PG}`);
  sh(`su postgres -c "${PG_BIN}/initdb -D ${DOSSIER_PG}/data -A trust -E UTF8 >/dev/null"`);
  sh(`su postgres -c "${PG_BIN}/pg_ctl -D ${DOSSIER_PG}/data -o '-p ${PORT} -k /tmp -c fsync=off -c shared_buffers=128MB -c max_wal_size=2GB' -l ${DOSSIER_PG}/log.txt -w start >/dev/null"`);
  psqlAdmin('postgres', ['-c', 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;']);
  for (const b of ['source', 'cible']) psqlAdmin('postgres', ['-c', `CREATE DATABASE ${b}`]);
}
const arreter = () => { sh(`su postgres -c "${PG_BIN}/pg_ctl -D ${DOSSIER_PG}/data -m fast stop >/dev/null"; rm -rf ${DOSSIER_PG}`); };

// Reconstruit une base : stub du schéma « auth » de Supabase, tables de référence, puis scripts du dossier sql/ (ceux du journal de production : tout sauf les scripts
// « préparés, non appliqués »), dans l'ordre alphabétique. Les « already exists » sont attendus (le schéma de référence est déjà dans son état final) et ne comptent pas.
const PAS_APPLIQUES = new Set(['recherche_dossiers_grands_volumes.sql']);
// Erreurs ATTENDUES, et pourquoi : ce script est une MIGRATION de l'ancienne table depenses_caisse (colonnes `date`, `validepar`) ; le schéma de référence contient déjà la table finale.
const ERREURS_ATTENDUES = [
  { script: 'ajoute_caissier_uid_depenses_caisse.sql', motif: /column "(date|validepar)"( of relation "depenses_caisse")? does not exist/ },
];
const STUB_AUTH = "create schema if not exists auth; create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;";
// Requêtes de conformité : ce sont EXACTEMENT les mêmes à lancer sur la production pour comparer les empreintes (voir LISEZMOI.md).
const SQL_CONFORMITE = {
  contraintes: "select md5(string_agg(c.conrelid::regclass::text || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid), '|' order by c.conrelid::regclass::text, c.conname)) from pg_constraint c where c.connamespace = 'public'::regnamespace and c.conrelid::regclass::text !~ '^(sauvegarde_|catalog_sauvegarde)'",
  index: "select md5(string_agg(indexdef, '|' order by indexname)) from pg_indexes where schemaname = 'public' and tablename !~ '^(sauvegarde_|catalog_sauvegarde)' and indexname not in (select conname from pg_constraint where connamespace = 'public'::regnamespace)",
  declencheurs: "select md5(string_agg(pg_get_triggerdef(t.oid), '|' order by c.relname, t.tgname)) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and c.relname !~ '^(sauvegarde_|catalog_sauvegarde)'",
  politiques: "select md5(string_agg(format('%s.%s %s %s %s %s %s', tablename, policyname, permissive, cmd, roles, qual, with_check), '|' order by tablename, policyname)) from pg_policies where schemaname = 'public' and tablename !~ '^(sauvegarde_|catalog_sauvegarde)'",
  rls: "select md5(string_agg(c.relname, '|' order by c.relname)) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity and c.relname !~ '^(sauvegarde_|catalog_sauvegarde)'",
  fonctions: "select md5(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(pg_get_functiondef(p.oid)), '|' order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'chf_interne') and p.prokind = 'f' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')",
};
function reconstruireSchema(base) {
  const erreurs = [];
  const lancer = (fichier, etiquette) => {
    const r = psqlAdmin(base, ['-v', 'ON_ERROR_STOP=0', '-f', fichier]);
    for (const l of (r.stderr || '').split('\n').filter(x => /ERROR/.test(x) && !/already exists/.test(x))) {
      if (ERREURS_ATTENDUES.some(e => e.script === etiquette && e.motif.test(l))) continue;
      erreurs.push(`${etiquette} : ${l.replace(/^psql:[^:]*:\d+: /, '')}`);
    }
  };
  psqlAdmin(base, ['-c', STUB_AUTH]);
  lancer(path.join(__dirname, 'schema-reference.sql'), 'schema-reference.sql');
  const listes = () => ({
    contraintes: json(base, "select jsonb_agg(c.conrelid::regclass::text || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid) order by 1) from pg_constraint c where c.connamespace = 'public'::regnamespace and c.conrelid::regclass::text !~ '^(sauvegarde_|catalog_sauvegarde)'") || [],
    index: json(base, "select jsonb_agg(indexdef order by indexname) from pg_indexes where schemaname = 'public' and tablename !~ '^(sauvegarde_|catalog_sauvegarde)' and indexname not in (select conname from pg_constraint where connamespace = 'public'::regnamespace)") || [],
  });
  const avant = listes();
  const scripts = fs.readdirSync(path.join(RACINE, 'sql')).filter(f => f.endsWith('.sql') && !PAS_APPLIQUES.has(f)).sort();
  for (const f of scripts) lancer(path.join(RACINE, 'sql', f), f);
  const apres = listes();
  const derives = [];
  // Une contrainte CHECK écrite dans un script s'affiche avec d'autres parenthèses selon la version de PostgreSQL (la production est en 15, ce banc d'essai en 16) : même
  // condition, autre mise en forme. On compare donc sans parenthèses ni espaces.
  const norme = (k, x) => (k === 'contraintes' ? x.replace(/[()\s]/g, '') : x);
  for (const k of ['contraintes', 'index']) {
    const normAvant = new Set(avant[k].map(x => norme(k, x))), normApres = new Set(apres[k].map(x => norme(k, x)));
    for (const x of avant[k]) if (!normApres.has(norme(k, x))) derives.push(`${k} : supprimé/modifié par les scripts → ${x.slice(0, 200)}`);
    for (const x of apres[k]) if (!normAvant.has(norme(k, x))) derives.push(`${k} : ajouté par les scripts → ${x.slice(0, 200)}`);
  }
  return { scripts: scripts.length, erreurs, derives };
}

// Les colonnes « numeric » se comparent par leur VALEUR : 61.50 (lu en base) et 61.5 (relu depuis le fichier JSON) sont le même poids.
const colonnesNumeriques = (base, table) => json(base, `select coalesce(jsonb_agg(column_name), '[]'::jsonb) from information_schema.columns where table_schema = 'public' and table_name = '${table}' and data_type = 'numeric'`);
function empreinte(base, table) {
  const cle = (CLES[table] || 'id').split(',').join(', ');
  const retire = IGNOREES.map(c => `- '${c}'`).join(' ');
  const numeriques = colonnesNumeriques(base, table).map(c => ` || jsonb_build_object('${c}', t."${c}"::float8)`).join('');
  return json(base, `select jsonb_build_object('lignes', count(*), 'md5', md5(coalesce(string_agg(((to_jsonb(t) ${retire})${numeriques})::text, '|' order by ${cle}), ''))) from public.${table} t`);
}

async function main() {
  console.log(`ÉCHELLE ${process.env.ECHELLE || 'petite'} : ${echelle.dos} dossiers, ${echelle.audit} lignes d'audit, ${echelle.sessions} sessions de caisse\n`);
  demarrer();
  try {
    console.log('1. Reconstruction de la base à partir du dépôt');
    const rec = { source: reconstruireSchema('source'), cible: reconstruireSchema('cible') };
    console.log(`   ${rec.source.scripts} scripts rejoués ; ${rec.source.erreurs.length} erreur(s) hors « already exists »`);
    for (const e of rec.source.erreurs.slice(0, 25)) console.log('     · ' + e.slice(0, 230));
    verifier(rec.source.erreurs.length === 0, 'les scripts du dépôt se rejouent sans erreur sur le schéma de référence');
    for (const d of rec.source.derives.slice(0, 30)) console.log('     ~ ' + d);
    verifier(rec.source.derives.length === 0, 'rejouer les scripts ne change NI les contraintes NI les index du schéma de référence (état final de la production)');
    console.log('   empreintes de conformité (à comparer à la production avec les mêmes requêtes, voir LISEZMOI.md) :');
    for (const [nom, sql] of Object.entries(SQL_CONFORMITE)) console.log(`     ${nom.padEnd(13)} ${json('source', sql)}`);

    console.log('\n2. Données synthétiques dans la base source');
    let t0 = Date.now();
    const donnees = fs.readFileSync(path.join(__dirname, 'donnees-synthetiques.sql'), 'utf8').replace(/{{N_DOS}}/g, echelle.dos).replace(/{{N_AUDIT}}/g, echelle.audit).replace(/{{N_SESSIONS}}/g, echelle.sessions);
    const fichierDonnees = path.join(os.tmpdir(), 'chf-donnees.sql'); fs.writeFileSync(fichierDonnees, donnees);
    const rg = psqlAdmin('source', ['-v', 'ON_ERROR_STOP=1', '-f', fichierDonnees]);
    if (rg.status !== 0) throw new Error('génération des données : ' + rg.stderr.slice(0, 600));
    const avant = {};
    for (const t of TABLES) avant[t] = empreinte('source', t);
    console.log(`   ${((Date.now() - t0) / 1000).toFixed(0)} s ; ` + TABLES.map(t => `${t}=${avant[t].lignes}`).join(', '));
    console.log(`   taille de la base source : ${json('source', "select pg_size_pretty(pg_database_size('source'))")}`);

    console.log('\n3. Sauvegarde (vrai code)');
    const stockage = creerStockageFichiers(path.join(os.tmpdir(), 'chf-stockage-essai'));
    fs.rmSync(stockage.racine, { recursive: true, force: true }); fs.mkdirSync(stockage.racine, { recursive: true });
    const clientSource = creerClientPg({ port: PORT, base: 'source' }); clientSource.storage = stockage;
    const clientCible = creerClientPg({ port: PORT, base: 'cible' }); clientCible.storage = stockage;
    const horloge = () => new Date('2026-10-16T12:00:00Z');
    const options = { bucket: 'sauvegardes-automatiques', tables: TABLES, clesPrimaires: CLES, ordreRestauration: ORDRE, journal: { log() {}, warn: console.warn, error: console.warn }, maintenant: horloge };
    const serviceSource = creerServiceSauvegarde({ supabase: clientSource, ...options });
    picMemoire = 0; const rss0 = process.memoryUsage().rss;
    const iv = setInterval(surveiller, 100);
    t0 = Date.now();
    const res = await serviceSource.sauvegarder();
    clearInterval(iv); surveiller();
    console.log(`   ${((Date.now() - t0) / 1000).toFixed(1)} s ; ${res.fichiers} fichiers ; ${mo(res.octets)} compressés ; mémoire du processus au pire moment ${mo(picMemoire)} (au départ ${mo(rss0)})`);
    verifier(res.tablesEnEchec.length === 0, 'aucune table en échec à la sauvegarde');
    verifier(res.verification.ok, 'la relecture de la sauvegarde (sommes de contrôle + comptage des lignes) est conforme : ' + (res.verification.erreurs.join(' ; ') || 'ok'));
    verifier(TABLES.every(t => res.nombreLignes[t] === avant[t].lignes), 'le manifeste compte exactement les lignes de chaque table');
    const liste = await serviceSource.listerSauvegardes();
    verifier(liste.length === 1 && liste[0].nom === 'backup-2026-10-16' && liste[0].format === 2, 'la sauvegarde apparaît dans la liste : ' + JSON.stringify(liste));
    verifier(await serviceSource.sauvegardeDuJourExisteDeja(), 'la sauvegarde du jour est reconnue');

    console.log('\n4. Restauration dans une base VIDE (vrai code)');
    const serviceCible = creerServiceSauvegarde({ supabase: clientCible, ...options });
    picMemoire = 0; const iv2 = setInterval(surveiller, 100); t0 = Date.now();
    const rest = await serviceCible.restaurer('backup-2026-10-16');
    clearInterval(iv2); surveiller();
    console.log(`   ${((Date.now() - t0) / 1000).toFixed(1)} s ; ${rest.totalInsere} lignes ajoutées ; ${rest.totalEnEchec} en échec ; mémoire au pire moment ${mo(picMemoire)}`);
    for (const a of rest.avertissements) console.log('   ⚠ ' + a);
    for (const r of rest.rapport.filter(r => r.lignesEnEchec.length)) console.log(`   ✗ ${r.table} : ${r.lignesEnEchec.length} échec(s), ex. ${JSON.stringify(r.lignesEnEchec[0]).slice(0, 250)}`);
    verifier(rest.totalEnEchec === 0, 'aucune ligne en échec à la restauration');
    verifier(rest.avertissements.length === 0, 'aucun avertissement de restauration' + (rest.avertissements.length ? ' : ' + rest.avertissements.join(' | ') : ''));

    console.log('\n5. Comparaison source / cible');
    for (const t of TABLES) {
      const apres = empreinte('cible', t);
      const identique = apres.md5 === avant[t].md5;
      verifier(apres.lignes === avant[t].lignes && identique, `${t} : ${apres.lignes} / ${avant[t].lignes} lignes, contenu ${identique ? 'IDENTIQUE' : 'DIFFÉRENT'}`);
      if (!identique) {
        const cle = (CLES[t] || 'id').split(',').join(', ');
        for (const c of json('source', `select jsonb_agg(column_name) from information_schema.columns where table_schema = 'public' and table_name = '${t}'`)) {
          if (IGNOREES.includes(c)) continue;
          const numerique = colonnesNumeriques('source', t).includes(c);
          const h = (b) => json(b, `select md5(coalesce(string_agg("${c}"${numerique ? '::float8' : ''}::text, '|' order by ${cle}), '')) from public.${t}`);
          if (h('source') !== h('cible')) console.log(`       ↳ colonne différente : ${c}`);
        }
      }
    }
    const recents = (b) => json(b, "select count(*) filter (where date > now() - interval '1 hour') from audit_log");
    verifier(recents('cible') === recents('source'), `les dates du journal d'audit sont celles d'ORIGINE (lignes datées de moins d'une heure : ${recents('cible')} ici, ${recents('source')} dans la source ; sinon ce serait ~toutes)`);
    const liens = json('cible', 'select count(*) from dossiers where fusionne_dans is not null or mere_dossier_id is not null');
    verifier(liens === json('source', 'select count(*) from dossiers where fusionne_dans is not null or mere_dossier_id is not null') && liens > 0, `les liens de fusion / mère-enfant entre dossiers sont rétablis (${liens})`);

    console.log('\n6. Garde-fous');
    const seconde = await serviceCible.restaurer('backup-2026-10-16');
    verifier(seconde.totalInsere === 0 && seconde.totalEnEchec === 0, `une 2e restauration n'ajoute rien (${seconde.totalInsere} ajoutée(s), ${seconde.rapport.reduce((s, r) => s + r.dejaPresentes, 0)} déjà présentes)`);
    const maxPaiement = json('cible', 'select max(numero_paiement) from paiements');
    const ins = psqlAdmin('cible', ['-c', "insert into paiements (episode_id, mode, montant) select id, 'cash', 10 from episodes limit 1 returning numero_paiement"]);
    const numero = Number((ins.stdout || '').trim().split('\n')[0]);
    verifier(numero > maxPaiement, `le premier paiement APRÈS restauration reçoit un numéro neuf (${numero} > ${maxPaiement})`);
    const verifSeule = await serviceCible.restaurer('backup-2026-10-16', { verifierSeulement: true });
    verifier(verifSeule.verification.ok, 'la vérification seule (sans écrire) confirme que la sauvegarde est intacte');

    // fichier abîmé : on altère un octet d'un fichier de la table fiches, puis on tente de restaurer dans une 3e base vide
    const dossierSauvegarde = path.join(stockage.racine, 'sauvegardes-automatiques', 'backup-2026-10-16');
    const abime = fs.readdirSync(dossierSauvegarde).find(f => f.startsWith('fiches.'));
    const chemin = path.join(dossierSauvegarde, abime); const original = fs.readFileSync(chemin);
    const copie = Buffer.from(original); copie[Math.floor(copie.length / 2)] ^= 0xff; fs.writeFileSync(chemin, copie);
    psqlAdmin('postgres', ['-c', 'CREATE DATABASE vide']);
    const clientVide = creerClientPg({ port: PORT, base: 'vide' }); clientVide.storage = stockage;
    reconstruireSchema('vide');
    let refus = null;
    try { await creerServiceSauvegarde({ supabase: clientVide, ...options }).restaurer('backup-2026-10-16'); } catch (e) { refus = e.message; }
    verifier(refus && /abîmée|somme de contrôle/.test(refus), 'un fichier abîmé est REFUSÉ avant toute écriture : ' + (refus || 'AUCUN REFUS').slice(0, 160));
    verifier(json('vide', 'select (select count(*) from dossiers) + (select count(*) from fiches)') === 0, "…et la base vide est restée vide");
    const verifAbimee = await creerServiceSauvegarde({ supabase: clientVide, ...options }).verifierSauvegarde('backup-2026-10-16', { profond: false });
    verifier(!verifAbimee.ok && verifAbimee.tables.some(t => t.table === 'fiches' && !t.ok), 'la vérification nomme la table abîmée (fiches)');
    fs.writeFileSync(chemin, original);
    // sauvegarde interrompue : un dossier sans manifeste n'est jamais proposé
    fs.mkdirSync(path.join(stockage.racine, 'sauvegardes-automatiques', 'backup-2026-10-17'), { recursive: true });
    fs.writeFileSync(path.join(stockage.racine, 'sauvegardes-automatiques', 'backup-2026-10-17', 'dossiers.0001.ndjson.gz'), 'x');
    const apres = await serviceSource.listerSauvegardes();
    verifier(apres.length === 1 && apres[0].nom === 'backup-2026-10-16', 'une sauvegarde interrompue (sans manifeste) n\'est pas proposée');
  } finally {
    arreter();
  }
  console.log();
  if (ECHECS.length) { console.log(`${ECHECS.length} ÉCHEC(S)`); process.exit(1); }
  console.log('Tous les contrôles passent.');
}
main().catch(e => { console.error('ERREUR :', e.stack || e.message); try { arreter(); } catch (_) {} process.exit(1); });
