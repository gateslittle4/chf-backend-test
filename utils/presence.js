// « Qui est connecté » et « qui était à la caisse tel jour ».
const FUSEAU = 'America/Port-au-Prince';
const EN_LIGNE_MS = 5 * 60 * 1000;

function jourHaiti(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSEAU }).format(new Date(ms));
}

// Début (inclus) et fin (exclue) d'un jour d'Haïti « AAAA-MM-JJ », en instants UTC.
function bornesJourHaiti(jour) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(jour))) return null;
  const [a, m, j] = jour.split('-').map(Number);
  for (const decalage of [5, 4]) {
    const t = Date.UTC(a, m - 1, j, decalage);
    if (jourHaiti(t) === jour && jourHaiti(t - 1) !== jour) {
      return { debut: new Date(t).toISOString(), fin: new Date(t + 86400000).toISOString() };
    }
  }
  return null;
}

// Marque l'activité d'un compte au plus une fois par minute (mémoire du serveur), sans jamais bloquer la requête.
function creerSuiviActivite(supabase, { intervalleMs = 60000, maintenant = () => Date.now() } = {}) {
  const dernier = new Map();
  return function suivreActivite(req, res, next) {
    try {
      const id = req.user && req.user.id;
      const t = maintenant();
      if (id && (!dernier.has(id) || t - dernier.get(id) >= intervalleMs)) {
        dernier.set(id, t);
        Promise.resolve(supabase.from('users').update({ derniere_activite: new Date(t).toISOString() }).eq('id', id))
          .catch(() => {});
      }
    } catch (e) { /* le suivi ne doit jamais gêner le travail */ }
    next();
  };
}

function classerConnectes(utilisateurs, maintenant = Date.now()) {
  return (utilisateurs || []).map(u => {
    const vu = u.derniere_activite ? new Date(u.derniere_activite).getTime() : null;
    return {
      id: u.id, nom: u.display_name || u.email || '', email: u.email || '', role: u.role, actif: u.active !== false,
      derniere_activite: u.derniere_activite || null,
      en_ligne: vu !== null && maintenant - vu <= EN_LIGNE_MS,
    };
  }).sort((a, b) => (b.en_ligne - a.en_ligne) || String(b.derniere_activite || '').localeCompare(String(a.derniere_activite || '')));
}

// Regroupe les paiements d'un jour par caissier.
function resumerCaisseDuJour(paiements, clotures, utilisateursParId = {}) {
  const parNom = new Map();
  for (const p of paiements || []) {
    if (p.annule || p.supprime_le || p.mode === 'transfert_hospitalisation') continue;
    const nom = p.encaisse_par || '(inconnu)';
    const l = parNom.get(nom) || { nom, paiements: 0, total: 0, premier: p.date_paiement, dernier: p.date_paiement };
    l.paiements += 1;
    l.total += Number(p.montant) || 0;
    if (p.date_paiement < l.premier) l.premier = p.date_paiement;
    if (p.date_paiement > l.dernier) l.dernier = p.date_paiement;
    parNom.set(nom, l);
  }
  return {
    caissiers: [...parNom.values()].sort((a, b) => a.premier.localeCompare(b.premier)),
    clotures: (clotures || []).map(c => ({
      par: c.cloturee_par || (utilisateursParId[c.cloturee_par_uid] || ''), statut: c.statut, date_cloture: c.date_cloture,
    })),
  };
}

module.exports = { jourHaiti, bornesJourHaiti, creerSuiviActivite, classerConnectes, resumerCaisseDuJour, EN_LIGNE_MS };
