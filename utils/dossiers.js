// utils/dossiers.js — règles pures sur les dossiers patients (testables sans base ni réseau).
//
// 09/10 (Esdras) : « quand le net est tombé, il n'y aura plus de connexion entre les deux ordinateurs ». La porte et la
// caisse ne se parlent QUE par internet : pendant une coupure, chacune peut créer le dossier du même patient avec le
// même numéro. Au retour d'internet, le 2e dossier envoyé était REFUSÉ (numéro déjà pris), et tout ce qui en dépend
// l'était avec lui — épisode, fiche et PAIEMENT de la caisse. Voir POST /api/dossiers (server.js).

// Forme de COMPARAISON d'un nom : sans accent, sans majuscule, sans ponctuation (« Jean-Baptiste » = « Jean Baptiste »),
// et sans ordre des mots (« BAPTISTE Jean » = « Jean Baptiste » : prénom et nom s'écrivent dans les deux ordres).
function jetonsDuNom(nom) {
  return String(nom === undefined || nom === null ? '' : nom)
    .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean).sort().join(' ');
}

// Le nom reçu est-il celui du dossier existant ? On compare aussi au nom d'ORIGINE (un bébé enregistré « Bébé Marie »
// puis renommé reste le même patient pour celui qui arrive encore avec l'ancien nom). Jamais vrai pour un nom vide.
// À n'utiliser QUE pour un dossier qui porte déjà le MÊME numéro : le numéro identifie le patient, le nom le confirme.
function memePatient(dossierExistant, nomRecu) {
  const recu = jetonsDuNom(nomRecu);
  if (!recu || !dossierExistant || typeof dossierExistant !== 'object') return false;
  return [dossierExistant.nom, dossierExistant.nom_origine].some(n => jetonsDuNom(n) === recu);
}

// Nom de personne : une majuscule au début de chaque mot, le reste en minuscules (« marie-ève o'neil » -> « Marie-Ève O'Neil »).
// Même règle que formaterNomPropre de l'application (chf-app2, utils/helpers.js) : le navigateur la fait déjà, le serveur la refait pour
// un vieux navigateur, une opération restée en file d'attente hors ligne, ou tout autre appelant (14/10, demande d'Esdras).
// Vide/absent -> '' ; les autres types (null, undefined) ne sont jamais convertis en texte « undefined ».
function formaterNomPropre(chaine) {
  if (chaine === undefined || chaine === null) return '';
  return String(chaine).trim().replace(/\s+/g, ' ').toLowerCase()
    .replace(/(^|[\s\-'’.])(\p{L})/gu, (_, separateur, lettre) => separateur + lettre.toUpperCase());
}

module.exports = { jetonsDuNom, memePatient, formaterNomPropre };
