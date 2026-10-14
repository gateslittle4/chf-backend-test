// utils/erreursClient.js — nettoyage et empreinte des erreurs envoyées par les postes (14/10). Fonctions pures.
//
// Une erreur d'application ne doit JAMAIS emporter de données de patient : un message comme « Cannot read properties of undefined (reading 'nom') »
// est sans danger, mais « Dossier Marie Joseph, tél 34567890 introuvable » ne l'est pas. On retire donc adresses e-mail et suites de 5 chiffres ou plus,
// on coupe les longueurs, et on ne garde dans la pile que les lignes de code (jamais le texte des valeurs).
const crypto = require('crypto');

const LIMITE_MESSAGE = 500;
const LIMITE_PILE = 4000;

function nettoyerTexte(texte, limite) {
  return String(texte === undefined || texte === null ? '' : texte)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[e-mail]')
    .replace(/\d{5,}/g, '[nombre]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, limite);
}

// Première ligne de la pile qui désigne du code (« at fonction (fichier:ligne:colonne) »), sans les numéros de ligne/colonne ni la version du fichier : une
// même erreur garde la même empreinte d'une version à l'autre de l'application.
function premierCadre(pile) {
  const ligne = String(pile || '').split('\n').find(l => /\bat\b|@/.test(l) && /\.js|<anonymous>|bundle/.test(l));
  return ligne ? ligne.replace(/https?:\/\/[^\s)]+\//g, '').replace(/\?v=[\w.-]+/g, '').replace(/:\d+(:\d+)?/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

function normaliserMessage(message) {
  return nettoyerTexte(message, LIMITE_MESSAGE).toLowerCase().replace(/\[nombre\]|\d+/g, '#').replace(/['"`][^'"`]{0,80}['"`]/g, '"…"').replace(/\s+/g, ' ').trim();
}

function empreinte(message, pile, source) {
  return crypto.createHash('sha1').update(`${source || 'js'}|${normaliserMessage(message)}|${premierCadre(pile)}`).digest('hex').slice(0, 20);
}

const SOURCES = ['js', 'promesse', 'react'];

// Corps reçu → valeurs prêtes pour la base, ou { erreur } si inutilisable.
function preparerErreur(corps) {
  const c = corps || {};
  const message = nettoyerTexte(c.message, LIMITE_MESSAGE).trim();
  if (!message) return { erreur: 'Le message est requis.' };
  const source = SOURCES.includes(c.source) ? c.source : 'js';
  const pile = nettoyerTexte(c.pile, LIMITE_PILE);
  const nombre = Math.max(1, Math.min(50, Number.parseInt(c.nombre, 10) || 1));
  const court = (v, n) => (v === undefined || v === null || v === '' ? null : String(v).replace(/[^\w .:/@#+-]/g, '').slice(0, n) || null);
  return { message, pile, source, nombre, empreinte: empreinte(message, pile, source), onglet: court(c.onglet, 60), version_app: court(c.version_app, 40), poste_id: court(c.poste_id, 64) };
}

module.exports = { nettoyerTexte, premierCadre, normaliserMessage, empreinte, preparerErreur, SOURCES };
