require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { compterActesNaissance, conflitActeNaissance, motifDerogationValide } = require('./utils/actesNaissance');
const { hospitaliserEpisode } = require('./utils/hospitalisation');
const { fermerConsultationsAnciennes } = require('./utils/fermetureConsultations');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants.');
  console.error('   → Copiez .env.example vers .env et remplissez vos vraies valeurs');
  console.error('   → (Supabase → Project Settings → API → service_role, PAS anon)');
  process.exit(1);
}
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT manquant.');
  console.error('   → Firebase Console → ⚙️ Paramètres du projet → Comptes de service');
  console.error('   → "Générer une nouvelle clé privée" → collez le JSON entier (une seule ligne) dans .env');
  process.exit(1);
}

initializeApp({
  credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});

const app = express();

// Ce backend vérifie déjà l'identité Firebase de chaque appelant (middleware verifyToken
// ci-dessous) avant de toucher à quoi que ce soit — c'est donc un serveur de confiance, qui
// doit CONTOURNER RLS plutôt que d'être bridé par des règles pensées pour un accès direct
// depuis un navigateur non fiable. D'où la clé service_role, pas anon (changé le 18/08 : ce
// backend utilisait l'anon key jusqu'ici, ce qui aurait bloqué ces routes une fois RLS activé).
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const { validerCreationEpisode } = require('./utils/validationEpisode');
const { motsDuNom } = require('./utils/portailPatient');
const { validerPaiementPartiel, soldeAjouteParPaiement } = require('./utils/paiementPartiel');
const { memePatient, formaterNomPropre, erreurIdentiteDossier } = require('./utils/dossiers');
const { creerServiceSauvegarde } = require('./utils/sauvegardeServeur');
const { numeroProvisoire, erreurNumeroDossier, erreurNumeroDepart, donnerNumeroAuPremierEpisode, marquerExamensSeulement } = require('./utils/numeroDossier');
const { genererLienReinitialisation } = require('./utils/lienReinitialisation');
const { fermerPostesExpires } = require('./utils/fermetureAutoPostes');
const { contenuDesFiches } = require('./utils/contenuEpisode');
const { verifierSante } = require('./utils/sante');
const { evaluerRetraitCaisse, estRefusSolde, MOTIF_MIN } = require('./utils/retraitFicheCaisse');
const { creerRoutesDoublons } = require('./utils/routesDoublons');
const { creerRoutesEtatSysteme } = require('./utils/routesEtatSysteme');
const { creerRoutesListesServices } = require('./utils/routesListesServices');
const { anciensNomsApresRenommage, verifierMere } = require('./utils/naissance');
const { controlerQualite } = require('./utils/qualiteDonnees');
const { creerSurveillance } = require('./utils/surveillanceQualite');
// Heure RÉELLE des paiements (13/10) : celle du serveur, jamais celle de l'ordinateur de la caisse — voir utils/heureServeur.js.
const { middlewareHeureServeur, appliquerHeureAuPaiement, estRejeu, ENTETE_HEURE } = require('./utils/heureServeur');
// Limite du nombre de requêtes (13/10) : par compte connecté, par adresse pour les pages publiques et les mauvais jetons — voir utils/limiteur.js.
const { creerLimiteUtilisateur, creerLimitePublique, creerLimiteEchecsAuth, refuser: refuserTropDeRequetes } = require('./utils/limiteur');
const limiteUtilisateur = creerLimiteUtilisateur();
const limitePublique = creerLimitePublique();
const limiteEchecsAuth = creerLimiteEchecsAuth();
// Les compteurs vivent en mémoire : on oublie les fenêtres terminées toutes les 5 minutes (unref : ne retient jamais l'arrêt du serveur).
setInterval(() => { limiteUtilisateur.nettoyer(); limitePublique.compteur.nettoyer(); limiteEchecsAuth.compteur.nettoyer(); }, 5 * 60 * 1000).unref();
// Contrôle des montants côté serveur (13/10) : jamais de négatif, de texte, d'infini ni de montant absurde — voir utils/validationMontant.js.
const { validerMontantPaiement, normaliserMontant } = require('./utils/validationMontant');
// Solde ATOMIQUE (13/10) : le paiement et son solde s'écrivent en une seule opération de la base, avec un verrou par épisode — voir sql/solde_atomique.sql.
const { estFonctionAbsente, estRefusRemboursement, messageRefusRemboursement } = require('./utils/soldeAtomique');
const { verifierTotalFiche, verifierPaiementContreFiche, MODES_VENTE } = require('./utils/verificationPrixFiche');
// Rôles personnalisés (09/10) : validation de la table des permissions, liste des rôles invitables, messages.
const {
  appliquerMiseAJourPermissions, lireTablePermissions, verifierRoleInvitation, verifierRoleDuLienOuvert, libelleRolePersonnalise,
  refusDeRoleParLaBase, etatBasePourRolesPersonnalises, MESSAGE_ROLE_NON_ACTIVE_INVITE,
} = require('./utils/roles');

// Miroir exact de utils/permissions.js côté front (mêmes valeurs par défaut) — nécessaire pour
// que le serveur puisse vérifier une permission même si la table catalog('permissions') est
// encore vide (avant le premier enregistrement depuis l'écran "Rôles & permissions"). Pas
// d'entrée 'administrateur' ici volontairement (retour d'Esdras, 25/08) : administrateur a
// TOUJOURS absolument tout, court-circuité avant même de lire cette table (voir aPermission()
// juste en dessous) — une entrée ici avait justement fini par dériver du vrai catalogue
// (fiche_patient_modifier et audit_voir manquaient), la preuve qu'une liste "tout" recopiée à la
// main finit toujours par désynchroniser ; la retirer élimine le risque à la racine.
// Retour d'Esdras (26/08) : "seul l'infirmier peut créer un dossier, la caisse crée l'épisode et
// travaille au calculateur, archiviste et infirmier consultent le dossier" (mot pour mot) —
// dossier_creer retiré de TOUS les rôles sauf infirmier. fiche_patient_voir_finances (statut
// paiement + solde de dépôt) accordé à direction/comptable/auditeur, jamais à archiviste/infirmier,
// qui consultent le dossier pour l'historique clinique, pas les montants — voir aussi le filtrage
// dans GET /api/dossiers/:id/historique plus bas.
// Dérive corrigée le 09/09 (analyse avant mise en production) : ce miroir avait de nouveau pris
// du retard sur utils/permissions.js côté front — audit_voir manquait à direction et auditeur,
// fiche_patient_modifier manquait à infirmier et infirmier_chef. Effet : sur une installation
// dont la table catalog('permissions') n'a jamais été enregistrée, l'écran affiche le bouton
// (le front l'autorise) et le serveur répond 403. Dormant en production aujourd'hui, puisque le
// catalogue enregistré couvre les 9 rôles et sert alors de seule source de vérité — mais un
// piège dès la première nouvelle installation. Toute modification de utils/permissions.js dans
// chf-app2 doit être recopiée ici dans le même mouvement.
const PERMISSIONS_PAR_DEFAUT = [
  { role: 'direction', permissions: ['episode_creer','fiche_patient_voir','fiche_patient_voir_finances','caisse_travailler','demandes_voir','demandes_repondre','dossier_annuler','paiement_annuler','facturation_supprimer','facturation_modifier','facturation_exporter','direction_voir','analytics_voir','rapport_chf_voir','catalogue_gerer','stock_gerer','partenaires_gerer','audit_voir','sortie_caisse_demander','pharmacie_voir','acte_naissance_derogation','episode_ouvert_derogation','stock_reception','requisition_modifier'] },
  { role: 'comptable', permissions: ['episode_creer','fiche_patient_voir','fiche_patient_voir_finances','caisse_travailler','demandes_voir','facturation_modifier','rapport_chf_voir','exoneration_accorder'] },
  { role: 'auditeur', permissions: ['episode_creer','fiche_patient_voir','fiche_patient_voir_finances','facturation_exporter','rapport_chf_voir','audit_voir','facturation_voir','caisse_voir'] },
  { role: 'lecteur', permissions: ['episode_creer','fiche_patient_voir','facturation_voir'] },
  // 22/10 (Esdras) : l'archive crée des patients, avec ou sans numéro de dossier (elle tape celui que la personne a déjà) ; le site ne donne un numéro qu'à qui n'en a pas.
  { role: 'archiviste', permissions: ['dossier_creer','dossier_numero_saisir','fiche_patient_voir','facturation_voir'] },
  // Retour d'Esdras (28/08) : "l'infirmier ne peut voir que Dossier/Épisode et Fiche Patient" —
  // rapport_chf_voir déplacé vers infirmier_chef (nouveau rôle, ci-dessous) ; facturation_voir
  // jamais accordé ici (Calcul Facture/Facturation exclus, c'est justement ce qu'on retire).
  { role: 'infirmier', permissions: ['dossier_creer','fiche_patient_voir','fiche_patient_modifier'] },
  // 30/09 : + tous les accès du médecin (episode_creer, fiche_patient_voir_finances).
  { role: 'infirmier_chef', permissions: ['dossier_creer','episode_creer','fiche_patient_voir','fiche_patient_modifier','fiche_patient_voir_finances','rapport_chf_voir'] },
  // 30/09 (Krystofia) : "il y aura quand même des docteurs qui vont créer des dossiers" — crée le
  // dossier ET l'épisode, consulte/modifie la Fiche Patient, voit le statut de paiement et le solde.
  { role: 'medecin', permissions: ['dossier_creer','episode_creer','fiche_patient_voir','fiche_patient_modifier','fiche_patient_voir_finances'] },
  // 08/10 (Krystofia) : rôle pharmacien — mêmes droits de caisse que direction/comptable, sans les droits
  // comptables, plus pharmacie_voir (onglet Pharmacie). Miroir de utils/permissions.js (chf-app2).
  { role: 'pharmacien', permissions: ['episode_creer','fiche_patient_voir','fiche_patient_voir_finances','caisse_travailler','demandes_voir','pharmacie_voir','exoneration_accorder'] },
  // 09/10 (Esdras) : "pharmacien en chef : tout ce que fait un pharmacien, et il peut modifier les stocks, mais
  // cliquable dans Rôles & permissions" — exactement les droits du pharmacien + stock_gerer (ajouter/définir le
  // stock, dons, réquisitions). stock_gerer reste une case de la matrice : la décocher le retire sans toucher au code.
  // 14/10 (Esdras) : + catalogue_gerer (médicaments, prix). Miroir de utils/permissions.js (chf-app2).
  { role: 'pharmacien_chef', permissions: ['episode_creer','fiche_patient_voir','fiche_patient_voir_finances','caisse_travailler','demandes_voir','pharmacie_voir','stock_gerer','catalogue_gerer','stock_reception','requisition_modifier','exoneration_accorder'] },
  // Retour d'Esdras (27/08) : "je veux créer un rôle pour visiteur, voir mais ne peut rien
  // modifier" — que des permissions "voir", jamais une action (créer/modifier/annuler/gérer).
  // analytics_voir (inclut les salaires du personnel) volontairement exclu.
  { role: 'visiteur', permissions: ['fiche_patient_voir','fiche_patient_voir_finances','direction_voir','rapport_chf_voir','caisse_voir','hospitalisation_voir','stock_voir','catalogue_voir','requisitions_voir','facturation_voir'] },
];

// Vérifie qu'un utilisateur a une permission donnée : lit son rôle, puis la table des
// permissions par rôle (catalog/permissions), avec repli sur les valeurs par défaut si cette
// table n'a jamais été enregistrée. Utilisé partout où une route exige un droit précis, pour que
// le backend reste toujours d'accord avec ce qu'affiche/autorise le front (pas 2 systèmes qui
// pourraient diverger).
//
// Bug trouvé le 25/08 (retour d'Esdras : "je suis administrateur, je ne vois pas Rôles et
// permissions") : dès qu'un tableau de permissions personnalisé a été enregistré une seule fois
// (pour n'importe quel rôle), il devient la SEULE source de vérité — le mirroir PERMISSIONS_
// PAR_DEFAUT ci-dessus ne sert alors plus que de repli initial. Ce mirroir avait d'ailleurs déjà
// dérivé du vrai catalogue (fiche_patient_modifier et audit_voir manquaient dans l'entrée
// administrateur ci-dessus) — la preuve concrète que garder à la main une liste "administrateur =
// tout" en double, ici ET côté front, finit toujours par désynchroniser. Si en plus le tableau
// enregistré datait d'avant l'ajout d'une permission (ex. parametres_gerer, 24/08), même un vrai
// administrateur ne l'aurait pas — et si la permission manquante est permissions_gerer
// elle-même, plus personne ne peut rouvrir l'écran qui permettrait de la recocher : verrouillage
// complet, sans solution possible depuis l'interface.
// Correctif : administrateur a TOUJOURS absolument tout, sans exception, peu importe ce que
// contient (ou pas) le tableau enregistré — un vrai superutilisateur, jamais soumis aux aléas
// d'une sauvegarde ni d'un mirroir qui dérive.
async function aPermission(userId, cle) {
  const { data: profil } = await supabase.from('users').select('role, active, date_expiration').eq('id', userId).maybeSingle();
  if (!profil) return false;
  // Correctif sécurité (audit du 31/08) : un compte DÉSACTIVÉ ou dont l'accès a EXPIRÉ était
  // refusé uniquement côté navigateur (chargerProfil, api/firebase.js, qui déconnecte au
  // chargement du profil). Le serveur, lui, ne regardait que le rôle : verifyToken valide le jeton
  // Firebase — donc l'identité — mais jamais le statut du compte. Conséquences réelles :
  //   - une personne renvoyée dont on vient de désactiver le compte continuait de travailler
  //     normalement tant qu'elle ne rechargeait pas sa page (chargerProfil ne tourne qu'au
  //     changement d'état d'authentification) ;
  //   - un jeton Firebase encore valide (il se renouvelle tout seul) permettait d'appeler l'API
  //     directement, sans jamais repasser par l'écran qui déconnecte.
  // Or c'est exactement le mécanisme utilisé pour couper l'accès à quelqu'un. Vérifié ici, à
  // CHAQUE requête, et AVANT le raccourci administrateur (un administrateur désactivé doit
  // l'être aussi). Mêmes règles que côté navigateur : active absent/NULL = actif (on ne bloque
  // jamais un compte qui n'a simplement pas encore ce champ), date d'expiration absente = pas
  // d'expiration.
  if (profil.active === false) return false;
  if (profil.date_expiration && new Date(profil.date_expiration) < new Date()) return false;
  if (profil.role === 'administrateur') return true;
  const { data: catalogue } = await supabase.from('catalog').select('items').eq('type', 'permissions').maybeSingle();
  const table = (catalogue && catalogue.items && catalogue.items.length > 0) ? catalogue.items : PERMISSIONS_PAR_DEFAUT;
  // Correctif (audit du 31/08) : même famille que le verrouillage administrateur du 25/08, mais
  // pour un RÔLE entier. Dès qu'une table de permissions personnalisée a été enregistrée une fois,
  // elle devient la seule source de vérité. Un rôle créé APRÈS cet enregistrement (infirmier_chef
  // et visiteur, tous deux ajoutés les 27–28/08) n'y figure tout simplement pas : la personne à qui
  // on l'attribue se retrouvait alors sans AUCUNE permission — pas même consulter une fiche — sans
  // que rien ne l'explique, ni dans l'app ni dans l'écran Rôles & permissions.
  // Un rôle volontairement privé de tout garde, lui, une entrée avec une liste VIDE : ce repli ne
  // peut donc jamais contredire une décision explicite de la direction.
  const entree = table.find(r => r.role === profil.role)
    || PERMISSIONS_PAR_DEFAUT.find(r => r.role === profil.role);
  return !!(entree && entree.permissions && entree.permissions.includes(cle));
}

// Correctif sécurité (27/08, audit avant mise en production) : cors() sans options autorisait
// N'IMPORTE QUEL site web à appeler cette API depuis le navigateur d'un utilisateur — restreint
// à la seule origine du frontend. Réutilise FRONTEND_URL (déjà utilisé plus bas pour les liens de
// réinitialisation de mot de passe) : changer cette variable sur Render suffira, le jour où
// l'app passera sur un domaine personnalisé (ex. app.chffontaine.org), à mettre à jour les deux
// à la fois. L'ancienne URL onrender.com reste acceptée en plus, pour ne pas casser l'accès
// pendant la transition vers le nouveau domaine.
const ORIGINE_FRONTEND = process.env.FRONTEND_URL || 'https://chf-app2.onrender.com';

// Audit de sécurité du 02/10 : en-têtes de protection sur chaque réponse de l'API (aucun effet sur le
// fonctionnement). nosniff : le navigateur ne devine pas le type d'un fichier ; HSTS : HTTPS seulement ;
// no-referrer : aucune adresse de page transmise ; x-powered-by retiré : on n'annonce pas « Express ».
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Ce serveur (Render) tourne en UTC, jamais à l'heure d'Haïti — un calcul de date "du jour" fait
// ICI sans préciser le fuseau donne la date UTC, pas celle d'Haïti (audit du 11/09, suite à un
// dossier ouvert un soir dont dateHeure affichait le lendemain). America/Port-au-Prince gère aussi
// le changement d'heure (Haïti suit le calendrier DST américain : UTC-5 en hiver, UTC-4 en été) —
// jamais un décalage fixe "-4" en dur, qui serait faux une bonne partie de l'année. Le navigateur,
// lui, n'a jamais ce problème (son fuseau local EST celui d'Haïti) : voir jourLocal()/moisLocal()
// côté chf-app2 (utils/helpers.js), qui résolvent le même besoin autrement, côté client.
const FUSEAU_HAITI = 'America/Port-au-Prince';
app.use(cors({
  origin: (origin, callback) => {
    // Pas d'en-tête Origin (curl, health check Render, appel serveur à serveur) : toujours
    // autorisé — CORS ne protège que les requêtes envoyées par un NAVIGATEUR pour le compte d'un
    // site tiers, jamais quelqu'un qui appelle directement l'API (celui-là devrait de toute façon
    // déjà avoir un jeton Firebase valide, ce que CORS ne vérifie pas).
    if (!origin || origin === ORIGINE_FRONTEND || origin === 'https://chf-app2.onrender.com') {
      return callback(null, true);
    }
    callback(new Error('Origine non autorisée par CORS'));
  },
  // L'app lit l'heure du serveur dans cet en-tête (voir utils/heureServeur.js) : un navigateur ne montre à une autre origine que les en-têtes exposés.
  exposedHeaders: [ENTETE_HEURE],
}));
app.use(middlewareHeureServeur);
// Derrière le proxy de Render, req.ip serait l'adresse du proxy (la même pour tout le monde) : on fait confiance au nombre de proxys indiqué
// (1 par défaut, TRUST_PROXY pour l'ajuster sans toucher au code) afin que les limites par adresse voient la vraie adresse du visiteur.
const sautsDeProxy = process.env.TRUST_PROXY !== undefined && process.env.TRUST_PROXY !== '' && Number.isFinite(Number(process.env.TRUST_PROXY)) ? Number(process.env.TRUST_PROXY) : 1;
app.set('trust proxy', sautsDeProxy);
app.use(express.json({ limit: '10mb' }));

// ------------------------------------------------------------
// Côté administrateur des liens d'invitation (partie publique : voir /invitation/:token plus haut).
// ------------------------------------------------------------
// Rôles qu'un lien d'invitation peut accorder. 'administrateur' est VOLONTAIREMENT absent : un
// lien d'invitation voyage dans une conversation WhatsApp, se transfère en un geste et reste
// lisible longtemps après coup. Donner les pleins pouvoirs par ce canal serait le maillon le plus
// faible de toute la sécurité de l'app — un administrateur se crée à la main, depuis Gestion des
// utilisateurs, avec un mot de passe que l'administrateur en place choisit lui-même.
// Ce sont les rôles DU CODE ; les rôles personnalisés (créés depuis l'écran Rôles & permissions) s'y ajoutent
// dynamiquement — voir rolesInvitablesAvecPersonnalises (utils/roles.js). Aucun rôle personnalisé ne peut être
// administrateur : sa clé ne peut pas être celle d'un rôle du code.
const ROLES_INVITABLES = ['direction', 'comptable', 'auditeur', 'lecteur', 'archiviste', 'infirmier', 'infirmier_chef', 'medecin', 'pharmacien', 'pharmacien_chef', 'visiteur'];
// Routes ouvertes (sans jeton) : montées ICI, avant le contrôle du jeton des routes /api, comme avant la découpe.
require('./routes/publiques')(app, { ROLES_INVITABLES, limitePublique, supabase });


// Vérification via Firebase Admin SDK — remplace la vérification Supabase.
// req.user.id remplace l'ancien req.user.id Supabase ; c'est un UID Firebase (texte),
// pas un UUID — voir le schéma (users.id, audit_log.effectue_par_uid sont en TEXT).
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Retour d'Esdras (29/08) : "des paiements refusés par le serveur pour token manquant ou
    // invalide" — jusqu'ici rien ne laissait de trace de ces rejets côté serveur, impossible de
    // savoir combien ça arrivait ni sur quelles routes. Juste assez pour repérer un pic ou une
    // route précise dans les logs Render, sans loguer le jeton lui-même.
    console.warn(`verifyToken: en-tête Authorization absent (${req.method} ${req.path})`);
    const blocage = limiteEchecsAuth.signalerEchec(req);
    if (blocage.bloque) return refuserTropDeRequetes(res, blocage.reessayerDansMs, 'echecs_auth');
    return res.status(401).json({ error: 'Token manquant ou invalide' });
  }
  const token = authHeader.split('Bearer ')[1];
  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(token);
  } catch (e) {
    console.warn(`verifyToken: jeton invalide ou expiré (${req.method} ${req.path}):`, e.message);
    // Beaucoup de mauvais jetons depuis la même adresse : on répond 429 (jamais pour un jeton valide, qui ne passe pas par ici).
    const blocage = limiteEchecsAuth.signalerEchec(req);
    if (blocage.bloque) return refuserTropDeRequetes(res, blocage.reessayerDansMs, 'echecs_auth');
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
  try {
    // "Désactiver un compte" (Gestion des utilisateurs) et l'accès à durée limitée (date
    // d'expiration) n'étaient vérifiés NULLE PART jusqu'ici — ni ici, ni côté écran : le bouton
    // "Désactiver" ne faisait qu'écrire un booléen que rien ne lisait jamais, un compte
    // "désactivé" pouvait continuer à se connecter et travailler normalement. Vérifié à chaque
    // requête, pas seulement à la connexion, pour qu'une désactivation en cours de session soit
    // immédiate (pas besoin d'attendre que le token expire).
    // Audit du 08/10 (« L'app ne se charge plus ») : une ERREUR de lecture (Supabase indisponible, colonne
    // absente, droits...) n'est PAS un profil absent. Avant, `{ data: profil }` ignorait `error` : avec
    // le refus « pas de profil » ajouté le 06/10, la moindre panne de la base répondait 403 « Ce compte
    // n'est pas autorisé » à TOUT LE MONDE en même temps — alors qu'un profil réellement absent ne
    // concerne qu'un compte. Une panne de la base est transitoire : 503, que l'app réessaie toute
    // seule (lectures servies depuis la copie locale, écritures mises en file).
    const { data: profil, error: erreurProfil } = await supabase.from('users').select('active, date_expiration').eq('id', decoded.uid).maybeSingle();
    if (erreurProfil) throw new Error(erreurProfil.message || 'lecture du profil impossible');
    // Audit de sécurité du 02/10 : un jeton Firebase valide prouve seulement que la personne a un
    // compte Firebase — pas qu'elle fait partie du personnel du CHF. Les comptes légitimes (créés par
    // /api/admin/users ou par une invitation) ont TOUS une ligne dans `users`, écrite côté serveur.
    // Jusqu'ici, un jeton sans ligne `users` passait (profil absent = on ne vérifiait rien) et pouvait
    // appeler les routes de lecture qui n'exigent aucune permission (dossiers, recherche, catalogue).
    // Si un tiers parvenait à créer un compte Firebase lui-même (inscription ouverte sur le projet
    // Firebase, la clé publique étant visible dans le navigateur), il aurait pu lire des données de
    // patients. Désormais : pas de profil = pas d'accès, quoi que dise le jeton.
    if (!profil) {
      console.warn(`verifyToken: jeton valide mais aucun profil CHF (uid ${String(decoded.uid).slice(0, 6)}…) — refusé (${req.method} ${req.path})`);
      return res.status(403).json({ error: "Ce compte n'est pas autorisé à utiliser l'application." });
    }
    if (profil.active === false) {
      return res.status(403).json({ error: 'Ce compte a été désactivé.' });
    }
    if (profil.date_expiration && new Date(profil.date_expiration) < new Date()) {
      return res.status(403).json({ error: "Cet accès a expiré. Contacte l'administrateur pour le renouveler." });
    }
    req.user = { id: decoded.uid, email: decoded.email };
    next();
  } catch (e) {
    // Seule la lecture du profil peut échouer ici (le jeton, lui, a déjà été vérifié plus haut).
    console.error(`verifyToken: lecture du profil impossible (${req.method} ${req.path}):`, e.message);
    return res.status(503).json({ error: 'Vérification du compte impossible pour le moment. Réessaie dans un instant.' });
  }
}

// Application du middleware sur toutes les routes API
app.use('/api', verifyToken);
// Limites par compte connecté : APRÈS verifyToken (req.user connu), AVANT l'idempotence et les routes.
app.use('/api', limiteUtilisateur);
// Dernière activité des comptes (écran « Qui est connecté »), au plus une écriture par minute et par compte.
const presence = require('./utils/presence');
app.use('/api', presence.creerSuiviActivite(supabase));
// Écritures idempotentes par clé (en-tête Idempotency-Key, audit hors ligne du 28/09) : une requête
// abandonnée par l'app après 15 s puis rejouée ne s'applique jamais deux fois. Voir utils/idempotence.js
// et sql/requetes_idempotentes.sql. APRÈS verifyToken : la clé est rangée par personne (req.user.id).
const { creerMiddlewareIdempotence, purgerClesIdempotence } = require('./utils/idempotence');
app.use('/api', creerMiddlewareIdempotence(supabase));

// ============================================================
// COMPATIBILITÉ /api/episodes — le front-end existant (CalculateurPanel,
// AnalyticsPanel, DashboardCaisse, ArchivesPanel) appelle encore ce chemin,
// avec la forme plate historique. Ces routes traduisent cette forme vers/depuis
// le nouveau modèle Dossier/Épisode/Fiches, SANS toucher au front-end existant.
//
// Correspondance des statuts (l'ancien avait 4 valeurs, le nouveau schéma
// n'a que ouvert/ferme — les 2 valeurs supplémentaires se distinguent par
// un champ déjà présent, pas un 3e statut) :
//   'actif'     → statut='ouvert', date_suspension=null, mois_report=null
//   'suspendu'  → statut='ouvert', date_suspension=<date>
//   'reporte'   → statut='ouvert', mois_report=<valeur>
//   'archived'  → statut='ferme'
//
// Correspondance typePatient : ancien 'ONG' → nouveau 'partenaire' ; tout
// le reste (y compris undefined) → 'prive'.
// ============================================================

function statutVersFlat(ep) {
  if (ep.statut === 'ferme') return 'archived';
  if (ep.date_suspension) return 'suspendu';
  if (ep.mois_report) return 'reporte';
  return 'actif';
}
function flatVersStatut(status) {
  return status === 'archived' ? 'ferme' : 'ouvert';
}
function typePatientVersFlat(tp) { return tp === 'partenaire' ? 'ONG' : 'Privé'; }
function flatVersTypePatient(typePatient) { return typePatient === 'ONG' ? 'partenaire' : 'prive'; }

// La date de naissance est optionnelle côté formulaire (saisie rétroactive, patient qui ne la
// connaît pas) : le champ vide arrive comme "" et Postgres refuse "" pour une colonne date
// ("invalid input syntax for type date"). Convertit en null, seule valeur qu'une colonne date
// accepte pour "pas de valeur".
function dateOuNull(v) { return v ? v : null; }

// Trace dans audit_log depuis le SERVEUR (qui, quoi, quand) pour les actions qui changent des numéros ou des montants et que le navigateur
// ne peut pas tracer lui-même (renumérotation automatique des fiches). Best-effort : un journal qui refuse la ligne n'annule jamais l'action.
async function enregistrerAuditServeur(req, action, details) {
  try {
    const { error } = await supabase.from('audit_log').insert({
      id: crypto.randomUUID(), action,
      effectue_par: (req.user && (req.user.email || req.user.id)) || null, effectue_par_uid: (req.user && req.user.id) || null,
      details: details || {}, date: new Date().toISOString(),
    });
    if (error) console.warn(`Audit « ${action} » non enregistré :`, error.message);
  } catch (e) { console.warn(`Audit « ${action} » non enregistré :`, e.message); }
}

function ficheVersFlat(f, fichesAvecPaiementAnnule) {
  return {
    id: f.id, numeroFiche: f.numero_fiche, dateCreation: f.date_creation,
    creePar: f.cree_par, probleme: f.probleme, noteProbleme: f.note_probleme,
    totalGlobal: f.total_global, breakdown: f.breakdown, modePaiement: f.mode_paiement,
    rawState: f.raw_state,
    // Le paiement d'origine de cette fiche a été annulé (fraude/erreur) — la fiche reste visible
    // pour l'historique/réimpression, mais son montant est déjà exclu de totalGlobal (voir
    // episodeVersFlat) ; ce champ permet aux écrans qui ITÈRENT eux-mêmes episode.fiches (au lieu
    // de se fier à totalGlobal) de faire le même choix, sans deviner.
    paiementAnnule: !!(fichesAvecPaiementAnnule && fichesAvecPaiementAnnule.has(f.id)),
  };
}
function ficheVersColonnes(f) {
  return {
    numero_fiche: f.numeroFiche, cree_par: f.creePar, probleme: !!f.probleme,
    note_probleme: f.noteProbleme, total_global: f.totalGlobal || 0,
    breakdown: f.breakdown || {}, mode_paiement: f.modePaiement, raw_state: f.rawState || {},
  };
}

// Une fiche envoyée par le navigateur juste après sa création porte un id local généré
// côté client ("fiche-" + Date.now()), pas encore un vrai UUID Postgres — cette fiche est
// donc nouvelle, même si f.id n'est pas vide. La traiter comme UPDATE échouait avec
// "invalid input syntax for type uuid", une erreur permanente jamais résolue par un
// nouvel essai, qui bloquait l'opération indéfiniment dans la file hors-ligne du navigateur.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function estUnVraiUuid(id) { return typeof id === 'string' && UUID_REGEX.test(id); }

// Qui a modifié ce dossier en dernier (affiché dans l'onglet Lots : « Dernière modification par … »). Le nom vient de la table users
// (display_name), à défaut l'e-mail ; jamais fourni par le navigateur, donc non falsifiable. Aucun échec ici ne doit bloquer une
// modification : sans nom, on enregistre l'identifiant.
async function signatureModification(utilisateur) {
  if (!utilisateur || !utilisateur.id) return {};
  let nom = utilisateur.email || utilisateur.id;
  try {
    const { data } = await supabase.from('users').select('display_name').eq('id', utilisateur.id).maybeSingle();
    if (data && data.display_name) nom = data.display_name;
  } catch (e) { /* le nom est un confort : on garde l'e-mail */ }
  return { modifie_par: String(nom).slice(0, 120), modifie_par_uid: String(utilisateur.id) };
}

async function episodeVersFlat(ep) {
  const { data: dossier, error: erreurDossier } = await supabase.from('dossiers').select('*').eq('id', ep.dossier_id).single();
  // Avant : cette erreur était silencieusement ignorée — un épisode dont le dossier ne pouvait
  // pas être lu (ligne orpheline, incident Supabase transitoire) apparaissait comme un patient
  // "sans nom" dans Archives/Analytics sans le moindre signal qu'une donnée manque vraiment.
  if (erreurDossier) console.error(`⚠️ episodeVersFlat: dossier introuvable pour l'épisode ${ep.id} (dossier_id=${ep.dossier_id}) :`, erreurDossier.message);
  // .order('id') en second : départage deux fiches créées à la même seconde, pour que cette
  // version unitaire et la version groupée (episodesVersFlatEnLot) donnent le MÊME ordre.
  const { data: fiches } = await supabase.from('fiches').select('*').eq('episode_id', ep.id).is('supprime_le', null).order('date_creation').order('id');
  // Audit financier (24/08, "on ne peut pas se permettre l'erreur") : un paiement ANNULÉ (fraude/
  // erreur corrigée par la direction) laissait quand même sa fiche compter dans totalGlobal — les
  // rapports de revenus (Statistiques/AnalyticsPanel, Direction, Archives...) restaient faussés
  // par une transaction qui n'existe plus, alors que le registre de caisse, lui, avait déjà été
  // corrigé (DashboardCaisse.js). fiche_id est NULL pour un dépôt/remboursement (jamais lié à une
  // fiche précise), donc sans effet sur ce filtre.
  const { data: paiementsAnnules } = await supabase
    .from('paiements').select('fiche_id').eq('episode_id', ep.id).eq('annule', true).not('fiche_id', 'is', null);
  const fichesAvecPaiementAnnule = new Set((paiementsAnnules || []).map(p => p.fiche_id));
  return assemblerEpisodeFlat(ep, dossier, fiches, fichesAvecPaiementAnnule);
}

// Assemblage PUR (aucune requête) d'un épisode + ses données liées vers la forme "flat" attendue
// par le navigateur. Extrait d'episodeVersFlat le 31/08 sans en changer une ligne, pour que le
// chemin UNITAIRE (episodeVersFlat, 3 requêtes) et le chemin GROUPÉ (episodesVersFlatEnLot, plus
// bas) produisent forcément le MÊME objet : c'est le seul moyen sûr de garantir qu'ils ne
// divergeront jamais. Ne jamais dupliquer cette logique ailleurs — l'appeler.
function assemblerEpisodeFlat(ep, dossier, fiches, fichesAvecPaiementAnnule) {
  // episodes n'a pas de colonne total_global — ce total n'existait qu'en mémoire côté
  // navigateur, calculé une fois à l'archivage (executerArchivage) et jamais recalculé au
  // chargement suivant. Tout dossier rechargé depuis le serveur (nouvel onglet, F5, écran
  // Lots & Facturation qui lit ce total pour chaque dossier) affichait donc 0 Gdes malgré des
  // fiches réelles en base. Recalculé ici à chaque lecture, à partir des vraies fiches — source
  // unique de vérité, plutôt que de rapiécer chaque écran qui lit ce total un par un.
  const totalGlobal = (fiches || []).reduce((s, f) => fichesAvecPaiementAnnule.has(f.id) ? s : s + (Number(f.total_global) || 0), 0);

  // Même raison que totalGlobal juste au-dessus : dateEntreePourTri et periodeSejourString
  // n'existent sur AUCUNE colonne d'episodes — le navigateur les calculait à l'archivage
  // (executerArchivage) et les envoyait, mais ni POST ni PUT /api/episodes ne les écrit, et cette
  // fonction ne les renvoyait pas. Tout dossier relu depuis le serveur (F5, autre poste, écran
  // Archives) les recevait donc `undefined`, avec deux conséquences concrètes :
  //   - ArchivesPanel filtre par date via `new Date(v.dateEntreePourTri)` puis écarte la ligne si
  //     la date est invalide → AUCUN dossier ne ressortait dès qu'un filtre de date était posé,
  //     précisément l'écran qui sert à préparer les factures partenaires ;
  //   - la colonne "période de séjour" de l'export Excel partenaire retombait sur la date
  //     d'ouverture du dossier, et Archives affichait "sans exeat" en rouge sur des
  //     hospitalisations pourtant correctement datées.
  // Recalculés ici depuis le raw_state des fiches (lui bien persisté), avec exactement la même
  // logique que le navigateur — le serveur redevient la source unique de vérité.
  const datesSejour = [];
  for (const f of (fiches || [])) {
    const rs = f.raw_state || {};
    if (rs.dateEntree1) datesSejour.push({ in: rs.dateEntree1, out: rs.dateSortie1 || rs.dateEntree1 });
    if (rs.multiPeriode && rs.dateEntree2) datesSejour.push({ in: rs.dateEntree2, out: rs.dateSortie2 || rs.dateEntree2 });
  }
  const jourMois = (d) => String(d).split('-').reverse().slice(0, 2).join('/');
  const periodeSejourString = datesSejour.length === 0 ? '—'
    : datesSejour.map(d => d.in === d.out ? jourMois(d.in) : `du ${jourMois(d.in)} au ${jourMois(d.out)}`).join(' et ');

  return {
    id: ep.id,
    // dossierId (16/09) : le dossier auquel appartient cet épisode. Absent jusqu'ici — la liste
    // renvoyée par GET /api/episodes est la copie locale (LOG_VERIF_KEY) qui sert de repli hors
    // ligne côté navigateur, et sans cet identifiant elle ne permettait pas de retrouver le DOSSIER
    // d'un patient, seulement ses épisodes. Nécessaire à la recherche hors ligne (retour d'Esdras :
    // "je n'arrive pas à chercher des dossiers sans net"). Voir utils/rechercheHorsLigne.js
    // (chf-app2). Purement additif : aucun écran existant ne lit ce champ.
    dossierId: ep.dossier_id,
    nomPatient: dossier?.nom, dateNaissance: dossier?.date_naissance,
    // sexe (02/09) : seul champ dossier ajouté ici pour un rapport (MSPP, répartition homme/femme
    // des examens) — poids/conjoint restent volontairement absents de cette liste, lus seulement
    // via GET /api/dossiers/:id (Fiche Patient), aucun rapport n'en ayant besoin jusqu'ici.
    sexe: dossier?.sexe || null,
    telephone: dossier?.telephone, adresse: dossier?.adresse, numDossier: dossier?.numero_dossier,
    typePatient: typePatientVersFlat(ep.type_patient),
    ongPartenaire: ep.ong_partenaire || null,
    serviceChoisi: ep.service,
    status: statutVersFlat(ep),
    dateSuspension: ep.date_suspension, moisReport: ep.mois_report,
    numeroLot: ep.numero_lot, verrouilleFacture: ep.verrouille_facture,
    moisLot: ep.mois_lot || null, lotVerrouille: ep.lot_verrouille || false,
    // 14/10 (version chf-demo2 de l'onglet Lots) : « dossier complet » (case de suivi visuel, aucun effet sur la facturation)
    // et « dernière modification par » (nom de la personne ; voir signatureModification). Colonnes de
    // sql/ajoute_dossier_complet_modifie_par_episodes.sql — absentes tant qu'il n'est pas collé : false / null.
    dossierComplet: ep.dossier_complet === true, modifiePar: ep.modifie_par || null,
    estHospitalisation: ep.est_hospitalisation,
    motifFermeture: ep.motif_fermeture, dateFermeture: ep.date_fermeture,
    lit: ep.lit || null,
    // Distingue Consultation de Vente comptoir (Achat Express) — les deux ont
    // estHospitalisation: false, seul voie_entree ('consultation' vs 'vente_comptoir') les sépare.
    voieEntree: ep.voie_entree,
    dateHeure: new Date(ep.date_ouverture).toLocaleDateString('fr-FR', { timeZone: FUSEAU_HAITI }),
    timestamp: new Date(ep.date_ouverture).getTime(),
    totalGlobal,
    // '9999-12-31' = la même convention "sans exeat" que le navigateur : trie ces dossiers en fin
    // de liste tout en restant une date VALIDE, pour ne pas refaire disparaître la ligne du filtre.
    dateEntreePourTri: datesSejour.length > 0 ? datesSejour[0].in : '9999-12-31',
    periodeSejourString,
    fiches: (fiches || []).map(f => ficheVersFlat(f, fichesAvecPaiementAnnule)),
  };
}

// ---------------------------------------------------------------------------------------------
// Lecture GROUPÉE des épisodes (audit du 31/08 — "priorité n°1 après le lancement", faite avant)
//
// Avant : GET /api/episodes appelait episodeVersFlat sur CHAQUE épisode, soit 3 requêtes Supabase
// par épisode (dossier, fiches, paiements annulés). À 50 dossiers/jour, après 2 mois (~3000
// épisodes) cela faisait ~9000 requêtes à chaque ouverture du tableau de bord — lent, puis
// inutilisable. Ici : un nombre CONSTANT de requêtes par tranche d'ids, quel que soit le nombre
// d'épisodes, en assemblant les correspondances en mémoire.
//
// Deux plafonds à ne jamais oublier en lisant en gros volume — les ignorer ferait échouer ce
// correctif exactement à l'échelle qu'il vise à corriger :
//   1. Longueur d'URL : un `.in('id', [...])` met tous les ids DANS l'URL. 3000 UUID = ~111 ko,
//      très au-dessus de ce qu'accepte PostgREST/nginx → ids découpés en lots (TAILLE_LOT_IDS).
//   2. Plafond de lignes par réponse : PostgREST tronque SANS ERREUR au-delà d'un maximum
//      (souvent 1000 chez Supabase) — les lignes en trop disparaîtraient silencieusement des
//      rapports. Chaque lecture est donc paginée explicitement par .range() jusqu'à épuisement.
const TAILLE_LOT_IDS = 200;      // ids par requête `.in()` — garde l'URL très en dessous des limites
const TAILLE_PAGE_LECTURE = 500; // lignes par page `.range()` — sous tout plafond PostgREST courant

function enLots(tableau, taille) {
  const lots = [];
  for (let i = 0; i < tableau.length; i += taille) lots.push(tableau.slice(i, i + taille));
  return lots;
}

// Exécute construireRequete(ids) pour chaque lot d'ids, en paginant chaque lot jusqu'à épuisement,
// et renvoie toutes les lignes concaténées. Lève l'erreur Supabase telle quelle : une lecture
// partielle silencieuse serait pire qu'un échec visible (des dossiers manquants dans un rapport
// financier ne se remarquent pas).
// Lit TOUTES les lignes d'une requête, page par page. Avance du nombre de lignes RÉELLEMENT
// reçues, et ne s'arrête que sur une page VIDE — jamais sur une page "plus petite que demandé".
// C'est ce qui rend la lecture correcte quel que soit le plafond configuré côté Supabase : si le
// serveur plafonne à 100 lignes alors qu'on en demande 500, s'arrêter sur "page incomplète"
// perdrait tout le reste EN SILENCE (le piège signalé par l'audit du 31/08). Coût : une requête
// de confirmation par lecture, négligeable.
//
// ⚠️ La requête passée ici doit avoir un tri TOTAL (un `.order()` sur une colonne unique en
// dernier, en pratique 'id') : avec un tri ambigu, Postgres peut ordonner deux lignes de même
// valeur différemment d'une page à l'autre, ce qui ferait apparaître une ligne deux fois et en
// sauterait une autre, sans la moindre erreur.
async function lireToutesLesPages(construireRequete) {
  const lignes = [];
  for (let debut = 0; ; ) {
    const { data, error } = await construireRequete().range(debut, debut + TAILLE_PAGE_LECTURE - 1);
    if (error) throw error;
    const page = data || [];
    if (page.length === 0) break;
    lignes.push(...page);
    debut += page.length;
  }
  return lignes;
}

async function lireParLotsDIds(ids, construireRequete) {
  const lignes = [];
  for (const lot of enLots(ids, TAILLE_LOT_IDS)) {
    lignes.push(...await lireToutesLesPages(() => construireRequete(lot)));
  }
  return lignes;
}

// Même résultat qu'appeler episodeVersFlat sur chaque épisode (assemblage strictement identique,
// via assemblerEpisodeFlat), mais en un nombre constant de requêtes par lot au lieu de 3 par
// épisode.
async function episodesVersFlatEnLot(episodes) {
  if (!episodes || episodes.length === 0) return [];
  const idsEpisodes = episodes.map(ep => ep.id);
  const idsDossiers = [...new Set(episodes.map(ep => ep.dossier_id).filter(Boolean))];

  // Chaque lecture est paginée (voir lireToutesLesPages) : elle DOIT donc avoir un tri total,
  // d'où le `.order('id')` final partout — sans lui, deux lignes de même valeur pourraient
  // changer de place d'une page à l'autre, et une ligne serait dupliquée pendant qu'une autre
  // serait sautée, sans erreur.
  const [dossiers, fiches, paiementsAnnules] = await Promise.all([
    lireParLotsDIds(idsDossiers, lot => supabase.from('dossiers').select('*').in('id', lot).order('id')),
    // Même tri que la version unitaire (date_creation, départagé par id) : le tri est global ici,
    // mais regrouper en préservant l'ordre de parcours laisse chaque épisode avec SES fiches dans
    // ce même ordre.
    lireParLotsDIds(idsEpisodes, lot => supabase.from('fiches').select('*').in('episode_id', lot).is('supprime_le', null).order('date_creation').order('id')),
    // episode_id est sélectionné en plus de fiche_id (la version unitaire n'en a pas besoin,
    // elle filtre déjà sur un seul épisode) — c'est lui qui permet de reconstituer, en mémoire,
    // le même Set par épisode.
    lireParLotsDIds(idsEpisodes, lot => supabase.from('paiements').select('fiche_id, episode_id').in('episode_id', lot).eq('annule', true).not('fiche_id', 'is', null).order('id')),
  ]);

  const dossierParId = new Map(dossiers.map(d => [d.id, d]));
  const fichesParEpisode = new Map();
  for (const f of fiches) {
    if (!fichesParEpisode.has(f.episode_id)) fichesParEpisode.set(f.episode_id, []);
    fichesParEpisode.get(f.episode_id).push(f);
  }
  const annuleesParEpisode = new Map();
  for (const p of paiementsAnnules) {
    if (!annuleesParEpisode.has(p.episode_id)) annuleesParEpisode.set(p.episode_id, new Set());
    annuleesParEpisode.get(p.episode_id).add(p.fiche_id);
  }

  return episodes.map(ep => {
    // Même signalement que la version unitaire : un épisode dont le dossier est illisible
    // apparaîtrait comme un patient "sans nom", sans le moindre signal, s'il restait silencieux.
    if (ep.dossier_id && !dossierParId.has(ep.dossier_id)) {
      console.error(`⚠️ episodesVersFlatEnLot: dossier introuvable pour l'épisode ${ep.id} (dossier_id=${ep.dossier_id})`);
    }
    return assemblerEpisodeFlat(
      ep,
      dossierParId.get(ep.dossier_id),
      fichesParEpisode.get(ep.id) || [],
      annuleesParEpisode.get(ep.id) || new Set(),
    );
  });
}

// Lecture incrémentale des listes (12/10) : GET /api/episodes et /api/paiements avec ?synchro=1 — voir
// utils/synchroListes.js et sql/synchro_incrementale.sql. Les fonctions passées ici sont des déclarations
// (hissées), disponibles dès ce point.
const { creerSynchroListes } = require('./utils/synchroListes');
const synchroListes = creerSynchroListes({ supabase, lireToutesLesPages, lireParLotsDIds, episodesVersFlatEnLot });

// ---------------------------------------------------------------------------------------------

// Retour d'Esdras (26/08) : un dépôt (paiement mode='depot', jamais lié à une fiche précise —
// voir episodeVersFlat ci-dessus) n'était jusqu'ici JAMAIS décrémenté au fur et à mesure de sa
// consommation. Chaque nouvelle fiche du même épisode calculait "reste à payer" en resoustrayant
// le total BRUT de tous les dépôts jamais faits, sans tenir compte de ce qu'un achat précédent
// avait déjà consommé — un dépôt de 5000 Gdes pouvait ainsi couvrir bien plus que 5000 Gdes
// d'achats successifs sur le même dossier (cas réel signalé : dépôt initial pour un nouveau-né en
// néonatalogie, consommé par plusieurs achats de médicaments étalés dans le temps).
// Corrigé : chaque paiement qui consomme du dépôt enregistre combien dans
// details.montant_depot_utilise (voir POST /api/paiements, appelé par CalculateurPanel.js) — le
// solde réellement disponible est le total des dépôts moins la somme de ce qui a déjà été
// consommé, jamais juste le total brut déposé.
function calculerSoldeDepot(paiements) {
  // 19/10 : le dépôt restant d'une consultation devenue hospitalisation arrive dans le nouvel épisode par une ligne « transfert_hospitalisation » de 0 Gdes (details.depot_transfere) — aucun argent encaissé.
  const totalDepots = (paiements || []).filter(p => p.mode === 'depot').reduce((s, p) => s + (Number(p.montant) || 0), 0)
    + (paiements || []).reduce((s, p) => s + (Number(p.details?.depot_transfere) || 0), 0);
  const totalDepotUtilise = (paiements || []).reduce((s, p) => s + (Number(p.details?.montant_depot_utilise) || 0), 0);
  return { totalDepots, totalDepotUtilise, soldeDepot: Math.max(0, totalDepots - totalDepotUtilise) };
}

// Retour d'Esdras (27/08) : "seulement l'intervention, soit accouchement, soit césarienne, soit
// chirurgie, pour savoir ce que la personne a fait en dernier" — visible sur Fiche Patient pour
// l'archiviste/infirmier, jamais gardé par fiche_patient_voir_finances (aucun prix ici, juste un
// nom d'acte). CLES_INTERVENTION reprend les clés 'sub' des catégories d'actes concernées (voir
// CATEGORIES_LISTE, chf-app2/utils/constants.js — dupliqué ici, ces 2 repos ne partagent pas de
// code). hasChirSpec/nomChirSpec (chirurgie nommée en texte libre, ex: CalculateurPanel.js) est
// une 2e source distincte, en plus des lignesCalcul catégorisées.
const CLES_INTERVENTION = ['accouchement', 'cesarienne', 'chirurgie'];
function extraireIntervention(fiches) {
  const noms = (fiches || []).flatMap(f => {
    const state = f.raw_state || {};
    const actes = (state.lignesCalcul || []).filter(l => CLES_INTERVENTION.includes(l.sub)).map(l => l.nom);
    const chirSpec = (state.hasChirSpec && state.nomChirSpec) ? [state.nomChirSpec] : [];
    return [...actes, ...chirSpec];
  });
  return noms.length > 0 ? [...new Set(noms)].join(', ') : null;
}

// Retour d'Esdras (28/08) : "on voit les actes sans prix" — détail de chaque fiche de l'épisode
// (médicaments/actes achetés, avec quantité) pour l'infirmier/archiviste sur Fiche Patient, SANS
// jamais inclure `prix` (donnée financière) — même philosophie qu'extraireIntervention ci-dessus :
// toujours inclus, quel que soit fiche_patient_voir_finances, car aucun montant n'y transite.
function extraireFichesDetail(fiches) {
  return (fiches || [])
    .map(f => ({
      date: f.date_creation,
      actes: (f.raw_state?.lignesCalcul || []).map(l => ({ nom: l.nom, qte: l.qte, type: l.type })),
    }))
    .filter(g => g.actes.length > 0)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

// 14/10 : « Qualité des données » — ce qui manque ou semble faux, avec de quoi corriger (voir utils/qualiteDonnees.js).
// 18/10 : + SURVEILLANCE automatique (voir utils/surveillanceQualite.js) : contrôle chaque matin, corrections de forme tracées, alerte WhatsApp avec les noms, historique.
const surveillanceQualite = creerSurveillance({ supabase, lireToutesLesPages, envoyerAlerte: (message) => envoyerCallMeBot(message), fuseau: FUSEAU_HAITI, journal: console });
let surveillanceEnCours = null; // un seul passage à la fois (minuteur, rattrapage au réveil et bouton « Lancer maintenant »)
function lancerSurveillanceQualite(options) {
  if (surveillanceEnCours) return surveillanceEnCours;
  surveillanceEnCours = surveillanceQualite.executer(options).finally(() => { surveillanceEnCours = null; });
  return surveillanceEnCours;
}

// ============================================================
// PIÈCES JOINTES — retour d'Esdras (23/08) : pouvoir attacher un document à un dossier,
// en priorité les fiches de référence envoyées par un ONG partenaire (pas un dossier clinique
// complet, juste éviter qu'un papier important se perde). Stockage Supabase Storage (bucket
// dédié, privé), métadonnées dans la table pieces_jointes — même principe que les sauvegardes
// automatiques plus bas dans ce fichier.
// ============================================================
const BUCKET_PIECES_JOINTES = 'pieces-jointes-dossiers';

// ============================================================
// CALLMEBOT — retour d'Esdras (29/08) : alertes WhatsApp pour 3 événements (stock bas franchi,
// demande d'exonération en attente, sauvegarde automatique échouée). CALLMEBOT_PHONE/APIKEY dans
// les variables d'environnement (Render), jamais codés en dur ni envoyés au navigateur — l'appel à
// l'API CallMeBot passe toujours par ICI (le serveur), jamais depuis le front, pour ne jamais
// exposer la clé dans bundle.js. Best-effort partout où c'est appelé : une alerte WhatsApp qui
// échoue (clé absente, CallMeBot en pause, pas de réseau...) ne doit jamais faire échouer l'action
// réelle (vente, demande, sauvegarde) qui l'a déclenchée.
// ============================================================
async function envoyerCallMeBot(message) {
  const phone = process.env.CALLMEBOT_PHONE;
  const apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey) {
    console.warn('CallMeBot non configuré (CALLMEBOT_PHONE/CALLMEBOT_APIKEY manquants) — alerte non envoyée :', message);
    return;
  }
  try {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(apikey)}`;
    const reponse = await fetch(url);
    if (!reponse.ok) console.warn('CallMeBot : réponse HTTP', reponse.status, await reponse.text().catch(() => ''));
  } catch (e) {
    console.warn('CallMeBot : envoi échoué —', e.message);
  }
}
// ============================================================
// MONTAGE DES ROUTES (23/10) : server.js ne garde que la configuration, la sécurité (jeton, limites, idempotence) et les lecteurs partagés ;
// chaque domaine a son fichier dans routes/. L'ORDRE ci-dessous est celui d'Express : ne pas le changer sans relire les chemins qui se recouvrent
// (ex. /api/dossiers/recherche doit rester avant /api/dossiers/:id).
// ============================================================
const contexte = { BUCKET_PIECES_JOINTES, FUSEAU_HAITI, ORIGINE_FRONTEND, PERMISSIONS_PAR_DEFAUT, ROLES_INVITABLES, aPermission, calculerSoldeDepot, dateOuNull, enregistrerAuditServeur, envoyerCallMeBot, episodeVersFlat, episodesVersFlatEnLot, estUnVraiUuid, extraireFichesDetail, extraireIntervention, ficheVersColonnes, flatVersStatut, flatVersTypePatient, lancerSurveillanceQualite, limitePublique, lireParLotsDIds, lireToutesLesPages, signatureModification, supabase, surveillanceEnCours, surveillanceQualite, synchroListes };
require('./routes/episodes')(app, contexte);
require('./routes/rechercheDossiers')(app, contexte);
require('./routes/exploitation')(app, contexte);
require('./routes/dossiers')(app, contexte);
require('./routes/parcoursEpisode')(app, contexte);
require('./routes/fiches')(app, contexte);
require('./routes/catalogue')(app, contexte);
require('./routes/caisse')(app, contexte);
require('./routes/partenaires')(app, contexte);
require('./routes/stock')(app, contexte);
require('./routes/administration')(app, contexte);
require('./routes/sauvegarde')(app, contexte);


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend CHF demarré sur le port ${PORT}`);
});
