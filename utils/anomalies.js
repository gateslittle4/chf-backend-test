// utils/anomalies.js — rapport de contrôle des ANOMALIES de caisse, par personne et par mois (15/10, Esdras : un rapport pour lui seul, pas encore pour la direction).
// Pourquoi : dans deux ans il y aura plus d'argent et plus de personnel. Une personne qui annule ou exonère bien plus que les autres doit se voir sans fouiller le journal.
// Ce sont des SIGNAUX, pas des preuves : un chiffre élevé a souvent une explication (un poste très chargé, un cas particulier). Le rapport dit « à regarder », jamais « fautif ».
// Fonctions pures : le serveur lit les tables et passe les lignes ici.
const SEUIL_MIN_PAIEMENTS = 5;       // en dessous, une personne n'a pas assez d'activité pour qu'un taux veuille dire quelque chose
const FACTEUR_SIGNAL = 2;            // signalé quand le taux d'une personne est au moins 2 fois celui de l'équipe (médiane des autres)
const SEUIL_MIN_EVENEMENTS = 2;      // et qu'il y a au moins 2 événements (une seule annulation ne suffit jamais)

const nombre = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arrondi = (n) => Math.round(n * 100) / 100;
const mediane = (liste) => { const t = [...liste].sort((a, b) => a - b); if (t.length === 0) return 0; const m = Math.floor(t.length / 2); return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2; };

// « AAAA-MM » d'une date (heure d'Haïti), ou null.
function moisDe(valeur, fuseau = 'America/Port-au-Prince') {
  const d = new Date(valeur);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: fuseau, year: 'numeric', month: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}`;
}
const moisPrecedent = (mois) => { const [a, m] = mois.split('-').map(Number); return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`; };

function ligneVide(cle, nom, role) {
  return { cle, nom, role: role || null, nbPaiements: 0, montantEncaisse: 0, nbAnnulationsFaites: 0, montantAnnulations: 0, nbExonerations: 0, montantExonere: 0,
    nbCredits: 0, montantCredit: 0, nbRemboursementsPatient: 0, montantRemboursementsPatient: 0, nbSorties: 0, montantSorties: 0, nbFermeturesAuto: 0 };
}

// paiements : lignes de `paiements` ; depenses : `depenses_caisse` ; sessions : éléments du catalogue sessions_caisse ; utilisateurs : `users`.
function calculerAnomalies({ paiements = [], depenses = [], sessions = [], utilisateurs = [], mois }) {
  const parUid = new Map((utilisateurs || []).map(u => [u.id, u]));
  const lignes = new Map();
  const ligne = (uid, nomRepli) => {
    const cle = uid || `nom:${nomRepli || 'inconnu'}`;
    if (!lignes.has(cle)) { const u = uid ? parUid.get(uid) : null; lignes.set(cle, ligneVide(cle, (u && u.display_name) || nomRepli || 'Inconnu', u && u.role)); }
    return lignes.get(cle);
  };
  const dansMois = (v) => moisDe(v) === mois;

  for (const p of paiements || []) {
    if (!p || p.supprime_le || !dansMois(p.date_paiement)) continue;
    const montant = nombre(p.montant);
    const l = ligne(p.traite_par_uid, p.encaisse_par);
    if (p.mode === 'remboursement_patient') { l.nbRemboursementsPatient += 1; l.montantRemboursementsPatient += montant; }
    else if (p.mode !== 'remboursement_credit') { l.nbPaiements += 1; l.montantEncaisse += montant; }
    if (p.mode === 'credit') { l.nbCredits += 1; l.montantCredit += montant; }
    if (p.mode === 'exoneration' || p.exoneration) { l.nbExonerations += 1; l.montantExonere += nombre(p.exoneration && (p.exoneration.montantExonere ?? p.exoneration.montant_exonere)); }
    if (p.annule) {
      // L'annulation est attribuée à CELLE QUI L'A FAITE (annule_par_uid), pas à l'encaisseuse d'origine.
      const a = ligne(p.annule_par_uid, p.annule_par);
      a.nbAnnulationsFaites += 1; a.montantAnnulations += montant;
    }
  }
  for (const d of depenses || []) {
    if (!d || d.statut !== 'accorde' || !dansMois(d.date_reponse || d.date_demande)) continue;
    const l = ligne(d.caissier_uid, d.caissier); l.nbSorties += 1; l.montantSorties += nombre(d.montant);
  }
  for (const s of sessions || []) {
    if (!s || !s.fermetureAuto || !dansMois(s.ouvertureISO)) continue;
    ligne(s.uid, s.nom).nbFermeturesAuto += 1;
  }

  const liste = [...lignes.values()].map(l => ({
    ...l,
    montantEncaisse: arrondi(l.montantEncaisse), montantAnnulations: arrondi(l.montantAnnulations), montantExonere: arrondi(l.montantExonere),
    montantCredit: arrondi(l.montantCredit), montantRemboursementsPatient: arrondi(l.montantRemboursementsPatient), montantSorties: arrondi(l.montantSorties),
    tauxAnnulation: l.nbPaiements > 0 ? arrondi(l.nbAnnulationsFaites / l.nbPaiements) : null,
    tauxExoneration: l.nbPaiements > 0 ? arrondi(l.nbExonerations / l.nbPaiements) : null,
    tauxCredit: l.nbPaiements > 0 ? arrondi(l.nbCredits / l.nbPaiements) : null,
  }));

  // Médiane de l'équipe (personnes ayant assez d'activité), pour chaque taux.
  const actifs = liste.filter(l => l.nbPaiements >= SEUIL_MIN_PAIEMENTS);
  const equipe = {
    personnesComparees: actifs.length,
    medianeAnnulation: arrondi(mediane(actifs.map(l => l.tauxAnnulation))),
    medianeExoneration: arrondi(mediane(actifs.map(l => l.tauxExoneration))),
    medianeCredit: arrondi(mediane(actifs.map(l => l.tauxCredit))),
  };
  const aRegarder = (taux, mediane, nb) => taux !== null && nb >= SEUIL_MIN_EVENEMENTS && actifs.length >= 3 && taux > 0 && taux >= Math.max(mediane * FACTEUR_SIGNAL, mediane + 0.02);
  for (const l of liste) {
    l.signaux = [];
    if (l.nbPaiements >= SEUIL_MIN_PAIEMENTS) {
      if (aRegarder(l.tauxAnnulation, equipe.medianeAnnulation, l.nbAnnulationsFaites)) l.signaux.push({ cle: 'annulations', texte: `${l.nbAnnulationsFaites} annulation(s) pour ${l.nbPaiements} paiements (${Math.round(l.tauxAnnulation * 100)} % — équipe : ${Math.round(equipe.medianeAnnulation * 100)} %)` });
      if (aRegarder(l.tauxExoneration, equipe.medianeExoneration, l.nbExonerations)) l.signaux.push({ cle: 'exonerations', texte: `${l.nbExonerations} exonération(s) pour ${l.nbPaiements} paiements (${Math.round(l.tauxExoneration * 100)} % — équipe : ${Math.round(equipe.medianeExoneration * 100)} %)` });
      if (aRegarder(l.tauxCredit, equipe.medianeCredit, l.nbCredits)) l.signaux.push({ cle: 'credits', texte: `${l.nbCredits} crédit(s) pour ${l.nbPaiements} paiements (${Math.round(l.tauxCredit * 100)} % — équipe : ${Math.round(equipe.medianeCredit * 100)} %)` });
    }
    if (l.nbFermeturesAuto > 0) l.signaux.push({ cle: 'fermetures_auto', texte: `${l.nbFermeturesAuto} poste(s) fermé(s) automatiquement (argent non compté)` });
  }
  liste.sort((a, b) => b.signaux.length - a.signaux.length || b.montantEncaisse - a.montantEncaisse || a.nom.localeCompare(b.nom));
  return { mois, equipe, parUtilisateur: liste, nbSignaux: liste.reduce((s, l) => s + l.signaux.length, 0) };
}

module.exports = { calculerAnomalies, moisDe, moisPrecedent, SEUIL_MIN_PAIEMENTS, FACTEUR_SIGNAL, SEUIL_MIN_EVENEMENTS };
