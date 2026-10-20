// tests/sauvegarde_service.test.js — le SERVICE de sauvegarde / restauration (utils/sauvegardeServeur.js) exécuté pour de vrai contre une fausse base en mémoire.
// Remplace les anciens tests qui lisaient le texte de server.js (16/10, sauvegarde compressée). Le test complet contre deux vraies bases PostgreSQL est
// scripts/restauration/essai-restauration.js (à lancer à la main).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../utils/sauvegarde');
const { creerServiceSauvegarde } = require('../utils/sauvegardeServeur');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ---------------------------------------------------------------------------------------------------------------------------------
// Fausse base : tables en mémoire (select / order / range / insert / update / eq) + Storage en mémoire. `.in()` n'existe PAS : l'appeler fait échouer le test.
// ---------------------------------------------------------------------------------------------------------------------------------
function fauxSupabase({ tables = {}, illisibles = [], refus = () => null, fichiers = new Map() } = {}) {
  const appels = { order: [], insert: [] };
  const construire = (nom) => {
    let colonnes = '*', ordre = [], filtres = [], mode = 'select', lignesAInserer = [], maj = null;
    const q = {
      select(c) { if (mode === 'insert') { colonnes = c; return q; } colonnes = c; return q; },
      order(c) { ordre.push(c); appels.order.push([nom, c]); return q; },
      eq(c, v) { filtres.push([c, v]); return q; },
      insert(lignes) { mode = 'insert'; lignesAInserer = lignes; return q; },
      update(m) { mode = 'update'; maj = m; return q; },
      range: async (a, b) => {
        if (illisibles.includes(nom)) return { data: null, error: new Error('table illisible') };
        const lues = (tables[nom] || []).slice(a, b + 1).map(l => (colonnes === '*' ? { ...l } : Object.fromEntries(colonnes.split(',').map(c => [c, l[c]]))));
        return { data: lues, error: null };
      },
      then(ok, ko) { return Promise.resolve(executer()).then(ok, ko); },
    };
    const executer = () => {
      if (mode === 'insert') {
        const erreur = refus(nom, lignesAInserer); if (erreur) return { data: null, error: new Error(erreur) };
        (tables[nom] = tables[nom] || []).push(...lignesAInserer.map(l => ({ ...l })));
        return { data: lignesAInserer.map(l => ({ ...l })), error: null };
      }
      if (mode === 'update') {
        for (const l of tables[nom] || []) if (filtres.every(([c, v]) => l[c] === v)) Object.assign(l, maj);
        return { data: null, error: null };
      }
      return { data: (tables[nom] || []).filter(l => filtres.every(([c, v]) => l[c] === v)).map(l => ({ ...l })), error: null };
    };
    return q;
  };
  const buckets = new Set();
  const stockage = (bucket) => ({
    upload: async (chemin, contenu) => { fichiers.set(`${bucket}/${chemin}`, Buffer.from(contenu)); return { error: null }; },
    download: async (chemin) => { const c = fichiers.get(`${bucket}/${chemin}`); return c ? { data: { arrayBuffer: async () => c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) }, error: null } : { data: null, error: { message: 'introuvable' } }; },
    remove: async (chemins) => { chemins.forEach(c => fichiers.delete(`${bucket}/${c}`)); return { error: null }; },
    list: async (prefixe) => {
      const base = `${bucket}/${prefixe ? prefixe + '/' : ''}`;
      const noms = new Map();
      for (const [cle, contenu] of fichiers) if (cle.startsWith(base)) { const reste = cle.slice(base.length); const premier = reste.split('/')[0]; noms.set(premier, reste.includes('/') ? null : contenu.length); }
      return { data: [...noms].map(([name, taille]) => ({ name, created_at: '2026-10-16T08:00:00Z', metadata: taille === null ? null : { size: taille } })), error: null };
    },
  });
  return {
    tables, fichiers, appels,
    from: construire,
    rpc: async () => ({ data: null, error: { code: '42883', message: 'function does not exist' } }),
    storage: { listBuckets: async () => ({ data: [...buckets].map(name => ({ name })), error: null }), createBucket: async (n) => { buckets.add(n); return { error: null }; }, from: stockage },
  };
}

const ORDRE = [['ong_partenaires', 'id'], ['dossiers', 'id'], ['episodes', 'id'], ['catalog', 'type'], ['doublons_ignores', 'dossier_a,dossier_b'], ['compteurs', 'id']];
const calmes = { log() {}, warn() {}, error() {} };
const lignes = (n, debut = 0) => Array.from({ length: n }, (_, i) => ({ id: `id-${debut + i}`, nom: `Patiente é ${debut + i}` }));
const service = (supabase, extra = {}) => creerServiceSauvegarde({
  supabase, bucket: 'sauvegardes-automatiques', tables: ORDRE.map(([t]) => t), ordreRestauration: ORDRE, journal: calmes,
  maintenant: () => new Date('2026-10-17T02:30:00Z'), // 22h30 le 16/10 en Haïti : le fichier doit porter la date d'Haïti, pas celle d'UTC
  ...extra,
});
const donneesDepart = () => ({
  ong_partenaires: [{ id: 'o1', nom: 'AVSI' }], dossiers: lignes(2500), episodes: lignes(30), catalog: [{ type: 'actes', items: [] }],
  doublons_ignores: [{ dossier_a: 'a', dossier_b: 'b' }], compteurs: [{ id: 'dossiers', derniernumero: 7, updated_at: '2026-10-16T00:00:00Z' }],
});

test("sauvegarde : une table de PLUS de 1000 lignes est sauvegardée EN ENTIER, triée sur sa vraie clé (même composée), nommée d'après la date d'HAÏTI", async () => {
  const base = fauxSupabase({ tables: donneesDepart() });
  const r = await service(base).sauvegarder();
  assert.strictEqual(r.fichier, 'backup-2026-10-16', "22h30 à Haïti le 16/10 = déjà le 17/10 en UTC : le nom doit garder le 16");
  assert.strictEqual(r.nombreLignes.dossiers, 2500);
  assert.deepStrictEqual(r.tablesEnEchec, []);
  assert.ok(r.verification.ok, 'la relecture de ce qui vient d\'être écrit est conforme');
  const cles = base.appels.order.filter(([t]) => ['catalog', 'doublons_ignores', 'dossiers'].includes(t)).map(([t, c]) => `${t}:${c}`);
  for (const attendu of ['catalog:type', 'doublons_ignores:dossier_a', 'doublons_ignores:dossier_b', 'dossiers:id']) assert.ok(cles.includes(attendu), `tri total sur ${attendu}`);
  assert.ok(base.fichiers.has('sauvegardes-automatiques/backup-2026-10-16/manifeste.json'), 'le manifeste est écrit');
});

test("sauvegarde : une table illisible ne fait pas échouer toute la sauvegarde, et le trou est annoncé ; si RIEN n'est lisible, elle échoue franchement", async () => {
  const base = fauxSupabase({ tables: donneesDepart(), illisibles: ['episodes'] });
  const r = await service(base).sauvegarder();
  assert.strictEqual(r.tablesEnEchec.length, 1); assert.match(r.tablesEnEchec[0], /^episodes \(/);
  assert.strictEqual(r.nombreLignes.dossiers, 2500);
  assert.strictEqual(r.verification.ok, false, 'la relecture signale la table non sauvegardée');
  const toutCasse = fauxSupabase({ tables: donneesDepart(), illisibles: ORDRE.map(([t]) => t) });
  await assert.rejects(service(toutCasse).sauvegarder(), /Aucune table n'a pu être lue/);
});

test("copie hors Supabase : non configurée = sauvegarde normale ; configurée = chaque fichier envoyé ; en panne = la sauvegarde réussit quand même et le dit", async () => {
  const envoyes = [];
  const ok = await service(fauxSupabase({ tables: donneesDepart() }), { ouvrirCopieHorsSite: async () => ({ envoyer: async (c) => { envoyes.push(c); }, terminer: async () => {} }) }).sauvegarder();
  assert.ok(ok.copie.configuree && ok.copie.envoyee && !ok.copie.erreur);
  assert.ok(envoyes.includes('backup-2026-10-16/manifeste.json'), 'le manifeste part aussi, en dernier'); assert.strictEqual(envoyes[envoyes.length - 1], 'backup-2026-10-16/manifeste.json');
  const sans = await service(fauxSupabase({ tables: donneesDepart() })).sauvegarder();
  assert.strictEqual(sans.copie.configuree, false); assert.strictEqual(sans.copie.erreur, null);
  const enPanne = await service(fauxSupabase({ tables: donneesDepart() }), { ouvrirCopieHorsSite: async () => ({ envoyer: async () => { throw new Error('B2 hors service'); } }) }).sauvegarder();
  assert.strictEqual(enPanne.copie.envoyee, false); assert.match(enPanne.copie.erreur, /B2 hors service/);
  assert.ok(enPanne.verification.ok, 'la sauvegarde principale n\'est pas touchée');
  const ouvertureEnPanne = await service(fauxSupabase({ tables: donneesDepart() }), { ouvrirCopieHorsSite: async () => { throw new Error('authentification refusée'); } }).sauvegarder();
  assert.match(ouvertureEnPanne.copie.erreur, /authentification refusée/); assert.ok(ouvertureEnPanne.verification.ok);
});

test("liste, dernière sauvegarde, sauvegarde du jour : seules les sauvegardes COMPLÈTES (avec manifeste) comptent ; la date est celle d'Haïti", async () => {
  const base = fauxSupabase({ tables: donneesDepart() });
  const svc = service(base);
  assert.strictEqual(await svc.dateDerniereSauvegarde(), null, 'bucket vide : jamais réussie');
  assert.strictEqual(await svc.sauvegardeDuJourExisteDeja(), false);
  await svc.sauvegarder();
  base.fichiers.set('sauvegardes-automatiques/backup-2026-10-20/dossiers.0001.ndjson.gz', Buffer.from('x')); // sauvegarde interrompue : pas de manifeste
  base.fichiers.set('sauvegardes-automatiques/backup-2026-10-01.json', Buffer.from('{}'));
  const liste = await svc.listerSauvegardes();
  assert.deepStrictEqual(liste.map(s => [s.nom, s.format]), [['backup-2026-10-16', 2], ['backup-2026-10-01.json', 1]]);
  assert.strictEqual(await svc.dateDerniereSauvegarde(), '2026-10-16');
  assert.strictEqual(await svc.sauvegardeDuJourExisteDeja(), true);
  const demain = service(base, { maintenant: () => new Date('2026-10-17T12:00:00Z') });
  assert.strictEqual(await demain.sauvegardeDuJourExisteDeja(), false);
});

test("restauration : n'écrase JAMAIS une ligne déjà présente, ajoute ce qui manque, relit ce qui a vraiment été écrit — et une 2e restauration n'ajoute rien", async () => {
  const source = fauxSupabase({ tables: donneesDepart() });
  await service(source).sauvegarder();
  const cible = fauxSupabase({ fichiers: source.fichiers, tables: { dossiers: [{ id: 'id-3', nom: 'MODIFIÉ APRÈS LA SAUVEGARDE' }], compteurs: [{ id: 'dossiers', derniernumero: 0, updated_at: '2026-10-01T00:00:00Z' }] } });
  const r = await service(cible).restaurer('backup-2026-10-16');
  assert.strictEqual(r.totalEnEchec, 0);
  const dossiers = r.rapport.find(x => x.table === 'dossiers');
  assert.deepStrictEqual([dossiers.lignesSauvegarde, dossiers.dejaPresentes, dossiers.inserees], [2500, 1, 2499]);
  assert.strictEqual(cible.tables.dossiers.length, 2500);
  assert.strictEqual(cible.tables.dossiers.find(d => d.id === 'id-3').nom, 'MODIFIÉ APRÈS LA SAUVEGARDE', 'la ligne déjà là n\'est pas écrasée');
  assert.strictEqual(cible.tables.compteurs[0].derniernumero, 7, 'un compteur ne repart jamais de zéro : la valeur la plus haute l\'emporte');
  const encore = await service(cible).restaurer('backup-2026-10-16');
  assert.strictEqual(encore.totalInsere, 0); assert.strictEqual(encore.totalEnEchec, 0);
  cible.tables.compteurs[0].derniernumero = 99;
  await service(cible).restaurer('backup-2026-10-16');
  assert.strictEqual(cible.tables.compteurs[0].derniernumero, 99, 'un compteur plus avancé que la sauvegarde ne recule jamais');
});

test("restauration : un lot refusé en bloc est retenté ligne par ligne — une seule mauvaise ligne ne bloque pas les autres, et elle est nommée dans le rapport", async () => {
  const source = fauxSupabase({ tables: donneesDepart() });
  await service(source).sauvegarder();
  const cible = fauxSupabase({ fichiers: source.fichiers, refus: (table, lot) => (table === 'dossiers' && lot.some(l => l.id === 'id-42') ? 'contrainte violée' : null) });
  const r = await service(cible).restaurer('backup-2026-10-16');
  const dossiers = r.rapport.find(x => x.table === 'dossiers');
  assert.strictEqual(dossiers.inserees, 2499); assert.deepStrictEqual(dossiers.lignesEnEchec.map(l => l.id), ['id-42']);
  assert.strictEqual(r.totalEnEchec, 1);
});

test("restauration : un fichier ABÎMÉ est refusé AVANT toute écriture ; la vérification seule ne modifie rien", async () => {
  const source = fauxSupabase({ tables: donneesDepart() });
  await service(source).sauvegarder();
  const cle = [...source.fichiers.keys()].find(k => k.includes('/dossiers.0001'));
  const abime = Buffer.from(source.fichiers.get(cle)); abime[abime.length - 12] ^= 0xff; source.fichiers.set(cle, abime);
  const cible = fauxSupabase({ fichiers: source.fichiers });
  await assert.rejects(service(cible).restaurer('backup-2026-10-16'), /Sauvegarde abîmée, rien n'a été restauré/);
  assert.deepStrictEqual(cible.tables, {}, 'aucune ligne écrite');
  const v = await service(cible).restaurer('backup-2026-10-16', { verifierSeulement: true });
  assert.strictEqual(v.verification.ok, false); assert.ok(v.verification.tables.find(t => t.table === 'dossiers' && !t.ok));
  assert.deepStrictEqual(cible.tables, {});
});

test("restauration d'une ANCIENNE sauvegarde (un seul fichier .json) : toujours possible, et un fichier qui n'en est pas une est refusé", async () => {
  const fichiers = new Map();
  fichiers.set('sauvegardes-automatiques/backup-2026-09-01.json', Buffer.from(JSON.stringify({ genere_le: 'x', dossiers: lignes(3), catalog: [{ type: 'actes' }] })));
  fichiers.set('sauvegardes-automatiques/backup-2026-09-02.json', Buffer.from(JSON.stringify({ rien: [] })));
  const cible = fauxSupabase({ fichiers });
  const r = await service(cible).restaurer('backup-2026-09-01.json');
  assert.strictEqual(r.format, 1); assert.strictEqual(r.totalInsere, 4); assert.strictEqual(cible.tables.dossiers.length, 3);
  await assert.rejects(service(cible).restaurer('backup-2026-09-02.json'), /ne ressemble pas à une sauvegarde automatique/);
  await assert.rejects(service(cible).restaurer('n-importe-quoi'), /Nom de sauvegarde non reconnu/);
});

test("conservation : après une sauvegarde, les sauvegardes qu'aucune règle ne garde sont supprimées (dossier ET fichiers), les autres jamais", async () => {
  const fichiers = new Map();
  for (let j = 1; j <= 45; j++) { const d = new Date(Date.UTC(2026, 9, 16) - j * 86400000).toISOString().slice(0, 10); fichiers.set(`sauvegardes-automatiques/backup-${d}/manifeste.json`, Buffer.from('{}')); fichiers.set(`sauvegardes-automatiques/backup-${d}/dossiers.0001.ndjson.gz`, Buffer.from('x')); }
  fichiers.set('sauvegardes-automatiques/README.txt', Buffer.from('à garder'));
  const base = fauxSupabase({ tables: donneesDepart(), fichiers });
  const r = await service(base).sauvegarder();
  assert.ok(r.nettoyage.supprimees.length > 0);
  assert.ok(base.fichiers.has('sauvegardes-automatiques/README.txt'), 'un nom inconnu n\'est jamais touché');
  assert.ok(base.fichiers.has('sauvegardes-automatiques/backup-2026-10-16/manifeste.json'));
  for (const nom of r.nettoyage.supprimees) assert.ok(![...base.fichiers.keys()].some(k => k.startsWith(`sauvegardes-automatiques/${nom}/`)), `${nom} entièrement supprimé`);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Câblage dans server.js (le texte du code, pour ce qu'un test d'exécution ne peut pas voir)
// ---------------------------------------------------------------------------------------------------------------------------------
const blocRoute = (debut, fin) => { const i = serverSrc.indexOf(debut); assert.ok(i !== -1, debut); return serverSrc.slice(i, fin ? serverSrc.indexOf(fin, i + 10) : serverSrc.length); };

test("câblage : les 4 routes d'administration exigent sauvegarde_gerer ; la restauration exige un fichier explicite et ne renvoie JAMAIS un « success » muet", () => {
  for (const [debut, fin] of [["app.post('/api/admin/backup-manuel'", "app.get('/api/admin/derniere-sauvegarde'"], ["app.get('/api/admin/derniere-sauvegarde'", '// (La liste ORDRE_RESTAURATION'], ["app.get('/api/admin/sauvegardes'", "app.post('/api/admin/restaurer-sauvegarde'"], ["app.post('/api/admin/restaurer-sauvegarde'", 'const PORT =']]) {
    assert.match(blocRoute(debut, fin), /aPermission\(req\.user\.id, 'sauvegarde_gerer'\)/, debut);
  }
  const restaurer = blocRoute("app.post('/api/admin/restaurer-sauvegarde'", 'const PORT =');
  assert.match(restaurer, /if \(!fichier \|\| typeof fichier !== 'string'\) return res\.status\(400\)/, "jamais de restauration à l'aveugle");
  assert.doesNotMatch(restaurer, /res\.json\(\{\s*success:\s*true/);
  assert.match(restaurer, /verifierSeulement: verifierSeulement === true/);
  const manuel = blocRoute("app.post('/api/admin/backup-manuel'", "app.get('/api/admin/derniere-sauvegarde'");
  assert.match(manuel, /copieEnvoyee: !!resultat\.copie\.envoyee, erreurCopie: resultat\.copie\.erreur/, "l'écran lit toujours copieEnvoyee / erreurCopie");
});

test("câblage : minuteur quotidien, rattrapage au réveil, une seule sauvegarde à la fois, aucune écriture sur le disque du serveur", () => {
  assert.match(serverSrc, /cron\.schedule\('0 6 \* \* \*'/);
  assert.match(serverSrc, /setTimeout\(rattraperSauvegardeAuDemarrage, DELAI_RATTRAPAGE_DEMARRAGE_MS\)\.unref\(\)/);
  assert.match(serverSrc, /if \(sauvegardeEnCours\) return sauvegardeEnCours;/, "minuteur, rattrapage et bouton manuel peuvent tomber en même temps");
  assert.doesNotMatch(serverSrc, /require\('fs'\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'utils', 'sauvegardeServeur.js'), 'utf8'), /require\('(node:)?fs'\)/);
  assert.match(serverSrc, /fuseau: FUSEAU_HAITI/, "le nom de la sauvegarde suit la date d'Haïti");
  const fonction = blocRoute('async function executerSauvegardeQuotidienne', "cron.schedule('0 6 * * *'");
  assert.match(fonction, /resultat\.tablesEnEchec && resultat\.tablesEnEchec\.length > 0/, "une sauvegarde partielle déclenche une alerte");
  assert.match(fonction, /resultat\.verification && !resultat\.verification\.ok/, "une relecture en défaut déclenche une alerte");
  assert.match(fonction, /resultat\.copie && resultat\.copie\.erreur/, "une copie hors Supabase en panne déclenche une alerte distincte");
});

test("câblage : ORDRE_RESTAURATION couvre exactement les tables sauvegardées, partenaires AVANT épisodes et paiements, dossiers → épisodes → fiches → paiements, bonnes clés", () => {
  const bloc = blocRoute('const ORDRE_RESTAURATION = [', '];');
  const ordre = [...bloc.matchAll(/\['(\w+)', '([\w,]+)'\]/g)].map(m => [m[1], m[2]]);
  const noms = ordre.map(([t]) => t);
  const sauvegardees = [...blocRoute('const TABLES_A_SAUVEGARDER = [', '];').matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.strictEqual(new Set(noms).size, noms.length, 'aucune table deux fois');
  assert.deepStrictEqual([...noms].sort(), [...sauvegardees].sort(), 'toutes les tables sauvegardées sont restaurées, et inversement');
  for (const t of ['compteurs', 'doublons_ignores', 'migrations_appliquees']) assert.ok(noms.includes(t), t);
  const pos = (t) => noms.indexOf(t);
  assert.ok(pos('ong_partenaires') < pos('episodes') && pos('ong_partenaires') < pos('paiements'), "le déclencheur retrouve l'identifiant du partenaire d'après son nom : il doit déjà exister");
  assert.ok(pos('dossiers') < pos('episodes') && pos('episodes') < pos('fiches') && pos('fiches') < pos('paiements'));
  for (const t of ['pieces_jointes']) assert.ok(pos('dossiers') < pos(t));
  for (const t of ['transferts_service', 'demandes_exoneration']) assert.ok(pos('episodes') < pos(t));
  const cle = Object.fromEntries(ordre);
  assert.deepStrictEqual([cle.catalog, cle.invitations, cle.decrements_stock_appliques, cle.doublons_ignores, cle.migrations_appliquees], ['type', 'token', 'local_id', 'dossier_a,dossier_b', 'nom']);
  const cles = blocRoute('const CLE_PRIMAIRE_SAUVEGARDE = {', '};');
  for (const [t, c] of Object.entries({ catalog: 'type', invitations: 'token', decrements_stock_appliques: 'local_id', doublons_ignores: 'dossier_a,dossier_b', migrations_appliquees: 'nom' })) assert.match(cles, new RegExp(`${t}: '${c}'`));
});

test("copie B2 : protocole natif (autorisation → bucket par nom → URL d'envoi → SHA1), une session pour toute la sauvegarde, garde-fous de durée, notification SANS pièce jointe", () => {
  const bloc = blocRoute('async function ouvrirSessionB2()', 'const serviceSauvegarde = ');
  assert.match(bloc, /if \(!keyId \|\| !applicationKey \|\| !nomBucket\) \{[\s\S]*?console\.warn\([\s\S]*?return null;/, 'variables absentes : avertissement, jamais une erreur');
  assert.match(bloc, /b2_authorize_account/); assert.match(bloc, /Authorization: `Basic \$\{identifiants\}`/);
  assert.match(bloc, /b2_list_buckets/); assert.match(bloc, /b2_get_upload_url/); assert.match(bloc, /'X-Bz-Content-Sha1': sha1/);
  assert.match(bloc, /crypto\.createHash\('sha1'\)\.update\(contenu\)\.digest\('hex'\)/, 'le SHA1 porte sur le contenu réellement envoyé');
  assert.match(bloc, /new AbortController\(\)[\s\S]*?signal: controleur\.signal/, "l'envoi des fichiers a son propre garde-fou");
  assert.doesNotMatch(bloc, /attachments:/); assert.doesNotMatch(bloc, /toString\('base64'\)\s*[,}]/);
  assert.match(bloc, /FUSEAU_HAITI/, 'le texte de la notification est daté en heure d\'Haïti');
  const appel = blocRoute('async function appelB2(', 'async function ouvrirSessionB2');
  assert.match(appel, /new AbortController\(\)/); assert.match(appel, /setTimeout\(\(\) => controleur\.abort\(\), gardeFouMs\)/); assert.match(appel, /clearTimeout\(gardeFou\)/);
  assert.match(serverSrc, /révocable seule/i, 'la clé B2 limitée à un bucket reste documentée');
});

test("câblage : les 21 tables sauvegardées incluent compteurs, doublons_ignores, migrations_appliquees et autres_revenus", () => {
  const sauvegardees = [...blocRoute('const TABLES_A_SAUVEGARDER = [', '];').matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.strictEqual(sauvegardees.length, 21);
  for (const t of ['compteurs', 'doublons_ignores', 'migrations_appliquees', 'autres_revenus']) assert.ok(sauvegardees.includes(t), t);
});
