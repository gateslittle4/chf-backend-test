// utils/sauvegarde.js — format v2 de la sauvegarde quotidienne (16/10, simulation « 5 ans »).
//
// Avant : TOUTES les tables étaient chargées en mémoire, écrites dans UN SEUL fichier JSON non compressé (backup-AAAA-MM-JJ.json), puis envoyées en bloc.
// Mesuré : 90 Mo et 325 Mo de mémoire à 1 an ; 179 Mo et 845 Mo à 2 ans (serveur de 512 Mo tué) ; 448 Mo et 2 Go à 5 ans — et la limite de 50 Mo par fichier de
// Supabase Storage (plan gratuit) aurait refusé le fichier dès ~6 mois. La restauration relisait ce fichier ENTIER en mémoire, au pire moment.
//
// Maintenant : un DOSSIER par sauvegarde, `backup-AAAA-MM-JJ/`, contenant
//   - un fichier compressé (gzip) par table et par tranche de 16 Mo de texte : `fiches.0003.ndjson.gz` (une ligne JSON par enregistrement) ;
//   - `manifeste.json`, écrit EN DERNIER : liste des fichiers, nombre de lignes, taille et somme SHA-256 de chacun. Un dossier sans manifeste est une sauvegarde
//     interrompue : elle n'est jamais proposée ni comptée comme faite.
// Le serveur ne tient jamais plus d'une tranche en mémoire (~16 Mo de texte, ~2 Mo compressés), à la sauvegarde comme à la restauration. L'ancien format
// (fichier .json unique) reste lisible et restaurable.
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const FORMAT = 2;
const NOM_MANIFESTE = 'manifeste.json';
const TAILLE_TRANCHE_MAX = 16 * 1024 * 1024; // octets de texte non compressé par fichier
const TAILLE_PAGE_LECTURE_DEFAUT = 500;
const RE_DOSSIER = /^backup-(\d{4}-\d{2}-\d{2})$/;
const RE_ANCIEN_FICHIER = /^backup-(\d{4}-\d{2}-\d{2})\.json$/;

const sha256 = (tampon) => crypto.createHash('sha256').update(tampon).digest('hex');

// Parcourt une lecture paginée page par page, SANS tout garder en mémoire. `construireRequete()` doit renvoyer une requête à tri TOTAL (sinon deux lignes de même
// valeur peuvent changer de page : l'une serait lue deux fois, une autre jamais). C'est l'unique implémentation de la pagination (lireToutesLesPages s'en sert aussi).
async function* parcourirPages(construireRequete, taillePage = TAILLE_PAGE_LECTURE_DEFAUT) {
  for (let debut = 0; ; ) {
    const { data, error } = await construireRequete().range(debut, debut + taillePage - 1);
    if (error) throw error;
    const page = data || [];
    if (page.length === 0) return;
    yield page;
    debut += page.length;
  }
}

// Transforme les pages d'UNE table en fichiers compressés (tranches de `tailleMax` octets de texte au plus). Une ligne plus grosse que la tranche occupe seule la sienne.
async function* produireTranches({ table, pages, tailleMax = TAILLE_TRANCHE_MAX }) {
  let morceaux = [], octets = 0, lignes = 0, numero = 0;
  const finir = async () => {
    numero++;
    const brut = Buffer.from(morceaux.join(''), 'utf8');
    const compresse = await gzip(brut, { level: 6 });
    const tranche = { table, fichier: `${table}.${String(numero).padStart(4, '0')}.ndjson.gz`, tampon: compresse, lignes, octetsBruts: brut.length, octets: compresse.length, sha256: sha256(compresse) };
    morceaux = []; octets = 0; lignes = 0;
    return tranche;
  };
  for await (const page of pages) {
    for (const ligne of page) {
      const texte = JSON.stringify(ligne) + '\n';
      const taille = Buffer.byteLength(texte, 'utf8');
      if (lignes > 0 && octets + taille > tailleMax) yield await finir();
      morceaux.push(texte); octets += taille; lignes++;
    }
  }
  if (lignes > 0) yield await finir();
}

// Ce qui est écrit dans le manifeste pour une tranche (jamais le contenu).
const resumeTranche = (t) => ({ fichier: t.fichier, lignes: t.lignes, octetsBruts: t.octetsBruts, octets: t.octets, sha256: t.sha256 });

function fabriquerManifeste({ genereLe, tables, tablesEnEchec = [] }) {
  const lignesParTable = {};
  let totalLignes = 0, totalOctets = 0;
  for (const [table, info] of Object.entries(tables)) {
    lignesParTable[table] = info.lignes;
    totalLignes += info.lignes;
    totalOctets += (info.tranches || []).reduce((s, t) => s + t.octets, 0);
  }
  return { format: FORMAT, genereLe, totalLignes, totalOctets, lignesParTable, tables, tablesEnEchec };
}

// Contrôle un fichier AVANT de s'en servir : taille et somme SHA-256 du manifeste. Lève une erreur claire sinon — une sauvegarde abîmée ne doit jamais être restaurée à moitié.
function verifierTranche(tampon, info) {
  if (!Buffer.isBuffer(tampon)) throw new Error(`${info.fichier} : contenu illisible.`);
  if (tampon.length !== info.octets) throw new Error(`${info.fichier} : taille ${tampon.length} octets au lieu de ${info.octets} (fichier tronqué ou modifié).`);
  if (sha256(tampon) !== info.sha256) throw new Error(`${info.fichier} : somme de contrôle différente (fichier abîmé ou modifié).`);
}

// Décompresse une tranche et renvoie ses lignes (objets). Vérifie le nombre de lignes annoncé par le manifeste.
async function lireTranche(tampon, info) {
  verifierTranche(tampon, info);
  const texte = (await gunzip(tampon)).toString('utf8');
  const lignes = [];
  for (const brut of texte.split('\n')) {
    if (brut === '') continue;
    try { lignes.push(JSON.parse(brut)); }
    catch (e) { throw new Error(`${info.fichier} : ligne ${lignes.length + 1} illisible.`); }
  }
  if (lignes.length !== info.lignes) throw new Error(`${info.fichier} : ${lignes.length} ligne(s) lue(s) au lieu de ${info.lignes}.`);
  return lignes;
}

function lireManifeste(texte) {
  let m;
  try { m = JSON.parse(texte); } catch (e) { throw new Error("Le manifeste de la sauvegarde n'est pas un JSON valide."); }
  if (!m || m.format !== FORMAT || typeof m.tables !== 'object' || m.tables === null) throw new Error("Ce manifeste n'est pas celui d'une sauvegarde (format 2).");
  return m;
}

const nomDossierSauvegarde = (dateAAAAMMJJ) => `backup-${dateAAAAMMJJ}`;
const dateDeNom = (nom) => { const m = RE_DOSSIER.exec(nom) || RE_ANCIEN_FICHIER.exec(nom); return m ? m[1] : null; };

// Quelles sauvegardes garder ? Les `quotidiennes` plus récentes, plus la plus ANCIENNE de chacun des `mensuelles` derniers mois (un problème découvert tard — donnée
// abîmée sans bruit pendant des semaines — se rattrape dans une sauvegarde d'avant). Un nom qu'on ne reconnaît pas n'est JAMAIS supprimé.
function choisirSauvegardesAGarder(noms, { quotidiennes = 30, mensuelles = 12 } = {}) {
  const reconnus = noms.map(nom => ({ nom, date: dateDeNom(nom) })).filter(x => x.date);
  const dates = [...new Set(reconnus.map(x => x.date))].sort().reverse();
  const gardees = new Set(dates.slice(0, quotidiennes));
  const parMois = new Map();
  for (const d of [...dates].reverse()) { const mois = d.slice(0, 7); if (!parMois.has(mois)) parMois.set(mois, d); }
  for (const mois of [...parMois.keys()].sort().reverse().slice(0, mensuelles)) gardees.add(parMois.get(mois));
  return {
    garder: noms.filter(n => !dateDeNom(n) || gardees.has(dateDeNom(n))),
    supprimer: reconnus.filter(x => !gardees.has(x.date)).map(x => x.nom),
  };
}

module.exports = {
  FORMAT, NOM_MANIFESTE, TAILLE_TRANCHE_MAX, RE_DOSSIER, RE_ANCIEN_FICHIER,
  sha256, parcourirPages, produireTranches, resumeTranche, fabriquerManifeste, verifierTranche, lireTranche, lireManifeste,
  nomDossierSauvegarde, dateDeNom, choisirSauvegardesAGarder,
};
