// utils/numeroDossier.js — numéro de dossier DONNÉ PAR LA CAISSE (16/10, Esdras).
//
// Règle d'Esdras : « seule la caisse donne un numéro, et c'est quand la personne a payé qu'elle reçoit son numéro ; infirmier et archive ne peuvent ni donner ni
// changer un numéro. Le site le donne automatiquement, c'est moi qui définis où ça commence, et la caisse peut le modifier. »
//
// Un dossier créé par l'infirmier ou l'archive n'a donc pas encore de numéro. Comme le numéro est la clé de recherche, d'unicité, des brouillons et des reçus, il garde
// un numéro PROVISOIRE (« EN-ATTENTE-… », même principe que les « AUTO-… » des ventes comptoir) jusqu'à ce que la caisse lui donne le vrai. L'application l'affiche
// partout comme « En attente de numéro », jamais tel quel.
const crypto = require('node:crypto');

const PREFIXE_EN_ATTENTE = 'EN-ATTENTE-';
const PREFIXE_VENTE_COMPTOIR = 'AUTO-';
const LONGUEUR_MAX = 30;

const estEnAttente = (numero) => typeof numero === 'string' && numero.startsWith(PREFIXE_EN_ATTENTE);

// Numéro provisoire, unique pour de bon (10 caractères au hasard) : plusieurs dossiers peuvent attendre en même temps.
const numeroProvisoire = (alea = crypto.randomBytes(5).toString('hex').toUpperCase()) => `${PREFIXE_EN_ATTENTE}${alea}`;

// Numéro saisi par la caisse : non vide, 30 caractères au plus, jamais un numéro réservé (provisoire ou vente comptoir). Renvoie un message, ou null si tout va bien.
function erreurNumeroDossier(valeur) {
  if (valeur === undefined || valeur === null || typeof valeur === 'object') return 'Le numéro de dossier est requis.';
  const numero = String(valeur).trim();
  if (!numero) return 'Le numéro de dossier est requis.';
  if (numero.length > LONGUEUR_MAX) return `Le numéro de dossier est trop long (${LONGUEUR_MAX} caractères au plus).`;
  const majuscules = numero.toUpperCase();
  if (majuscules.startsWith(PREFIXE_EN_ATTENTE) || majuscules.startsWith(PREFIXE_VENTE_COMPTOIR)) return `Un numéro ne peut pas commencer par « ${majuscules.startsWith(PREFIXE_EN_ATTENTE) ? PREFIXE_EN_ATTENTE : PREFIXE_VENTE_COMPTOIR} » (réservé par le site).`;
  return null;
}

// Numéro de départ choisi par l'administrateur : un entier positif raisonnable.
function erreurNumeroDepart(valeur) {
  const n = typeof valeur === 'number' ? valeur : (typeof valeur === 'string' && /^\d+$/.test(valeur.trim()) ? Number(valeur.trim()) : NaN);
  if (!Number.isInteger(n) || n < 1) return 'Le numéro de départ doit être un nombre entier, 1 ou plus.';
  if (n > 999999999) return 'Le numéro de départ est trop grand (999 999 999 au plus).';
  return null;
}

module.exports = { PREFIXE_EN_ATTENTE, PREFIXE_VENTE_COMPTOIR, LONGUEUR_MAX, estEnAttente, numeroProvisoire, erreurNumeroDossier, erreurNumeroDepart };
