// utils/contenuEpisode.js — ce qu'un épisode contient déjà (15/10, Esdras : « quand on ouvre un dossier et qu'il affiche les épisodes ouverts, mets examen /
// médicament si la personne les a pris, et rien si elle ne les a pas faits : on saura dès le départ si on doit continuer le même épisode »).
// Lu sur les fiches de l'épisode (hors fiches à la corbeille) : le détail par catégorie (`breakdown`) et, à défaut, les lignes de la fiche (`raw_state.lignesCalcul`).
// Examen = laboratoire, sonographie ou ECG ; médicament = pharmacie.
const CATEGORIES_EXAMEN = ['labo', 'sono', 'ecg'];
const CATEGORIE_MEDICAMENT = 'med';

const positif = (v) => Number(v) > 0;

function contenuDesFiches(fiches) {
  let examens = false, medicaments = false;
  for (const f of fiches || []) {
    if (!f || f.supprime_le) continue;
    const b = f.breakdown && typeof f.breakdown === 'object' ? f.breakdown : {};
    if (CATEGORIES_EXAMEN.some(k => positif(b[k]))) examens = true;
    if (positif(b[CATEGORIE_MEDICAMENT])) medicaments = true;
    const lignes = f.raw_state && Array.isArray(f.raw_state.lignesCalcul) ? f.raw_state.lignesCalcul : [];
    for (const l of lignes) {
      if (!l || !(Number(l.qte) > 0)) continue;
      if (l.type === 'med') medicaments = true;
      if (CATEGORIES_EXAMEN.includes(l.sub)) examens = true;
    }
  }
  return { examens, medicaments };
}

module.exports = { contenuDesFiches, CATEGORIES_EXAMEN };
