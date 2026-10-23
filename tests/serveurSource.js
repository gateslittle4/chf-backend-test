// tests/serveurSource.js — le texte COMPLET du serveur, pour les tests qui lisent le code source (extraire une route, vérifier une règle).
// Depuis la découpe du 23/10, le serveur est réparti entre server.js (configuration, sécurité, lecteurs partagés) et routes/*.js (une par domaine).
// Ici, chaque ligne de montage `require('./routes/xxx')(app, …);` de server.js est REMPLACÉE par le corps du module : le texte obtenu a l'ordre réel
// de montage des routes, et le texte d'une route est exactement celui de son fichier (en-tête d'importations et lignes d'enveloppe retirés).
const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.join(__dirname, '..');
const lire = (...p) => fs.readFileSync(path.join(RACINE, ...p), 'utf8');
const MONTAGE = /^require\('\.\/routes\/([A-Za-z]+)'\)\(app, [^\n]*\);[ \t]*$/gm;

function corpsDuModule(nom) {
  const brut = lire('routes', nom + '.js');
  const debut = brut.indexOf('module.exports = function');
  return brut.slice(debut).split('\n').filter(l => !/\/\/ @enveloppe\s*$/.test(l)).join('\n');
}

const lireServeur = () => lire('server.js').replace(MONTAGE, (_, nom) => corpsDuModule(nom));
const nomsDesModules = () => [...lire('server.js').matchAll(MONTAGE)].map(m => m[1]);

module.exports = { lireServeur, nomsDesModules, corpsDuModule };
