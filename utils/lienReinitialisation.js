// utils/lienReinitialisation.js — lien de mot de passe perdu (15/10).
// Firebase refuse de générer le lien (« Domain not allowlisted by project », code auth/unauthorized-continue-uri) quand le site de retour
// (FRONTEND_URL) n'est pas dans Firebase > Authentication > Paramètres > Domaines autorisés — c'est le cas du domaine personnalisé
// app.chffontaine.org tant qu'il n'y a pas été ajouté. Le lien marche très bien SANS adresse de retour (la personne choisit son nouveau
// mot de passe sur la page Firebase, puis revient elle-même sur le site) : on réessaie donc sans, et on le dit à l'administrateur.
const domaineRefuse = (e) => !!e && (e.code === 'auth/unauthorized-continue-uri' || e.code === 'auth/invalid-continue-uri'
  || /allowlist|authorized domain|continue uri/i.test(String(e.message || '')));

// auth : getAuth() de firebase-admin (ou un faux). Renvoie { lien, retourAuSite } ; relance toute autre erreur (compte introuvable, etc.).
async function genererLienReinitialisation(auth, email, urlRetour) {
  if (urlRetour) {
    try {
      return { lien: await auth.generatePasswordResetLink(email, { url: urlRetour }), retourAuSite: true };
    } catch (e) {
      if (!domaineRefuse(e)) throw e;
    }
  }
  return { lien: await auth.generatePasswordResetLink(email), retourAuSite: false };
}

module.exports = { genererLienReinitialisation, domaineRefuse };
