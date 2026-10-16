// Ce que coûte, dans le navigateur et sur le serveur, la LISTE COMPLÈTE des épisodes + paiements (stockée dans localStorage toutes les 45 s par AppHospitaliere.js).
// Dépôt de l'application (pour la vraie fonction fusionnerEpisodes) : variable CHF_APP, par défaut le dépôt voisin.
const path = require('node:path');
const { fusionnerEpisodes } = require(path.join(process.env.CHF_APP || path.join(__dirname, '..', '..', '..', 'chf-app2'), 'utils', 'fusionEpisodes'));
const zlib = require('zlib');
function episode(i) { // ~3 Ko : épisode + dossier + 2,3 fiches avec détail (mesuré en production : épisode 0,8 Ko, fiche 0,8 Ko)
  const fiches = Array.from({ length: 1 + (i % 3) }, (_, k) => ({ id: `f-${i}-${k}`, numeroFiche: k + 1, dateCreation: '2026-10-14T17:28:01.531337+00:00', creePar: 'infirmier@chf.org', total: 1200 + k, breakdown: { lignes: Array.from({ length: 6 }, (_, l) => ({ id: l, label: 'Acte ' + l, prix: 150 + l, qte: 1 })) }, modePaiement: 'cash', rawState: { note: 'x'.repeat(150) } }));
  return { id: `e-${i}`, dossierId: `d-${i % 40000}`, nomPatient: 'Patient ' + i, numeroDossier: 'D' + i, dateNaissance: '1980-01-01', telephone: '34567890', adresse: 'Adresse ' + (i % 900), sexe: 'M', voieEntree: 'consultation', service: 'General', typePatient: 'prive', statut: 'ferme', estHospitalisation: false, timestamp: 1760000000000 - i * 60000, dateOuverture: '2026-10-14T17:28:01.504175+00:00', fiches, modifieLe: '2026-10-14T17:28:01.504175+00:00' };
}
function paiement(i) { return { id: `p-${i}`, numero_paiement: i, episode_id: `e-${i % 70000}`, mode: 'cash', montant: 1200, date_paiement: '2026-10-14T17:28:01.978367+00:00', details: { note: 'y'.repeat(120) }, annule: false, encaisse_par: 'caisse@chf.org', patient_nom: 'Patient X', modifie_le: '2026-10-14T17:28:01.978367+00:00' }; }
const mo = (o) => (o / 1048576).toFixed(0) + ' Mo';
const ms = (t) => Math.round(Number(process.hrtime.bigint() - t) / 1e6) + ' ms';
console.log('épisodes | JSON épisodes+paiements | gzip (réseau) | écrire localStorage (stringify) | relire (parse) | fusionnerEpisodes | mémoire occupée');
for (const n of [1000, 5000, 20000, 70000, 175000]) {
  global.gc && global.gc();
  const avant = process.memoryUsage().heapUsed;
  const eps = Array.from({ length: n }, (_, i) => episode(i));
  const pas = Array.from({ length: Math.round(n * 1.5) }, (_, i) => paiement(i));
  const memoire = process.memoryUsage().heapUsed - avant;
  let t = process.hrtime.bigint();
  const a = JSON.stringify(eps), b = JSON.stringify(pas);
  const tStringify = ms(t);
  const octets = a.length + b.length;
  const gz = zlib.gzipSync(Buffer.from(a + b), { level: 1 }).length;
  t = process.hrtime.bigint(); JSON.parse(a); JSON.parse(b); const tParse = ms(t);
  t = process.hrtime.bigint(); fusionnerEpisodes(eps, eps.slice(0, 50), new Set(), new Set()); const tFusion = ms(t);
  console.log(`${String(n).padStart(7)} | ${mo(octets).padStart(7)} (${(a.length/n/1024).toFixed(1)} Ko/épisode) | ${mo(gz).padStart(6)} | ${tStringify.padStart(8)} ${octets > 5 * 1048576 ? '→ DÉPASSE les ~5 Mo de localStorage' : ''} | ${tParse.padStart(7)} | ${tFusion.padStart(7)} | ${mo(memoire)}`);
}
