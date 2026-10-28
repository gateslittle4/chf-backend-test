// utils/reglagesDirection.js — réglages de la direction que le SERVEUR relit lui-même (28/10, Esdras : « que beaucoup de choses soient modifiables sans passer par Claude »).
// Stockés dans le catalogue « parametres » (Paramètres, réservé à parametres_gerer). Le serveur fait foi : il relit la valeur au moment d'agir et ne se fie jamais à l'écran. Un réglage absent ou invalide
// donne la valeur d'origine ci-dessous — donc rien ne change tant que la direction n'y touche pas.
//   exonerationPourcentageMaxCaisse (100)  plus gros % d'exonération que la CAISSE peut accorder (la direction, elle, va toujours jusqu'à 100 %).
//   plafondCreditEpisode (0)               plus grosse dette (en gourdes) qu'un épisode peut porter après un crédit ou un paiement partiel de la caisse ; 0 = pas de limite. La direction n'est pas limitée.
//   fermetureAutoPostes (true)             false : plus aucun poste n'est fermé automatiquement — chaque personne ferme le sien après avoir compté l'argent (28/10, Esdras).
//   heureFinPosteJour (16), heureFinPosteNuit (8)   heures d'Haïti (0 à 23) où un poste oublié ouvert est fermé automatiquement (voir utils/fermetureAutoPostes.js).
const DEFAUTS = { exonerationPourcentageMaxCaisse: 100, plafondCreditEpisode: 0, fermetureAutoPostes: true, heureFinPosteJour: 16, heureFinPosteNuit: 8 };

async function lireReglagesDirection(supabase) {
  try {
    const { data } = await supabase.from('catalog').select('items').eq('type', 'parametres').maybeSingle();
    return data && data.items && !Array.isArray(data.items) ? data.items : {};
  } catch (_) { return {}; }
}

function nombreOuDefaut(valeur, defaut, { min, max, entier = false } = {}) {
  const n = typeof valeur === 'number' ? valeur : (typeof valeur === 'string' && valeur.trim() !== '' ? Number(valeur) : NaN);
  if (!Number.isFinite(n) || (entier && !Number.isInteger(n)) || (min !== undefined && n < min) || (max !== undefined && n > max)) return defaut;
  return n;
}

// Pourcentage d'exonération (0 à 100) : une valeur à 0 bloquerait toute exonération de la caisse — c'est permis (la direction peut vouloir tout garder pour elle).
const exonerationMaxCaisse = (reglages) => nombreOuDefaut(reglages && reglages.exonerationPourcentageMaxCaisse, DEFAUTS.exonerationPourcentageMaxCaisse, { min: 0, max: 100 });
const plafondCredit = (reglages) => nombreOuDefaut(reglages && reglages.plafondCreditEpisode, DEFAUTS.plafondCreditEpisode, { min: 0 });
// Active sauf si la direction l'a EXPLICITEMENT coupée (une valeur absente ou illisible garde la fermeture automatique : jamais de poste oublié ouvert par accident).
const fermetureAutoActive = (reglages) => !(reglages && reglages.fermetureAutoPostes === false);
function heuresFinPoste(reglages) {
  return {
    jour: nombreOuDefaut(reglages && reglages.heureFinPosteJour, DEFAUTS.heureFinPosteJour, { min: 0, max: 23, entier: true }),
    nuit: nombreOuDefaut(reglages && reglages.heureFinPosteNuit, DEFAUTS.heureFinPosteNuit, { min: 0, max: 23, entier: true }),
  };
}

const messageExonerationTropElevee = (pourcentage, max) => `La caisse peut accorder une exonération de ${max} % au plus (demandée : ${pourcentage} %). Au-delà, la direction doit l'accorder.`;
const messagePlafondCredit = (dette, plafond) => `Cette fiche laisserait ${dette} Gdes à crédit sur cet épisode ; la limite fixée par la direction est de ${plafond} Gdes. Encaisse davantage maintenant, ou demande à la direction.`;

module.exports = { DEFAUTS, lireReglagesDirection, nombreOuDefaut, exonerationMaxCaisse, plafondCredit, heuresFinPoste, fermetureAutoActive, messageExonerationTropElevee, messagePlafondCredit };
