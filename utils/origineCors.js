// utils/origineCors.js — décide si une origine de navigateur a le droit d'appeler l'API (CORS).
// Extrait de server.js pour pouvoir être testé sans démarrer le serveur.

// Aperçus de pull request Render du frontend (service « chf-app2 ») : https://chf-app2-pr-41.onrender.com.
// Seul ce motif exact est accepté, jamais un joker sur onrender.com.
const MOTIF_APERCU_PR = /^https:\/\/chf-app2-pr-\d+\.onrender\.com$/;

/**
 * @param {string|undefined} origin  En-tête Origin de la requête (absent : curl, health check, serveur à serveur)
 * @param {{ origineFrontend: string, apercusAutorises?: boolean }} options
 *   apercusAutorises : true seulement si AUTORISER_APERCUS_PR=1 sur Render (désactivé par défaut)
 */
function origineAutorisee(origin, { origineFrontend, apercusAutorises = false }) {
  if (!origin) return true;
  if (origin === origineFrontend || origin === 'https://chf-app2.onrender.com') return true;
  if (apercusAutorises && MOTIF_APERCU_PR.test(origin)) return true;
  return false;
}

module.exports = { origineAutorisee, MOTIF_APERCU_PR };
