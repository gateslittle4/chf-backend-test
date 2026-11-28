// utils/suiviDossiersPapier.js — onglet « Archiviste » (28/11, Esdras : « je peux savoir quand un dossier entre dans l'archive, avec sa date, mais je ne sais pas quand il en sort »).
// Fonctions pures : l'ÉTAT d'un dossier papier (dans l'archive / sorti) d'après ses mouvements cochés à la main et les achats de médicaments faits à la caisse.
//
// Règle de la sortie :
//  - « Entré à l'archiviste » = un mouvement 'entree' coché par l'archiviste (avec date et heure du serveur). Le DERNIER fait foi (un dossier peut revenir plusieurs fois).
//  - « Sorti de l'archiviste » = le PLUS TÔT de : une sortie cochée à la main APRÈS cette entrée, ou le premier achat de médicament à la caisse APRÈS cette entrée (sortie automatique :
//    dès qu'un médicament est donné au patient et acheté, le dossier est forcément sorti). En cas d'égalité, la sortie à la main l'emporte.
//  - Un dossier jamais entré n'a pas de sortie : « pas entré ».
// Les modes qui ne sont pas un achat (dépôt, remboursements, transfert d'hospitalisation) ne déclenchent jamais la sortie ; un paiement annulé ou à la corbeille non plus.
const MODES_SANS_ACHAT = new Set(['depot', 'remboursement_credit', 'remboursement_patient', 'transfert_hospitalisation']);
const temps = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? t : NaN; };

// Un paiement compte comme un achat de médicament si sa fiche a une part « pharmacie » (breakdown.med > 0) et si ce n'est ni un dépôt, ni un remboursement, ni un paiement annulé / supprimé.
function estAchatMedicament(paiement, fiche) {
  if (!paiement || paiement.annule || paiement.supprime_le || MODES_SANS_ACHAT.has(paiement.mode)) return false;
  const med = Number(fiche && fiche.breakdown && fiche.breakdown.med);
  return Number.isFinite(med) && med > 0;
}

// mouvements : ceux d'UN dossier, non annulés [{ id, type, date, par }] ; achats : ses achats de médicament [{ date, numero_paiement }].
// Renvoie { etat: 'pas_entre' | 'dans_archive' | 'sorti', entree, sortie } ; sortie.origine = 'manuel' | 'automatique'.
function etatDossierPapier(mouvements, achats) {
  const valides = (mouvements || []).filter(m => m && !m.annule && Number.isFinite(temps(m.date))).sort((a, b) => temps(a.date) - temps(b.date));
  const entrees = valides.filter(m => m.type === 'entree');
  if (entrees.length === 0) return { etat: 'pas_entre', entree: null, sortie: null };
  const e = entrees[entrees.length - 1];
  const te = temps(e.date);
  const entree = { id: e.id || null, date: e.date, par: e.par || null };
  const manuelle = valides.find(m => m.type === 'sortie' && temps(m.date) >= te);
  const achat = (achats || []).filter(a => a && Number.isFinite(temps(a.date)) && temps(a.date) > te).sort((a, b) => temps(a.date) - temps(b.date))[0];
  let sortie = null;
  if (manuelle && (!achat || temps(manuelle.date) <= temps(achat.date))) sortie = { id: manuelle.id || null, date: manuelle.date, origine: 'manuel', par: manuelle.par || null, numero_paiement: null };
  else if (achat) sortie = { id: null, date: achat.date, origine: 'automatique', par: null, numero_paiement: achat.numero_paiement == null ? null : achat.numero_paiement };
  return { etat: sortie ? 'sorti' : 'dans_archive', entree, sortie };
}

// Fenêtre [debut, fin[ (ISO, UTC) du jour d'HAÏTI « AAAA-MM-JJ » : minuit à minuit heure d'Haïti, heure d'été comprise (Intl, America/Port-au-Prince). null si le jour est illisible.
const FUSEAU = 'America/Port-au-Prince';
const formatParties = new Intl.DateTimeFormat('en-CA', { timeZone: FUSEAU, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const partiesHaiti = (ms) => { const p = {}; for (const x of formatParties.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = x.value; return p; };
function minuitHaiti(jour) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(jour || ''));
  if (!m) return null;
  const [a, mo, j] = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (const decalage of [5, 4]) { // UTC−5 (hiver) puis UTC−4 (heure d'été)
    const ms = Date.UTC(a, mo - 1, j, decalage);
    const p = partiesHaiti(ms);
    if (`${p.year}-${p.month}-${p.day}` === jour && p.hour === '00' && p.minute === '00') return ms;
  }
  return null;
}
function fenetreJourHaiti(jour) {
  const debut = minuitHaiti(jour);
  if (debut === null) return null;
  const suivant = new Date(Date.parse(`${jour}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const fin = minuitHaiti(suivant);
  return fin === null ? null : { debut: new Date(debut).toISOString(), fin: new Date(fin).toISOString() };
}

// Assemble les lignes de l'écran. dossiers [{ id, nom, numero_dossier }], paiements (non annulés, non supprimés, avec episode_id, date_paiement, fiche_id, mode, numero_paiement),
// episodes [{ id, dossier_id }], fiches [{ id, breakdown }], mouvements [{ dossier_id, ... }]. fenetre { debut, fin } optionnelle : ne compte alors comme « transactions » que celles de la fenêtre.
function construireSuivi({ dossiers, episodes, paiements, fiches, mouvements, fenetre }) {
  const dossierDeEpisode = new Map((episodes || []).map(e => [e.id, e.dossier_id]));
  const ficheParId = new Map((fiches || []).map(f => [f.id, f]));
  const parDossier = new Map();
  const noeud = (id) => { let n = parDossier.get(id); if (!n) { n = { paiements: [], achats: [], mouvements: [] }; parDossier.set(id, n); } return n; };
  for (const p of paiements || []) {
    if (!p || p.annule || p.supprime_le) continue;
    const d = dossierDeEpisode.get(p.episode_id);
    if (!d) continue;
    noeud(d).paiements.push(p);
    if (estAchatMedicament(p, ficheParId.get(p.fiche_id))) noeud(d).achats.push({ date: p.date_paiement, numero_paiement: p.numero_paiement });
  }
  for (const m of mouvements || []) { if (m && !m.annule && m.dossier_id) noeud(m.dossier_id).mouvements.push(m); }
  const dansFenetre = (p) => !fenetre || (temps(p.date_paiement) >= temps(fenetre.debut) && temps(p.date_paiement) < temps(fenetre.fin));
  const lignes = [];
  for (const d of dossiers || []) {
    const n = parDossier.get(d.id) || { paiements: [], achats: [], mouvements: [] };
    const transactions = n.paiements.filter(dansFenetre);
    if (transactions.length === 0) continue; // seuls les patients qui ont fait une transaction apparaissent
    const derniere = transactions.map(p => temps(p.date_paiement)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    lignes.push({
      dossier_id: d.id, nom: d.nom || '', numero_dossier: d.numero_dossier || null, nb_transactions: transactions.length,
      derniere_transaction: Number.isFinite(derniere) ? new Date(derniere).toISOString() : null,
      ...etatDossierPapier(n.mouvements, n.achats),
    });
  }
  return lignes.sort((a, b) => String(b.derniere_transaction).localeCompare(String(a.derniere_transaction)) || a.nom.localeCompare(b.nom, 'fr'));
}

module.exports = { MODES_SANS_ACHAT, estAchatMedicament, etatDossierPapier, fenetreJourHaiti, construireSuivi };
