// utils/paiementPartiel.js — paiement partiel (13/10) : le patient verse une PARTIE du montant maintenant
// (acompte d'une césarienne, par exemple) et le reste devient une créance, réglée plus tard ou à la sortie.
//
// Une SEULE ligne de paiement porte les deux : montant = ce qui est réellement versé (il entre dans le tiroir
// ou dans les recettes MonCash / virement / chèque, et dans la ventilation par service, comme tout paiement),
// solde_restant = ce qu'il reste à payer (c'est lui que lisent les Créances, la Fiche Patient et le
// remboursement de crédit). Une seule ligne, donc annuler ce paiement annule aussi la créance qui va avec :
// pas de dette fantôme si la caissière s'est trompée. Aucun nouveau mode (la contrainte SQL
// paiements_mode_check ne change pas) : le marqueur est details.paiement_partiel.
const MODES_PAIEMENT_PARTIEL = ['cash', 'moncash', 'virement', 'cheque'];

function estPaiementPartiel(corps) {
  return !!(corps && corps.details && typeof corps.details === 'object' && corps.details.paiement_partiel === true);
}

// null si le paiement est valide (ou s'il n'est pas partiel), sinon le message à renvoyer (400).
function validerPaiementPartiel(corps) {
  if (!estPaiementPartiel(corps)) return null;
  if (!MODES_PAIEMENT_PARTIEL.includes(corps.mode)) {
    return `Un paiement partiel se fait en espèces, MonCash, virement ou chèque (pas en « ${corps.mode} »).`;
  }
  if (!corps.episode_id) return 'episode_id requis pour un paiement partiel.';
  if (!(parseFloat(corps.montant) > 0)) return 'Un paiement partiel doit avoir un montant versé supérieur à 0 (sinon, utilise le mode Crédit).';
  if (!(parseFloat(corps.solde_restant) > 0)) return 'Un paiement partiel doit laisser un reste à payer supérieur à 0 (sinon, c\'est un paiement complet).';
  return null;
}

// Ce que CE paiement ajoute au solde dû de l'épisode (le serveur l'ajoute à ce qui était déjà dû) :
// un crédit ajoute sa dette, un paiement partiel ajoute son reste, tout autre mode n'ajoute rien.
function soldeAjouteParPaiement(corps) {
  if (corps.mode === 'credit' || estPaiementPartiel(corps)) return parseFloat(corps.solde_restant) || 0;
  return 0;
}

module.exports = { MODES_PAIEMENT_PARTIEL, estPaiementPartiel, validerPaiementPartiel, soldeAjouteParPaiement };
