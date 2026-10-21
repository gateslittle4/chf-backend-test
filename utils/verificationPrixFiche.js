// utils/verificationPrixFiche.js — le serveur ne doit plus faire confiance au montant d'une fiche calculé dans le téléphone (audit de sécurité du 21/10 : « soigner au
// tarif plein, facturer moins, empocher la différence » n'était détectable par personne). Reproduit la MÊME formule que l'app (CalculateurPanel.js/AppHospitaliere.js,
// chf-app2 : calculerPrixEffectif, calculsFacturation.js, utils/parametres.js) pour revérifier chaque fiche à la création, sans changer ce qu'une caissière peut
// légitimement faire (le bouton « Tarif Actuel / Nouveau prix » reste un vrai choix : les DEUX prix restent acceptés quand l'article le permet).
//
// Ce que ce module NE PEUT PAS vérifier, par nature : le prix d'une « Opération chirurgicale hors-catalogue » (texte libre + montant libre, un vrai acte rare qui
// n'existe dans aucune liste) — seulement borné à un montant raisonnable, jamais comparé à rien. Documenté comme limite connue, pas un oubli.

const CONFIG_LITS = {
  normal: { nom: 'Lit normal', prix: 250 },
  semi_prive: { nom: 'Salle Semi Privé', prix: 500 },
  prive: { nom: 'Salle Privé', prix: 750 },
  isolette: { nom: 'Lit Isolette', prix: 1250 },
  incubateur: { nom: 'Incubateur', prix: 2500 },
};
const CLE_PRIX_PAR_TYPE_LIT = { normal: 'prixLitNormal', semi_prive: 'prixLitSemiPrive', prive: 'prixLitPrive', isolette: 'prixLitIsolette', incubateur: 'prixLitIncubateur' };
const CLE_PRIX_PARTENAIRE_PAR_TYPE_LIT = { normal: 'prixLitPartenaireNormal', semi_prive: 'prixLitPartenaireSemiPrive', prive: 'prixLitPartenairePrive', isolette: 'prixLitPartenaireIsolette', incubateur: 'prixLitPartenaireIncubateur' };
const PARAMETRES_PAR_DEFAUT_LITS = { prixLitNormal: 250, prixLitSemiPrive: 500, prixLitPrive: 750, prixLitIsolette: 1250, prixLitIncubateur: 2500, prixLitPartenaireNormal: 250, prixLitPartenaireSemiPrive: 500, prixLitPartenairePrive: 750, prixLitPartenaireIsolette: 1250, prixLitPartenaireIncubateur: 2500 };
const MONTANT_MAX = 100000000;

function valeurParametre(parametres, cle) { return (parametres && parametres[cle] !== undefined) ? parametres[cle] : PARAMETRES_PAR_DEFAUT_LITS[cle]; }

// Même formule que chf-app2/utils/calculsFacturation.js::calculerJours.
function calculerJours(dateEntree, dateSortie) {
  if (!dateEntree || !dateSortie) return 0;
  const d = (new Date(dateSortie) - new Date(dateEntree)) / 86400000;
  return d < 0 ? 0 : Math.max(0, Math.floor(d));
}

// Même formule que chf-app2/utils/parametres.js::configLits.
function configLits(parametres) {
  const resultat = {};
  for (const [type, lit] of Object.entries(CONFIG_LITS)) {
    const cle = CLE_PRIX_PAR_TYPE_LIT[type];
    const prix = Number(valeurParametre(parametres, cle));
    resultat[type] = { ...lit, prix: (Number.isFinite(prix) && prix > 0) ? prix : lit.prix };
  }
  return resultat;
}

// Même formule que chf-app2/utils/parametres.js::ongSousContrat.
function ongSousContrat(ongDoc, maintenant = new Date()) {
  const dateFin = ongDoc && ongDoc.dateFinContrat;
  return !dateFin || new Date(dateFin) >= new Date(maintenant.toDateString());
}

// Même formule que chf-app2/utils/parametres.js::parametresPourPatient.
function parametresPourPatient(parametres, { estONG, ongDoc, maintenant } = {}) {
  // Même règle que chf-app2 (ongSousContrat) : AUCUNE fiche (ongDoc introuvable) = encore sous contrat, PAR PRUDENCE — jamais l'inverse.
  if (!estONG) return parametres;
  if (!ongSousContrat(ongDoc, maintenant || new Date())) return parametres;
  const remplaces = { ...(parametres || {}) };
  for (const [type, cle] of Object.entries(CLE_PRIX_PAR_TYPE_LIT)) {
    const prix = Number(valeurParametre(parametres, CLE_PRIX_PARTENAIRE_PAR_TYPE_LIT[type]));
    remplaces[cle] = (Number.isFinite(prix) && prix > 0) ? prix : PARAMETRES_PAR_DEFAUT_LITS[CLE_PRIX_PARTENAIRE_PAR_TYPE_LIT[type]];
  }
  return remplaces;
}

// Les prix qu'une caissière HONNÊTE peut légitimement obtenir pour cet article (chf-app2/app/AppHospitaliere.js::calculerPrixEffectif, mêmes branches) — pas UN
// prix déterministe : le bouton « Tarif Actuel / Nouveau prix » est un vrai choix laissé à qui encaisse, donc les DEUX restent acceptés quand rien ne l'empêche.
// Un article « tarifParContrat » n'a PAS ce choix : un seul prix légitime selon que le patient est encore sous contrat ou non.
function prixAutorises(item, { estONG, ongSousContratBool }) {
  const aPrixContrat = item.prixContratOng != null && item.prixContratOng !== '' && !Number.isNaN(parseFloat(item.prixContratOng));
  if (aPrixContrat && estONG && ongSousContratBool) return [parseFloat(item.prixContratOng)];
  const aNouveauPrix = item.nouveauPrix != null && item.nouveauPrix !== '' && !Number.isNaN(parseFloat(item.nouveauPrix));
  if (!aNouveauPrix) return [Number(item.prix) || 0];
  if (item.tarifParContrat) return [estONG && ongSousContratBool ? (Number(item.prix) || 0) : parseFloat(item.nouveauPrix)];
  return [Number(item.prix) || 0, parseFloat(item.nouveauPrix)];
}

const ARRONDI = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const PROCHE = (a, b) => Math.abs(ARRONDI(a) - ARRONDI(b)) <= 0.01;

// Vérifie une fiche entière (total_global + breakdown) contre raw_state — renvoie { ok: true } ou { ok: false, erreur }.
// catalogue: { med: [...], actes: [...] } (catalog.items courants) ; episode: { type_patient, ong_partenaire } ; ongDoc: { dateFinContrat } du partenaire de l'épisode, ou null.
function verifierTotalFiche({ raw_state, total_global, breakdown, episode, catalogue, parametres, ongDoc }) {
  // Pas de raw_state du tout (jamais le cas des 2 seuls appelants connus, CalculateurPanel.js et Demandes.js) : rien à vérifier, on ne bloque pas un appelant inconnu.
  if (raw_state === undefined || raw_state === null) return { ok: true, ignore: true };
  const rs = raw_state || {};
  const estONG = episode && episode.type_patient === 'partenaire';
  const ongSousContratBool = estONG && ongSousContrat(ongDoc);
  const medicaments = (catalogue && catalogue.med) || [];
  const actes = (catalogue && catalogue.actes) || [];

  const breakdownAttendu = {};
  let sommeLignes = 0;
  for (const ligne of (rs.lignesCalcul || [])) {
    const liste = ligne.type === 'med' ? medicaments : actes;
    const item = liste.find(i => i.id === ligne.itemId);
    const qte = Number(ligne.qte) || 0;
    const prixLigne = Number(ligne.prix);
    if (!Number.isFinite(prixLigne) || prixLigne < 0) return { ok: false, erreur: `Prix invalide pour « ${ligne.nom || ligne.itemId} ».` };
    const estDonLegitime = ligne.sourceDon && episode && ligne.sourceDon === episode.ong_partenaire;
    if (!item) {
      // Article supprimé/renommé depuis : impossible à vérifier contre le catalogue actuel — on garde le prix fourni (limite connue, documentée).
    } else if (estDonLegitime) {
      if (prixLigne !== 0) return { ok: false, erreur: `« ${item.nom} » est marqué comme un don mais son prix n'est pas 0.` };
    } else {
      const autorises = prixAutorises(item, { estONG, ongSousContratBool });
      if (!autorises.some(p => PROCHE(p, prixLigne))) {
        return { ok: false, erreur: `Prix refusé pour « ${item.nom} » : ${prixLigne} Gdes n'est pas un prix reconnu (attendu : ${autorises.join(' ou ')} Gdes).` };
      }
    }
    const montantLigne = qte * prixLigne;
    sommeLignes += montantLigne;
    if (ligne.type === 'med') breakdownAttendu.med = (breakdownAttendu.med || 0) + montantLigne;
    else if (breakdownAttendu[ligne.sub] !== undefined || ['service','hospit','labo','med','oxygene','curetage','accouchement','sono','cesarienne','chirurgie','ecg','suture','pansement','drainage','radio','pap','visite','nebulisation'].includes(ligne.sub)) {
      breakdownAttendu[ligne.sub] = (breakdownAttendu[ligne.sub] || 0) + montantLigne;
    } else breakdownAttendu.chirurgie = (breakdownAttendu.chirurgie || 0) + montantLigne;
  }

  const litsAttendus = configLits(parametresPourPatient(parametres, { estONG, ongDoc }));
  const litValide = (type) => litsAttendus[type] ? type : 'normal';
  const j1 = calculerJours(rs.dateEntree1, rs.dateSortie1);
  const totalE1 = j1 * (litsAttendus[litValide(rs.typeLit1)].prix || 0);
  const j2 = rs.multiPeriode ? calculerJours(rs.dateEntree2, rs.dateSortie2) : 0;
  const totalE2 = rs.multiPeriode ? j2 * (litsAttendus[litValide(rs.typeLit2)].prix || 0) : 0;
  const totalHebergement = ARRONDI(totalE1 + totalE2);
  if (totalHebergement > 0) breakdownAttendu.hospit = (breakdownAttendu.hospit || 0) + totalHebergement;

  // Chirurgie hors-catalogue : par nature invérifiable (texte libre, montant libre) — seulement bornée, jamais comparée à rien (limite connue, voir l'en-tête du fichier).
  let totalChirSpec = 0;
  if (rs.hasChirSpec) {
    totalChirSpec = parseFloat(rs.prixChirSpec);
    if (!Number.isFinite(totalChirSpec) || totalChirSpec < 0) totalChirSpec = 0;
    if (totalChirSpec > MONTANT_MAX) return { ok: false, erreur: 'Le montant de la chirurgie hors-catalogue dépasse la limite autorisée.' };
    if (totalChirSpec > 0) breakdownAttendu.chirurgie = (breakdownAttendu.chirurgie || 0) + totalChirSpec;
  }

  const totalAttendu = ARRONDI(sommeLignes + totalHebergement + totalChirSpec);
  const totalRecu = Number(total_global) || 0;
  if (!PROCHE(totalAttendu, totalRecu)) {
    return { ok: false, erreur: `Le montant de la fiche (${totalRecu} Gdes) ne correspond pas aux prix reconnus (${totalAttendu} Gdes attendus).` };
  }
  if (breakdown && typeof breakdown === 'object') {
    for (const [cle, valeur] of Object.entries(breakdown)) {
      if (!PROCHE(valeur || 0, breakdownAttendu[cle] || 0)) {
        return { ok: false, erreur: `La ventilation par service de la fiche ne correspond pas aux prix reconnus (catégorie « ${cle} »).` };
      }
    }
  }
  return { ok: true };
}


// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Le PAIEMENT contre sa FICHE (audit du 21/10, rappel d'Esdras : « pour le prix plus bas, il ne faut pas oublier l'exonération et le paiement partiel »).
// La fiche porte toujours le total BRUT ; c'est la ligne de paiement qui peut légitimement être plus basse, et seulement de 4 façons :
//   - un dépôt déjà versé qu'on déduit (details.montant_depot_utilise, jamais plus que le dépôt réellement disponible),
//   - une exonération accordée par la direction (exoneration.montantExonere, cohérente avec son pourcentage),
//   - un reste à payer plus tard : crédit (solde_restant) ou paiement partiel (details.paiement_partiel + solde_restant),
//   - ce qui est réellement versé (montant).
// Total de la fiche = montant + dépôt déduit + exonéré + reste dû. Rien d'autre ne peut faire baisser ce que le tiroir reçoit sans laisser de trace.
const MODES_VENTE = ['cash', 'moncash', 'virement', 'cheque', 'ong', 'credit', 'exoneration'];
const TOLERANCE_PAIEMENT = 0.02;

function verifierPaiementContreFiche({ corps, fiche, soldeDepotDisponible }) {
  if (!corps || !MODES_VENTE.includes(corps.mode)) return { ok: true, ignore: true };
  if (!fiche) return { ok: false, erreur: "Ce paiement doit être rattaché à sa fiche (fiche introuvable) : il n'est pas enregistré." };
  const nombre = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const montant = nombre(corps.montant);
  const total = nombre(fiche.total_global);
  const depot = nombre(corps.details && corps.details.montant_depot_utilise);
  if (depot < 0) return { ok: false, erreur: 'Dépôt déduit invalide.' };
  if (depot > nombre(soldeDepotDisponible) + TOLERANCE_PAIEMENT) {
    return { ok: false, erreur: `Le dépôt déduit (${depot} Gdes) dépasse le dépôt réellement disponible (${nombre(soldeDepotDisponible)} Gdes).` };
  }
  let exonere = 0;
  if (corps.mode === 'exoneration') {
    const ex = corps.exoneration || {};
    exonere = nombre(ex.montantExonere);
    const pct = nombre(ex.pourcentage);
    if (pct < 0 || pct > 100 || exonere < 0) return { ok: false, erreur: "Exonération invalide (pourcentage entre 0 et 100)." };
    if (Math.abs(exonere - (total * pct) / 100) > TOLERANCE_PAIEMENT) {
      return { ok: false, erreur: `Le montant exonéré (${exonere} Gdes) ne correspond pas à ${pct} % de la fiche (${total} Gdes).` };
    }
  }
  const estPartiel = !!(corps.details && corps.details.paiement_partiel === true);
  const reste = (corps.mode === 'credit' || estPartiel) ? nombre(corps.solde_restant) : 0;
  const somme = montant + depot + exonere + reste;
  if (Math.abs(somme - total) > TOLERANCE_PAIEMENT) {
    return { ok: false, erreur: `Le paiement ne correspond pas à la fiche : ${montant} payé + ${depot} de dépôt + ${exonere} exonéré + ${reste} à payer plus tard = ${somme} Gdes, mais la fiche est de ${total} Gdes.` };
  }
  return { ok: true };
}

module.exports = { MODES_VENTE, verifierPaiementContreFiche, configLits, ongSousContrat, parametresPourPatient, prixAutorises, calculerJours, verifierTotalFiche };
