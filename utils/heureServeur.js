// utils/heureServeur.js — l'heure d'un paiement est l'heure RÉELLE (celle du serveur), jamais celle de l'ordinateur de la caisse (13/10, Esdras :
// « on peut dérégler l'ordi et perdre la vraie heure »). Avant, l'app envoyait date_paiement = new Date() du navigateur et le serveur l'enregistrait
// telle quelle : un PC déréglé rangeait le paiement dans le mauvais poste de caisse ou le mauvais jour, sans que rien ne le signale.
//
// Deux cas, séparés par l'en-tête X-CHF-Rejeu que l'app pose quand elle REJOUE une opération restée dans sa file hors ligne :
//   - requête en direct : l'heure du serveur fait foi, sans exception. Si l'ordinateur annonçait une heure très différente (plus de 2 min), l'heure
//     annoncée et l'écart sont gardés dans details (heure_appareil, decalage_appareil_s) : la direction peut voir quel poste est déréglé.
//   - rejeu hors ligne : le paiement a eu lieu AVANT (parfois des heures) ; le serveur ne peut pas la deviner. L'app envoie son heure CORRIGÉE avec le
//     dernier calage sur le serveur (voir chf-app2 utils/heureReelle.js). Elle est gardée, mais jamais dans le futur, et marquée heure_hors_ligne.
const TOLERANCE_MS = 2 * 60 * 1000;

// En-tête ajouté à CHAQUE réponse : l'heure du serveur en millisecondes. L'app s'en sert pour caler son horloge (le navigateur ne peut pas lire
// l'en-tête standard Date d'une autre origine sans que le serveur l'expose — d'où cet en-tête dédié, listé dans exposedHeaders de CORS).
const ENTETE_HEURE = 'X-CHF-Heure';
const ENTETE_REJEU = 'X-CHF-Rejeu';

function middlewareHeureServeur(req, res, next) {
  res.setHeader(ENTETE_HEURE, String(Date.now()));
  next();
}

function estRejeu(req) {
  const v = req && req.headers ? req.headers[ENTETE_REJEU.toLowerCase()] : null;
  return v === '1' || v === 'true';
}

// Renvoie { date: ISO à enregistrer, details: objet à FUSIONNER dans paiements.details ou null }.
function heureDuPaiement({ dateClient, rejeu = false, maintenant = new Date() } = {}) {
  const now = maintenant.getTime();
  const t = dateClient === undefined || dateClient === null || dateClient === '' ? NaN : Date.parse(dateClient);
  if (!rejeu) {
    const details = Number.isFinite(t) && Math.abs(t - now) > TOLERANCE_MS
      ? { heure_appareil: new Date(t).toISOString(), decalage_appareil_s: Math.round((t - now) / 1000) }
      : null;
    return { date: new Date(now).toISOString(), details };
  }
  if (!Number.isFinite(t)) return { date: new Date(now).toISOString(), details: { heure_hors_ligne: true, heure_inconnue: true } };
  if (t > now + TOLERANCE_MS) {
    // Une opération hors ligne ne peut pas venir du futur : l'horloge de l'appareil était en avance et non calée.
    return { date: new Date(now).toISOString(), details: { heure_hors_ligne: true, heure_appareil: new Date(t).toISOString(), decalage_appareil_s: Math.round((t - now) / 1000) } };
  }
  return { date: new Date(Math.min(t, now)).toISOString(), details: { heure_hors_ligne: true } };
}

// Applique au corps d'un paiement (modifié sur place). Les anciens clients qui n'envoient pas de date reçoivent l'heure du serveur.
function appliquerHeureAuPaiement(corps, req, maintenant = new Date()) {
  const r = heureDuPaiement({ dateClient: corps.date_paiement, rejeu: estRejeu(req), maintenant });
  corps.date_paiement = r.date;
  if (r.details) {
    const actuels = corps.details && typeof corps.details === 'object' && !Array.isArray(corps.details) ? corps.details : {};
    corps.details = { ...actuels, ...r.details };
  }
  return r;
}

module.exports = { TOLERANCE_MS, ENTETE_HEURE, ENTETE_REJEU, middlewareHeureServeur, estRejeu, heureDuPaiement, appliquerHeureAuPaiement };
