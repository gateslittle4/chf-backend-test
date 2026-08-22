// utils/validationEpisode.js
// Validation pure de la création d'un épisode — extraite de server.js pour pouvoir la tester
// sans faire tourner tout le serveur (comportement inchangé, juste séparée de la route).
// Renvoie null si valide, ou un message d'erreur (string) sinon.
function validerCreationEpisode({ dossier_id, voie_entree, service, type_consultation, type_patient }) {
  if (!dossier_id || !voie_entree || !type_patient || (!service && !type_consultation)) {
    return "dossier_id (dans l'URL), voie_entree, type_patient, et service (hospitalisation) OU type_consultation (consultation) sont requis";
  }
  return null;
}

module.exports = { validerCreationEpisode };
