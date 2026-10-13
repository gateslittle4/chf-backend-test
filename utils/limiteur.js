// utils/limiteur.js — limite du nombre de requêtes (13/10, liste de contrôle fintech d'Esdras : « rate limits sur la connexion et les opérations sensibles »).
// Sans limite, un script (ou une personne mal intentionnée avec un compte valide) pouvait envoyer des milliers de requêtes par minute : saturer le
// serveur gratuit de Render, remplir la base de faux paiements, ou tester des jetons à l'infini. Ici : un compteur par clé (compte connecté, adresse...) sur une
// fenêtre de temps, en mémoire (un seul serveur, pas besoin de Redis) ; au-delà du seuil, réponse 429 « réessaie dans N secondes ».
//
// Choix qui comptent pour un hôpital :
//  - on compte par COMPTE CONNECTÉ, pas par adresse internet : tout l'hôpital sort par la même adresse, une limite par adresse bloquerait tout le monde ;
//  - seuils LARGES : un usage normal (même la reprise de 40 paiements après une longue coupure) ne s'en approche pas ;
//  - une demande avec un jeton VALIDE n'est jamais bloquée à cause des mauvais jetons d'autres personnes ;
//  - interrupteur de secours : la variable d'environnement DESACTIVER_LIMITES=1 coupe tout sans toucher au code.

// Seuils (par compte et par minute, sauf mention) — modifiables ici, ou d'urgence via l'environnement (LIMITE_GENERALE, LIMITE_ECRITURES, LIMITE_PAIEMENTS).
const FENETRE_MS = 60 * 1000;
const SEUILS = {
  generale: 600,        // toutes requêtes (l'écran en fait quelques-unes par minute : listes toutes les 45 s)
  ecritures: 240,       // POST / PUT / PATCH / DELETE
  paiements: 120,       // POST /api/paiements (une caisse en fait moins de dix par minute ; 40 d'un coup à la reprise après coupure)
  publiques: 60,        // pages publiques (invitation), par adresse
  echecsAuth: 30,       // jetons manquants / invalides, par adresse, sur 10 minutes
};
const FENETRE_ECHECS_AUTH_MS = 10 * 60 * 1000;

function entierEnv(nom, defaut) {
  const v = Number(process.env[nom]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : defaut;
}

// Compteur à fenêtre fixe : essayer(cle) compte UNE requête et dit si elle passe. nettoyer() oublie les fenêtres terminées.
function creerCompteur({ fenetreMs, max, maintenant = () => Date.now() }) {
  const fenetres = new Map(); // cle -> { debut, n }
  return {
    essayer(cle) {
      const t = maintenant();
      let f = fenetres.get(cle);
      if (!f || t - f.debut >= fenetreMs) { f = { debut: t, n: 0 }; fenetres.set(cle, f); }
      f.n += 1;
      const autorise = f.n <= max;
      return { autorise, restant: Math.max(0, max - f.n), reessayerDansMs: autorise ? 0 : Math.max(1, fenetreMs - (t - f.debut)) };
    },
    // Compte sans bloquer ni incrémenter : l'état actuel d'une clé.
    etat(cle) {
      const t = maintenant();
      const f = fenetres.get(cle);
      if (!f || t - f.debut >= fenetreMs) return { n: 0, bloque: false, reessayerDansMs: 0 };
      return { n: f.n, bloque: f.n > max, reessayerDansMs: f.n > max ? Math.max(1, fenetreMs - (t - f.debut)) : 0 };
    },
    nettoyer() {
      const t = maintenant();
      for (const [cle, f] of fenetres) if (t - f.debut >= fenetreMs) fenetres.delete(cle);
    },
    get taille() { return fenetres.size; },
  };
}

function desactive() {
  return process.env.DESACTIVER_LIMITES === '1' || process.env.DESACTIVER_LIMITES === 'true';
}

function refuser(res, reessayerDansMs, raison) {
  const secondes = Math.max(1, Math.ceil(reessayerDansMs / 1000));
  res.setHeader('Retry-After', String(secondes));
  return res.status(429).json({
    error: 'TROP_DE_REQUETES',
    message: `Trop de demandes en peu de temps. Réessaie dans ${secondes} seconde${secondes > 1 ? 's' : ''}.`,
    raison,
  });
}

const estEcriture = (req) => !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method).toUpperCase());
const estPaiement = (req) => String(req.method).toUpperCase() === 'POST' && /^\/paiements\/?$/.test(req.path || '');

// Limites par compte connecté — À PLACER APRÈS verifyToken (req.user.id connu).
function creerLimiteUtilisateur({ maintenant = () => Date.now(), seuils = {} } = {}) {
  const s = {
    generale: seuils.generale || entierEnv('LIMITE_GENERALE', SEUILS.generale),
    ecritures: seuils.ecritures || entierEnv('LIMITE_ECRITURES', SEUILS.ecritures),
    paiements: seuils.paiements || entierEnv('LIMITE_PAIEMENTS', SEUILS.paiements),
  };
  const generale = creerCompteur({ fenetreMs: FENETRE_MS, max: s.generale, maintenant });
  const ecritures = creerCompteur({ fenetreMs: FENETRE_MS, max: s.ecritures, maintenant });
  const paiements = creerCompteur({ fenetreMs: FENETRE_MS, max: s.paiements, maintenant });
  const mw = (req, res, next) => {
    if (desactive() || !req.user || !req.user.id || String(req.method).toUpperCase() === 'OPTIONS') return next();
    const cle = req.user.id;
    const g = generale.essayer(cle);
    if (!g.autorise) return refuser(res, g.reessayerDansMs, 'generale');
    if (estEcriture(req)) {
      const e = ecritures.essayer(cle);
      if (!e.autorise) return refuser(res, e.reessayerDansMs, 'ecritures');
    }
    if (estPaiement(req)) {
      const p = paiements.essayer(cle);
      if (!p.autorise) return refuser(res, p.reessayerDansMs, 'paiements');
    }
    return next();
  };
  mw.compteurs = { generale, ecritures, paiements };
  mw.nettoyer = () => { generale.nettoyer(); ecritures.nettoyer(); paiements.nettoyer(); };
  return mw;
}

// Pages publiques (invitation...) : par adresse internet. Seuil large (invitations : quelques par jour).
function creerLimitePublique({ maintenant = () => Date.now(), max } = {}) {
  const compteur = creerCompteur({ fenetreMs: FENETRE_MS, max: max || SEUILS.publiques, maintenant });
  const mw = (req, res, next) => {
    if (desactive()) return next();
    const r = compteur.essayer(req.ip || 'inconnue');
    if (!r.autorise) return refuser(res, r.reessayerDansMs, 'publique');
    return next();
  };
  mw.compteur = compteur;
  return mw;
}

// Jetons manquants / invalides : par adresse. Ne bloque QUE les demandes dont le jeton est mauvais (jamais celles d'un jeton valide) —
// verifyToken appelle signalerEchec(req) à chaque rejet ; si l'adresse a trop échoué, il répond 429 au lieu de 401.
function creerLimiteEchecsAuth({ maintenant = () => Date.now(), max } = {}) {
  const compteur = creerCompteur({ fenetreMs: FENETRE_ECHECS_AUTH_MS, max: max || SEUILS.echecsAuth, maintenant });
  return {
    compteur,
    // true = cette adresse est bloquée (réponse 429 à renvoyer, avec reessayerDansMs).
    signalerEchec(req) {
      if (desactive()) return { bloque: false, reessayerDansMs: 0 };
      const r = compteur.essayer(req.ip || 'inconnue');
      return { bloque: !r.autorise, reessayerDansMs: r.reessayerDansMs };
    },
  };
}

module.exports = { FENETRE_MS, FENETRE_ECHECS_AUTH_MS, SEUILS, creerCompteur, creerLimiteUtilisateur, creerLimitePublique, creerLimiteEchecsAuth, refuser, desactive };
