// utils/qualiteDonnees.js — « Qualité des données » (14/10) : ce qui manque ou semble faux dans les dossiers et les épisodes, avec de quoi corriger.
// Fonctions pures : reçoivent des lignes déjà lues (dossiers, épisodes) et renvoient des contrôles { cle, titre, gravite, nombre, exemples[] }.
// Rien n'est modifié ici : ce sont des contrôles. Les corrections de FORME (espaces, majuscules) sont faites par utils/surveillanceQualite.js, les autres par une personne.
const JOUR_MS = 86400000;
const MAX_EXEMPLES = 25;

const vide = (v) => v === null || v === undefined || String(v).trim() === '';
const joursDepuis = (iso, maintenantMs) => { const t = new Date(iso).getTime(); return Number.isFinite(t) ? Math.floor((maintenantMs - t) / JOUR_MS) : null; };
const exemplesDossier = (d, plus = {}) => ({ type: 'dossier', id: d.id, numero_dossier: d.numero_dossier, nom: d.nom, ...plus });
const exemplesEpisode = (e, d, plus = {}) => ({ type: 'episode', id: e.id, dossier_id: e.dossier_id, numero_dossier: d ? d.numero_dossier : null, nom: d ? d.nom : null, ...plus });

// dossiers : { id, numero_dossier, nom, nom_origine, date_naissance, telephone, sexe, mere_dossier_id, fusionne_dans }
// episodes : { id, dossier_id, date_fermeture, statut, est_hospitalisation, voie_entree, date_ouverture, type_patient, ong_partenaire, motif_fermeture, service, supprime_le }
// paiements (facultatif) : { id, episode_id, fiche_id, mode, montant, annule, details, exoneration, patient_nom, date_paiement, supprime_le }
// seuils : { joursConsultationOuverte, joursHospitalisationOuverte }
function controlerQualite({ dossiers, episodes, paiements = [], maintenantMs, seuils = {} }) {
  const jc = seuils.joursConsultationOuverte ?? 30; // 19/10 : une consultation reste ouverte jusqu'à 1 mois (fermeture automatique à 30 jours)
  const jh = seuils.joursHospitalisationOuverte ?? 30;
  const actifs = (dossiers || []).filter(d => !d.fusionne_dans);
  const parId = new Map(actifs.map(d => [d.id, d]));
  const eps = (episodes || []).filter(e => !e.supprime_le && parId.has(e.dossier_id));
  const controles = [];
  const ajouter = (cle, titre, gravite, lignes, aide) => controles.push({ cle, titre, gravite, aide, nombre: lignes.length, exemples: lignes.slice(0, MAX_EXEMPLES) });

  const reels = actifs.filter(d => !/^(?:test|essai)\b/i.test(String(d.nom || '')));
  ajouter('sans_naissance', 'Dossiers sans date de naissance', 'moyenne', reels.filter(d => !d.date_naissance).map(d => exemplesDossier(d)),
    "Le Rapport CHF (tranches d'âge) ne peut pas les compter. Ouvre le dossier dans Fiche Patient et renseigne la date, ou l'âge approximatif.");
  ajouter('sans_sexe', 'Dossiers sans sexe', 'moyenne', reels.filter(d => d.sexe !== 'M' && d.sexe !== 'F').map(d => exemplesDossier(d)),
    'Le Rapport CHF répartit les visites par sexe : ces dossiers tombent dans « non précisé ».');
  ajouter('sans_telephone', 'Dossiers sans téléphone', 'faible', reels.filter(d => vide(d.telephone)).map(d => exemplesDossier(d)),
    'Impossible de rappeler le patient (créance, suivi). Un téléphone de proche suffit.');
  ajouter('nom_suspect', 'Noms à vérifier (trop courts ou avec des chiffres)', 'moyenne',
    actifs.filter(d => { const n = String(d.nom || '').trim(); return n.length < 4 || /\d/.test(n) || !/\s/.test(n) && !/^(b[ée]b[ée]|bb)(?=\s|$)/i.test(n); }).map(d => exemplesDossier(d)),
    'Un seul mot, un chiffre ou deux lettres : probablement une faute de saisie ou un nom incomplet. Le nom complet évite les doublons.');

  const bebes = actifs.filter(d => /^\s*(b[ée]b[ée]|bb)(?=\s|$)/i.test(String(d.nom_origine || d.nom || '')) && !d.mere_dossier_id);
  ajouter('bebe_sans_mere', 'Nouveau-nés sans mère liée', 'moyenne', bebes.map(d => exemplesDossier(d)),
    "Dossiers « Bébé … » non reliés au dossier de leur mère : ouvre le dossier et choisis la mère (les naissances du mois sont comptées d'après ce lien).");

  const consultationsOubliees = eps.filter(e => e.statut === 'ouvert' && !e.est_hospitalisation && e.voie_entree !== 'vente_comptoir' && (joursDepuis(e.date_ouverture, maintenantMs) ?? 0) >= jc);
  ajouter('consultation_ouverte', `Consultations restées ouvertes depuis ${jc} jours ou plus`, 'moyenne',
    consultationsOubliees.map(e => exemplesEpisode(e, parId.get(e.dossier_id), { jours: joursDepuis(e.date_ouverture, maintenantMs), service: e.service || null })),
    "Une consultation s'ouvre et se referme le jour même : un épisode ouvert depuis des jours bloque un nouvel épisode et fausse les statistiques.");
  const longues = eps.filter(e => e.statut === 'ouvert' && e.est_hospitalisation && (joursDepuis(e.date_ouverture, maintenantMs) ?? 0) >= jh);
  ajouter('hospitalisation_longue', `Hospitalisations ouvertes depuis ${jh} jours ou plus`, 'haute',
    longues.map(e => exemplesEpisode(e, parId.get(e.dossier_id), { jours: joursDepuis(e.date_ouverture, maintenantMs), service: e.service || null })),
    "Soit le patient est vraiment encore hospitalisé, soit la sortie n'a jamais été enregistrée (la durée de séjour et l'occupation sont alors faux).");
  ajouter('sortie_sans_motif', 'Hospitalisations clôturées sans motif de sortie', 'haute',
    eps.filter(e => e.statut === 'ferme' && e.est_hospitalisation && vide(e.motif_fermeture)).map(e => exemplesEpisode(e, parId.get(e.dossier_id), { service: e.service || null })),
    'Le Rapport CHF ne sait pas classer ces sorties (normale, transfert, décès, partis sans autorisation).');
  ajouter('partenaire_sans_nom', 'Épisodes « partenaire » sans nom de partenaire', 'haute',
    eps.filter(e => e.type_patient === 'partenaire' && vide(e.ong_partenaire)).map(e => exemplesEpisode(e, parId.get(e.dossier_id))),
    "Impossible de facturer l'ONG à la fin du mois : choisis le partenaire (Changer Privé/Partenaire).");

  // 18/10 : un dossier qui a déjà un épisode mais pas encore de vrai numéro (« en attente de numéro ») — la caisse doit le lui donner. Les dossiers « examens seulement » (EXAMEN-…) n'en
  // ont volontairement pas : ils ne sont pas signalés.
  const avecEpisode = new Set(eps.map(e => e.dossier_id));
  ajouter('sans_numero', 'Dossiers avec épisode mais sans numéro de dossier', 'haute',
    actifs.filter(d => String(d.numero_dossier || '').startsWith('EN-ATTENTE-') && avecEpisode.has(d.id)).map(d => exemplesDossier(d)),
    "La caisse doit leur donner un numéro (bouton « Donner le numéro » dans Fiche Patient ou Dossier/Épisode), sauf les patients venus pour des examens seulement.");

  // 19/10 : épisodes clôturés sans date de fermeture (la durée de séjour et les statistiques par jour en dépendent).
  ajouter('ferme_sans_date', 'Épisodes clôturés sans date de fermeture', 'moyenne',
    eps.filter(e => e.statut === 'ferme' && vide(e.date_fermeture)).map(e => exemplesEpisode(e, parId.get(e.dossier_id), { service: e.service || null })),
    "L'épisode est fermé mais la date de fermeture manque : la sortie ne peut pas être datée. Rouvre-le puis archive-le à nouveau, ou signale-le à l'administrateur.");

  // 19/10 : paiements. Pas de faux positifs : un dépôt, un remboursement de crédit, un paiement annulé ou supprimé n'est jamais lié à une fiche ; un paiement à zéro est normal
  // quand un dépôt, un crédit ou une exonération a tout couvert.
  const pays = (paiements || []).filter(p => !p.supprime_le && !p.annule);
  const epParId = new Map(eps.map(e => [e.id, e]));
  const nomPaiement = (p) => { const e = epParId.get(p.episode_id); const dos = e ? parId.get(e.dossier_id) : null; return { type: 'paiement', id: p.id, episode_id: p.episode_id, dossier_id: dos ? dos.id : null, numero_dossier: dos ? dos.numero_dossier : null, nom: (dos && dos.nom) || p.patient_nom || null, montant: p.montant, mode: p.mode, date: p.date_paiement || null }; };
  const MODES_SANS_FICHE = ['depot', 'remboursement_credit'];
  ajouter('paiement_sans_fiche', 'Paiements liés à aucune fiche', 'moyenne',
    pays.filter(p => vide(p.fiche_id) && !MODES_SANS_FICHE.includes(p.mode)).map(nomPaiement),
    "Un encaissement qui ne correspond à aucune fiche n'est pas rattaché à ce qui a été facturé : à vérifier avec la caisse.");
  const couvert = (p) => { const d = p.details || {}; return Number(d.montant_depot_utilise) > 0 || Number(d.montant_credit_utilise) > 0 || Number(d.credit_utilise) > 0 || !!p.exoneration; };
  ajouter('paiement_zero', 'Paiements à zéro sans dépôt, crédit ni exonération', 'moyenne',
    pays.filter(p => Number(p.montant) === 0 && !MODES_SANS_FICHE.includes(p.mode) && !couvert(p)).map(nomPaiement),
    "Un encaissement de 0 sans raison (ni dépôt utilisé, ni crédit, ni exonération) est probablement une erreur de saisie.");


  // 19/10 : UN SEUL épisode ouvert à la fois par patient (règle d'Esdras). Les cas déjà existants (avant la règle) sont listés ici pour être réglés à la main.
  const ouvertsParDossier = new Map();
  eps.filter(e => e.statut === 'ouvert' && e.voie_entree !== 'vente_comptoir').forEach(e => { if (!ouvertsParDossier.has(e.dossier_id)) ouvertsParDossier.set(e.dossier_id, []); ouvertsParDossier.get(e.dossier_id).push(e); });
  ajouter('episodes_ouverts_multiples', 'Patients avec plusieurs épisodes ouverts en même temps', 'haute',
    [...ouvertsParDossier.entries()].filter(([, l]) => l.length > 1).map(([id, l]) => exemplesDossier(parId.get(id), { nombre: l.length })),
    "Un seul épisode ouvert à la fois : fermez ou regroupez les autres (une consultation devenue hospitalisation passe par « Hospitaliser »).");

  const gravites = { haute: 0, moyenne: 1, faible: 2 };
  controles.sort((a, b) => (b.nombre > 0) - (a.nombre > 0) || gravites[a.gravite] - gravites[b.gravite]);
  const total = controles.reduce((s, c) => s + c.nombre, 0);
  return { controles, total, dossiersAnalyses: actifs.length, episodesAnalyses: eps.length };
}

module.exports = { controlerQualite, MAX_EXEMPLES };
