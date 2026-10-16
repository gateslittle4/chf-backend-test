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


// 15/10 (Esdras : « comment peut-on enregistrer un dossier sans sexe, sans numéro d'archive, sans date de naissance ? ») : à la CRÉATION d'un dossier, le sexe (M ou F) et la date
// de naissance sont obligatoires. 16/10 : le NUMÉRO ne l'est plus — c'est la caisse qui le donne après le paiement (voir utils/numeroDossier.js), le dossier reste « en attente » d'ici là — vérifié ICI, pas seulement à l'écran : un ancien écran resté ouvert,
// un appel direct ou une file d'attente hors ligne ne doivent pas pouvoir contourner la règle. Une date ESTIMÉE (âge approximatif) reste une date valide.
// Renvoie un message d'erreur en français, ou null si tout est en règle.
function erreurIdentiteDossier({ sexe, date_naissance } = {}, maintenantMs = Date.now()) {
  if (sexe !== 'M' && sexe !== 'F') return "Le sexe est obligatoire (M ou F).";
  const d = String(date_naissance || '');
  if (!d) return "La date de naissance est obligatoire (ou un âge approximatif, converti en date estimée).";
  const date = /^\d{4}-\d{2}-\d{2}/.test(d) ? new Date(`${d.slice(0, 10)}T12:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== d.slice(0, 10)) return "La date de naissance n'est pas valide (format AAAA-MM-JJ).";
  if (date.getUTCFullYear() < 1900 || date.getTime() > maintenantMs + 2 * 86400000) return "La date de naissance n'est pas valide (pas dans le futur, après 1900).";
  return null;
}

module.exports = { jetonsDuNom, memePatient, formaterNomPropre, erreurIdentiteDossier };
