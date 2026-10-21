// utils/retraitFicheCaisse.js — la caisse peut retirer une fiche DÉJÀ encaissée, sous conditions.
//
// Cas réel (Esdras, 21/10) : un client prend un service, puis ne le veut plus, ou le médecin déplace
// l'acte. Jusqu'ici seule la direction (« dossier_annuler ») pouvait supprimer une fiche encaissée.
// La caisse reçoit ce droit pour les PETITS montants (paramètre « montantRetraitFicheCaisse »,
// Paramètres > Caisse, 7500 Gdes par défaut), le JOUR MÊME de l'encaissement, et jamais en silence :
// motif obligatoire + ligne dans le Journal d'audit.
const { jourHaiti } = require('./presence');

const MONTANT_RETRAIT_PAR_DEFAUT = 7500;
const MOTIF_MIN = 5;
const MOTIF_MAX = 300;
// Modes dont le retrait a des suites (facture au partenaire, remise accordée par la direction) : pas pour la caisse seule.
const MODES_RESERVES_DIRECTION = ['ong', 'exoneration'];

function limiteRetrait(parametres) {
  const v = parametres && parametres.montantRetraitFicheCaisse;
  return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : MONTANT_RETRAIT_PAR_DEFAUT;
}

function estDette(p) {
  return p.mode === 'credit' || (Number(p.solde_restant) || 0) > 0 || !!(p.details && p.details.paiement_partiel);
}

// `paiements` = paiements valides de CETTE fiche (ni annulés ni à la corbeille).
// `rejeu` : rejeu de la file hors ligne — le délai « jour même » ne s'applique pas (le retrait a été fait à l'écran le bon jour,
// le serveur ne le refuse jamais une fois la connexion revenue), mais le plafond, lui, reste vérifié et l'écart est signalé.
// Retourne { ok: true, horsDelai } ou { ok: false, code, message }.
function evaluerRetraitCaisse({ fiche, paiements, episode, parametres, motif, maintenantMs = Date.now(), rejeu = false }) {
  const refus = (code, message) => ({ ok: false, code, message });
  const texte = String(motif || '').trim();
  if (texte.length < MOTIF_MIN) return refus('MOTIF_REQUIS', `Un motif d'au moins ${MOTIF_MIN} caractères est obligatoire.`);
  if (texte.length > MOTIF_MAX) return refus('MOTIF_TROP_LONG', `Motif trop long (${MOTIF_MAX} caractères au maximum).`);

  const limite = limiteRetrait(parametres);
  const total = Number(fiche.total_global) || 0;
  if (!(total < limite)) {
    return refus('MONTANT_AU_DESSUS_LIMITE', `Cette fiche (${total} Gdes) dépasse le montant que la caisse peut retirer (${limite} Gdes). Voir la direction.`);
  }
  if (episode && (episode.verrouille_facture || episode.numero_lot)) {
    return refus('DOSSIER_VERROUILLE', 'Ce dossier est déjà facturé au partenaire : la fiche ne peut plus être retirée par la caisse.');
  }
  const liste = paiements || [];
  if (liste.some(p => MODES_RESERVES_DIRECTION.includes(p.mode))) {
    return refus('MODE_RESERVE', 'Une fiche payée par un partenaire ou exonérée ne se retire pas depuis la caisse. Voir la direction.');
  }
  if (liste.some(estDette)) {
    return refus('PAIEMENT_A_CREDIT', 'Cette fiche est à crédit ou en paiement partiel : le retirer change la dette du patient. Voir la direction.');
  }

  const aujourdhui = jourHaiti(maintenantMs);
  const dates = liste.length > 0 ? liste.map(p => p.date_paiement) : [fiche.date_creation];
  const memeJour = dates.every(d => d && jourHaiti(new Date(d).getTime()) === aujourdhui);
  if (!memeJour && !rejeu) {
    return refus('HORS_DELAI', "La caisse ne peut retirer une fiche que le jour même de l'encaissement. Voir la direction.");
  }
  return { ok: true, horsDelai: !memeJour, limite, total };
}

module.exports = { evaluerRetraitCaisse, limiteRetrait, MONTANT_RETRAIT_PAR_DEFAUT, MOTIF_MIN, MOTIF_MAX };
