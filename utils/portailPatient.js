// utils/portailPatient.js
// Portail patient (retour d'Esdras, 24/08) — comparaison de noms utilisée par
// POST /portail-patient/recherche (server.js). Extraite ici (fonction pure, sans dépendance
// réseau/base) pour rester testable directement, comme utils/validationEpisode.js.
function motsDuNom(nom) {
  return (nom || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s+/).filter(Boolean)
    .sort()
    .join(' ');
}

module.exports = { motsDuNom };
