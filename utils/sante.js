// utils/sante.js — page de contrôle pour une surveillance EXTERNE (15/10) : un service gratuit qui visite l'adresse toutes les 5 minutes et prévient s'il n'y a pas de réponse.
// Les alertes qui partent du serveur lui-même ne peuvent rien dire quand le serveur est éteint ; celle-ci le peut, de l'extérieur.
//   GET /sante          : le serveur répond (toujours 200, aucune base consultée) ;
//   GET /sante/complet  : le serveur ET la base répondent (200 « ok » ; 503 « degrade » si la base ne répond pas dans le délai).
// Rien de secret n'est renvoyé : ni donnée, ni nom, ni version. Accessible sans compte (comme /).
const DELAI_BASE_MS = 4000;

function avecDelai(promesse, ms) {
  let minuteur;
  const delai = new Promise((_, rejeter) => { minuteur = setTimeout(() => rejeter(new Error('délai dépassé')), ms); });
  return Promise.race([promesse, delai]).finally(() => clearTimeout(minuteur));
}

// Lit UNE ligne minuscule de la base (type du premier catalogue) : prouve que la base répond, sans rien lire de sensible.
async function verifierSante({ supabase, maintenant = () => Date.now(), delaiMs = DELAI_BASE_MS }) {
  const debut = maintenant();
  let base = 'ok';
  try {
    const { error } = await avecDelai(supabase.from('catalog').select('type').limit(1), delaiMs);
    if (error) base = 'indisponible';
  } catch (_) { base = 'indisponible'; }
  return { statut: base === 'ok' ? 'ok' : 'degrade', base, duree_ms: maintenant() - debut };
}

module.exports = { verifierSante, DELAI_BASE_MS };
