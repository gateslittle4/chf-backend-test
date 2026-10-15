// utils/doublonsIdentite.js — repérer les dossiers qui sont probablement LA MÊME PERSONNE (14/10) : noms proches (fautes de frappe, ordre prénom/nom
// inversé, accents), même date de naissance, même téléphone. Fonctions pures, testables sans base ni réseau.
//
// Un score de 0 à 100 est calculé pour chaque paire, avec les RAISONS en clair (c'est ce que la personne lit avant de décider de réunir ou non).
// Garde-fous contre les faux positifs que le métier connaît bien :
//   - un bébé et sa mère partagent nom, téléphone, adresse : une paire « mère ↔ enfant » (lien mere_dossier_id, ou nom commençant par Bébé d'un
//     côté seulement) n'est JAMAIS proposée ;
//   - deux dates de naissance connues et éloignées de plus d'un an = deux personnes (père et fils portent souvent le même nom) ;
//   - deux sexes connus et différents = deux personnes ;
//   - un téléphone partagé ne suffit pas (une famille entière a le même) : il ne compte que si les noms se ressemblent déjà.
const { jetonsDuNom } = require('./dossiers');

const NIVEAUX = [
  { cle: 'forte', label: 'Très probable', min: 85 },
  { cle: 'probable', label: 'Probable', min: 70 },
  { cle: 'possible', label: 'Possible', min: 55 },
];
const SEUIL_MIN = 55;
const TAILLE_MAX_GROUPE = 80;
const TAILLE_MAX_GROUPE_COUPLES = 200; // les groupes « couple de mots + année de naissance » restent petits (voir clesDe) : on peut en comparer davantage

const JETONS_BEBE = new Set(['bebe', 'bb', 'baby']);

function distance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prec = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cour = [i];
    for (let j = 1; j <= b.length; j++) {
      cour[j] = Math.min(prec[j] + 1, cour[j - 1] + 1, prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prec = cour;
  }
  return prec[b.length];
}
const ratio = (a, b) => (a.length === 0 && b.length === 0 ? 1 : 1 - distance(a, b) / Math.max(a.length, b.length));

const jetons = (nom) => jetonsDuNom(nom).split(' ').filter(Boolean);
const sansBebe = (liste) => liste.filter(t => !JETONS_BEBE.has(t));
const estBebe = (nom) => jetons(nom).some(t => JETONS_BEBE.has(t));

// Ressemblance de deux noms (0..1) : chaque mot du plus court est apparié à son meilleur mot de l'autre (≥ 0,65 de ressemblance : Joseph ≈ Josef), sans ordre.
function similariteNoms(nomA, nomB) {
  const a = sansBebe(jetons(nomA)), b = sansBebe(jetons(nomB));
  if (!a.length || !b.length) return 0;
  const [court, long] = a.length <= b.length ? [a, b] : [b, a];
  const restants = [...long];
  let somme = 0;
  for (const t of court) {
    let meilleur = -1, score = 0;
    restants.forEach((u, i) => { const r = ratio(t, u); if (r > score) { score = r; meilleur = i; } });
    if (meilleur >= 0 && score >= 0.65) { somme += score; restants.splice(meilleur, 1); }
  }
  return (2 * somme) / (a.length + b.length);
}

function nomsDe(d) {
  const noms = [d.nom, d.nom_origine, ...(Array.isArray(d.anciens_noms) ? d.anciens_noms.map(n => n && n.nom) : [])];
  return [...new Set(noms.filter(n => n && String(n).trim()))];
}

function meilleureSimilarite(a, b) {
  let max = 0;
  for (const x of nomsDe(a)) for (const y of nomsDe(b)) max = Math.max(max, similariteNoms(x, y));
  return max;
}

// 8 derniers chiffres (indicatif 509 ignoré) ; moins de 8 chiffres = pas un vrai numéro.
function normaliserTel(tel) {
  const chiffres = String(tel === undefined || tel === null ? '' : tel).replace(/\D/g, '');
  return chiffres.length >= 8 ? chiffres.slice(-8) : '';
}

const annees = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / (365.25 * 86400000) : null; };
const niveauDe = (score) => NIVEAUX.find(n => score >= n.min) || null;

// Score d'une paire { score, niveau, raisons } — ou null si la paire est écartée par un garde-fou ou trop faible.
function scorePaire(a, b) {
  if (!a || !b || a.id === b.id) return null;
  if (a.fusionne_dans || b.fusionne_dans) return null;
  if (a.mere_dossier_id === b.id || b.mere_dossier_id === a.id) return null; // mère ↔ enfant
  if (a.sexe && b.sexe && a.sexe !== b.sexe) return null;
  const ta = annees(a.date_naissance), tb = annees(b.date_naissance);
  if (ta !== null && tb !== null && Math.abs(ta - tb) > 1) return null;
  if (estBebe(a.nom_origine || a.nom) !== estBebe(b.nom_origine || b.nom) && !(ta !== null && tb !== null && Math.abs(ta - tb) < 0.01)) return null;

  const raisons = [];
  let score = 0;
  const sim = meilleureSimilarite(a, b);
  if (sim >= 0.999) { score += 60; raisons.push('Même nom'); }
  else if (sim >= 0.85) { score += 50; raisons.push('Noms très proches'); }
  else if (sim >= 0.7) { score += 30; raisons.push('Noms qui se ressemblent'); }
  const nomsSeRessemblent = sim >= 0.7;

  if (ta !== null && tb !== null) {
    if (Math.abs(ta - tb) < 0.01) { score += 30; raisons.push('Même date de naissance'); }
    else { score += 10; raisons.push('Dates de naissance à moins d\'un an'); }
  }
  const tel = normaliserTel(a.telephone);
  if (tel && tel === normaliserTel(b.telephone) && nomsSeRessemblent) { score += 25; raisons.push('Même téléphone'); }
  if (a.sexe && b.sexe && a.sexe === b.sexe) score += 5;
  if (!nomsSeRessemblent) return null; // sans noms proches, aucun autre indice ne suffit
  score = Math.min(100, score);
  const niveau = niveauDe(score);
  return niveau ? { score, niveau, raisons } : null;
}

const cle = (a, b) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);

// Clés de regroupement : évite de comparer chaque dossier à tous les autres. Même naissance, même téléphone, ou même début d'un mot du nom.
// Le token avec UNE lettre en moins (et lui-même) : deux mots qui diffèrent d'une faute de frappe (lettre oubliée, en trop, changée ou deux lettres inversées) en partagent toujours un.
const variantes = (mot) => { const v = new Set([mot]); for (let i = 0; i < mot.length; i++) v.add(mot.slice(0, i) + mot.slice(i + 1)); return v; };

function clesDe(d) {
  const cles = [];
  if (d.date_naissance) cles.push('n:' + String(d.date_naissance).slice(0, 10));
  const t = normaliserTel(d.telephone);
  if (t) cles.push('t:' + t);
  const annee = d.date_naissance ? String(d.date_naissance).slice(0, 4) : null;
  nomsDe(d).forEach(n => {
    const mots = sansBebe(jetons(n)).filter(j => j.length >= 3);
    mots.forEach(j => cles.push('m:' + j.slice(0, 3)));
    // 15/10 : avec des milliers de dossiers, « Mar… » ou « Jos… » regroupent des centaines de personnes et ces groupes étaient IGNORÉS (trop gros) : les doublons dont la date de
    // naissance ou le téléphone diffèrent n'étaient plus trouvés (98 % à 1 000 dossiers, 75 % à 50 000, mesuré avec des doublons plantés). On regroupe donc aussi par COUPLE de mots :
    // un mot (avec ses variantes à une faute près) + le début de l'autre mot. Groupes bien plus petits, même tolérance aux fautes de frappe.
    if (mots.length >= 2) {
      const unique = [...new Set(mots)].slice(0, 4);
      for (const a of unique) for (const b of unique) {
        if (a === b) continue;
        for (const v of variantes(a)) {
          cles.push('v:' + v + '|' + b.slice(0, 3));                                     // sans l'année : seulement utile si le couple est rare (groupe ≤ TAILLE_MAX_GROUPE)
          if (annee) cles.push('y:' + annee + ':' + v + '|' + b.slice(0, 3));            // avec l'année de naissance : groupes petits même pour les noms très courants
        }
      }
    }
  });
  return [...new Set(cles)];
}

// Toutes les paires de doublons probables. ignores : Set de « idA|idB » (ids triés) déjà déclarées « pas les mêmes personnes ».
// Écrit comme un générateur qui « rend la main » toutes les `pas` comparaisons : la version synchrone le parcourt d'un trait, la version asynchrone
// (trouverDoublonsSansBloquer) laisse le serveur répondre aux autres requêtes entre deux morceaux — à 50 000 dossiers le calcul dure plusieurs secondes.
function* parcourirDoublons(dossiers, { ignores = new Set(), seuil = SEUIL_MIN, pas = 4000 } = {}) {
  const liste = (dossiers || []).filter(d => d && d.id && !d.fusionne_dans);
  const groupes = new Map();
  liste.forEach((d, i) => clesDe(d).forEach(c => { if (!groupes.has(c)) groupes.set(c, []); groupes.get(c).push(i); }));
  const vues = new Set();
  const paires = [];
  let comparaisons = 0;
  for (const [cleGroupe, indices] of groupes) {
    if (indices.length < 2 || indices.length > (cleGroupe.startsWith('y:') ? TAILLE_MAX_GROUPE_COUPLES : TAILLE_MAX_GROUPE)) continue;
    for (let x = 0; x < indices.length; x++) {
      for (let y = x + 1; y < indices.length; y++) {
        const a = liste[indices[x]], b = liste[indices[y]];
        const k = cle(a, b);
        if (vues.has(k)) continue;
        vues.add(k);
        if (ignores.has(k)) continue;
        const r = scorePaire(a, b);
        if (r && r.score >= seuil) paires.push({ a, b, ...r });
        if (++comparaisons % pas === 0) yield;
      }
    }
  }
  return paires.sort((p, q) => q.score - p.score || String(p.a.nom).localeCompare(String(q.a.nom), 'fr'));
}

function trouverDoublons(dossiers, options = {}) {
  const parcours = parcourirDoublons(dossiers, options);
  for (let etape = parcours.next(); ; etape = parcours.next()) if (etape.done) return etape.value;
}

// Même résultat, sans bloquer le serveur : cède la main (setImmediate) entre deux morceaux.
async function trouverDoublonsSansBloquer(dossiers, options = {}) {
  const parcours = parcourirDoublons(dossiers, options);
  for (let etape = parcours.next(); ; etape = parcours.next()) {
    if (etape.done) return etape.value;
    await new Promise(resolve => setImmediate(resolve));
  }
}

// Dossiers existants qui ressemblent à une personne qu'on s'apprête à créer : { nom, date_naissance, telephone, sexe }.
function candidatsPour(nouveau, dossiers, { ignores = new Set(), max = 5, seuil = SEUIL_MIN } = {}) {
  const fictif = { id: '__nouveau__', ...nouveau };
  return (dossiers || [])
    .filter(d => d && d.id && !d.fusionne_dans)
    .map(d => ({ dossier: d, r: scorePaire(fictif, d) }))
    .filter(x => x.r && x.r.score >= seuil)
    .sort((p, q) => q.r.score - p.r.score)
    .slice(0, max)
    .map(x => ({ dossier: x.dossier, ...x.r }));
}

module.exports = { NIVEAUX, SEUIL_MIN, similariteNoms, normaliserTel, scorePaire, trouverDoublons, trouverDoublonsSansBloquer, candidatsPour, nomsDe, estBebe };
