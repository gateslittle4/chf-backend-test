// tests/sauvegarde_v2.test.js — format v2 de la sauvegarde : fichiers compressés par table, manifeste avec sommes de contrôle (voir utils/sauvegarde.js).
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const S = require('../utils/sauvegarde');

const lignes = (n, debut = 0) => Array.from({ length: n }, (_, i) => ({ id: `id-${debut + i}`, nom: `Patient é ${debut + i}`, montant: 12.5, details: { note: 'x'.repeat(40), ok: true }, vide: null }));
async function* pages(tout, taille = 500) { for (let i = 0; i < tout.length; i += taille) yield tout.slice(i, i + taille); }
async function tout(it) { const r = []; for await (const x of it) r.push(x); return r; }

test("aller-retour : ce qui est écrit puis relu est IDENTIQUE (accents, null, JSON imbriqué, nombres)", async () => {
  const source = lignes(1234);
  const tranches = await tout(S.produireTranches({ table: 'dossiers', pages: pages(source) }));
  assert.strictEqual(tranches.length, 1);
  assert.strictEqual(tranches[0].fichier, 'dossiers.0001.ndjson.gz');
  const relu = await S.lireTranche(tranches[0].tampon, S.resumeTranche(tranches[0]));
  assert.deepStrictEqual(relu, source);
});

test("découpage : une table qui dépasse la taille maximale est répartie en plusieurs fichiers, sans perdre ni dupliquer une ligne", async () => {
  const source = lignes(3000);
  const tranches = await tout(S.produireTranches({ table: 'fiches', pages: pages(source, 400), tailleMax: 100 * 1024 }));
  assert.ok(tranches.length > 3, 'plusieurs fichiers : ' + tranches.length);
  assert.deepStrictEqual(tranches.map(t => t.fichier), tranches.map((_, i) => `fiches.${String(i + 1).padStart(4, '0')}.ndjson.gz`));
  for (const t of tranches) assert.ok(t.octetsBruts <= 100 * 1024 + 400, 'chaque tranche reste sous la limite (à une ligne près)');
  const relues = [];
  for (const t of tranches) relues.push(...await S.lireTranche(t.tampon, S.resumeTranche(t)));
  assert.deepStrictEqual(relues, source);
  assert.strictEqual(tranches.reduce((s, t) => s + t.lignes, 0), 3000);
});

test("une table vide ne produit aucun fichier ; une ligne plus grosse que la tranche occupe seule la sienne", async () => {
  assert.deepStrictEqual(await tout(S.produireTranches({ table: 'x', pages: pages([]) })), []);
  const grosse = [{ id: 'a', gros: 'y'.repeat(5000) }, { id: 'b' }];
  const t = await tout(S.produireTranches({ table: 'x', pages: pages(grosse), tailleMax: 1000 }));
  assert.strictEqual(t.length, 2);
  assert.deepStrictEqual(await S.lireTranche(t[0].tampon, S.resumeTranche(t[0])), [grosse[0]]);
});

test("la compression est réelle : le fichier est beaucoup plus petit que le texte", async () => {
  const [t] = await tout(S.produireTranches({ table: 'audit_log', pages: pages(lignes(5000)) }));
  assert.ok(t.octets * 5 < t.octetsBruts, `${t.octets} octets compressés pour ${t.octetsBruts} de texte`);
});

test("un fichier TRONQUÉ, MODIFIÉ ou dont les lignes ne correspondent pas au manifeste est refusé avec un message clair", async () => {
  const [t] = await tout(S.produireTranches({ table: 'paiements', pages: pages(lignes(200)) }));
  const info = S.resumeTranche(t);
  await assert.rejects(S.lireTranche(t.tampon.subarray(0, t.tampon.length - 10), info), /taille .* au lieu de/);
  const modifie = Buffer.from(t.tampon); modifie[modifie.length - 20] ^= 0xff;
  await assert.rejects(S.lireTranche(modifie, info), /somme de contrôle différente/);
  await assert.rejects(S.lireTranche(t.tampon, { ...info, lignes: 199 }), /200 ligne\(s\) lue\(s\) au lieu de 199/);
  await assert.rejects(S.lireTranche('pas un tampon', info), /illisible/);
  // somme et taille cohérentes avec un contenu qui n'est pas du gzip : refusé aussi
  const faux = Buffer.from("ceci n'est pas du gzip");
  await assert.rejects(S.lireTranche(faux, { fichier: 'f', octets: faux.length, sha256: S.sha256(faux), lignes: 0 }));
});

test("manifeste : totaux, lignes par table, tables en échec ; relu seulement s'il est bien de format 2", () => {
  const m = S.fabriquerManifeste({
    genereLe: '2026-10-16T06:00:00Z',
    tables: { dossiers: { lignes: 3, tranches: [{ fichier: 'dossiers.0001.ndjson.gz', lignes: 3, octets: 100 }] }, episodes: { lignes: 0, tranches: [] } },
    tablesEnEchec: ['fiches (boum)'],
  });
  assert.strictEqual(m.format, 2); assert.strictEqual(m.totalLignes, 3); assert.strictEqual(m.totalOctets, 100);
  assert.deepStrictEqual(m.lignesParTable, { dossiers: 3, episodes: 0 }); assert.deepStrictEqual(m.tablesEnEchec, ['fiches (boum)']);
  assert.deepStrictEqual(S.lireManifeste(JSON.stringify(m)), m);
  assert.throws(() => S.lireManifeste('{pas du json'), /JSON valide/);
  assert.throws(() => S.lireManifeste(JSON.stringify({ format: 1, tables: {} })), /format 2/);
  assert.throws(() => S.lireManifeste(JSON.stringify({ dossiers: [] })), /format 2/);
});

test("pagination : toutes les pages jusqu'à la fin, dans l'ordre, une page à la fois ; une erreur est relayée, jamais avalée", async () => {
  const base = lignes(1250); const appels = [];
  const construire = () => ({ range: async (a, b) => { appels.push([a, b]); return { data: base.slice(a, b + 1), error: null }; } });
  const lues = []; for await (const p of S.parcourirPages(construire, 500)) lues.push(p.length);
  assert.deepStrictEqual(lues, [500, 500, 250]);
  assert.deepStrictEqual(appels, [[0, 499], [500, 999], [1000, 1499], [1250, 1749]]);
  const casse = () => ({ range: async () => ({ data: null, error: new Error('lecture impossible') }) });
  await assert.rejects(tout(S.parcourirPages(casse)), /lecture impossible/);
});

test("conservation : 30 sauvegardes quotidiennes + la plus ancienne de chacun des 12 derniers mois ; un nom inconnu n'est jamais supprimé", () => {
  const noms = [];
  for (let j = 0; j < 400; j++) { const d = new Date(Date.UTC(2026, 9, 16) - j * 86400000).toISOString().slice(0, 10); noms.push(j % 2 ? `backup-${d}` : `backup-${d}.json`); }
  noms.push('README.txt', 'backup-brouillon');
  const { garder, supprimer } = S.choisirSauvegardesAGarder(noms);
  const dates = (liste) => new Set(liste.map(S.dateDeNom).filter(Boolean));
  assert.ok(garder.includes('README.txt') && garder.includes('backup-brouillon'), 'noms inconnus jamais supprimés');
  assert.ok(!supprimer.includes('README.txt'));
  assert.ok(dates(garder).has('2026-10-16') && dates(garder).has('2026-09-17'), 'les 30 derniers jours');
  const moisGardes = new Set([...dates(garder)].map(d => d.slice(0, 7)));
  assert.ok(moisGardes.size >= 12, 'au moins 12 mois représentés : ' + moisGardes.size);
  assert.ok(dates(garder).size <= 30 + 12, 'pas plus de 42 dates gardées : ' + dates(garder).size);
  assert.strictEqual(garder.length + supprimer.length, noms.length);
  assert.ok(supprimer.length > 300, 'le plus ancien est bien nettoyé');
});

test("conservation : la même date gardée en ancien et nouveau format est gardée DES DEUX côtés ; rien à supprimer sur une petite liste", () => {
  const { garder, supprimer } = S.choisirSauvegardesAGarder(['backup-2026-10-15.json', 'backup-2026-10-15', 'backup-2026-10-16']);
  assert.deepStrictEqual(supprimer, []); assert.strictEqual(garder.length, 3);
});

test("noms : dossier et date", () => {
  assert.strictEqual(S.nomDossierSauvegarde('2026-10-16'), 'backup-2026-10-16');
  assert.strictEqual(S.dateDeNom('backup-2026-10-16'), '2026-10-16');
  assert.strictEqual(S.dateDeNom('backup-2026-10-16.json'), '2026-10-16');
  assert.strictEqual(S.dateDeNom('backup-2026-10-16/manifeste.json'), null);
  assert.strictEqual(S.dateDeNom('autre'), null);
});
