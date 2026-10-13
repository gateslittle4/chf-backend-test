// utils/validationMontant.js — contrôle des montants d'un paiement côté SERVEUR (13/10). Avant, POST /api/paiements enregistrait le montant tel quel :
// un appel direct à l'API (jeton valide, droit « caisse ») pouvait envoyer un montant négatif, illisible (« abc »), infini ou absurde, et fausser les totaux
// de la caisse, l'écart et les soldes. L'écran ne laisse jamais faire cela ; le serveur ne doit pas lui faire confiance (Esdras : « la vraie sécurité »).
// Double verrou : ce contrôle (message clair, 400) ET une contrainte en base (sql/controles_montants.sql) au cas où une autre route oublierait de contrôler.
const MONTANT_MAX = 100000000;          // 100 millions de gourdes : très au-delà d'une facture d'hôpital, bien en dessous des limites de la colonne
const MODES_MONTANT_POSITIF = ['depot', 'remboursement_credit', 'remboursement_patient']; // un dépôt ou un remboursement de 0 n'a aucun sens

const arrondi2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Lit un montant : nombre fini, ou texte strictement numérique (« 1250 », « 1250.50 »). Jamais « 1e3 », « 0x10 », « abc », vide, null, objet.
function lireMontant(valeur) {
  if (typeof valeur === 'number') return Number.isFinite(valeur) ? valeur : null;
  if (typeof valeur === 'string' && /^-?\d+(\.\d+)?$/.test(valeur.trim())) return Number(valeur.trim());
  return null;
}

// Renvoie un message d'erreur (à renvoyer en 400) ou null si le montant est acceptable.
function validerMontantPaiement(corps) {
  if (!corps || typeof corps !== 'object') return 'Paiement illisible.';
  if (corps.montant === undefined || corps.montant === null || corps.montant === '') return 'Le montant du paiement est requis.';
  const montant = lireMontant(corps.montant);
  if (montant === null) return 'Le montant du paiement doit être un nombre.';
  if (montant < 0) return 'Le montant du paiement ne peut pas être négatif.';
  if (montant > MONTANT_MAX) return `Le montant du paiement dépasse la limite autorisée (${MONTANT_MAX.toLocaleString('fr-FR')} Gdes).`;
  if (MODES_MONTANT_POSITIF.includes(corps.mode) && !(montant > 0)) return 'Le montant doit être supérieur à 0 pour ce type de paiement.';
  if (corps.solde_restant !== undefined && corps.solde_restant !== null && corps.solde_restant !== '') {
    const solde = lireMontant(corps.solde_restant);
    if (solde === null || Math.abs(solde) > MONTANT_MAX) return 'Le solde restant du paiement est invalide.';
  }
  return null;
}

// Applique le montant lu et arrondi au centime (la colonne est numeric(12,2)) — appelé APRÈS validerMontantPaiement.
function normaliserMontant(corps) {
  corps.montant = arrondi2(lireMontant(corps.montant));
  return corps;
}

module.exports = { MONTANT_MAX, MODES_MONTANT_POSITIF, lireMontant, validerMontantPaiement, normaliserMontant, arrondi2 };
