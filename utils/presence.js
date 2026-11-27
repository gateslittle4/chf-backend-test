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

// Version de l'application que le navigateur fait tourner (27/11, Esdras : « savoir quelle version chaque utilisateur a, pour voir si un poste a bien téléchargé une version que j'ai ajoutée »).
// L'app envoie, avec chaque requête, X-App-Version (identifiant de la version : le commit déployé) et X-App-Build (date de construction, ISO). Valeurs vérifiées : tout ce qui n'a pas la bonne forme est ignoré.
const RE_VERSION = /^[A-Za-z0-9._-]{1,64}$/;
function lireVersionApp(req) {
  try {
    const h = (req && req.headers) || {};
    const version = String(h['x-app-version'] || '').trim();
    if (!RE_VERSION.test(version) || version === 'dev') return null;
    const brut = String(h['x-app-build'] || '').trim();
    const t = Date.parse(brut);
    return { version, build: Number.isFinite(t) ? new Date(t).toISOString() : null };
  } catch (_) { return null; }
}
const ERREURS_COLONNE_ABSENTE = ['42703', 'PGRST204'];

// Marque l'activité d'un compte au plus une fois par minute (mémoire du serveur), sans jamais bloquer la requête.
// La version de l'app est notée dans la même cadence, SEULEMENT quand elle change (ou après un redémarrage du serveur), dans une écriture à part : si les colonnes version_app / version_build
// n'existent pas encore (sql/version_app_utilisateurs.sql pas appliqué), cette écriture échoue sans conséquence et l'activité continue d'être suivie ; nouvel essai toutes les 10 minutes.
function creerSuiviActivite(supabase, { intervalleMs = 60000, maintenant = () => Date.now() } = {}) {
  const dernier = new Map();
  const versionNotee = new Map();
  let prochainEssaiVersion = 0;
  return function suivreActivite(req, res, next) {
    try {
      const id = req.user && req.user.id;
      const t = maintenant();
      if (id && (!dernier.has(id) || t - dernier.get(id) >= intervalleMs)) {
        dernier.set(id, t);
        Promise.resolve(supabase.from('users').update({ derniere_activite: new Date(t).toISOString() }).eq('id', id))
          .catch(() => {});
        const v = lireVersionApp(req);
        if (v && versionNotee.get(id) !== v.version && t >= prochainEssaiVersion) {
          versionNotee.set(id, v.version);
          Promise.resolve(supabase.from('users').update({ version_app: v.version, version_build: v.build }).eq('id', id))
            .then(r => {
              if (r && r.error) {
                versionNotee.delete(id);
                if (ERREURS_COLONNE_ABSENTE.includes(String(r.error.code))) prochainEssaiVersion = t + 10 * 60 * 1000;
              }
            })
            .catch(() => { versionNotee.delete(id); });
        }
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
      version: u.version_app || null, version_build: u.version_build || null, // null = pas encore vue (le navigateur n'a pas encore chargé une version qui l'envoie)
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

module.exports = { jourHaiti, bornesJourHaiti, creerSuiviActivite, classerConnectes, resumerCaisseDuJour, lireVersionApp, ERREURS_COLONNE_ABSENTE, EN_LIGNE_MS };
