// utils/soldeAtomique.js — compagnon de sql/solde_atomique.sql (13/10) : le paiement et son solde s'écrivent en une seule opération de la base, avec un
// verrou par épisode (voir ce fichier SQL pour le pourquoi). Ici : reconnaître les réponses de cette fonction.

// Refus de remboursement de crédit levés par la fonction (400 avec son message).
const CODES_REFUS_REMBOURSEMENT = ['CHF01', 'CHF02', 'CHF03'];

// La fonction n'existe pas encore en base (script SQL pas encore collé) : le serveur retombe sur l'ancien chemin (lecture puis écriture), jamais une erreur.
// PostgREST : PGRST202 (fonction introuvable dans le cache de schéma) ; Postgres : 42883 (fonction inexistante).
function estFonctionAbsente(erreur) {
  if (!erreur) return false;
  const code = String(erreur.code || '');
  if (code === 'PGRST202' || code === '42883') return true;
  return /enregistrer_paiement_atomique/.test(String(erreur.message || '')) && /could not find|does not exist|n'existe pas|introuvable/i.test(String(erreur.message || ''));
}

const estRefusRemboursement = (erreur) => !!erreur && CODES_REFUS_REMBOURSEMENT.includes(String(erreur.code || ''));

// 22/10 : la caisse compte en dollars haïtiens, l'écran convertit tout montant suivi de « Gdes » (utils/monnaie.js de l'application). Le message de la base
// (« Le remboursement (300) dépasse le solde restant (200). ») n'a pas d'unité : on la lui donne, sinon la caissière lirait des gourdes comme des dollars.
const messageRefusRemboursement = (erreur) => String((erreur && erreur.message) || '').replace(/\((\d+(?:[.,]\d+)?)\)/g, '($1 Gdes)');

module.exports = { CODES_REFUS_REMBOURSEMENT, estFonctionAbsente, estRefusRemboursement, messageRefusRemboursement };
