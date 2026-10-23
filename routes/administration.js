// routes/administration.js — Administration : comptes, liens de réinitialisation, anomalies de caisse, invitations, alertes.
// Découpé de server.js le 23/10 sans changer une ligne de logique : le texte des routes est celui d'avant. Ce module reçoit de server.js
// l'application Express et ses dépendances partagées (base, droits, journal d'audit, lecteurs communs) ; voir « montage des routes » dans server.js.
const crypto = require('crypto');
const { getAuth } = require('firebase-admin/auth');
const { genererLienReinitialisation } = require('../utils/lienReinitialisation');
const {
  appliquerMiseAJourPermissions, lireTablePermissions, verifierRoleInvitation, verifierRoleDuLienOuvert, libelleRolePersonnalise,
  refusDeRoleParLaBase, etatBasePourRolesPersonnalises, MESSAGE_ROLE_NON_ACTIVE_INVITE,
} = require('../utils/roles');
// CORRECTIF (23/10) : ces trois fonctions n'avaient JAMAIS été importées dans server.js — GET /api/admin/anomalies plantait (ReferenceError) en production. Trouvé par l'analyse faite pour la découpe.
const { calculerAnomalies, moisDe, moisPrecedent } = require('../utils/anomalies');

module.exports = function monterAdministration(app, { ORIGINE_FRONTEND, ROLES_INVITABLES, aPermission, envoyerCallMeBot, supabase }) { // @enveloppe
// Route : création d'un utilisateur par un administrateur (remplace
// auth.createUserWithEmailAndPassword de Firebase, qui n'a pas d'équivalent sûr côté
// client avec Supabase — créer un compte via le SDK client déconnecterait
// l'administrateur en le remplaçant par la session du nouveau compte).
app.post('/api/admin/users', async (req, res) => {
  if (!(await aPermission(req.user.id, 'utilisateurs_gerer'))) {
    return res.status(403).json({ error: "Permission 'utilisateurs_gerer' requise." });
  }
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email et password requis.' });
  try {
    const nouvelUtilisateur = await getAuth().createUser({ email, password, emailVerified: true });
    // Revendication requise par l'intégration Supabase "Third-Party Auth" (Firebase) — voir
    // PLAN_RLS.md étape 2. N'a aucun effet tant que cette intégration n'est pas configurée côté
    // Supabase ; l'ajouter dès maintenant évite d'avoir à retraiter les comptes créés d'ici là.
    await getAuth().setCustomUserClaims(nouvelUtilisateur.uid, { role: 'authenticated' });
    res.status(201).json({ uid: nouvelUtilisateur.uid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 01/10 (Krystofia) : "il y a trop d'utilisateurs qui ne fonctionnent plus, permets-moi d'en
// supprimer". Suppression DÉFINITIVE d'un compte (Firebase + ligne users). 15/10 (Esdras) : « permets à l'administrateur de
// supprimer totalement un compte » — plus besoin de désactiver d'abord, et un administrateur peut en supprimer un autre. Garde-fous restants :
//   - jamais son propre compte ;
//   - supprimer un administrateur est réservé à un administrateur, et il doit en rester au moins un autre ACTIF ;
//   - l'historique reste intact : paiements, fiches et journal gardent le NOM et l'uid recopiés au
//     moment de l'action (encaisse_par, effectue_par...), ils ne dépendent pas de cette ligne.
// L'identifiant (@chf.com) redevient libre pour un nouveau compte.
app.delete('/api/admin/users/:uid', async (req, res) => {
  if (!(await aPermission(req.user.id, 'utilisateurs_gerer'))) {
    return res.status(403).json({ error: "Permission 'utilisateurs_gerer' requise." });
  }
  const uid = req.params.uid;
  if (uid === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas supprimer ton propre compte.' });
  const { data: cible, error: erreurLecture } = await supabase.from('users').select('id, email, display_name, role, active').eq('id', uid).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!cible) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  if (cible.role === 'administrateur') {
    const { data: appelant } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
    if (!appelant || appelant.role !== 'administrateur') return res.status(403).json({ error: "Seul un administrateur peut supprimer un compte administrateur." });
    const { data: autres, error: erreurAutres } = await supabase.from('users').select('id').eq('role', 'administrateur').neq('active', false).neq('id', uid);
    if (erreurAutres) return res.status(500).json({ error: erreurAutres.message });
    if (!autres || autres.length === 0) return res.status(400).json({ error: "Impossible : ce serait le dernier administrateur actif. Crée ou réactive un autre administrateur d'abord." });
  }
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') return res.status(500).json({ error: 'Compte de connexion non supprimé : ' + e.message });
  }
  const { data: supprime, error: erreurSuppression } = await supabase.from('users').delete().eq('id', uid).select('id');
  if (erreurSuppression) return res.status(500).json({ error: "Connexion supprimée mais fiche utilisateur conservée : " + erreurSuppression.message });
  if (!supprime || supprime.length === 0) return res.status(500).json({ error: 'Fiche utilisateur non supprimée (0 ligne).' });
  const { error: erreurAudit } = await supabase.from('audit_log').insert({
    id: crypto.randomUUID(),
    action: 'suppression_utilisateur',
    effectue_par: req.user.email || req.user.id,
    effectue_par_uid: req.user.id,
    details: { utilisateurCible: uid, email: cible.email, nom: cible.display_name, role: cible.role },
    date: new Date().toISOString(),
  });
  if (erreurAudit) console.warn('Audit de suppression d\'utilisateur non enregistré :', erreurAudit.message);
  res.json({ success: true });
});

// Génère un lien de réinitialisation SANS envoyer d'email — identifiant@chf.com n'est pas une
// vraie boîte mail (voir discussion avec Esdras du 22/08), donc sendPasswordResetEmail
// n'atteindrait jamais personne tout en affichant "envoyé avec succès". L'administrateur
// récupère le lien ici et le transmet lui-même (téléphone, WhatsApp, en personne).
app.post('/api/admin/generer-lien-reinitialisation', async (req, res) => {
  if (!(await aPermission(req.user.id, 'utilisateurs_gerer'))) {
    return res.status(403).json({ error: "Permission 'utilisateurs_gerer' requise." });
  }
  const { email } = req.body;
  if (!email || !String(email).trim()) return res.status(400).json({ error: 'email requis.' });
  try {
    const { lien, retourAuSite } = await genererLienReinitialisation(getAuth(), email.trim(), process.env.FRONTEND_URL || 'https://chf-app2.onrender.com');
    res.json(retourAuSite ? { lien } : {
      lien,
      avertissement: "Lien créé sans retour automatique vers le site (le domaine du site n'est pas dans les « Domaines autorisés » de Firebase). Il fonctionne : après avoir choisi son mot de passe, la personne rouvre le site elle-même.",
    });
  } catch (e) {
    if (e.code === 'auth/user-not-found') return res.status(404).json({ error: 'Aucun compte avec cet email.' });
    res.status(500).json({ error: e.message });
  }
});

// Rapport de contrôle des anomalies de caisse (15/10) — voir utils/anomalies.js. RÉSERVÉ AU RÔLE « administrateur » : pas une permission qu'on pourrait donner à un autre
// rôle par l'écran Rôles & permissions, volontairement (Esdras : ce rapport est pour lui seul, pas encore pour la direction).
app.get('/api/admin/anomalies', async (req, res) => {
  const { data: profil, error: erreurProfil } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
  if (erreurProfil) return res.status(500).json({ error: erreurProfil.message });
  if (!profil || profil.role !== 'administrateur') return res.status(403).json({ error: "Réservé à l'administrateur." });
  const mois = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.mois || '')) ? String(req.query.mois) : moisDe(Date.now());
  const precedent = moisPrecedent(mois);
  // Fenêtre de lecture : du mois précédent à la fin du mois demandé, avec un jour de marge de chaque côté (le découpage exact se fait en heure d'Haïti dans calculerAnomalies).
  const [a, m] = mois.split('-').map(Number);
  const debut = new Date(Date.UTC(m === 1 ? a - 1 : a, m === 1 ? 11 : m - 2, 1) - 86400000).toISOString();
  const fin = new Date(Date.UTC(m === 12 ? a + 1 : a, m === 12 ? 0 : m, 1) + 86400000).toISOString();
  const lirePages = async (requete) => { // la base renvoie 1000 lignes au plus par appel
    const toutes = [];
    for (let i = 0; i < 30; i++) {
      const { data, error } = await requete().range(i * 1000, i * 1000 + 999);
      if (error) throw new Error(error.message);
      toutes.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return toutes;
  };
  try {
    const paiements = await lirePages(() => supabase.from('paiements').select('id, mode, montant, date_paiement, annule, annule_par, annule_par_uid, encaisse_par, traite_par_uid, exoneration, supprime_le').gte('date_paiement', debut).lt('date_paiement', fin).order('id'));
    const depenses = await lirePages(() => supabase.from('depenses_caisse').select('id, statut, montant, caissier_uid, caissier, date_reponse, date_demande').order('id'));
    const { data: ligneSessions } = await supabase.from('catalog').select('items').eq('type', 'sessions_caisse').maybeSingle();
    const { data: utilisateurs, error: erreurUsers } = await supabase.from('users').select('id, display_name, role');
    if (erreurUsers) return res.status(500).json({ error: erreurUsers.message });
    const entree = { paiements, depenses, sessions: (ligneSessions && ligneSessions.items) || [], utilisateurs: utilisateurs || [] };
    res.json({ mois, precedent, actuel: calculerAnomalies({ ...entree, mois }), moisPrecedent: calculerAnomalies({ ...entree, mois: precedent }) });
  } catch (e) {
    res.status(500).json({ error: 'Lecture impossible : ' + e.message });
  }
});
// Durées proposées à l'écran. Bornées ici aussi : le corps de la requête ne doit pas pouvoir
// fabriquer un lien valable dix ans.
const HEURES_VALIDITE_MAX = 168; // 7 jours

app.post('/api/admin/invitations', async (req, res) => {
  if (!(await aPermission(req.user.id, 'utilisateurs_gerer'))) {
    return res.status(403).json({ error: "Permission 'utilisateurs_gerer' requise." });
  }
  const { role, heuresValidite, note } = req.body || {};
  const lectureRoles = await lireTablePermissions(supabase);
  if (lectureRoles.erreur) return res.status(500).json({ error: lectureRoles.erreur.message });
  // Rôles du code + rôles créés depuis l'écran ; un rôle créé depuis l'écran n'est donné par lien que si la base
  // l'accepte (sql/roles_personnalises.sql collé). Décision dans utils/roles.js, où les tests l'exécutent.
  const refusRole = await verifierRoleInvitation({ role, invitablesIntegres: ROLES_INVITABLES, table: lectureRoles.table, supabase });
  if (refusRole) return res.status(refusRole.status).json({ error: refusRole.error });
  const heures = Number(heuresValidite);
  if (!Number.isFinite(heures) || heures <= 0 || heures > HEURES_VALIDITE_MAX) {
    return res.status(400).json({ error: `Durée de validité invalide (entre 1 et ${HEURES_VALIDITE_MAX} heures).` });
  }
  // 32 octets aléatoires = 43 caractères en base64url. Sûr cryptographiquement (crypto, pas
  // Math.random) et sans caractère qui pose problème dans une URL collée dans WhatsApp.
  const token = crypto.randomBytes(32).toString('base64url');
  const { data, error } = await supabase.from('invitations').insert({
    token, role, note: (note || '').trim() || null,
    cree_par_uid: req.user.id, cree_par_email: req.user.email || null,
    date_expiration: new Date(Date.now() + heures * 3600000).toISOString(),
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ...data, lien: `${ORIGINE_FRONTEND}/invitation/${token}` });
});

// L'écran Utilisateurs demande, AVANT de créer un compte avec un rôle créé depuis l'écran Rôles & permissions, si la
// base accepte ce genre de rôle : le compte de connexion est créé en premier, et un refus ensuite le laisserait sans
// profil (donc « auditeur » à sa première connexion). Réponse { pret: true|false }.
app.get('/api/admin/roles-personnalises/pret', async (req, res) => {
  if (!(await aPermission(req.user.id, 'utilisateurs_gerer'))) {
    return res.status(403).json({ error: "Permission 'utilisateurs_gerer' requise." });
  }
  const etat = await etatBasePourRolesPersonnalises(supabase);
  if (etat.erreur) return res.status(500).json({ error: etat.erreur.message });
  res.json({ pret: etat.pret });
});

app.get('/api/admin/invitations', async (req, res) => {
  if (!(await aPermission(req.user.id, 'utilisateurs_gerer'))) {
    return res.status(403).json({ error: "Permission 'utilisateurs_gerer' requise." });
  }
  const { data, error } = await supabase.from('invitations').select('*')
    .order('date_creation', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(i => ({ ...i, lien: `${ORIGINE_FRONTEND}/invitation/${i.token}` })));
});

// Annulation d'un lien encore ouvert (envoyé à la mauvaise personne, ou plus nécessaire).
// On ne SUPPRIME pas la ligne : la trace de qui a invité qui, et avec quel rôle, doit rester.
app.patch('/api/admin/invitations/:token/revoquer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'utilisateurs_gerer'))) {
    return res.status(403).json({ error: "Permission 'utilisateurs_gerer' requise." });
  }
  const { data, error } = await supabase.from('invitations')
    .update({ revoque: true }).eq('token', req.params.token).is('utilise_le', null).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) {
    return res.status(409).json({ error: "Ce lien a déjà servi — impossible de l'annuler. Désactive plutôt le compte créé." });
  }
  res.json(data[0]);
});

// Alerte WhatsApp quand une demande d'exonération est créée (retour d'Esdras, 29/08) — appelée
// par CalculateurPanel.js juste après avoir créé la demande dans Firestore (demandes_exoneration,
// collection HORS de ce backend Supabase — c'est pour ça que ceci est un appel séparé, pas
// déclenché depuis une route existante). N'importe quel utilisateur authentifié peut l'appeler
// (verifyToken, ligne ~237, s'applique déjà à toute route /api) : ça ne fait que déclencher une
// notification best-effort, aucune donnée sensible exposée ni modifiée.
app.post('/api/notifications/exoneration-demandee', async (req, res) => {
  // Texte libre venant du client : borné et nettoyé (pas de retours à la ligne, 80 caractères max)
  // pour qu'un utilisateur connecté ne puisse pas fabriquer un message WhatsApp arbitraire/long.
  const propre = (v, fallback) => (typeof v === 'string' || typeof v === 'number') ? String(v).replace(/[\r\n]+/g, ' ').slice(0, 80) : fallback;
  const { patientNom, montantExonere, pourcentage, demandeur } = req.body || {};
  const montantAffiche = Number.isFinite(Number(montantExonere)) ? Math.round(Number(montantExonere)) : '?';
  envoyerCallMeBot(`🎯 CHF : demande d'exonération de ${propre(demandeur, 'inconnu')} pour ${propre(patientNom, 'un patient')} — ${propre(pourcentage, '?')}% (${montantAffiche} Gdes). À approuver dans l'app.`);
  res.json({ success: true }); // best-effort : jamais d'erreur même si CallMeBot est down
});
}; // @enveloppe
