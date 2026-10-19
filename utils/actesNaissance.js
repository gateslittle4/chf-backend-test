// utils/actesNaissance.js — UN SEUL acte de naissance par épisode (19/10, Esdras) : pas deux accouchements, pas deux césariennes, pas un accouchement ET une césarienne,
// pas le même acte en quantité 2 — et aucune exemption (la délivrance ne peut pas non plus s'ajouter à un accouchement ou une césarienne du même épisode).
// Sont des « actes de naissance » : les actes des rubriques Accouchement et Césarienne, plus toute « Délivrance » (dont la « Délivrance placentaire artificielle », rangée en Chirurgie).
// Une dérogation exceptionnelle existe (droit `acte_naissance_derogation`, motif obligatoire, tracée au journal d'audit).
// Fonctions pures, identiques côté application et côté serveur (copie : chf-app2/utils/actesNaissance.js).
const SOUS_CATEGORIES_NAISSANCE = ['accouchement', 'cesarienne'];
const MOTIF_MINIMUM = 5;

// Une ligne de panier / de fiche : { type: 'acte' | 'med', sub, nom, qte }.
function estActeNaissance(ligne) {
  if (!ligne || ligne.type === 'med') return false;
  return SOUS_CATEGORIES_NAISSANCE.includes(ligne.sub) || /d[ée]livrance/i.test(String(ligne.nom || ''));
}

function compterActesNaissance(lignes) {
  return (Array.isArray(lignes) ? lignes : []).reduce((n, l) => (estActeNaissance(l) ? n + (Number(l.qte) > 0 ? Number(l.qte) : 1) : n), 0);
}

// fichesExistantes : fiches déjà enregistrées de l'épisode ({ raw_state: { lignesCalcul } } ou { rawState: { lignesCalcul } }), sans celles supprimées ni au paiement annulé.
// lignesNouvelles : les lignes qu'on veut ajouter. Renvoie { conflit, deja, nouveau, message }.
function conflitActeNaissance({ fichesExistantes = [], lignesNouvelles = [] } = {}) {
  const deja = (fichesExistantes || []).reduce((n, f) => {
    const etat = (f && (f.raw_state || f.rawState)) || {};
    return n + compterActesNaissance(etat.lignesCalcul);
  }, 0);
  const nouveau = compterActesNaissance(lignesNouvelles);
  const conflit = nouveau > 0 && deja + nouveau > 1;
  const message = !conflit ? null
    : deja > 0 ? "Cet épisode a déjà un acte de naissance (accouchement, césarienne ou délivrance) : un seul est permis par épisode. Seule la direction peut autoriser une exception, avec un motif."
      : "Un seul acte de naissance (accouchement, césarienne ou délivrance, en quantité 1) est permis par épisode. Seule la direction peut autoriser une exception, avec un motif.";
  return { conflit, deja, nouveau, message };
}

const motifDerogationValide = (d) => !!d && typeof d.motif === 'string' && d.motif.trim().length >= MOTIF_MINIMUM;

module.exports = { SOUS_CATEGORIES_NAISSANCE, MOTIF_MINIMUM, estActeNaissance, compterActesNaissance, conflitActeNaissance, motifDerogationValide };
