// utils/retraitFicheCaisse.js — la caisse peut retirer (ou CORRIGER) une fiche DÉJÀ encaissée, sous conditions.
//
// Cas réel (Esdras, 21/10) : un client prend un service, puis ne le veut plus, ou le médecin déplace
// l'acte. Jusqu'ici seule la direction (« dossier_annuler ») pouvait supprimer une fiche encaissée.
// La caisse reçoit ce droit pour les PETITS montants (paramètre « montantRetraitFicheCaisse »,
// Paramètres > Caisse, 7500 Gdes par défaut), le JOUR MÊME de l'encaissement (ou pendant sa session de
// caisse ouverte), et jamais en silence : motif obligatoire + ligne dans le Journal d'audit.
// 22/10 (Esdras) : « Toute fiche de la même journée ou session peut être corrigée » → tous les modes de
// paiement (crédit, partiel, partenaire, exonération compris) : la caisse accorde déjà les exonérations, et la dette
// du patient est recalculée par la base (sql/retrait_fiche_solde.sql). « Corriger » = retirer, puis refaire la fiche à la même place.
const { jourHaiti } = require('./presence');

const MONTANT_RETRAIT_PAR_DEFAUT = 7500;
const MOTIF_MIN = 5;
const MOTIF_MAX = 300;

function limiteRetrait(parametres) {
  const v = parametres && parametres.montantRetraitFicheCaisse;
  return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : MONTANT_RETRAIT_PAR_DEFAUT;
}

// Refus levés par sql/retrait_fiche_solde.sql (le serveur répond 409 avec le message de la base).
const CODES_REFUS_SOLDE = ['CHF11', 'CHF12'];
const estRefusSolde = (erreur) => !!erreur && CODES_REFUS_SOLDE.includes(String(erreur.code || ''));

// `paiements` = paiements valides de CETTE fiche (ni annulés ni à la corbeille).
// `debutSessionMs` : ouverture du poste de caisse ouvert de la personne (ms) — un encaissement fait depuis cette ouverture compte comme « même session ».
// `rejeu` : rejeu de la file hors ligne — le délai « jour même » ne s'applique pas (le retrait a été fait à l'écran le bon jour,
// le serveur ne le refuse jamais une fois la connexion revenue), mais le plafond, lui, reste vérifié et l'écart est signalé.
// Retourne { ok: true, horsDelai } ou { ok: false, code, message }.
function evaluerRetraitCaisse({ fiche, paiements, episode, parametres, motif, maintenantMs = Date.now(), debutSessionMs = null, rejeu = false }) {
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
  if (liste.some(p => p.mode === 'remboursement_credit')) {
    return refus('PAIEMENT_NON_CORRIGEABLE', "Un remboursement de crédit ne se corrige pas depuis une fiche. Voir la direction.");
  }

  const aujourdhui = jourHaiti(maintenantMs);
  const dates = liste.length > 0 ? liste.map(p => p.date_paiement) : [fiche.date_creation];
  const debutSession = Number.isFinite(debutSessionMs) ? debutSessionMs : null;
  const memeJourOuSession = dates.every(d => {
    if (!d) return false;
    const t = new Date(d).getTime();
    return jourHaiti(t) === aujourdhui || (debutSession !== null && t >= debutSession);
  });
  if (!memeJourOuSession && !rejeu) {
    return refus('HORS_DELAI', "La caisse ne peut corriger une fiche que le jour même de l'encaissement, ou pendant la session de caisse où elle a été encaissée. Voir la direction.");
  }
  return { ok: true, horsDelai: !memeJourOuSession, limite, total };
}

module.exports = { evaluerRetraitCaisse, limiteRetrait, estRefusSolde, CODES_REFUS_SOLDE, MONTANT_RETRAIT_PAR_DEFAUT, MOTIF_MIN, MOTIF_MAX };
