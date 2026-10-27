// utils/autorisateursSortieCaisse.js — qui peut AUTORISER une sortie de fonds (27/10, Esdras : « Jean Jacques / Madame Dioumitrie : ce sont eux seulement qui peuvent autoriser une sortie de fonds »).
// Valable pour toute sortie d'argent saisie avec « autorisé par » : « Passer » une sortie de caisse et « Rendre le dépôt ». La liste vit ICI (et dans l'application, utils/autorisateursSortieCaisse.js, pour
// l'écran de choix) : le serveur est l'autorité et refuse tout autre nom, même si quelqu'un contourne l'écran. Pour changer la liste : modifier ce fichier ET celui de l'application.
const AUTORISATEURS_SORTIE_CAISSE = ['Jean Jacques', 'Madame Dioumitrie'];

const estAutorisateurSortieCaisse = (nom) => AUTORISATEURS_SORTIE_CAISSE.includes(String(nom || '').trim());
const MESSAGE_AUTORISATEUR_INVALIDE = `Seuls ${AUTORISATEURS_SORTIE_CAISSE.join(' et ')} peuvent autoriser une sortie de fonds : choisis l'un des deux dans « Autorisé par ».`;

module.exports = { AUTORISATEURS_SORTIE_CAISSE, estAutorisateurSortieCaisse, MESSAGE_AUTORISATEUR_INVALIDE };
