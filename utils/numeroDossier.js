// utils/numeroDossier.js — numéro de dossier DONNÉ PAR LA CAISSE (16/10, Esdras).
//
// Règle d'Esdras : « seule la caisse donne un numéro, et c'est quand la personne a payé qu'elle reçoit son numéro ; infirmier et archive ne peuvent ni donner ni
// changer un numéro. Le site le donne automatiquement, c'est moi qui définis où ça commence, et la caisse peut le modifier. »
//
// Un dossier créé par l'infirmier ou l'archive n'a donc pas encore de numéro. Comme le numéro est la clé de recherche, d'unicité, des brouillons et des reçus, il garde
// un numéro PROVISOIRE (« EN-ATTENTE-… », même principe que les « AUTO-… » des ventes comptoir) jusqu'à ce que la caisse lui donne le vrai. L'application l'affiche
// partout comme « En attente de numéro », jamais tel quel.
const crypto = require('node:crypto');

const PREFIXE_EN_ATTENTE = 'EN-ATTENTE-';
const PREFIXE_VENTE_COMPTOIR = 'AUTO-';
// Patients envoyés par un partenaire (ex. AVSI) pour des EXAMENS SEULEMENT : enregistrés par leur nom (ils figurent dans les lots et le rapport du partenaire) mais SANS numéro de dossier.
const PREFIXE_EXAMENS = 'EXAMEN-';
const LONGUEUR_MAX = 30;

const estEnAttente = (numero) => typeof numero === 'string' && numero.startsWith(PREFIXE_EN_ATTENTE);
const estExamensSeulement = (numero) => typeof numero === 'string' && numero.startsWith(PREFIXE_EXAMENS);
// Pas de vrai numéro : en attente (la caisse le donnera) ou examens seulement (jamais de numéro tant que la caisse n'en donne pas un).
const estSansVraiNumero = (numero) => estEnAttente(numero) || estExamensSeulement(numero);

// Numéro provisoire, unique pour de bon (10 caractères au hasard) : plusieurs dossiers peuvent attendre en même temps.
const numeroProvisoire = (alea = crypto.randomBytes(5).toString('hex').toUpperCase()) => `${PREFIXE_EN_ATTENTE}${alea}`;
const numeroExamens = (alea = crypto.randomBytes(5).toString('hex').toUpperCase()) => `${PREFIXE_EXAMENS}${alea}`;

// Numéro saisi par la caisse : non vide, 30 caractères au plus, jamais un numéro réservé (provisoire ou vente comptoir). Renvoie un message, ou null si tout va bien.
function erreurNumeroDossier(valeur) {
  if (valeur === undefined || valeur === null || typeof valeur === 'object') return 'Le numéro de dossier est requis.';
  const numero = String(valeur).trim();
  if (!numero) return 'Le numéro de dossier est requis.';
  if (numero.length > LONGUEUR_MAX) return `Le numéro de dossier est trop long (${LONGUEUR_MAX} caractères au plus).`;
  const majuscules = numero.toUpperCase();
  const reserve = [PREFIXE_EN_ATTENTE, PREFIXE_VENTE_COMPTOIR, PREFIXE_EXAMENS].find(p => majuscules.startsWith(p));
  if (reserve) return `Un numéro ne peut pas commencer par « ${reserve} » (réservé par le site).`;
  return null;
}

// Numéro de départ choisi par l'administrateur : un entier positif raisonnable.
function erreurNumeroDepart(valeur) {
  const n = typeof valeur === 'number' ? valeur : (typeof valeur === 'string' && /^\d+$/.test(valeur.trim()) ? Number(valeur.trim()) : NaN);
  if (!Number.isInteger(n) || n < 1) return 'Le numéro de départ doit être un nombre entier, 1 ou plus.';
  if (n > 999999999) return 'Le numéro de départ est trop grand (999 999 999 au plus).';
  return null;
}

const SQL_ABSENT = (erreur) => ['42883', 'PGRST202'].includes(String(erreur && erreur.code));

// 16/10 (Esdras) : « le numéro se donne automatiquement dès la création du premier épisode ; il peut être manuel si la personne a déjà un numéro, on rentre alors le sien ».
// Appelée par la création d'un épisode, APRÈS les contrôles et AVANT l'insertion. Ne fait rien si le dossier a déjà son vrai numéro (« premier épisode » = tant que le dossier est
// « en attente de numéro »). Le droit de donner un numéro (caisse) est vérifié par l'appelant.
//   numeroSaisi : le numéro que la caisse a tapé (personne déjà numérotée) → pris tel quel s'il est libre ;
//   automatique : true → le site prend le prochain numéro libre (nouvel essai si une autre caisse prend le même en même temps).
// Renvoie { numero, automatique, ancien } si un numéro a été donné, null sinon. Lève { statut, message, code } si le numéro tapé est refusé (épisode alors NON créé).
async function donnerNumeroAuPremierEpisode({ supabase, dossierId, numeroSaisi, automatique }) {
  const saisi = numeroSaisi === undefined || numeroSaisi === null ? '' : String(numeroSaisi).trim();
  if (!saisi && automatique !== true) return null;
  const { data: dossier, error: erreurLecture } = await supabase.from('dossiers').select('numero_dossier').eq('id', dossierId).maybeSingle();
  if (erreurLecture || !dossier || !estSansVraiNumero(dossier.numero_dossier)) return null;
  const echec = (statut, message, code) => Object.assign(new Error(message), { statut, code });

  if (saisi) {
    const erreurSaisie = erreurNumeroDossier(saisi);
    if (erreurSaisie) throw echec(400, erreurSaisie, 'NUMERO_INVALIDE');
    const { data, error } = await supabase.rpc('attribuer_numero_dossier', { p_dossier: dossierId, p_numero: saisi });
    if (error) {
      if (SQL_ABSENT(error)) throw echec(503, "Le script sql/numero_dossier_compteur.sql n'est pas encore collé dans Supabase : impossible de donner le numéro.", 'NUMERO_SQL_ABSENT');
      if (error.code === 'CHF32') throw echec(409, `Le numéro ${saisi} est déjà utilisé par un autre dossier. L'épisode n'a pas été créé : vérifie le numéro (ou cherche ce patient par son numéro).`, 'NUMERO_DEJA_PRIS');
      throw echec(500, error.message, 'NUMERO_ERREUR');
    }
    return { numero: data.numero, automatique: !!data.automatique, ancien: data.ancien };
  }

  // Automatique : un épisode ne doit JAMAIS échouer à cause du numéro (script SQL pas encore collé, panne passagère) → le dossier reste simplement « en attente » et la caisse
  // le donnera avec le bouton « Donner le numéro ».
  for (let essai = 0; essai < 4; essai++) {
    const { data: propose, error: erreurPropose } = await supabase.rpc('numero_dossier_propose');
    if (erreurPropose || !propose) return null;
    const { data, error } = await supabase.rpc('attribuer_numero_dossier', { p_dossier: dossierId, p_numero: propose });
    if (!error) return { numero: data.numero, automatique: !!data.automatique, ancien: data.ancien };
    if (error.code !== 'CHF32') return null; // une autre caisse vient de prendre ce numéro → on redemande le suivant
  }
  return null;
}

// Épisode « examens seulement » d'un patient d'un partenaire : le dossier (encore sans vrai numéro) est marqué « sans numéro » — il ne recevra pas de numéro automatique aux
// visites suivantes, mais la caisse peut toujours lui en donner un. Renvoie le numéro de marquage, ou null si le dossier a déjà un vrai numéro (rien n'est touché).
async function marquerExamensSeulement({ supabase, dossierId }) {
  const { data: dossier, error } = await supabase.from('dossiers').select('numero_dossier').eq('id', dossierId).maybeSingle();
  if (error || !dossier) return null;
  if (estExamensSeulement(dossier.numero_dossier)) return { numero: dossier.numero_dossier, ancien: dossier.numero_dossier, inchange: true };
  if (!estEnAttente(dossier.numero_dossier)) return null;
  const numero = numeroExamens();
  const { error: erreurMaj } = await supabase.from('dossiers').update({ numero_dossier: numero }).eq('id', dossierId).eq('numero_dossier', dossier.numero_dossier);
  if (erreurMaj) return null;
  return { numero, ancien: dossier.numero_dossier };
}

module.exports = { PREFIXE_EN_ATTENTE, PREFIXE_VENTE_COMPTOIR, PREFIXE_EXAMENS, LONGUEUR_MAX, estEnAttente, estExamensSeulement, estSansVraiNumero, numeroProvisoire, numeroExamens, erreurNumeroDossier, erreurNumeroDepart, donnerNumeroAuPremierEpisode, marquerExamensSeulement };
