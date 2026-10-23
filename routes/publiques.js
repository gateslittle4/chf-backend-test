// routes/publiques.js — Santé, portail patient, création de compte par invitation (routes ouvertes, sans jeton).
// Découpé de server.js le 23/10 sans changer une ligne de logique : le texte des routes est celui d'avant. Ce module reçoit de server.js
// l'application Express et ses dépendances partagées (base, droits, journal d'audit, lecteurs communs) ; voir « montage des routes » dans server.js.
const crypto = require('crypto');
const { getAuth } = require('firebase-admin/auth');
const { motsDuNom } = require('../utils/portailPatient');
const { verifierSante } = require('../utils/sante');
const {
  appliquerMiseAJourPermissions, lireTablePermissions, verifierRoleInvitation, verifierRoleDuLienOuvert, libelleRolePersonnalise,
  refusDeRoleParLaBase, etatBasePourRolesPersonnalises, MESSAGE_ROLE_NON_ACTIVE_INVITE,
} = require('../utils/roles');

module.exports = function monterPubliques(app, { ROLES_INVITABLES, limitePublique, supabase }) { // @enveloppe
app.get('/', (req, res) => res.json({ statut: 'CHF backend (Firebase Auth + Supabase DB) en ligne' }));
// Surveillance externe (15/10) — voir utils/sante.js. Publiques, sans donnée : /sante (le serveur répond), /sante/complet (le serveur ET la base répondent ; 503 sinon).
app.get('/sante', (req, res) => res.json({ statut: 'ok', heure: new Date().toISOString() }));
app.get('/sante/complet', limitePublique, async (req, res) => {
  const etat = await verifierSante({ supabase });
  res.status(etat.statut === 'ok' ? 200 : 503).json({ ...etat, heure: new Date().toISOString() });
});

// ============================================================
// Portail patient (retour d'Esdras, 24/08) : un patient qui a perdu/jeté sa prescription papier
// peut retrouver la liste des médicaments/actes de sa dernière visite, SANS compte à créer. Route
// VOLONTAIREMENT hors de /api (donc PAS protégée par `verifyToken`, appliqué juste plus bas via
// `app.use('/api', verifyToken)`) — c'est le seul accès public de tout ce backend, à traiter avec
// prudence : jamais de prix/solde/mode de paiement dans la réponse (décision explicite d'Esdras,
// une donnée financière est plus sensible qu'une liste de médicaments), et 3 informations exigées
// ensemble (numéro de dossier + date de naissance + nom) plutôt qu'une seule, pour qu'un tiers ne
// puisse pas retrouver un patient avec une seule information devinée/connue.
//
// Limite de tentatives en mémoire (pas besoin de Redis pour ce volume) — 5 essais par 15 minutes,
// par couple (adresse IP, numéro de dossier tenté), pour empêcher d'essayer toutes les dates de
// naissance possibles sur un numéro de dossier connu/deviné.
const tentativesPortailPatient = new Map(); // cle: "ip:numero_dossier" -> [timestamps]
const FENETRE_LIMITE_PORTAIL_MS = 15 * 60 * 1000;
const MAX_TENTATIVES_PORTAIL = 5;

// Réglage désactivable depuis l'écran Paramètres (retour d'Esdras du 24/08 : "je peux désactiver
// ça sans tout supprimer ?") — vérifié CÔTÉ SERVEUR, pas juste masqué côté écran : cette route est
// publique, donc la couper uniquement dans l'interface n'empêcherait pas quelqu'un de continuer à
// l'appeler directement. Activé par défaut (true) tant que personne n'a jamais touché à l'écran
// Paramètres — cohérent avec le reste des catalogues (repli sur un comportement inchangé).
async function portailPatientActif() {
  const { data } = await supabase.from('catalog').select('items').eq('type', 'parametres').maybeSingle();
  const parametres = data?.items;
  return !parametres || parametres.portailPatientActif !== false;
}

app.post('/portail-patient/recherche', async (req, res) => {
  if (!(await portailPatientActif())) {
    return res.status(503).json({ error: "Ce service est temporairement désactivé." });
  }
  const { numero_dossier, date_naissance, nom } = req.body || {};
  if (!numero_dossier || !date_naissance || !nom) {
    return res.status(400).json({ error: "Numéro de dossier, date de naissance et nom complet sont requis." });
  }
  const cle = `${req.ip}:${numero_dossier}`;
  const maintenant = Date.now();
  const tentatives = (tentativesPortailPatient.get(cle) || []).filter(t => maintenant - t < FENETRE_LIMITE_PORTAIL_MS);
  if (tentatives.length >= MAX_TENTATIVES_PORTAIL) {
    return res.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques minutes." });
  }
  tentatives.push(maintenant);
  tentativesPortailPatient.set(cle, tentatives);
  // Audit du 01/09 : une entrée n'était supprimée qu'en cas de SUCCÈS (plus bas). Chaque tentative
  // ratée depuis une IP nouvelle, ou sur un numéro de dossier nouveau, laissait donc une clé pour
  // toujours — sur la seule route publique de l'app, atteignable par n'importe quel scanner
  // d'internet. La mémoire du serveur montait sans jamais redescendre, jusqu'au redémarrage de
  // Render (qui remet au passage le compteur anti-force-brute à zéro). On balaie les clés
  // périmées quand la table devient grande : rien ne change tant que le trafic est normal.
  if (tentativesPortailPatient.size > 5000) {
    for (const [k, ts] of tentativesPortailPatient) {
      if (!ts.some(t => maintenant - t < FENETRE_LIMITE_PORTAIL_MS)) tentativesPortailPatient.delete(k);
    }
  }

  // Même message d'erreur générique dans TOUS les cas de désaccord (dossier introuvable, date ou
  // nom qui ne correspond pas) — ne jamais laisser deviner QUELLE information était fausse.
  const echec = () => res.status(404).json({ error: "Aucun dossier ne correspond à ces informations." });

  const { data: dossier } = await supabase.from('dossiers').select('*')
    .eq('numero_dossier', numero_dossier).eq('date_naissance', date_naissance).maybeSingle();
  if (!dossier || motsDuNom(dossier.nom) !== motsDuNom(nom)) return echec();

  // Succès : la personne a bien prouvé qui elle est, on lui laisse le bénéfice du doute pour ses
  // prochaines recherches (n'accumule plus contre le compteur ci-dessus).
  tentativesPortailPatient.delete(cle);

  // .is('supprime_le', null) (25/09) : une visite ou une fiche mise à la corbeille ne doit jamais
  // réapparaître au patient comme s'il l'avait réellement reçue.
  const { data: episodes } = await supabase.from('episodes').select('id').eq('dossier_id', dossier.id).is('supprime_le', null);
  const episodeIds = (episodes || []).map(e => e.id);
  const { data: fiches } = episodeIds.length === 0 ? { data: [] } : await supabase
    .from('fiches').select('date_creation, raw_state').in('episode_id', episodeIds).is('supprime_le', null)
    .order('date_creation', { ascending: false }).limit(5);

  const historique = (fiches || []).map(f => ({
    date: f.date_creation,
    // lignesCalcul (voir CalculateurPanel.js) porte nom/qte/prix par article — seuls nom et qte
    // quittent ce backend, jamais le prix.
    articles: (f.raw_state?.lignesCalcul || []).map(l => ({ nom: l.nom, quantite: l.qte })),
  }));
  res.json({ nomPatient: dossier.nom, historique });
});

// ============================================================
// LIENS D'INVITATION (retour d'Esdras, 02/09) : "la possibilité de générer un lien temporaire à
// envoyer à quelqu'un pour qu'elle crée un nouveau compte toute seule, et je prédéfinis le rôle
// dès le départ." L'administrateur génère le lien (POST /api/admin/invitations, plus bas), le
// transmet lui-même par WhatsApp — même raison que le lien de réinitialisation : identifiant@chf.com
// n'est pas une vraie boîte mail, aucun email ne partira jamais d'ici.
//
// Les 2 routes ci-dessous sont PUBLIQUES (hors /api, donc hors verifyToken) : la personne invitée
// n'a par définition pas encore de compte. C'est le 2e accès public de tout ce backend après le
// portail patient, et le plus sensible des deux — il CRÉE un compte. D'où :
//   - un jeton de 32 octets aléatoires (crypto.randomBytes), impossible à deviner ou à énumérer ;
//   - à USAGE UNIQUE, réservé de façon atomique (UPDATE ... WHERE utilise_le IS NULL) avant même
//     de créer le compte : deux personnes qui ouvrent le même lien en même temps, une seule passe ;
//   - une date d'expiration obligatoire, vérifiée ici et pas seulement à l'affichage ;
//   - le rôle vient TOUJOURS de la ligne en base, JAMAIS du corps de la requête — sinon l'invité
//     n'aurait qu'à changer un champ dans sa requête pour se donner le rôle qu'il veut ;
//   - le rôle 'administrateur' est refusé à la création du lien (voir plus bas) : un lien qui
//     traîne dans une conversation WhatsApp ne doit jamais pouvoir donner les pleins pouvoirs.
const tentativesInvitation = new Map(); // cle: "ip" -> [timestamps]
const FENETRE_LIMITE_INVITATION_MS = 15 * 60 * 1000;
const MAX_TENTATIVES_INVITATION = 10;

function limiteInvitationAtteinte(ip) {
  const maintenant = Date.now();
  const tentatives = (tentativesInvitation.get(ip) || []).filter(t => maintenant - t < FENETRE_LIMITE_INVITATION_MS);
  tentatives.push(maintenant);
  tentativesInvitation.set(ip, tentatives);
  // Même ménage que pour le portail patient : sans ça, chaque IP ayant essayé une fois laisserait
  // une clé pour toujours sur une route publique atteignable par n'importe quel scanner d'internet.
  if (tentativesInvitation.size > 5000) {
    for (const [k, ts] of tentativesInvitation) {
      if (!ts.some(t => maintenant - t < FENETRE_LIMITE_INVITATION_MS)) tentativesInvitation.delete(k);
    }
  }
  return tentatives.length > MAX_TENTATIVES_INVITATION;
}

// Lit une invitation et dit si elle est encore utilisable. Message d'erreur volontairement précis
// ICI (expiré / déjà utilisé / inconnu) : contrairement au portail patient, il n'y a rien à
// deviner — sans le jeton, qui fait 43 caractères aléatoires, on n'atteint jamais cette réponse ;
// et la personne invitée doit pouvoir comprendre pourquoi son lien ne marche pas.
async function lireInvitationUtilisable(token) {
  const { data } = await supabase.from('invitations').select('*').eq('token', token).maybeSingle();
  if (!data) return { erreur: "Ce lien d'invitation n'existe pas ou a été supprimé." };
  if (data.revoque) return { erreur: "Ce lien d'invitation a été annulé par l'administrateur." };
  if (data.utilise_le) return { erreur: "Ce lien a déjà servi à créer un compte. Demande-en un nouveau." };
  if (new Date(data.date_expiration) < new Date()) return { erreur: "Ce lien a expiré. Demande-en un nouveau à l'administrateur." };
  // 09/10 : le rôle d'un lien doit exister au moment où il sert (un rôle créé depuis l'écran a pu être supprimé depuis).
  const refusRole = await verifierRoleDuLienOuvert({ role: data.role, invitablesIntegres: ROLES_INVITABLES, supabase });
  if (refusRole) return { erreur: refusRole.error, statut: refusRole.status };
  return { invitation: data };
}

app.get('/invitation/:token', limitePublique, async (req, res) => {
  if (limiteInvitationAtteinte(req.ip)) {
    return res.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques minutes." });
  }
  const { erreur, statut, invitation } = await lireInvitationUtilisable(req.params.token);
  if (erreur) return res.status(statut || 404).json({ error: erreur });
  // role_libelle (09/10) : la personne invitée n'est pas connectée, donc ne peut pas lire la table des
  // rôles — le NOM d'un rôle personnalisé doit lui être donné ici (null pour un rôle du code, que l'app
  // connaît déjà). Une table illisible ne doit jamais empêcher l'invitation de s'afficher.
  const lectureRoles = await lireTablePermissions(supabase);
  const roleLibelle = lectureRoles.table ? libelleRolePersonnalise(invitation.role, lectureRoles.table) : null;
  // Rien d'autre ne sort d'ici : ni qui a créé le lien, ni la note interne de l'administrateur
  // (« le nouveau caissier de nuit »), qui ne regarde pas la personne invitée.
  res.json({ valide: true, role: invitation.role, role_libelle: roleLibelle, expire_le: invitation.date_expiration });
});

app.post('/invitation/:token/creer-compte', limitePublique, async (req, res) => {
  if (limiteInvitationAtteinte(req.ip)) {
    return res.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques minutes." });
  }
  const { identifiant, displayName, password } = req.body || {};
  if (!identifiant || !displayName || !password) {
    return res.status(400).json({ error: "Identifiant, nom complet et mot de passe sont requis." });
  }
  // Même forme d'identifiant que les comptes créés à la main par l'administrateur : un mot simple,
  // auquel on ajoute @chf.com. On refuse tout ce qui n'est pas [a-z0-9._-] pour que la personne
  // invitée ne puisse pas fabriquer une adresse dans un autre domaine, ni glisser d'espace.
  const identifiantPropre = String(identifiant).trim().toLowerCase().replace(/@chf\.com$/, '');
  if (!/^[a-z0-9._-]{3,40}$/.test(identifiantPropre)) {
    return res.status(400).json({ error: "Identifiant invalide : 3 à 40 caractères, lettres/chiffres/point/tiret uniquement, sans espace ni accent." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Le mot de passe doit faire au moins 8 caractères." });
  }
  if (!String(displayName).trim()) {
    return res.status(400).json({ error: "Le nom complet est requis." });
  }

  const { erreur, statut } = await lireInvitationUtilisable(req.params.token);
  if (erreur) return res.status(statut || 404).json({ error: erreur });

  // RÉSERVATION ATOMIQUE avant toute création : la condition utilise_le IS NULL est évaluée par
  // Postgres, pas par nous — deux requêtes simultanées avec le même jeton ne peuvent pas passer
  // toutes les deux. `date_expiration` est revérifiée ici aussi pour qu'un lien qui expire pile
  // entre la lecture ci-dessus et cette écriture ne passe pas.
  const { data: reserve, error: erreurReservation } = await supabase.from('invitations')
    .update({ utilise_le: new Date().toISOString() })
    .eq('token', req.params.token).is('utilise_le', null).eq('revoque', false)
    .gt('date_expiration', new Date().toISOString())
    .select();
  if (erreurReservation) return res.status(500).json({ error: erreurReservation.message });
  if (!reserve || reserve.length === 0) {
    return res.status(409).json({ error: "Ce lien vient d'être utilisé. Demande-en un nouveau." });
  }
  const invitation = reserve[0];
  // Si la création échoue (identifiant déjà pris, Firebase indisponible), le lien est RELIBÉRÉ :
  // sans ça, une personne qui se trompe d'identifiant une seule fois brûlerait son invitation et
  // devrait rappeler l'administrateur.
  // .select() obligatoire : un UPDATE qui ne touche aucune ligne ne lève AUCUNE erreur côté
  // Supabase (voir le test "Toutes les écritures vérifient une ligne réellement affectée"). Ici,
  // une libération silencieusement sans effet laisserait l'invitation brûlée alors que le compte
  // n'a pas été créé — la personne appellerait l'administrateur sans que rien ne l'explique.
  const relacher = async () => {
    const { data, error } = await supabase.from('invitations')
      .update({ utilise_le: null }).eq('token', req.params.token).select();
    if (error || !data || data.length === 0) {
      console.error(`⚠️ Invitation ${req.params.token.slice(0, 8)}… NON relâchée après un échec de création — elle restera inutilisable.`, error ? error.message : '0 ligne');
    }
  };

  const email = `${identifiantPropre}@chf.com`;
  let nouvelUtilisateur;
  try {
    nouvelUtilisateur = await getAuth().createUser({ email, password: String(password), emailVerified: true });
    await getAuth().setCustomUserClaims(nouvelUtilisateur.uid, { role: 'authenticated' });
  } catch (e) {
    await relacher();
    if (e.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: "Cet identifiant est déjà pris. Choisis-en un autre." });
    }
    if (e.code === 'auth/invalid-password') {
      return res.status(400).json({ error: "Mot de passe refusé : au moins 8 caractères." });
    }
    return res.status(500).json({ error: e.message });
  }

  // Le profil est écrit ICI, côté serveur (clé service_role) : la personne invitée n'a aucun droit
  // d'écriture sur la table users depuis son navigateur, et surtout le rôle doit venir de
  // l'invitation, pas d'elle. `active: true` explicitement, jamais de date_expiration (l'accès
  // temporaire reste une décision distincte, prise après coup depuis Gestion des utilisateurs).
  const { error: erreurProfil } = await supabase.from('users').insert({
    id: nouvelUtilisateur.uid, email, display_name: String(displayName).trim(),
    role: invitation.role, active: true,
  });
  if (erreurProfil) {
    // Le compte Firebase existe mais n'a pas de profil : sans rôle il ne peut rien faire et le
    // prochain login le recréerait en 'auditeur' (voir ApplicationRoot). On le supprime pour que
    // l'invité puisse simplement recommencer avec le même lien, relâché juste après.
    try { await getAuth().deleteUser(nouvelUtilisateur.uid); } catch (_) {}
    await relacher();
    // Rôle personnalisé alors que la base a encore l'ancienne liste fixe (sql/roles_personnalises.sql pas
    // collé) : la personne invitée ne peut rien y faire — elle doit prévenir l'administrateur. Le lien est
    // relâché, elle réessaiera avec le même. Le détail pour l'administrateur reste dans les journaux.
    if (refusDeRoleParLaBase(erreurProfil)) {
      console.error(`⚠️ Création par invitation refusée : la base n'accepte pas le rôle « ${invitation.role} » (users_role_check). Coller sql/roles_personnalises.sql dans Supabase (SQL Editor).`);
      return res.status(409).json({ error: MESSAGE_ROLE_NON_ACTIVE_INVITE });
    }
    return res.status(500).json({ error: erreurProfil.message });
  }

  // Complète la ligne déjà réservée plus haut (utilise_le est posé depuis la réservation). Le
  // compte existe déjà à ce stade : si cette écriture-ci rate, l'invitation reste bien consommée,
  // seule la trace de QUI l'a utilisée manque — journalisée pour qu'elle ne disparaisse pas.
  const { data: trace, error: erreurTrace } = await supabase.from('invitations').update({
    utilise_par_uid: nouvelUtilisateur.uid, utilise_par_email: email,
  }).eq('token', req.params.token).select();
  if (erreurTrace || !trace || trace.length === 0) {
    console.warn(`⚠️ Invitation ${req.params.token.slice(0, 8)}… : compte ${email} créé, mais l'utilisateur n'a pas pu être noté sur le lien.`, erreurTrace ? erreurTrace.message : '0 ligne');
  }

  // Trace anti-fraude : c'est la seule création de compte que personne de connecté n'a effectuée.
  // effectue_par_uid porte l'UID du NOUVEAU compte, et details rappelle qui avait émis le lien.
  // Best-effort comme partout ailleurs (enregistrerAudit côté front) : un journal qui refuse la
  // ligne ne doit pas annuler un compte déjà créé — mais l'échec est journalisé, pas avalé.
  const { error: erreurAudit } = await supabase.from('audit_log').insert({
    id: crypto.randomUUID(),
    action: 'creation_compte_par_invitation',
    effectue_par: String(displayName).trim(),
    effectue_par_uid: nouvelUtilisateur.uid,
    details: { email, role: invitation.role, invite_par: invitation.cree_par_email || invitation.cree_par_uid || null },
    date: new Date().toISOString(),
  });
  if (erreurAudit) console.warn('Audit de création par invitation non enregistré :', erreurAudit.message);

  console.log(`✅ Compte créé par invitation : ${email} (rôle ${invitation.role})`);
  res.status(201).json({ success: true, email, role: invitation.role });
});
}; // @enveloppe
