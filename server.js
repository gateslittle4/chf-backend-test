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

// Utilisé par le Calculateur (CalculateurPanel.js) au moment de facturer, pour savoir combien de
// dépôt reste réellement disponible sur cet épisode — jamais le total brut déposé.
// Audit du 31/08 : cette route renvoie un solde de dépôt — une donnée financière. La même donnée
// servie par /api/dossiers/:id/historique est, elle, filtrée sur 'fiche_patient_voir_finances'
// (permission volontairement refusée à archiviste et infirmier, qui consultent le dossier pour son
// historique clinique, pas ses montants). Ici, aucun contrôle : la même information restait
// accessible par un autre chemin. Aligné. Aucun appelant côté navigateur aujourd'hui
// (chf.getSoldeDepot n'est utilisé nulle part), donc aucun risque de régression.
app.get('/api/episodes/:id/solde-depot', async (req, res) => {
  if (!(await aPermission(req.user.id, 'fiche_patient_voir_finances'))) {
    return res.status(403).json({ error: "Permission 'fiche_patient_voir_finances' requise." });
  }
  const { data: paiements, error } = await supabase
    .from('paiements').select('mode, montant, details').eq('episode_id', req.params.id)
    .or('annule.eq.false,annule.is.null').is('supprime_le', null);
  if (error) return res.status(500).json({ error: error.message });
  res.json(calculerSoldeDepot(paiements));
});

app.get('/api/episodes', async (req, res) => {
  // 21/10 : même correctif — la liste complète des épisodes (dossiers, totaux, statuts) n'avait aucune vérification de permission.
  if (!(await aPermission(req.user.id, 'fiche_patient_voir'))) return res.status(403).json({ error: "Permission 'fiche_patient_voir' requise." });
  // Lecture groupée (voir episodesVersFlatEnLot) : un nombre constant de requêtes par lot au lieu
  // de 3 par épisode. Résultat strictement identique — les deux chemins partagent le même
  // assemblage (assemblerEpisodeFlat).
  try {
    // ?synchro=1 : réponse incrémentale { mode, curseur, lignes, supprimes } (utils/synchroListes.js).
    // Sans ce paramètre : le tableau complet d'avant, pour les versions de l'app encore en cache.
    if (req.query.synchro === '1') return res.json(await synchroListes.episodes(req.query.depuis || null));
    // Paginée elle aussi : sans ça, un plafond de lignes côté Supabase aurait tronqué la liste
    // des épisodes EN SILENCE (les plus anciens auraient simplement disparu des rapports, sans
    // erreur) — le reste du correctif n'y aurait rien changé, puisque tout part de cette lecture.
    const episodes = await lireToutesLesPages(
      () => supabase.from('episodes').select('*').is('supprime_le', null).order('date_ouverture', { ascending: false }).order('id'));
    res.json(await episodesVersFlatEnLot(episodes));
  } catch (e) {
    // lireParLotsDIds relaie l'erreur Supabase plutôt que de renvoyer une liste incomplète en
    // silence : mieux vaut un échec visible que des dossiers manquants dans un rapport financier.
    console.error('GET /api/episodes: lecture groupée échouée :', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Création : pas de dossier_id fourni par l'ancien flux (il ne connaît que la
// création directe) → on crée un dossier ET un épisode ensemble dans ce cas.
// Le flux anti-doublon (chercher un dossier existant d'abord) reste le rôle
// du nouvel onglet "Dossier/Épisode", pas de cette route de compatibilité.
app.post('/api/episodes', async (req, res) => {
  if (!(await aPermission(req.user.id, 'dossier_creer'))) {
    return res.status(403).json({ error: "Permission 'dossier_creer' requise." });
  }
  const d = req.body;
  // Tous les appelants passent par toEpisodeApi() côté navigateur avant d'envoyer, donc le
  // corps reçu ici est en snake_case (nom_patient, pas nomPatient) — lire les champs en
  // camelCase les laissait toujours undefined, et cette création échouait systématiquement.
  // Un nom manquant/vide laissait l'erreur brute de Postgres remonter telle quelle à l'écran
  // ("null value in column nom... violates not-null constraint") au lieu d'un message clair.
  if (!d.nom_patient || !String(d.nom_patient).trim()) {
    return res.status(400).json({ error: "Le nom du patient est requis pour créer un dossier." });
  }

  // Idempotence — même principe que /api/dossiers, /api/fiches, /api/paiements et
  // /api/dossiers/:dossierId/episodes. Cette route-ci était la SEULE route de création à ne pas
  // l'avoir (constaté le 25/09, avant la mise en production à l'hôpital), alors qu'elle est
  // empruntée par Achat Express — donc par la file d'attente hors ligne. Une vente comptoir dont
  // la requête atteignait le serveur mais dont la réponse se perdait (coupure réseau au mauvais
  // moment, courant en Haïti) était rejouée au retour d'internet et créait un SECOND dossier,
  // avec sa fiche : un doublon de vente, visible dans le registre et dans les archives.
  if (d.local_id) {
    const { data: dejaCree } = await supabase.from('episodes').select('*').eq('local_id', d.local_id).maybeSingle();
    if (dejaCree) return res.status(200).json(await episodeVersFlat(dejaCree));
  }

  // Faille d'audit du 21/10 : cette route (compatibilité, utilisée par ⚡ Achat Express) insère aussi des FICHES (d.fiches) avec leur total_global/breakdown
  // venus tels quels du téléphone — le même trou que POST /api/fiches, jamais couvert par ce premier correctif puisque c'est une route différente. Même
  // vérification ici, AVANT tout insert (dossier/épisode non encore créés à ce stade) : rien n'est créé si une seule fiche a un montant refusé. Jamais
  // appliqué à la restauration d'une sauvegarde (import_sauvegarde) : d'anciennes données, déjà telles quelles, peuvent légitimement ne plus correspondre
  // au catalogue ou aux tarifs d'AUJOURD'HUI.
  if (Array.isArray(d.fiches) && d.fiches.length > 0 && d.import_sauvegarde !== true) {
    const episodePourPrix = { type_patient: flatVersTypePatient(d.type_patient), ong_partenaire: d.ong_partenaire || null };
    const [{ data: catalogueMed }, { data: catalogueActes }, { data: parametresData }] = await Promise.all([
      supabase.from('catalog').select('items').eq('type', 'medicaments').maybeSingle(),
      supabase.from('catalog').select('items').eq('type', 'actes').maybeSingle(),
      supabase.from('catalog').select('items').eq('type', 'parametres').maybeSingle(),
    ]);
    let ongDocExpress = null;
    if (episodePourPrix.ong_partenaire) {
      const { data } = await supabase.from('ong_partenaires').select('date_fin_contrat').eq('nom', episodePourPrix.ong_partenaire).maybeSingle();
      if (data) ongDocExpress = { dateFinContrat: data.date_fin_contrat };
    }
    const catalogue = { med: (catalogueMed && catalogueMed.items) || [], actes: (catalogueActes && catalogueActes.items) || [] };
    const parametresPourVerif = (parametresData && parametresData.items) || {};
    for (const f of d.fiches) {
      const verification = verifierTotalFiche({
        raw_state: f.rawState !== undefined ? f.rawState : f.raw_state, total_global: f.totalGlobal, breakdown: f.breakdown,
        episode: episodePourPrix, catalogue, parametres: parametresPourVerif, ongDoc: ongDocExpress,
      });
      if (!verification.ok) {
        // Même règle qu'à POST /api/fiches : un rejeu hors ligne n'est jamais refusé (vente déjà faite), seulement signalé.
        if (estRejeu(req)) {
          enregistrerAuditServeur(req, 'fiche_montant_suspect', { episode_id: null, total_global: f.totalGlobal, breakdown: f.breakdown, erreur: verification.erreur, route: '/api/episodes', hors_ligne: true });
        } else {
          enregistrerAuditServeur(req, 'fiche_montant_refuse', { episode_id: null, total_global: f.totalGlobal, breakdown: f.breakdown, erreur: verification.erreur, route: '/api/episodes' });
          return res.status(400).json({ error: verification.erreur, code: 'MONTANT_FICHE_REFUSE' });
        }
      }
    }
  }
  // 15/10 : cette route crée aussi le DOSSIER. Même règle que POST /api/dossiers (numéro, sexe, date de naissance obligatoires), sauf deux cas
  // qui n'enregistrent pas un vrai patient : la vente comptoir (⚡ Express : client de passage, numéro « AUTO-… ») et l'import d'une sauvegarde
  // (anciennes données, déjà telles quelles).
  const exempteIdentite = d.voie_entree === 'vente_comptoir' || d.import_sauvegarde === true;
  // 16/10 : hors vente comptoir et import, le numéro n'est plus exigé — et seule la caisse peut en fournir un ; sans numéro, le dossier est « en attente » (EN-ATTENTE-…).
  let numeroDuDossier = d.numero_dossier || null;
  if (!exempteIdentite) {
    const erreurIdentite = erreurIdentiteDossier({ sexe: d.sexe, date_naissance: d.date_naissance });
    if (erreurIdentite) return res.status(400).json({ error: erreurIdentite, code: 'IDENTITE_INCOMPLETE' });
    if (numeroDuDossier && String(numeroDuDossier).trim()) {
      if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
        return res.status(403).json({ error: "Seule la caisse peut donner un numéro de dossier. Crée le dossier sans numéro : la caisse le donnera après le paiement.", code: 'NUMERO_RESERVE_CAISSE' });
      }
      const erreurNumero = erreurNumeroDossier(numeroDuDossier);
      if (erreurNumero) return res.status(400).json({ error: erreurNumero });
      numeroDuDossier = String(numeroDuDossier).trim();
    } else {
      numeroDuDossier = numeroProvisoire();
    }
  }
  const { data: dossier, error: erreurDossier } = await supabase
    .from('dossiers')
    .insert({
      numero_dossier: numeroDuDossier || `AUTO-${Date.now()}`,
      nom: formaterNomPropre(d.nom_patient), date_naissance: dateOuNull(d.date_naissance), telephone: d.telephone, adresse: d.adresse,
      ...(d.sexe === 'M' || d.sexe === 'F' ? { sexe: d.sexe } : {}),
    })
    .select().single();
  if (erreurDossier) return res.status(500).json({ error: erreurDossier.message });

  const { data: episode, error: erreurEpisode } = await supabase
    .from('episodes')
    .insert({
      dossier_id: dossier.id,
      // Avant : voie_entree/est_hospitalisation étaient figés en dur ('consultation'/false),
      // donc un épisode "Achat Express" (voir components/AchatExpress.js) était indiscernable
      // d'une vraie consultation classique en base. Maintenant lus depuis le corps de la requête
      // (comme la route POST /api/dossiers/:dossierId/episodes le fait déjà) — les 3 autres
      // appelants de cette route (nouveau dossier rapide, archivage sans id serveur, restauration
      // de sauvegarde) n'envoient pas ces champs et gardent donc exactement le même comportement
      // par défaut qu'avant.
      voie_entree: d.voie_entree || 'consultation', service: d.service_choisi || 'Général',
      type_patient: flatVersTypePatient(d.type_patient), ong_partenaire: d.ong_partenaire || null,
      statut: flatVersStatut(d.status), est_hospitalisation: !!d.est_hospitalisation,
      // 19/10 : un épisode créé déjà clôturé (Achat Express) porte sa date de fermeture dès le départ.
      ...(d.status === 'archived' ? { date_fermeture: new Date().toISOString() } : {}),
      // Sans cette colonne renseignée, la vérification d'idempotence ci-dessus ne trouve jamais
      // rien et l'index unique episodes_local_id_unique ne protège rien : les deux ne servent
      // qu'ensemble.
      local_id: d.local_id || null,
    })
    .select().single();
  if (erreurEpisode) {
    // Deux rejeux simultanés peuvent passer la vérification ci-dessus en même temps (la lecture
    // et l'insertion ne sont pas atomiques) : c'est l'index unique en base qui tranche, et 23505
    // signifie alors que l'autre a gagné la course — on renvoie son résultat plutôt qu'une erreur.
    if (erreurEpisode.code === '23505' && d.local_id) {
      const { data: dejaCree } = await supabase.from('episodes').select('*').eq('local_id', d.local_id).maybeSingle();
      if (dejaCree) return res.status(200).json(await episodeVersFlat(dejaCree));
    }
    return res.status(500).json({ error: erreurEpisode.message });
  }

  if (Array.isArray(d.fiches) && d.fiches.length > 0) {
    // Avant : le résultat de cette insertion n'était jamais vérifié — un échec ici laissait
    // quand même passer un 201 "succès" pour tout le dossier, fiches manquantes en silence.
    const { error: erreurFiches } = await supabase.from('fiches').insert(d.fiches.map(f => ({ episode_id: episode.id, ...ficheVersColonnes(f) })));
    if (erreurFiches) return res.status(500).json({ error: `Dossier créé, mais échec de l'enregistrement des fiches : ${erreurFiches.message}` });
  }
  res.status(201).json(await episodeVersFlat(episode));
});

app.put('/api/episodes/:id', async (req, res) => {
  const d = req.body;

  // Même défaut que POST /api/episodes ci-dessus : tous les appelants envoient du snake_case
  // via toEpisodeApi() — lire ces champs en camelCase les laissait toujours undefined, donc
  // ces mises à jour (lot de facturation, service, ONG, type patient, suspension, report au
  // mois suivant) réussissaient (200 OK) sans jamais rien écrire.
  const { data: episodeActuel, error: erreurActuel } = await supabase.from('episodes').select('statut, dossier_id').eq('id', req.params.id).maybeSingle();
  if (erreurActuel) return res.status(500).json({ error: erreurActuel.message });
  // Modifier un dossier déjà archivé (statut 'ferme' — donc potentiellement déjà facturé/lotté)
  // n'avait aucun contrôle de rôle, contrairement à DELETE juste en dessous. Même logique ici,
  // avec la permission 'facturation_modifier' : un dossier encore ouvert reste librement
  // modifiable (saisie rétroactive normale), un dossier déjà archivé ne l'est plus pour tous.
  if (episodeActuel && episodeActuel.statut === 'ferme') {
    if (!(await aPermission(req.user.id, 'facturation_modifier'))) {
      return res.status(403).json({ error: "Permission 'facturation_modifier' requise pour modifier un dossier déjà archivé." });
    }
  }

  const maj = {};
  if (d.service_choisi !== undefined) maj.service = d.service_choisi;
  if (d.type_patient !== undefined) maj.type_patient = flatVersTypePatient(d.type_patient);
  if (d.ong_partenaire !== undefined) maj.ong_partenaire = d.ong_partenaire;
  if (d.status !== undefined) {
    maj.statut = flatVersStatut(d.status);
    maj.date_suspension = d.status === 'suspendu' ? (d.date_suspension || new Date().toISOString()) : null;
    maj.mois_report = d.status === 'reporte' ? (d.mois_report || null) : null;
    // Motif de sortie (hospitalisation uniquement — voir HebergementForm.js) : capturé au
    // moment de la clôture, sur ce même chemin (Archiver), plutôt que via la route dédiée
    // /fermer qui existait déjà mais qu'aucun écran n'appelait.
    if (d.status === 'archived') {
      maj.motif_fermeture = d.motif_fermeture || null;
      maj.date_fermeture = new Date().toISOString();
    }
  }
  if (d.numero_lot !== undefined) maj.numero_lot = d.numero_lot;
  if (d.verrouille_facture !== undefined) maj.verrouille_facture = d.verrouille_facture;
  // Lots & Facturation (version chf-demo2, portée le 08/09) : mois_lot (badge affiché sur le lot,
  // modifiable/rétro-rempli automatiquement) et lot_verrouille (verrouillage d'un lot déjà
  // approuvé par le partenaire — distinct de verrouille_facture, qui protège un dossier
  // individuel). Colonnes ajoutées par sql/ajoute_lot_mois_verrouillage_episodes.sql.
  if (d.mois_lot !== undefined) maj.mois_lot = d.mois_lot;
  if (d.lot_verrouille !== undefined) maj.lot_verrouille = d.lot_verrouille;
  // « Dossier complet » (onglet Lots, version chf-demo2) : strictement vrai ou faux, jamais une chaîne ni un nombre.
  if (d.dossier_complet !== undefined) {
    if (typeof d.dossier_complet !== 'boolean') return res.status(400).json({ error: 'dossier_complet doit valoir true ou false.' });
    maj.dossier_complet = d.dossier_complet;
  }

  if (Object.keys(maj).length > 0) {
    // Chaque modification signe le dossier (modifie_par / modifie_par_uid). Si les colonnes n'existent pas encore (SQL pas collé),
    // la modification passe quand même SANS signature — sauf « dossier complet », qui a besoin de sa colonne.
    let { data, error } = await supabase.from('episodes').update({ ...maj, ...(await signatureModification(req.user)) }).eq('id', req.params.id).select();
    if (error && error.code === '42703') {
      if (d.dossier_complet !== undefined) return res.status(500).json({ error: "La colonne dossier_complet n'existe pas encore dans Supabase — colle sql/ajoute_dossier_complet_modifie_par_episodes.sql dans le SQL Editor." });
      ({ data, error } = await supabase.from('episodes').update(maj).eq('id', req.params.id).select());
    }
    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.status(404).json({ error: "Dossier introuvable — rien n'a été modifié." });
  }

  // Le nom du patient vit sur la table dossiers, pas episodes — cette route ne le touchait
  // jamais, donc corriger un nom depuis Archives affichait "succès" sans rien enregistrer.
  if (d.nom_patient !== undefined && String(d.nom_patient).trim() && episodeActuel) {
    const { data: nomMaj, error: erreurNom } = await supabase.from('dossiers').update({ nom: formaterNomPropre(d.nom_patient) }).eq('id', episodeActuel.dossier_id).select();
    if (erreurNom) return res.status(500).json({ error: erreurNom.message });
    if (!nomMaj || nomMaj.length === 0) return res.status(404).json({ error: "Dossier lié introuvable — le nom n'a pas été modifié." });
  }

  // Fiches : upsert (id fourni = mise à jour, sinon = nouvelle fiche). Ne supprime
  // jamais une fiche absente du tableau reçu — cette route ne gère que l'ajout/modif,
  // pas la suppression de fiches individuelles (aucun ancien appel ne l'utilisait ainsi).
  if (Array.isArray(d.fiches)) {
    for (const f of d.fiches) {
      if (estUnVraiUuid(f.id)) {
        // Avant : ni l'erreur ni le nombre de lignes touchées n'étaient vérifiés ici —
        // même angle mort que /api/catalog (succès silencieux même si rien n'est écrit).
        // Le numéro d'une fiche existante n'est JAMAIS réécrit depuis le navigateur (14/10) : depuis la renumérotation automatique (insertion /
        // suppression d'une fiche), un écran resté sur d'anciens numéros écraserait la bonne numérotation, ou violerait la contrainte d'unicité.
        const { numero_fiche: _numeroIgnore, ...colonnesSansNumero } = ficheVersColonnes(f);
        const { data: fd, error: fe } = await supabase.from('fiches').update(colonnesSansNumero).eq('id', f.id).select();
        if (fe) return res.status(500).json({ error: `Fiche ${f.id} : ${fe.message}` });
        if (!fd || fd.length === 0) return res.status(404).json({ error: `Fiche ${f.id} introuvable — rien n'a été modifié.` });
      }
      else {
        const { error: ei } = await supabase.from('fiches').insert({ episode_id: req.params.id, ...ficheVersColonnes(f) });
        if (ei) return res.status(500).json({ error: `Nouvelle fiche : ${ei.message}` });
      }
    }
  }

  const { data: episode, error: erreurLecture } = await supabase.from('episodes').select('*').eq('id', req.params.id).single();
  if (erreurLecture) return res.status(404).json({ error: 'Épisode introuvable' });
  res.json(await episodeVersFlat(episode));
});

app.delete('/api/episodes/:id', async (req, res) => {
  // Aucun rôle n'était vérifié ici : n'importe quel utilisateur connecté pouvait supprimer
  // définitivement n'importe quel dossier, même déjà archivé/facturé. On distingue maintenant :
  // annuler un brouillon jamais envoyé (statut 'ouvert') reste libre pour qui l'a créé, mais
  // supprimer un dossier déjà archivé (statut 'ferme') est réservé à direction/administrateur.
  const { data: episode, error: erreurLecture } = await supabase.from('episodes').select('statut').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (episode && episode.statut === 'ferme') {
    if (!(await aPermission(req.user.id, 'facturation_supprimer'))) {
      return res.status(403).json({ error: "Permission 'facturation_supprimer' requise pour supprimer un dossier déjà archivé." });
    }
  }
  // Corbeille 30 jours (retour d'Esdras, 01/09 : "j'aime pas trop suppression irréversible") —
  // phase 2, jamais branchée jusqu'ici malgré les colonnes déjà en place (voir
  // sql/corbeille_30_jours.sql). Un UPDATE de supprime_le au lieu d'un vrai DELETE : la ligne
  // reste en base, purgée pour de bon seulement après 30 jours (voir purgerCorbeilleDossiers()).
  // fiches/paiements de CET épisode suivent avec le MÊME horodatage (le vrai DELETE cascadait
  // déjà automatiquement vers eux au niveau base — episodes.dossier_id/fiches.episode_id/
  // paiements.episode_id sont ON DELETE CASCADE — un simple UPDATE ne déclenche pas cette
  // cascade, donc il faut la refaire à la main ici). .is('supprime_le', null) : ne touche jamais
  // une fiche déjà mise à la corbeille séparément plus tôt pour une autre raison, avec sa propre
  // date — cette date sert de repère exact pour distinguer, à la restauration, ce qui a été
  // supprimé AVEC ce dossier de ce qui l'a été indépendamment (voir la route de restauration).
  const maintenant = new Date().toISOString();
  const { data: episodeMaj, error } = await supabase.from('episodes').update({ supprime_le: maintenant }).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!episodeMaj || episodeMaj.length === 0) return res.status(404).json({ error: 'Dossier introuvable.' });
  await supabase.from('fiches').update({ supprime_le: maintenant }).eq('episode_id', req.params.id).is('supprime_le', null).select();
  await supabase.from('paiements').update({ supprime_le: maintenant }).eq('episode_id', req.params.id).is('supprime_le', null).select();
  res.json({ success: true });
});

// Restauration d'un dossier mis à la corbeille — même permission que sa suppression (un
// utilisateur qui peut supprimer un dossier archivé peut aussi annuler ce geste). Ne restaure
// QUE les fiches/paiements dont supprime_le correspond EXACTEMENT à celui de l'épisode — ceux-là
// ont été mis à la corbeille EN MÊME TEMPS que lui (par la cascade ci-dessus), jamais une fiche
// supprimée séparément avant ou après pour une raison qui n'a rien à voir.
app.post('/api/episodes/:id/restaurer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'facturation_supprimer'))) {
    return res.status(403).json({ error: "Permission 'facturation_supprimer' requise pour restaurer un dossier." });
  }
  const { data: episode, error: erreurLecture } = await supabase.from('episodes').select('supprime_le').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!episode) return res.status(404).json({ error: 'Dossier introuvable.' });
  if (!episode.supprime_le) return res.status(400).json({ error: "Ce dossier n'est pas à la corbeille." });
  const horodatageSuppression = episode.supprime_le;
  const { data: episodeRestaure, error } = await supabase.from('episodes').update({ supprime_le: null }).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!episodeRestaure || episodeRestaure.length === 0) return res.status(404).json({ error: 'Dossier introuvable.' });
  await supabase.from('fiches').update({ supprime_le: null }).eq('episode_id', req.params.id).eq('supprime_le', horodatageSuppression).select();
  await supabase.from('paiements').update({ supprime_le: null }).eq('episode_id', req.params.id).eq('supprime_le', horodatageSuppression).select();
  res.json({ success: true });
});

// Liste des dossiers à la corbeille — alimente l'onglet "🗑️ Corbeille" d'Archives, même
// principe que la corbeille du catalogue (GrilleEdition.js) : montrer ce qui reste avant la
// purge définitive à 30 jours, avec la possibilité de restaurer avant.
app.get('/api/episodes/corbeille', async (req, res) => {
  if (!(await aPermission(req.user.id, 'facturation_supprimer'))) {
    return res.status(403).json({ error: "Permission 'facturation_supprimer' requise pour voir la corbeille." });
  }
  // Lectures paginées et par lots (25/09, audit avant mise en production) : la liste des épisodes
  // était plafonnée en silence à 1000 lignes, et un seul .in() mettait TOUS les ids de dossiers
  // dans l'URL — une corbeille bien remplie (30 jours de suppressions) aurait fini par dépasser la
  // limite de longueur, et l'onglet Corbeille aurait cessé de s'afficher. Voir TAILLE_LOT_IDS.
  let episodes, dossiers;
  try {
    episodes = await lireToutesLesPages(() => supabase
      .from('episodes').select('id, dossier_id, supprime_le').not('supprime_le', 'is', null).order('supprime_le', { ascending: false }).order('id'));
    const dossierIds = [...new Set(episodes.map(e => e.dossier_id))];
    dossiers = await lireParLotsDIds(dossierIds, lot => supabase.from('dossiers').select('id, nom').in('id', lot).order('id'));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  const nomParDossier = new Map(dossiers.map(d => [d.id, d.nom]));
  res.json(episodes.map(e => ({ id: e.id, nomPatient: nomParDossier.get(e.dossier_id) || null, supprimeLe: e.supprime_le })));
});

// ============================================================
// DOSSIER / ÉPISODE / FICHES — nouvelle structure (le vrai flux anti-doublon,
// via l'onglet "🔍 Dossier/Épisode", séparé de la compatibilité ci-dessus)
// ============================================================

// Recherche par nom exact OU par numéro de dossier (si le patient a sa carte). Pour le nom :
// tolérante aux fautes de frappe/accents (fonction Postgres atomique rechercher_dossiers_flou,
// extension pg_trgm — voir fonction_recherche_floue_dossiers.sql) — sans ça, la moindre variation
// (espace en trop, faute de frappe) faisait croire qu'aucun dossier n'existait, créant un doublon
// au lieu de retrouver le patient existant. Repli sur %nom% si la fonction/l'extension n'existe
// pas encore (comme les autres fonctions atomiques du projet, code d'erreur 42883).
app.get('/api/dossiers/recherche', async (req, res) => {
  // 21/10 : faille d'audit — cette route (et les suivantes du même bloc) n'avait aucune vérification de permission, juste un jeton valide. Tous les rôles
  // par défaut ont déjà fiche_patient_voir (aucun changement de comportement aujourd'hui) : ferme le trou pour un futur rôle créé sans ce droit.
  if (!(await aPermission(req.user.id, 'fiche_patient_voir'))) return res.status(403).json({ error: "Permission 'fiche_patient_voir' requise." });
  const nom = (req.query.nom || '').trim();
  const numero = (req.query.numero || '').trim();
  if (!nom && !numero) return res.json([]);

  if (numero) {
    const { data, error } = await supabase.from('dossiers').select('*').eq('numero_dossier', numero);
    if (error) return res.status(500).json({ error: error.message });
    // 14/10 : un dossier FUSIONNÉ dans un autre renvoie le dossier final (le numéro de l'ancien dossier retrouve la bonne personne).
    const fusionnes = (data || []).filter(d => d.fusionne_dans);
    if (fusionnes.length === 0) return res.json(data);
    const { data: finaux } = await supabase.from('dossiers').select('*').in('id', fusionnes.map(d => d.fusionne_dans));
    return res.json((data || []).filter(d => !d.fusionne_dans).concat(finaux || []));
  }

  const { data, error } = await supabase.rpc('rechercher_dossiers_flou', { p_nom: nom });
  if (error) {
    if (error.code === '42883') {
      let { data: repli, error: erreurRepli } = await supabase.from('dossiers').select('*').is('fusionne_dans', null).ilike('nom', `%${nom}%`);
      if (erreurRepli && erreurRepli.code === '42703') ({ data: repli, error: erreurRepli } = await supabase.from('dossiers').select('*').ilike('nom', `%${nom}%`)); // base pas encore migrée
      if (erreurRepli) return res.status(500).json({ error: erreurRepli.message });
      return res.json(repli);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// Liste des patients pour la recherche HORS LIGNE (audit du 28/09 avant la mise en production).
// Esdras : "on doit pouvoir chercher des personnes récentes hors ligne". Jusqu'ici, un appareil
// hors ligne ne retrouvait un patient que s'il avait déjà une VISITE chargée sur cet appareil (la
// copie locale ne contenait que les épisodes) : un dossier créé le matin par l'infirmier sur SA
// tablette restait introuvable à la caisse pendant une coupure. Chaque appareil connecté recopie
// maintenant cette liste (voir chf-app2, api/apiDossierEpisode.js, rafraichirListeHorsLigne).
// nom_origine (28/09) : un bébé renommé au retour du néonat doit rester retrouvable hors ligne
// par son nom de naissance. Colonnes réduites au strict nécessaire pour RETROUVER quelqu'un (pas d'adresse, rien de
// financier). Même accès que /api/dossiers/recherche (toute personne connectée), qui renvoie déjà
// davantage. Paginée : un select unique s'arrêterait en silence à 1000 lignes.
// ============================================================================================
// NUMÉRO DE DOSSIER DONNÉ PAR LA CAISSE (16/10, Esdras) — voir utils/numeroDossier.js et sql/numero_dossier_compteur.sql.
// « Seule la caisse donne un numéro, quand la personne a payé ; le site le donne automatiquement, c'est moi qui définis où ça commence, la caisse peut le modifier. »
// Droit : caisse_travailler (direction, comptable, pharmacien, pharmacien en chef, administrateur) ; infirmier et archiviste n'ont PAS ce droit.
// ⚠️ Ces routes sont déclarées AVANT /api/dossiers/:id (sinon « numero-propose » serait pris pour un identifiant de dossier).
// ============================================================================================
app.get('/api/dossiers/numero-propose', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) return res.status(403).json({ error: "Seule la caisse peut donner un numéro de dossier.", code: 'NUMERO_RESERVE_CAISSE' });
  const { data, error } = await supabase.rpc('numero_dossier_propose');
  if (error) {
    if (['42883', 'PGRST202'].includes(String(error.code))) return res.status(503).json({ error: "Le script sql/numero_dossier_compteur.sql n'est pas encore collé dans Supabase : le numéro automatique n'est pas disponible." });
    return res.status(500).json({ error: error.message });
  }
  res.json({ numero: data });
});

// Donne (ou change) le numéro d'un dossier. Corps : { numero }. Le serveur refuse un numéro déjà pris (409) ; le compteur n'avance que si c'est le numéro proposé.
app.post('/api/dossiers/:id/numero', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) return res.status(403).json({ error: "Seule la caisse peut donner ou changer un numéro de dossier.", code: 'NUMERO_RESERVE_CAISSE' });
  const erreurNumero = erreurNumeroDossier(req.body && req.body.numero);
  if (erreurNumero) return res.status(400).json({ error: erreurNumero });
  const numero = String(req.body.numero).trim();
  const { data, error } = await supabase.rpc('attribuer_numero_dossier', { p_dossier: req.params.id, p_numero: numero });
  if (error) {
    if (['42883', 'PGRST202'].includes(String(error.code))) return res.status(503).json({ error: "Le script sql/numero_dossier_compteur.sql n'est pas encore collé dans Supabase : le numéro automatique n'est pas disponible." });
    const statut = { CHF30: 400, CHF31: 404, CHF32: 409 }[error.code] || (error.code === '22P02' ? 404 : 500);
    return res.status(statut).json({ error: error.message });
  }
  if (!data.inchange) {
    await enregistrerAuditServeur(req, 'numero_dossier_donne', { dossier_id: req.params.id, ancien_numero: data.ancien, nouveau_numero: data.numero, automatique: !!data.automatique });
  }
  res.json(data);
});

// Réglage de l'administrateur : le prochain numéro que le site proposera. RÉSERVÉ au rôle « administrateur » (contrôle de rôle, comme /api/admin/anomalies : pas une permission
// qu'on pourrait donner à un autre rôle par l'écran Rôles & permissions — « c'est moi qui définis où ça commence »).
async function exigerAdministrateur(req, res) {
  const { data: profil, error } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return false; }
  if (!profil || profil.role !== 'administrateur') { res.status(403).json({ error: "Réservé à l'administrateur." }); return false; }
  return true;
}
// « Qui est connecté » : réservé à l'administrateur et à la direction.
async function exigerAdminOuDirection(req, res) {
  const { data: profil, error } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return false; }
  if (!profil || !['administrateur', 'direction'].includes(profil.role)) { res.status(403).json({ error: "Réservé à l'administrateur et à la direction." }); return false; }
  return true;
}
app.get('/api/admin/connectes', async (req, res) => {
  if (!(await exigerAdminOuDirection(req, res))) return;
  const { data, error } = await supabase.from('users').select('id, display_name, email, role, active, derniere_activite');
  if (error) return res.status(['42703', 'PGRST204'].includes(String(error.code)) ? 503 : 500).json({ error: error.message });
  res.json({ maintenant: new Date().toISOString(), utilisateurs: presence.classerConnectes(data) });
});
// « Qui était à la caisse tel jour » : paiements encaissés ce jour (heure d'Haïti) regroupés par caissier + clôture.
app.get('/api/admin/caisse-jour', async (req, res) => {
  if (!(await exigerAdminOuDirection(req, res))) return;
  const bornes = presence.bornesJourHaiti(req.query.date);
  if (!bornes) return res.status(400).json({ error: 'Date invalide (AAAA-MM-JJ).' });
  const { data: paiements, error } = await supabase.from('paiements')
    .select('encaisse_par, montant, mode, date_paiement, annule, supprime_le')
    .gte('date_paiement', bornes.debut).lt('date_paiement', bornes.fin).limit(5000);
  if (error) return res.status(500).json({ error: error.message });
  const { data: clotures } = await supabase.from('cloture_caisse').select('cloturee_par, cloturee_par_uid, statut, date_cloture').eq('date', req.query.date);
  res.json({ date: req.query.date, ...presence.resumerCaisseDuJour(paiements, clotures) });
});
app.get('/api/admin/numero-dossier-depart', async (req, res) => {
  if (!(await exigerAdministrateur(req, res))) return;
  const { data, error } = await supabase.rpc('numero_dossier_depart');
  if (error) return res.status(['42883', 'PGRST202'].includes(String(error.code)) ? 503 : 500).json({ error: error.message });
  res.json({ prochain: Number(data) });
});
app.put('/api/admin/numero-dossier-depart', async (req, res) => {
  if (!(await exigerAdministrateur(req, res))) return;
  const erreur = erreurNumeroDepart(req.body && req.body.prochain);
  if (erreur) return res.status(400).json({ error: erreur });
  const prochain = Number(req.body.prochain);
  const { data: avant } = await supabase.rpc('numero_dossier_depart');
  const { data, error } = await supabase.rpc('definir_numero_dossier_depart', { p_prochain: prochain });
  if (error) return res.status(error.code === 'CHF33' ? 400 : (['42883', 'PGRST202'].includes(String(error.code)) ? 503 : 500)).json({ error: error.message });
  await enregistrerAuditServeur(req, 'numero_dossier_depart_modifie', { ancien: avant === undefined ? null : Number(avant), nouveau: prochain });
  res.json({ prochain: Number(data) });
});

// ⚠️ Déclarée AVANT /api/dossiers/:id, sinon Express y verrait un dossier nommé "liste-hors-ligne".
// 30/09 (test réel) : "correspondances" id local -> vrai id. Une fiche et son paiement mis en file
// PENDANT qu'une synchronisation envoyait déjà le dossier et l'épisode dont ils dépendent restaient
// bloqués pour toujours sur l'appareil : la correspondance local -> réel ne vivait que dans la
// mémoire de CE cycle. L'app la garde maintenant sur l'appareil, et pour les files déjà bloquées
// (ou un appareil qui a perdu cette mémoire) elle la redemande ici. Ne renvoie que des identifiants,
// jamais de contenu ; format local_id vérifié ; 100 au plus par appel.
app.get('/api/ids-locaux', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(x => x.trim())
    .filter(x => /^local-\d+-[a-z0-9]+$/.test(x)).slice(0, 100);
  if (ids.length === 0) return res.json({});
  const correspondances = {};
  try {
    for (const table of ['dossiers', 'episodes', 'fiches']) {
      const { data, error } = await supabase.from(table).select('id, local_id').in('local_id', ids);
      if (error) throw error;
      (data || []).forEach(r => { if (r.local_id && !correspondances[r.local_id]) correspondances[r.local_id] = r.id; });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json(correspondances);
});

app.get('/api/dossiers/liste-hors-ligne', async (req, res) => {
  try {
    let dossiers;
    try {
      // 14/10 : un dossier fusionné n'est plus proposé hors ligne non plus.
      dossiers = await lireToutesLesPages(() => supabase.from('dossiers')
        .select('id, numero_dossier, nom, nom_origine, date_naissance, telephone, sexe').is('fusionne_dans', null).order('id'));
    } catch (e) {
      if (e && e.code !== '42703') throw e; // base pas encore migrée : liste complète comme avant
      dossiers = await lireToutesLesPages(() => supabase.from('dossiers')
        .select('id, numero_dossier, nom, nom_origine, date_naissance, telephone, sexe').order('id'));
    }
    res.json(dossiers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 14/10 : doublons d'identité + fusion de dossiers, puis état du système (postes, erreurs) — déclarés AVANT /api/dossiers/:id (voir utils/routesDoublons.js).
creerRoutesDoublons({ supabase, aPermission, lireToutesLesPages }).monter(app);
creerRoutesEtatSysteme({ supabase }).monter(app);
// 14/10 : renommer un type de consultation / un service d'hospitalisation sans couper l'historique (voir utils/routesListesServices.js).
creerRoutesListesServices({ supabase, aPermission }).monter(app);

// 14/10 : « Qualité des données » — ce qui manque ou semble faux, avec de quoi corriger (voir utils/qualiteDonnees.js).
// 18/10 : + SURVEILLANCE automatique (voir utils/surveillanceQualite.js) : contrôle chaque matin, corrections de forme tracées, alerte WhatsApp avec les noms, historique.
const surveillanceQualite = creerSurveillance({ supabase, lireToutesLesPages, envoyerAlerte: (message) => envoyerCallMeBot(message), fuseau: FUSEAU_HAITI, journal: console });
let surveillanceEnCours = null; // un seul passage à la fois (minuteur, rattrapage au réveil et bouton « Lancer maintenant »)
function lancerSurveillanceQualite(options) {
  if (surveillanceEnCours) return surveillanceEnCours;
  surveillanceEnCours = surveillanceQualite.executer(options).finally(() => { surveillanceEnCours = null; });
  return surveillanceEnCours;
}
// 19/10 (Esdras) : la Qualité des données est réservée au rôle « administrateur » (c'est lui le gestionnaire de données) — contrôle de rôle, comme les anomalies de caisse ; ni la direction ni le PDG.

app.get('/api/qualite-donnees', async (req, res) => {
  if (!(await exigerAdministrateur(req, res))) return;
  try {
    const { dossiers, episodes, paiements } = await surveillanceQualite.lireDonnees();
    res.json({ ...controlerQualite({ dossiers, episodes, paiements, maintenantMs: Date.now() }), genere_le: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Résumé léger (le dernier instantané de la surveillance, pas de recalcul) : alimente le compteur du menu.
app.get('/api/qualite-donnees/resume', async (req, res) => {
  if (!(await exigerAdministrateur(req, res))) return;
  try { res.json({ dernier: await surveillanceQualite.dernierInstantane() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Historique de la surveillance (30 derniers passages) et corrections de forme faites automatiquement (100 dernières, avant → après).
app.get('/api/qualite-donnees/surveillance', async (req, res) => {
  if (!(await exigerAdministrateur(req, res))) return;
  try {
    const [historique, corrections] = await Promise.all([surveillanceQualite.historique(30), surveillanceQualite.correctionsRecentes(100)]);
    res.json({ historique, corrections, en_cours: !!surveillanceEnCours });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// « Lancer maintenant » : un passage complet tout de suite (sans alerte WhatsApp : la personne regarde l'écran).
app.post('/api/qualite-donnees/surveillance/lancer', async (req, res) => {
  if (!(await exigerAdministrateur(req, res))) return;
  const resultat = await lancerSurveillanceQualite({ origine: 'manuel', alerter: false });
  if (!resultat.ok) return res.status(500).json({ error: resultat.erreur });
  res.json(resultat);
});

app.post('/api/dossiers', async (req, res) => {
  // 01/10 (retour d'Esdras) : la caisse/pharmacie (caisse_travailler) peut aussi créer un dossier —
  // elle le fait depuis l'écran "Dossier/Épisode" puis passe directement au calculateur. Les autres
  // rôles (archiviste, lecteur, visiteur...) restent exclus : dossier_creer OU caisse_travailler.
  if (!(await aPermission(req.user.id, 'dossier_creer')) && !(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'dossier_creer' (ou accès caisse) requise." });
  }
  const { numero_dossier: numeroSaisi, nom: nomSaisi, date_naissance, telephone, adresse, local_id, sexe, mere_dossier_id } = req.body;
  if (!nomSaisi) return res.status(400).json({ error: 'Le nom est requis' });
  // Faille d'audit du 21/10 : nom/adresse/téléphone n'avaient aucune limite de longueur côté serveur (seul le corps entier était borné à 10 Mo) — un compte
  // avec dossier_creer ou caisse_travailler (presque tous les rôles) pouvait gonfler une colonne TEXT avec plusieurs Mo de texte. Bornes larges, jamais atteintes par un vrai dossier.
  if (typeof nomSaisi === 'string' && nomSaisi.length > 200) return res.status(400).json({ error: 'Le nom est trop long (200 caractères au plus).' });
  if (typeof adresse === 'string' && adresse.length > 300) return res.status(400).json({ error: "L'adresse est trop longue (300 caractères au plus)." });
  if (typeof telephone === 'string' && telephone.length > 40) return res.status(400).json({ error: 'Le téléphone est trop long (40 caractères au plus).' });
  const nom = formaterNomPropre(nomSaisi); // majuscule au début de chaque mot (14/10)
  if (!nom) return res.status(400).json({ error: 'Le nom est requis' });
  // Idempotence : mêmes principes que /api/fiches et /api/paiements — nécessaire maintenant que
  // apiDossierEpisode passe par la file d'attente hors-ligne (avant, cette route n'était jamais
  // rejouée automatiquement, donc jamais appelée deux fois pour la même action).
  if (local_id) {
    const { data: existant } = await supabase.from('dossiers').select('*').eq('local_id', local_id).maybeSingle();
    if (existant) return res.status(200).json(existant);
  }
  // Après le rejeu : un dossier déjà créé (avant cette règle) qu'on renvoie par idempotence reste renvoyé tel quel.
  // 15/10 : sexe ET date de naissance obligatoires à la création (voir utils/dossiers.js::erreurIdentiteDossier).
  const erreurIdentite = erreurIdentiteDossier({ sexe, date_naissance });
  if (erreurIdentite) return res.status(400).json({ error: erreurIdentite, code: 'IDENTITE_INCOMPLETE' });
  // 16/10 (Esdras) : SEULE LA CAISSE donne un numéro de dossier (quand la personne a payé). Sans numéro, le dossier est créé « en attente » sous un numéro provisoire
  // (EN-ATTENTE-…) que la caisse remplace ensuite (POST /api/dossiers/:id/numero). Un numéro fourni par quelqu'un qui n'a ni la caisse ni dossier_numero_saisir (archive) est REFUSÉ, jamais ignoré en silence.
  const numeroDemande = numeroSaisi === undefined || numeroSaisi === null ? '' : String(numeroSaisi).trim();
  let numero_dossier;
  if (numeroDemande) {
    // 22/10 (Esdras) : à la CRÉATION du dossier, la caisse ET l'archive (dossier_numero_saisir) peuvent taper le numéro d'une personne qui en a déjà un.
    // Donner ou changer le numéro d'un dossier existant reste réservé à la caisse (routes plus bas).
    if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'dossier_numero_saisir'))) {
      return res.status(403).json({ error: "Tu ne peux pas donner de numéro de dossier. Crée le dossier sans numéro : il sera donné automatiquement.", code: 'NUMERO_RESERVE_CAISSE' });
    }
    const erreurNumero = erreurNumeroDossier(numeroDemande);
    if (erreurNumero) return res.status(400).json({ error: erreurNumero });
    numero_dossier = numeroDemande;
  } else {
    numero_dossier = numeroProvisoire();
  }
  // Retour d'Esdras (01/09) : "je ne veux pas oublier la racine de l'enfant" — un bébé né au
  // néonat est d'abord enregistré sous un nom temporaire ("Bébé + nom de la mère"), puis reçoit
  // son vrai nom au retour de la mère en consultation. nom_origine fige le nom du dossier à sa
  // CRÉATION, pour toujours — un renommage plus tard (PUT /api/dossiers/:id ci-dessous) ne
  // touche jamais ce champ, donc le nom d'origine reste consultable même après. `error.code ===
  // '42703'` (colonne inexistante) : la colonne peut ne pas encore exister dans Supabase (voir
  // sql/ajoute_nom_origine_dossiers.sql, pas encore confirmé collé) — repli sur l'ancien insert
  // sans elle, comme les autres fonctions Postgres pas encore déployées dans ce projet (42883).
  // Colonnes facultatives (nom_origine, sexe) : 42703 = colonne absente (script SQL pas encore collé). On retire d'abord nom_origine (comme
  // avant), puis le sexe en dernier recours — jamais le sexe d'abord, pour ne pas le perdre quand seul nom_origine manque.
  // 14/10 : un nouveau-né est lié au dossier de sa MÈRE (mere_dossier_id) — vérifiée (existe, pas fusionnée, pas un homme). Sans la colonne en base, on refuse
  // plutôt que de créer le bébé en perdant le lien en silence.
  if (mere_dossier_id) {
    const verif = await verifierMere(supabase, mere_dossier_id, null);
    if (!verif.ok) return res.status(verif.status).json({ error: verif.erreur });
  }
  const ligneDossier = { numero_dossier, nom, nom_origine: nom, date_naissance: dateOuNull(date_naissance), telephone, adresse, local_id: local_id || null, ...(sexe ? { sexe } : {}), ...(mere_dossier_id ? { mere_dossier_id } : {}) };
  let { data, error } = await supabase.from('dossiers').insert(ligneDossier).select().single();
  if (error && error.code === '42703') {
    const { nom_origine, ...sansNomOrigine } = ligneDossier;
    ({ data, error } = await supabase.from('dossiers').insert(sansNomOrigine).select().single());
    if (error && error.code === '42703' && sansNomOrigine.sexe) {
      const { sexe: _sexe, ...sansSexe } = sansNomOrigine;
      ({ data, error } = await supabase.from('dossiers').insert(sansSexe).select().single());
    }
  }
  if (error) {
    if (error.code === '23505') {
      if (local_id) {
        const { data: existant } = await supabase.from('dossiers').select('*').eq('local_id', local_id).maybeSingle();
        if (existant) return res.status(200).json(existant);
      }
      // 23505 non résolu par le local_id : un VRAI conflit (numero_dossier déjà pris par un autre
      // patient), pas une simple répétition de cette même tentative. Avant, ceci tombait dans le
      // 500 générique ci-dessous — indiscernable côté client d'une vraie panne serveur, donc une
      // création hors ligne bloquée sur ce conflit était réessayée indéfiniment toutes les 30
      // secondes (elle ne peut pourtant jamais réussir avec les mêmes données) au lieu d'être
      // signalée clairement une seule fois. Voir CHF_API.syncPending (api/supabase.js, chf-app2).
      //
      // 09/10 (Esdras : « quand le net est tombé, il n'y aura plus de connexion entre les deux ordinateurs ») :
      // si le dossier qui porte déjà ce numéro porte AUSSI ce nom (accents, majuscules, ponctuation et ordre des mots
      // mis à part), c'est probablement le MÊME patient enregistré deux fois — typiquement à la porte et à la caisse
      // pendant une coupure d'internet. 13/10 (Esdras) : jamais réuni AUTOMATIQUEMENT. Sans confirmation, le serveur
      // refuse (409, code PATIENT_DEJA_ENREGISTRE) en renvoyant le dossier en place : l'application le montre à une
      // personne, qui choisit de réunir ou non. Avec `reunir: true` (la personne a confirmé), il renvoie le dossier
      // existant et l'app rattache tout à lui (épisode, fiche, paiement). Un nom DIFFÉRENT reste un vrai conflit.
      const { data: memeNumero } = await supabase.from('dossiers').select('*').eq('numero_dossier', numero_dossier).maybeSingle();
      if (memeNumero && memePatient(memeNumero, nom)) {
        if (req.body.reunir !== true) {
          return res.status(409).json({
            error: 'PATIENT_DEJA_ENREGISTRE',
            message: `Le dossier N° ${numero_dossier} existe déjà au nom de « ${memeNumero.nom} ». Est-ce la même personne ?`,
            dossierExistant: { id: memeNumero.id, numero_dossier: memeNumero.numero_dossier, nom: memeNumero.nom, date_naissance: memeNumero.date_naissance || null, telephone: memeNumero.telephone || null },
          });
        }
        // Trace (best-effort, comme partout : un journal qui refuse la ligne ne doit pas bloquer la caisse) — la direction
        // voit chaque fois que deux enregistrements ont été réunis ET par qui la réunion a été confirmée.
        try {
          const { error: erreurAudit } = await supabase.from('audit_log').insert({
            id: crypto.randomUUID(), action: 'dossier_deja_enregistre',
            effectue_par: (req.user && (req.user.email || req.user.id)) || null, effectue_par_uid: (req.user && req.user.id) || null,
            details: { numero_dossier, nom_recu: nomSaisi, nom_existant: memeNumero.nom, dossier_id: memeNumero.id, confirme: true },
            date: new Date().toISOString(),
          });
          if (erreurAudit) console.warn('Audit « dossier déjà enregistré » non enregistré :', erreurAudit.message);
        } catch (e) { console.warn('Audit « dossier déjà enregistré » non enregistré :', e.message); }
        return res.status(200).json({ ...memeNumero, dejaEnregistre: true });
      }
      return res.status(409).json({ error: `Le numéro de dossier "${numero_dossier}" est déjà utilisé par un autre patient${memeNumero && memeNumero.nom ? ` (« ${memeNumero.nom} »)` : ''}.` });
    }
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

// Fiche patient — infos de base (nom, tél, adresse, date de naissance), pour affichage/préremplissage.
app.get('/api/dossiers/:id', async (req, res) => {
  // 21/10 : même correctif (voir /api/dossiers/recherche juste au-dessus).
  if (!(await aPermission(req.user.id, 'fiche_patient_voir'))) return res.status(403).json({ error: "Permission 'fiche_patient_voir' requise." });
  const { data, error } = await supabase.from('dossiers').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Dossier introuvable' });
  // 14/10 : la mère d'un nouveau-né, ses enfants, et — si ce dossier a été fusionné — le dossier final. Tout est facultatif : une base pas encore
  // migrée (colonnes absentes) renvoie simplement le dossier comme avant.
  const resume = 'id, numero_dossier, nom, nom_origine, date_naissance, sexe';
  try {
    if (data.mere_dossier_id) {
      const { data: mere } = await supabase.from('dossiers').select(resume).eq('id', data.mere_dossier_id).maybeSingle();
      if (mere) data.mere = mere;
    }
    const { data: enfants } = await supabase.from('dossiers').select(resume).eq('mere_dossier_id', data.id).is('fusionne_dans', null).order('date_naissance', { ascending: false });
    if (enfants && enfants.length) data.enfants = enfants;
    if (data.fusionne_dans) {
      const { data: final } = await supabase.from('dossiers').select(resume).eq('id', data.fusionne_dans).maybeSingle();
      if (final) data.fusionne_dans_dossier = final;
    }
  } catch (e) { /* liaisons facultatives */ }
  res.json(data);
});

// Modifier les infos de base d'un patient (ex : nouveau numéro de téléphone) — n'importe qui de
// connecté peut le faire (comme la création), pas une action sensible comme l'annulation d'un paiement.
// Retour d'Esdras (29/08) : poids et conjoint ajoutés aux données personnelles, et un endroit pour
// corriger le numéro de dossier "au cas où" (ex. faute de frappe à la création) — poids/conjoint
// (nouvelles colonnes, voir sql/ajoute_poids_conjoint_dossiers.sql) toujours acceptés tels quels
// (pas de contrainte d'unicité), numero_dossier réutilise le même traitement du conflit 23505 que
// POST /api/dossiers ci-dessus (déjà utilisé par un AUTRE patient).
// Retour d'Esdras (02/09) : sexe ajouté pour le rapport MSPP (répartition homme/femme des examens,
// voir components/RapportCHF.js) — contrairement à poids/conjoint, validé ICI en plus de la
// contrainte CHECK côté base (sql/ajoute_sexe_dossiers.sql) : c'est la seule colonne de cette
// table dont la valeur EXACTE alimente un calcul plutôt qu'un simple affichage, et un rejet 400
// clair vaut mieux que l'erreur Postgres brute d'une contrainte violée remontant telle quelle.
app.put('/api/dossiers/:id', async (req, res) => {
  // 16/10 (Esdras) : le caissier modifie un dossier depuis Facturation, sans passer par Dossier/Épisode ni Fiche Patient → la caisse (caisse_travailler) peut aussi.
  if (!(await aPermission(req.user.id, 'fiche_patient_modifier')) && !(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'fiche_patient_modifier' ou 'caisse_travailler' requise." });
  }
  const { nom: nomSaisi, date_naissance, telephone, adresse, poids, conjoint: conjointSaisi, sexe, numero_dossier, mere_dossier_id } = req.body;
  if (!nomSaisi || !String(nomSaisi).trim()) return res.status(400).json({ error: 'Le nom est requis' });
  // Même correctif que POST /api/dossiers ci-dessus (faille d'audit du 21/10).
  if (typeof nomSaisi === 'string' && nomSaisi.length > 200) return res.status(400).json({ error: 'Le nom est trop long (200 caractères au plus).' });
  if (typeof adresse === 'string' && adresse.length > 300) return res.status(400).json({ error: "L'adresse est trop longue (300 caractères au plus)." });
  if (typeof telephone === 'string' && telephone.length > 40) return res.status(400).json({ error: 'Le téléphone est trop long (40 caractères au plus).' });
  if (typeof conjointSaisi === 'string' && conjointSaisi.length > 200) return res.status(400).json({ error: 'Le nom du conjoint est trop long (200 caractères au plus).' });
  const nom = formaterNomPropre(nomSaisi); // majuscule au début de chaque mot (14/10)
  const conjoint = typeof conjointSaisi === 'string' ? formaterNomPropre(conjointSaisi) : conjointSaisi;
  if (sexe !== undefined && sexe !== null && sexe !== 'M' && sexe !== 'F') {
    return res.status(400).json({ error: "Sexe invalide : 'M', 'F' ou vide." });
  }
  const maj = { nom, date_naissance: dateOuNull(date_naissance), telephone, adresse, poids: poids || null, conjoint, sexe: sexe || null };
  // 16/10 (Esdras) : seule la caisse donne ou change un numéro de dossier. L'écran de modification renvoie le numéro tel quel : un numéro INCHANGÉ passe pour tout le
  // monde (l'infirmier corrige un téléphone sans que le numéro bloque) ; un numéro DIFFÉRENT exige la caisse. Voir aussi POST /api/dossiers/:id/numero.
  if (numero_dossier !== undefined) {
    if (!String(numero_dossier).trim()) return res.status(400).json({ error: 'Le numéro de dossier est requis' });
    const { data: actuel } = await supabase.from('dossiers').select('numero_dossier').eq('id', req.params.id).maybeSingle();
    if (!actuel || String(actuel.numero_dossier) !== String(numero_dossier).trim()) {
      if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
        return res.status(403).json({ error: "Seule la caisse peut donner ou changer un numéro de dossier.", code: 'NUMERO_RESERVE_CAISSE' });
      }
      const erreurNumero = erreurNumeroDossier(numero_dossier);
      if (erreurNumero) return res.status(400).json({ error: erreurNumero });
      maj.numero_dossier = String(numero_dossier).trim();
    }
  }
  // 14/10 : nouveau nom du bébé — chaque nom quitté est gardé (anciens_noms), le nom de création reste intact. Lien vers la mère : absent du corps =
  // inchangé ; null ou vide = lien retiré ; sinon vérifié comme à la création.
  const avecNaissance = {};
  const { data: avant, error: erreurLecture } = await supabase.from('dossiers').select('nom, anciens_noms, sexe, date_naissance').eq('id', req.params.id).maybeSingle();
  // 15/10 : une fois connus, le sexe et la date de naissance ne peuvent plus être EFFACÉS (seulement corrigés) — sinon le dossier redevient incomplet.
  if (!erreurLecture && avant) {
    if (avant.sexe && !sexe) return res.status(400).json({ error: "Le sexe est déjà enregistré : tu peux le corriger, pas l'effacer." });
    if (avant.date_naissance && !date_naissance) return res.status(400).json({ error: "La date de naissance est déjà enregistrée : tu peux la corriger, pas l'effacer." });
  }
  if (!erreurLecture && avant) {
    const liste = anciensNomsApresRenommage(avant, nom, (req.user && (req.user.email || req.user.id)) || null, new Date().toISOString());
    if (liste) avecNaissance.anciens_noms = liste;
  }
  if (mere_dossier_id !== undefined) {
    if (mere_dossier_id === null || mere_dossier_id === '') avecNaissance.mere_dossier_id = null;
    else {
      const verif = await verifierMere(supabase, mere_dossier_id, req.params.id);
      if (!verif.ok) return res.status(verif.status).json({ error: verif.erreur });
      avecNaissance.mere_dossier_id = mere_dossier_id;
    }
  }
  let { data, error } = await supabase.from('dossiers').update({ ...maj, ...avecNaissance }).eq('id', req.params.id).select();
  if (error && error.code === '42703' && Object.keys(avecNaissance).length > 0) {
    // Base pas encore migrée : on enregistre le reste, mais on ne fait PAS semblant d'avoir gardé le lien à la mère.
    if (avecNaissance.mere_dossier_id !== undefined) return res.status(503).json({ error: "Le script sql/dossiers_naissance_fusion.sql n'est pas encore collé dans Supabase : le lien bébé → mère n'est pas disponible." });
    ({ data, error } = await supabase.from('dossiers').update(maj).eq('id', req.params.id).select());
  }
  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: `Le numéro de dossier "${numero_dossier}" est déjà utilisé par un autre patient.` });
    }
    return res.status(500).json({ error: error.message });
  }
  if (!data || data.length === 0) return res.status(404).json({ error: "Dossier introuvable — rien n'a été modifié." });
  res.json(data[0]);
});

// Historique complet d'un patient : TOUS ses épisodes (pas seulement les ouverts, contrairement à
// episodes-ouverts ci-dessous), chacun avec son dernier paiement connu pour déduire le statut
// (payé / solde restant / jamais facturé) sans recalculer côté serveur — le front décide de l'affichage.
app.get('/api/dossiers/:id/historique', async (req, res) => {
  const { data: episodes, error } = await supabase
    .from('episodes').select('*').eq('dossier_id', req.params.id).is('supprime_le', null).order('date_ouverture', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  // Retour d'Esdras (26/08) : "les infirmiers et archivistes vont avoir accès à Fiche Patient, ils
  // ne peuvent pas voir si le patient a un solde ou statut de paiement" — vérifié UNE fois pour
  // tout le dossier, pas par épisode (même utilisateur, même permission). Filtré ici (pas
  // seulement côté client, FichePatient.js) : une donnée financière ne doit jamais transiter vers
  // un navigateur qui n'a pas le droit de la voir, même consultable via l'onglet réseau.
  const peutVoirFinances = await aPermission(req.user.id, 'fiche_patient_voir_finances');
  const enrichis = await Promise.all((episodes || []).map(async (ep) => {
    // Audit financier (24/08) : un paiement ANNULÉ (fraude/erreur corrigée par la direction) ne
    // doit jamais être pris pour le "dernier paiement" — sinon le statut affiché (payé/solde
    // restant) et le plafond de remboursement de crédit se basent sur une transaction qui n'existe
    // plus. .or(...) plutôt que .eq('annule', false) : les paiements d'avant cette fonctionnalité
    // ont annule=NULL, qu'une simple égalité à false exclurait à tort.
    // Récupère tout l'historique (pas juste le dernier, comme avant) : nécessaire pour calculer
    // aussi soldeDepot (retour d'Esdras 26/08, voir calculerSoldeDepot ci-dessus) — affiché sur
    // Fiche Patient (très consulté par l'archiviste).
    const { data: paiements } = await supabase
      .from('paiements').select('*').eq('episode_id', ep.id)
      .or('annule.eq.false,annule.is.null').is('supprime_le', null)
      .order('date_paiement', { ascending: false });
    // Intervention (accouchement/césarienne/chirurgie) : jamais une donnée financière, toujours
    // incluse même sans fiche_patient_voir_finances — voir extraireIntervention ci-dessus.
    const { data: fiches } = await supabase.from('fiches').select('raw_state, date_creation').eq('episode_id', ep.id).is('supprime_le', null);
    const intervention = extraireIntervention(fiches);
    const fichesDetail = extraireFichesDetail(fiches);
    if (!peutVoirFinances) return { ...ep, dernierPaiement: null, intervention, fichesDetail };
    return { ...ep, dernierPaiement: (paiements && paiements[0]) || null, intervention, fichesDetail, ...calculerSoldeDepot(paiements) };
  }));
  res.json(enrichis);
});

// ============================================================
// PIÈCES JOINTES — retour d'Esdras (23/08) : pouvoir attacher un document à un dossier,
// en priorité les fiches de référence envoyées par un ONG partenaire (pas un dossier clinique
// complet, juste éviter qu'un papier important se perde). Stockage Supabase Storage (bucket
// dédié, privé), métadonnées dans la table pieces_jointes — même principe que les sauvegardes
// automatiques plus bas dans ce fichier.
// ============================================================
const BUCKET_PIECES_JOINTES = 'pieces-jointes-dossiers';

async function assurerBucketPiecesJointes() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`Liste des buckets : ${error.message}`);
  if (!buckets.some(b => b.name === BUCKET_PIECES_JOINTES)) {
    const { error: erreurCreation } = await supabase.storage.createBucket(BUCKET_PIECES_JOINTES, { public: false });
    if (erreurCreation) throw new Error(`Création du bucket : ${erreurCreation.message}`);
  }
}

app.get('/api/dossiers/:id/pieces-jointes', async (req, res) => {
  const { data, error } = await supabase
    .from('pieces_jointes').select('*').eq('dossier_id', req.params.id).is('supprime_le', null).order('date_ajout', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// contenu_base64 (pas de multipart/form-data) : réutilise express.json() déjà en place
// (limite 10mb), pas besoin d'une dépendance d'upload de fichiers séparée pour ce volume
// (photo d'un document, PDF scanné) — largement suffisant pour une fiche de référence ONG.
app.post('/api/dossiers/:id/pieces-jointes', async (req, res) => {
  if (!(await aPermission(req.user.id, 'fiche_patient_modifier'))) {
    return res.status(403).json({ error: "Permission 'fiche_patient_modifier' requise." });
  }
  const { nom_original, type_document, contenu_base64, content_type } = req.body;
  if (!nom_original || !contenu_base64) {
    return res.status(400).json({ error: 'nom_original et contenu_base64 sont requis.' });
  }
  try {
    await assurerBucketPiecesJointes();
    const buffer = Buffer.from(contenu_base64, 'base64');
    // Horodatage dans le chemin : 2 documents du même nom sur le même dossier ne s'écrasent
    // jamais l'un l'autre (contrairement aux sauvegardes, où upsert écrase volontairement).
    const cheminStockage = `${req.params.id}/${Date.now()}-${nom_original}`;
    const { error: erreurUpload } = await supabase.storage
      .from(BUCKET_PIECES_JOINTES)
      .upload(cheminStockage, buffer, { contentType: content_type || 'application/octet-stream' });
    if (erreurUpload) return res.status(500).json({ error: `Envoi vers Storage : ${erreurUpload.message}` });

    const { data, error } = await supabase.from('pieces_jointes').insert({
      dossier_id: req.params.id, storage_path: cheminStockage, nom_original,
      type_document: type_document || null, taille_octets: buffer.length,
      ajoute_par: req.body.ajoute_par || null, ajoute_par_uid: req.user.id,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lien signé temporaire (1h) plutôt que de faire transiter les octets du fichier par ce serveur —
// le navigateur télécharge directement depuis Supabase Storage.
app.get('/api/dossiers/:id/pieces-jointes/:fichierId/lien', async (req, res) => {
  // Faille d'audit du 21/10 : contrairement à la LISTE des pièces jointes (volontairement ouverte, comme GET /api/dossiers/:id — voir le test juste au-dessus),
  // CE lien donne un accès réel au FICHIER (souvent une pièce d'identité) : un compte authentifié quelconque pouvait en obtenir un (lien signé, 1h) pour n'importe quel dossier.
  if (!(await aPermission(req.user.id, 'fiche_patient_voir'))) return res.status(403).json({ error: "Permission 'fiche_patient_voir' requise." });
  const { data: piece, error: erreurPiece } = await supabase
    .from('pieces_jointes').select('storage_path, nom_original').eq('id', req.params.fichierId).eq('dossier_id', req.params.id).maybeSingle();
  if (erreurPiece) return res.status(500).json({ error: erreurPiece.message });
  if (!piece) return res.status(404).json({ error: 'Pièce jointe introuvable.' });
  const { data, error } = await supabase.storage.from(BUCKET_PIECES_JOINTES).createSignedUrl(piece.storage_path, 3600);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ lien: data.signedUrl, nomOriginal: piece.nom_original });
});

app.delete('/api/dossiers/:id/pieces-jointes/:fichierId', async (req, res) => {
  if (!(await aPermission(req.user.id, 'fiche_patient_modifier'))) {
    return res.status(403).json({ error: "Permission 'fiche_patient_modifier' requise." });
  }
  const { data: piece, error: erreurPiece } = await supabase
    .from('pieces_jointes').select('storage_path').eq('id', req.params.fichierId).eq('dossier_id', req.params.id).maybeSingle();
  if (erreurPiece) return res.status(500).json({ error: erreurPiece.message });
  if (!piece) return res.status(404).json({ error: 'Pièce jointe introuvable.' });
  // Corbeille 30 jours (phase 2) — le VRAI fichier dans Storage n'est PLUS supprimé ici : une
  // ligne restaurée pointant vers un fichier déjà effacé serait inutile. Le fichier n'est retiré
  // de Storage qu'à la purge définitive après 30 jours (purgerCorbeilleDossiers ci-dessous), en
  // même temps que la ligne.
  const { data: pieceMaj, error } = await supabase.from('pieces_jointes').update({ supprime_le: new Date().toISOString() }).eq('id', req.params.fichierId).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!pieceMaj || pieceMaj.length === 0) return res.status(404).json({ error: 'Pièce jointe introuvable.' });
  res.json({ success: true });
});

// Restauration d'une pièce jointe mise à la corbeille — le fichier physique n'a jamais quitté
// Storage (voir ci-dessus), donc rien à refaire que d'annuler la marque.
app.post('/api/dossiers/:id/pieces-jointes/:fichierId/restaurer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'fiche_patient_modifier'))) {
    return res.status(403).json({ error: "Permission 'fiche_patient_modifier' requise." });
  }
  const { data: piece, error: erreurPiece } = await supabase
    .from('pieces_jointes').select('supprime_le').eq('id', req.params.fichierId).eq('dossier_id', req.params.id).maybeSingle();
  if (erreurPiece) return res.status(500).json({ error: erreurPiece.message });
  if (!piece) return res.status(404).json({ error: 'Pièce jointe introuvable.' });
  if (!piece.supprime_le) return res.status(400).json({ error: "Cette pièce jointe n'est pas à la corbeille." });
  const { data: pieceRestauree, error } = await supabase.from('pieces_jointes').update({ supprime_le: null }).eq('id', req.params.fichierId).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!pieceRestauree || pieceRestauree.length === 0) return res.status(404).json({ error: 'Pièce jointe introuvable.' });
  res.json({ success: true });
});

// Épisodes ouverts d'un dossier — la question centrale du flux anti-doublon
app.get('/api/dossiers/:id/episodes-ouverts', async (req, res) => {
  // 21/10 : même correctif.
  if (!(await aPermission(req.user.id, 'fiche_patient_voir'))) return res.status(403).json({ error: "Permission 'fiche_patient_voir' requise." });
  const { data, error } = await supabase
    .from('episodes').select('*').eq('dossier_id', req.params.id).eq('statut', 'ouvert').is('supprime_le', null);
  if (error) return res.status(500).json({ error: error.message });
  // 15/10 : chaque épisode ouvert dit ce qu'il contient déjà (contenu.examens / contenu.medicaments) pour savoir dès le départ s'il faut le continuer.
  // Champ AJOUTÉ : un ancien écran l'ignore. Si les fiches ne sont pas lisibles, on renvoie les épisodes tels quels plutôt que d'échouer.
  const episodes = data || [];
  if (episodes.length === 0) return res.json(episodes);
  const { data: fiches, error: erreurFiches } = await supabase
    .from('fiches').select('episode_id, breakdown, raw_state, supprime_le').in('episode_id', episodes.map(e => e.id));
  if (erreurFiches) return res.json(episodes);
  res.json(episodes.map(e => ({ ...e, contenu: contenuDesFiches((fiches || []).filter(f => f.episode_id === e.id)) })));
});

// Solde du dossier = somme des soldes_restants de ses épisodes (dernier paiement non annulé)
// Audit du 28/09 avant la mise en production : donnée financière servie SANS contrôle, alors que
// /historique et /solde-depot exigent 'fiche_patient_voir_finances' (même logique que l'audit du
// 31/08 ci-dessus) — aligné. Et les épisodes/paiements mis à la corbeille (supprime_le) étaient
// comptés dans le solde : exclus, comme partout ailleurs depuis le 25/09.
app.get('/api/dossiers/:id/solde', async (req, res) => {
  if (!(await aPermission(req.user.id, 'fiche_patient_voir_finances'))) {
    return res.status(403).json({ error: "Permission 'fiche_patient_voir_finances' requise." });
  }
  const dossierId = req.params.id;

  // Récupérer tous les épisodes du dossier
  const { data: episodes, error: errEpisodes } = await supabase
    .from('episodes').select('id').eq('dossier_id', dossierId).is('supprime_le', null);
  if (errEpisodes) return res.status(500).json({ error: errEpisodes.message });

  if (!episodes || episodes.length === 0) {
    return res.json({ solde_total: 0, episodes_count: 0, detailParEpisode: [] });
  }

  // Une seule lecture groupée (lireParLotsDIds) au lieu d'une requête par épisode : un patient
  // chronique avec 30 épisodes coûtait 31 allers-retours vers la base. Même règle qu'avant : le
  // DERNIER paiement non annulé et non mis à la corbeille de chaque épisode fait foi.
  let paiements;
  try {
    paiements = await lireParLotsDIds(episodes.map(ep => ep.id), (lot) => supabase
      .from('paiements')
      .select('episode_id, solde_restant, date_paiement')
      .in('episode_id', lot)
      .or('annule.eq.false,annule.is.null')
      .is('supprime_le', null)
      .order('date_paiement', { ascending: false }));
  } catch (errPaiement) {
    return res.status(500).json({ error: errPaiement.message });
  }
  const dernierParEpisode = new Map();
  for (const p of paiements) {
    const actuel = dernierParEpisode.get(p.episode_id);
    if (!actuel || new Date(p.date_paiement) > new Date(actuel.date_paiement)) dernierParEpisode.set(p.episode_id, p);
  }

  let soldeTotal = 0;
  const detailParEpisode = [];
  for (const ep of episodes) {
    const paiement = dernierParEpisode.get(ep.id);
    const solde = (paiement && paiement.solde_restant) || 0;
    soldeTotal += solde;
    detailParEpisode.push({ episode_id: ep.id, solde });
  }

  res.json({
    solde_total: soldeTotal,
    episodes_count: episodes.length,
    detailParEpisode: detailParEpisode
  });
});

// Création d'un épisode — règle anti-doublon appliquée ICI, pas seulement à l'écran.
// ⚠️ Chemin distinct de POST /api/episodes (route de compatibilité plus haut) : les deux routes
// ne peuvent pas partager le même chemin+méthode, sinon Express n'exécute jamais que la première
// enregistrée — ce qui désactivait silencieusement tout ce bloc (anti-doublon ET blocage
// hospitalisation) et faisait créer un dossier en double par l'écran "🔍 Dossier/Épisode" au lieu
// de rattacher l'épisode au dossier existant. Voir api/apiDossierEpisode.js (creerEpisode) côté front.
app.post('/api/dossiers/:dossierId/episodes', async (req, res) => {
  // Infirmier/archiviste peuvent créer un Dossier (route ci-dessus) mais pas déclencher un
  // Épisode (Consultation/Hospitalisation) — vérifié ici aussi, pas seulement côté écran, sinon
  // un appel direct à cette route contournerait la restriction affichée dans l'app.
  if (!(await aPermission(req.user.id, 'episode_creer'))) {
    return res.status(403).json({ error: "Permission 'episode_creer' requise — ce rôle peut créer un dossier, mais pas un épisode." });
  }
  const dossier_id = req.params.dossierId;
  const { voie_entree, service, type_consultation, type_patient, ong_partenaire, est_hospitalisation, forcerMalgreAvertissement, local_id } = req.body;
  const erreurValidation = validerCreationEpisode({ dossier_id, voie_entree, service, type_consultation, type_patient });
  if (erreurValidation) return res.status(400).json({ error: erreurValidation });

  // Idempotence : mêmes principes que /api/fiches et /api/paiements — nécessaire maintenant que
  // apiDossierEpisode passe par la file d'attente hors-ligne. Vérifiée AVANT la règle de blocage
  // hospitalisation ci-dessous : si c'est une vraie répétition de la même tentative (déjà créée),
  // il faut renvoyer cet épisode, pas le comparer à lui-même et le bloquer par erreur.
  if (local_id) {
    const { data: existant } = await supabase.from('episodes').select('*').eq('local_id', local_id).maybeSingle();
    if (existant) return res.status(200).json(existant);
  }

  // .is('supprime_le', null) (25/09, audit avant mise en production) : un épisode mis à la corbeille
  // (hospitalisation créée par erreur, puis supprimée) restait compté comme "ouvert" — le patient
  // ne pouvait alors plus JAMAIS être hospitalisé (BLOCAGE_HOSPITALISATION, sans contournement
  // possible) tant que la purge à 30 jours ne l'avait pas fait disparaître.
  const { data: episodesOuverts, error: erreurRecherche } = await supabase
    .from('episodes').select('*').eq('dossier_id', dossier_id).eq('statut', 'ouvert').is('supprime_le', null);
  if (erreurRecherche) return res.status(500).json({ error: erreurRecherche.message });

  let derogationEpisodeAAuditer = null;
  const episodeHospitalisationOuvert = (episodesOuverts || []).find(e => e.est_hospitalisation === true);

  // Règle stricte : un patient hospitalisé ne peut JAMAIS avoir une 2e hospitalisation ouverte en
  // même temps. Aucun moyen de passer outre, même avec forcerMalgreAvertissement. Une consultation
  // reste en revanche autorisée pendant une hospitalisation en cours (ex: un patient hospitalisé
  // qui a besoin d'une consultation spécialisée ailleurs) — avant, N'IMPORTE QUEL nouvel épisode
  // (même une simple consultation) était bloqué dès qu'une hospitalisation était ouverte, retour
  // d'Esdras. Seul le cumul de 2 hospitalisations est bloqué en dur.
  if (episodeHospitalisationOuvert && est_hospitalisation) {
    return res.status(409).json({
      error: 'BLOCAGE_HOSPITALISATION',
      message: "Ce patient a déjà un épisode hospitalisation ouvert — impossible d'en ouvrir un 2e.",
      episodeExistant: episodeHospitalisationOuvert,
    });
  }

  // 19/10 (Esdras) : UN SEUL épisode ouvert à la fois. Si le patient voit un autre docteur, on ajoute une fiche dans l'épisode déjà ouvert ; s'il est retenu, on utilise « Hospitaliser »
  // (la consultation se ferme, l'hospitalisation s'ouvre, dettes et dépôts suivent). Exception : droit « episode_ouvert_derogation » (direction) + motif écrit, tracée au journal.
  // L'ancien « confirmer malgré l'avertissement » ne suffit plus.
  if (episodesOuverts.length > 0) {
    const derogation = req.body.derogation_episode;
    const autorise = motifDerogationValide(derogation) && await aPermission(req.user.id, 'episode_ouvert_derogation');
    if (!autorise) {
      return res.status(409).json({
        error: 'EPISODE_DEJA_OUVERT',
        message: "Ce patient a déjà un épisode ouvert : continuez cet épisode (ajoutez une fiche), ou utilisez « Hospitaliser » s'il est retenu. Un seul épisode ouvert à la fois ; seule la direction peut autoriser une exception, avec un motif.",
        episodesExistants: episodesOuverts,
      });
    }
    derogationEpisodeAAuditer = { dossier_id, motif: derogation.motif.trim(), episodes_ouverts: episodesOuverts.map(e => e.id) };
  }

  // 16/10 (Esdras) : le numéro de dossier se donne AUTOMATIQUEMENT dès la création du premier épisode (numero_automatique) — ou, si la personne a déjà un numéro, la caisse le tape
  // (numero_dossier). Seule la caisse : un autre rôle qui enverrait un numéro est refusé, et une demande automatique d'un autre rôle est simplement ignorée (le dossier reste « en attente »).
  // Fait AVANT l'insertion : un numéro tapé déjà pris renvoie 409 et aucun épisode n'est créé.
  let numeroDonne = null, marqueExamens = null;
  const numeroTape = req.body.numero_dossier !== undefined && req.body.numero_dossier !== null && String(req.body.numero_dossier).trim() !== '';
  // « Examens seulement » : un patient envoyé par un partenaire (ex. AVSI) pour des examens ne reçoit PAS de numéro de dossier, mais figure dans les lots du partenaire.
  // Réservé à la caisse et aux épisodes PARTENAIRE ; incompatible avec un numéro (tapé ou automatique).
  if (req.body.examens_seulement === true) {
    if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
      return res.status(403).json({ error: "Seule la caisse peut enregistrer un patient « examens seulement » (sans numéro de dossier).", code: 'NUMERO_RESERVE_CAISSE' });
    }
    if (type_patient !== 'partenaire' && type_patient !== 'ONG') {
      return res.status(400).json({ error: "« Examens seulement » (sans numéro de dossier) ne concerne que les patients envoyés par un partenaire.", code: 'EXAMENS_PARTENAIRE_SEULEMENT' });
    }
    if (numeroTape || req.body.numero_automatique === true) {
      return res.status(400).json({ error: "« Examens seulement » et numéro de dossier s'excluent : choisis l'un ou l'autre.", code: 'EXAMENS_ET_NUMERO' });
    }
    marqueExamens = await marquerExamensSeulement({ supabase, dossierId: dossier_id });
    if (marqueExamens && !marqueExamens.inchange) {
      await enregistrerAuditServeur(req, 'dossier_sans_numero_examens', { dossier_id, ancien_numero: marqueExamens.ancien, nouveau_numero: marqueExamens.numero });
    }
  } else if (numeroTape || req.body.numero_automatique === true) {
    const caisse = await aPermission(req.user.id, 'caisse_travailler');
    if (!caisse && numeroTape) {
      return res.status(403).json({ error: "Seule la caisse peut donner un numéro de dossier.", code: 'NUMERO_RESERVE_CAISSE' });
    }
    if (caisse) {
      try {
        numeroDonne = await donnerNumeroAuPremierEpisode({ supabase, dossierId: dossier_id, numeroSaisi: numeroTape ? req.body.numero_dossier : null, automatique: req.body.numero_automatique === true });
      } catch (e) {
        return res.status(e.statut || 500).json({ error: e.message, code: e.code });
      }
      if (numeroDonne && numeroDonne.ancien !== undefined && numeroDonne.numero !== numeroDonne.ancien) {
        await enregistrerAuditServeur(req, 'numero_dossier_donne', { dossier_id, ancien_numero: numeroDonne.ancien, nouveau_numero: numeroDonne.numero, automatique: numeroDonne.automatique, a_la_creation_de_l_episode: true });
      }
    }
  }

  const { data, error } = await supabase
    .from('episodes')
    .insert({ dossier_id, voie_entree, service: service || null, type_consultation: type_consultation || null, type_patient, ong_partenaire: ong_partenaire || null, est_hospitalisation: !!est_hospitalisation, local_id: local_id || null })
    .select().single();
  if (error) {
    if (error.code === '23505' && local_id) {
      const { data: existant } = await supabase.from('episodes').select('*').eq('local_id', local_id).maybeSingle();
      if (existant) return res.status(200).json(existant);
    }
    return res.status(500).json({ error: error.message });
  }
  if (derogationEpisodeAAuditer) enregistrerAuditServeur(req, 'derogation_episode_ouvert', { ...derogationEpisodeAAuditer, nouvel_episode: data.id });
  res.status(201).json({ ...data, ...(numeroDonne ? { numero_dossier_donne: numeroDonne.numero } : {}), ...(marqueExamens ? { numero_dossier_examens: marqueExamens.numero } : {}) });
});

// Ancienne bascule « est_hospitalisation » sur place (même épisode) : remplacée le 19/10 par POST /api/episodes/:id/hospitaliser-nouvel-episode (nouvel épisode lié, transfert des soldes).
// Aucun écran ne l'utilisait ; elle est refusée pour qu'on ne fabrique jamais une hospitalisation qui mélange la consultation payée et le séjour.
app.patch('/api/episodes/:id/hospitaliser', (req, res) => {
  res.status(410).json({ error: "Cette route n'existe plus : utilisez « Hospitaliser » (nouvel épisode lié) — POST /api/episodes/:id/hospitaliser-nouvel-episode." });
});

// 19/10 (Esdras) : « Hospitaliser » — la consultation ouverte est fermée et une hospitalisation s'ouvre dans un nouvel épisode lié ; dépôt et crédit (dette) restants passent au nouvel épisode.
// Voir utils/hospitalisation.js. Même droit que créer un épisode (le bouton est sur la liste des épisodes ouverts de Dossier/Épisode).
app.post('/api/episodes/:id/hospitaliser-nouvel-episode', async (req, res) => {
  if (!(await aPermission(req.user.id, 'episode_creer'))) {
    return res.status(403).json({ error: "Permission 'episode_creer' requise pour hospitaliser un patient." });
  }
  try {
    const r = await hospitaliserEpisode({ supabase, episodeId: req.params.id, service: req.body && req.body.service, typeLit: req.body && req.body.type_lit, utilisateur: req.user, calculerSoldeDepot });
    enregistrerAuditServeur(req, 'consultation_vers_hospitalisation', { consultation: req.params.id, hospitalisation: r.nouvelEpisode.id, dossier_id: r.nouvelEpisode.dossier_id, service: r.nouvelEpisode.service, type_lit: r.nouvelEpisode.type_lit, depot_transfere: r.transfere.depot, dette_transferee: r.transfere.dette });
    res.status(201).json({ nouvelEpisode: await episodeVersFlat(r.nouvelEpisode), nouvelEpisodeBrut: r.nouvelEpisode, consultationFermee: r.consultationFermee, transfere: r.transfere });
  } catch (e) {
    res.status(e.statut || 500).json({ error: e.message, code: e.code });
  }
});

// Fermeture d'un épisode (exeat normal ou sans autorisation — même mécanisme, motif différent)
app.patch('/api/episodes/:id/fermer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { motif_fermeture } = req.body;
  const { data, error } = await supabase
    .from('episodes')
    .update({ statut: 'ferme', motif_fermeture, date_fermeture: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Badge ⏳ — uniquement pertinent quand la résolution déborde sur un autre jour
app.patch('/api/episodes/:id/attente-resultats', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { en_attente } = req.body;
  const { data, error } = await supabase
    .from('episodes').update({ en_attente_resultats: !!en_attente }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Transfert d'un patient hospitalisé vers un autre service (retour d'Esdras du 23/08) — ex.
// Maternité -> Néonatologie. Rien ne traçait ça avant : chaque service voyait juste "son"
// épisode séparément, sans lien formel. Change episode.service ET garde une trace (table
// transferts_service) — motif, qui, quand, ancien/nouveau service.
app.patch('/api/episodes/:id/transferer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { nouveau_service, motif, transfere_par, service_attendu } = req.body;
  if (!nouveau_service || !String(nouveau_service).trim()) {
    return res.status(400).json({ error: 'nouveau_service est requis.' });
  }
  const { data: episode, error: erreurLecture } = await supabase
    .from('episodes').select('service, est_hospitalisation, statut').eq('id', req.params.id).single();
  if (erreurLecture) return res.status(404).json({ error: 'Épisode introuvable' });
  if (!episode.est_hospitalisation) return res.status(400).json({ error: 'Seul un épisode en hospitalisation peut être transféré entre services.' });
  if (episode.statut !== 'ouvert') return res.status(400).json({ error: 'Épisode déjà fermé — impossible de le transférer.' });

  // Détection de conflit (retour d'Esdras du 23/08, chantier de robustesse hors ligne, item 8) —
  // même principe que /lit ci-dessous : service_attendu = le service que le poste appelant
  // voyait pour ce patient avant de préparer ce transfert. Si cette requête a attendu en file
  // hors ligne et que quelqu'un d'autre a déjà transféré ce même patient entre-temps (en ligne),
  // appliquer quand même écraserait ce transfert sans prévenir personne.
  if (service_attendu !== undefined && episode.service !== service_attendu) {
    return res.status(409).json({
      error: `Conflit : le service de ce patient a été changé entre-temps par quelqu'un d'autre (actuellement "${episode.service}", tu voyais "${service_attendu}"). Recharge la page pour voir l'état actuel avant de réessayer.`
    });
  }

  // Le lit assigné (retour d'Esdras du 23/08) appartient à l'ANCIEN service — il faut le vider,
  // sinon le patient "occupe" encore un lit d'un service où il n'est plus, et ce lit reste
  // faussement indisponible pour un autre patient.
  const { data, error } = await supabase
    .from('episodes').update({ service: nouveau_service.trim(), lit: null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  const { error: erreurTrace } = await supabase.from('transferts_service').insert({
    episode_id: req.params.id, ancien_service: episode.service, nouveau_service: nouveau_service.trim(),
    motif: motif || null, transfere_par: transfere_par || null, transfere_par_uid: req.user.id,
  });
  if (erreurTrace) console.error('Transfert effectué mais non tracé (transferts_service) :', erreurTrace.message);

  res.json(data);
});

app.get('/api/episodes/:id/transferts', async (req, res) => {
  const { data, error } = await supabase
    .from('transferts_service').select('*').eq('episode_id', req.params.id).order('date_transfert', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Assignation d'un lit nommé (retour d'Esdras du 23/08) — "on sait 12 patients hospitalisés à
// Maternité" mais pas "Lit 3 occupé, Lit 4 libre". lit=null libère le lit (retour, sortie...).
// Refuse d'assigner un lit déjà pris par un AUTRE épisode ouvert du même service — un lit
// physique ne peut pas avoir 2 patients en même temps.
app.patch('/api/episodes/:id/lit', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { lit, lit_attendu } = req.body;
  const { data: episode, error: erreurLecture } = await supabase
    .from('episodes').select('service, est_hospitalisation, statut, lit').eq('id', req.params.id).single();
  if (erreurLecture) return res.status(404).json({ error: 'Épisode introuvable' });
  if (!episode.est_hospitalisation) return res.status(400).json({ error: "Seul un épisode en hospitalisation peut avoir un lit assigné." });
  if (episode.statut !== 'ouvert') return res.status(400).json({ error: 'Épisode déjà fermé.' });

  // Détection de conflit (retour d'Esdras du 23/08, chantier de robustesse hors ligne, item 8) —
  // lit_attendu = le lit que le poste appelant voyait pour ce patient AVANT de préparer ce
  // changement (transmis par le frontend, voir HospitalisationPanel.js). Si cette requête a
  // attendu en file hors ligne et que quelqu'un d'autre a changé le lit de ce même patient
  // entre-temps (en ligne), appliquer quand même écraserait ce changement sans prévenir personne
  // — jusqu'ici seule la CRÉATION avait une protection de ce genre (local_id), pas la
  // modification. Optionnel : un appelant qui ne l'envoie pas garde l'ancien comportement.
  if (lit_attendu !== undefined && (episode.lit || null) !== (lit_attendu || null)) {
    return res.status(409).json({
      error: `Conflit : le lit de ce patient a été changé entre-temps par quelqu'un d'autre (actuellement "${episode.lit || 'aucun'}", tu voyais "${lit_attendu || 'aucun'}"). Recharge la page pour voir l'état actuel avant de réessayer.`
    });
  }

  if (lit) {
    const { data: occupants, error: erreurOccupants } = await supabase
      .from('episodes').select('id').eq('service', episode.service).eq('lit', lit).eq('statut', 'ouvert').neq('id', req.params.id).is('supprime_le', null);
    if (erreurOccupants) return res.status(500).json({ error: erreurOccupants.message });
    if (occupants && occupants.length > 0) return res.status(409).json({ error: `${lit} est déjà occupé par un autre patient de ${episode.service}.` });
  }

  const { data, error } = await supabase
    .from('episodes').update({ lit: lit || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 19/10 (Esdras) : UN SEUL acte de naissance par épisode (accouchement, césarienne, délivrance : voir utils/actesNaissance.js). Contrôle placé AVANT la route de création (la route elle-même reste inchangée).
// Comptés : les fiches déjà enregistrées de l'épisode (ni supprimées, ni au paiement annulé) + la nouvelle fiche. Exception : droit « acte_naissance_derogation » + motif écrit, tracée au journal
// (action « derogation_acte_naissance », écrite par la route après la création de la fiche). Un rejeu de la file hors ligne (local_id déjà enregistré) n'est jamais refusé.
app.use('/api/fiches', async (req, res, next) => {
  if (req.method !== 'POST' || (req.path !== '/' && req.path !== '')) return next();
  try {
    const { episode_id, raw_state, local_id } = req.body || {};
    if (!episode_id || !raw_state || compterActesNaissance(raw_state.lignesCalcul) === 0) return next();
    if (local_id) {
      const { data: existante } = await supabase.from('fiches').select('id').eq('local_id', local_id).maybeSingle();
      if (existante) return next();
    }
    const { data: fichesDeLEpisode, error: erreurFiches } = await supabase.from('fiches').select('id, raw_state').eq('episode_id', episode_id).is('supprime_le', null);
    if (erreurFiches) return res.status(500).json({ error: erreurFiches.message });
    const { data: annules } = await supabase.from('paiements').select('fiche_id').eq('episode_id', episode_id).eq('annule', true).not('fiche_id', 'is', null);
    const idsAnnules = new Set((annules || []).map(p => p.fiche_id));
    const verdict = conflitActeNaissance({ fichesExistantes: (fichesDeLEpisode || []).filter(f => !idsAnnules.has(f.id)), lignesNouvelles: raw_state.lignesCalcul });
    if (!verdict.conflit) return next();
    const derogation = req.body.derogation_naissance;
    if (!(motifDerogationValide(derogation) && await aPermission(req.user.id, 'acte_naissance_derogation'))) {
      return res.status(409).json({ error: verdict.message, code: 'ACTE_NAISSANCE_MULTIPLE' });
    }
    req.derogationNaissanceAAuditer = { episode_id, motif: derogation.motif.trim(), deja: verdict.deja, nouveau: verdict.nouveau };
    return next();
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Même règle pour les fiches créées avec l'épisode (Achat Express, POST /api/episodes) — sans dérogation possible ici.
app.use('/api/episodes', (req, res, next) => {
  if (req.method !== 'POST' || (req.path !== '/' && req.path !== '') || !req.body || !Array.isArray(req.body.fiches) || req.body.import_sauvegarde === true) return next();
  const verdict = conflitActeNaissance({ lignesNouvelles: req.body.fiches.flatMap(f => (f && f.rawState && f.rawState.lignesCalcul) || (f && f.raw_state && f.raw_state.lignesCalcul) || []) });
  if (verdict.conflit) return res.status(409).json({ error: verdict.message, code: 'ACTE_NAISSANCE_MULTIPLE' });
  return next();
});

// Fiches — rattachées à un épisode. Appelée depuis le Calculateur (caisse_travailler) ET
// depuis l'approbation d'une exonération (demandes_repondre) — voir Demandes.js.
// Retour d'Esdras (29/09) : un dossier suspendu redevient ACTIF dès qu'une nouvelle fiche y est
// enregistrée, où que ce soit (Calculateur, Dossier/Épisode, fiche envoyée après une coupure).
// Ici plutôt que dans chaque écran : toutes les fiches passent par cette route. Appelée seulement à
// la vraie création d'une fiche, JAMAIS sur un rejeu idempotent — un rejeu tardif de la file hors
// ligne ne doit pas réactiver un dossier suspendu volontairement depuis. Un dossier archivé
// (statut 'ferme') ou reporté n'est pas touché. Sans effet sur la fiche si cette mise à jour échoue.
async function reactiverEpisodeSuspendu(episodeId) {
  try {
    const { error } = await supabase.from('episodes').update({ date_suspension: null })
      .eq('id', episodeId).eq('statut', 'ouvert').not('date_suspension', 'is', null).select();
    if (error) console.error('Réactivation du dossier suspendu impossible :', error.message);
  } catch (e) {
    console.error('Réactivation du dossier suspendu impossible :', e.message);
  }
}

app.post('/api/fiches', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'demandes_repondre'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' ou 'demandes_repondre' requise." });
  }
  const { episode_id, cree_par, cree_par_uid, raw_state, local_id, total_global, breakdown, mode_paiement, inserer_apres } = req.body;
  if (!episode_id) return res.status(400).json({ error: 'episode_id est requis' });
  // Faille d'audit du 21/10 : une exonération ne peut être APPLIQUÉE (fiche créée avec ce mode) que par quelqu'un qui peut l'ACCORDER (demandes_repondre) —
  // sans ce contrôle, n'importe quel compte ayant seulement caisse_travailler (ex. comptable, pharmacien) pouvait appeler cette route directement (hors écran)
  // avec mode_paiement: 'exoneration' et s'auto-accorder une remise, sans jamais passer par la direction (voir Demandes.js, le seul appelant légitime).
  // 22/10 (Esdras) : la CAISSE peut aussi accorder une exonération (droit exoneration_accorder), sans attendre la direction — motif obligatoire et trace dans le journal d'audit, voir POST /api/paiements.
  if (mode_paiement === 'exoneration' && !(await aPermission(req.user.id, 'demandes_repondre')) && !(await aPermission(req.user.id, 'exoneration_accorder'))) {
    return res.status(403).json({ error: "Tu n'as pas le droit d'accorder une exonération (permission 'exoneration_accorder' ou 'demandes_repondre').", code: 'EXONERATION_NON_AUTORISEE' });
  }

  // Idempotence : si cette transaction précise a déjà été enregistrée (réponse perdue
  // lors d'une coupure réseau, puis renvoyée par la file d'attente), on renvoie
  // l'enregistrement existant au lieu d'en créer un doublon.
  if (local_id) {
    const { data: existante } = await supabase.from('fiches').select('*').eq('local_id', local_id).maybeSingle();
    if (existante) return res.status(200).json(existante);
  }

  // Faille d'audit du 21/10, la plus sérieuse trouvée : le montant d'une fiche (total_global/breakdown) venait ENTIÈREMENT du téléphone, jamais revérifié —
  // une caissière malhonnête pouvait soigner normalement puis envoyer une fiche à un prix fabriqué plus bas, encaisser le vrai montant en espèces et garder
  // la différence, sans que rien ne le signale. Revérifié ici avec la MÊME formule que l'app (utils/verificationPrixFiche.js) : chaque prix de ligne doit être
  // un prix RECONNU de l'article (ancien OU nouveau prix — la caissière garde son vrai choix — ou le tarif du contrat ONG), l'hébergement est recalculé des
  // dates et du tarif réglé par la direction, la ventilation par service doit concorder. Seule la chirurgie hors-catalogue (texte libre + montant libre) reste
  // invérifiable par nature, juste bornée. `raw_state` absent (appelant inconnu) n'est jamais bloqué, par prudence.
  // raw_state absent (jamais le cas des appelants connus) : rien à relire, on ne fait aucune requête de plus — voir verifierTotalFiche.
  if (raw_state !== undefined && raw_state !== null) {
    const { data: episodePourPrix } = await supabase.from('episodes').select('type_patient, ong_partenaire').eq('id', episode_id).maybeSingle();
    const [{ data: catalogueMed }, { data: catalogueActes }, { data: parametresData }] = await Promise.all([
      supabase.from('catalog').select('items').eq('type', 'medicaments').maybeSingle(),
      supabase.from('catalog').select('items').eq('type', 'actes').maybeSingle(),
      supabase.from('catalog').select('items').eq('type', 'parametres').maybeSingle(),
    ]);
    let ongDoc = null;
    if (episodePourPrix && episodePourPrix.ong_partenaire) {
      const { data } = await supabase.from('ong_partenaires').select('date_fin_contrat').eq('nom', episodePourPrix.ong_partenaire).maybeSingle();
      if (data) ongDoc = { dateFinContrat: data.date_fin_contrat };
    }
    const verification = verifierTotalFiche({
      raw_state, total_global, breakdown, episode: episodePourPrix || null,
      catalogue: { med: (catalogueMed && catalogueMed.items) || [], actes: (catalogueActes && catalogueActes.items) || [] },
      parametres: (parametresData && parametresData.items) || {}, ongDoc,
    });
    if (!verification.ok) {
      // HORS LIGNE (rejeu de la file d'attente, en-tête X-CHF-Rejeu) : jamais refusé. La vente a déjà eu lieu (argent pris, reçu remis) alors que le téléphone ne pouvait pas
      // joindre le serveur : un prix qui a changé entre-temps (nouveaux tarifs appliqués, contrat terminé) ne doit pas faire PERDRE la transaction. On l'enregistre et on la SIGNALE
      // à la direction (journal d'audit, action sensible) — détectée, jamais perdue. En ligne, le refus reste immédiat.
      if (estRejeu(req)) {
        enregistrerAuditServeur(req, 'fiche_montant_suspect', { episode_id, total_global, breakdown, erreur: verification.erreur, hors_ligne: true });
      } else {
        enregistrerAuditServeur(req, 'fiche_montant_refuse', { episode_id, total_global, breakdown, erreur: verification.erreur });
        return res.status(400).json({ error: verification.erreur, code: 'MONTANT_FICHE_REFUSE' });
      }
    }
  }


  // Bug financier découvert le 28/08 : numero_fiche venait du CLIENT (CalculateurPanel.js,
  // Math.max(fichesDossier) + 1) — un état local qui peut rester en retard, notamment quand le
  // paiement d'une fiche précédente échoue (la fiche existe déjà en base, mais l'app n'apprend
  // jamais son numéro puisqu'elle ne l'ajoute à son état local qu'après un encaissement COMPLET).
  // Résultat observé en production : 2 fiches distinctes portant le même numéro dans le même
  // dossier. On calcule désormais toujours le vrai prochain numéro ICI, à partir de ce qui existe
  // réellement en base au moment de l'insertion — la contrainte unique (episode_id, numero_fiche,
  // voir sql/ajoute_contrainte_numero_fiche_unique.sql) sert de filet pour la course plus rare
  // entre 2 requêtes vraiment simultanées (2 postes/onglets) : on relit et on retente.
  for (let tentative = 0; tentative < 5; tentative++) {
    // .not(... null) : une fiche à la corbeille a pu lâcher son numéro (NULL, voir sql/renumerotation_fiches.sql) — en tri décroissant
    // Postgres range les NULL EN PREMIER, la « dernière » fiche serait alors NULL et le numéro suivant retomberait à 1.
    const { data: derniere, error: erreurDerniere } = await supabase
      .from('fiches').select('numero_fiche').eq('episode_id', episode_id).not('numero_fiche', 'is', null)
      .order('numero_fiche', { ascending: false }).limit(1).maybeSingle();
    if (erreurDerniere) return res.status(500).json({ error: erreurDerniere.message });
    let numero_fiche = (derniere?.numero_fiche || 0) + 1;

    // Insertion d'une fiche oubliée ENTRE deux fiches (14/10, reprise de chf-demo2) : `inserer_apres` = id de la fiche après laquelle
    // elle se place, ou 'DEBUT'. Les fiches suivantes avancent d'un numéro (decaler_fiches, atomique) ; le numéro est calculé ICI.
    let decalees = 0;
    if (inserer_apres) {
      let cible = 1;
      if (inserer_apres !== 'DEBUT') {
        if (!estUnVraiUuid(inserer_apres)) return res.status(400).json({ error: "inserer_apres doit être l'id d'une fiche du dossier, ou 'DEBUT'." });
        const { data: apres, error: erreurApres } = await supabase.from('fiches').select('numero_fiche, episode_id')
          .eq('id', inserer_apres).is('supprime_le', null).maybeSingle();
        if (erreurApres) return res.status(500).json({ error: erreurApres.message });
        if (!apres || apres.episode_id !== episode_id || apres.numero_fiche == null) {
          return res.status(400).json({ error: "La fiche après laquelle insérer est introuvable dans ce dossier (supprimée entre-temps ?)." });
        }
        cible = apres.numero_fiche + 1;
      }
      if (cible <= numero_fiche - 1 || (inserer_apres === 'DEBUT' && numero_fiche > 1)) {
        const { data: nb, error: erreurDecalage } = await supabase.rpc('decaler_fiches', { p_episode: episode_id, p_a_partir_de: cible });
        if (erreurDecalage) {
          return res.status(500).json({ error: erreurDecalage.code === '42883' || erreurDecalage.code === 'PGRST202'
            ? "Insertion impossible : le script sql/renumerotation_fiches.sql n'a pas encore été collé dans Supabase." : erreurDecalage.message });
        }
        decalees = Number(nb) || 0;
        numero_fiche = cible;
      }
    }

    // total_global/breakdown/mode_paiement sont écrits dès la création (pas seulement à
    // l'archivage) — sinon un dossier encore actif affiche un total de 0 malgré des
    // transactions déjà encaissées.
    const { data, error } = await supabase
      .from('fiches').insert({
        episode_id, numero_fiche, cree_par, cree_par_uid: cree_par_uid || null,
        raw_state: raw_state || {}, local_id: local_id || null,
        total_global: total_global || 0, breakdown: breakdown || {}, mode_paiement: mode_paiement || null,
      }).select().single();
    if (!error) {
      await reactiverEpisodeSuspendu(episode_id);
      if (req.derogationNaissanceAAuditer) enregistrerAuditServeur(req, 'derogation_acte_naissance', { ...req.derogationNaissanceAAuditer, fiche_id: data.id, numero_fiche });
      if (inserer_apres && decalees > 0) {
        enregistrerAuditServeur(req, 'fiche_inseree', { episode_id, fiche_id: data.id, numero_fiche, inserer_apres, fiches_decalees: decalees });
        const { data: apres } = await supabase.from('fiches').select('id, numero_fiche').eq('episode_id', episode_id).is('supprime_le', null).order('numero_fiche');
        return res.status(201).json({ ...data, renumerotation: apres || [] });
      }
      return res.status(201).json(data);
    }

    if (error.code === '23505') {
      if (local_id) {
        const { data: existante } = await supabase.from('fiches').select('*').eq('local_id', local_id).maybeSingle();
        if (existante) return res.status(200).json(existante);
      }
      // Conflit sur (episode_id, numero_fiche) : une autre requête vient d'insérer le même
      // numéro entre notre lecture et notre écriture — on relit le vrai dernier numéro et on
      // retente, plutôt que d'échouer ou de créer un doublon.
      continue;
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(500).json({ error: "Impossible d'attribuer un numéro de fiche après plusieurs tentatives (forte contention)." });
});

app.get('/api/fiches/episode/:episodeId', async (req, res) => {
  // 21/10 : même correctif.
  if (!(await aPermission(req.user.id, 'fiche_patient_voir'))) return res.status(403).json({ error: "Permission 'fiche_patient_voir' requise." });
  // .is('supprime_le', null) manquait ici (trouvé le 13/09 en testant la corbeille dossiers avec un
  // compte réel) — cette route sert à ROUVRIR un dossier dans le Calculateur pour continuer à le
  // facturer (voir AppHospitaliere.js, GestionOng.js) : une fiche mise à la corbeille par erreur, une
  // fois le dossier rouvert, réapparaissait dans les totaux comme si de rien n'était. Même classe de
  // bug que celui du 24/08 juste en dessous (paiement annulé compté quand même), sur le même écran.
  const { data, error } = await supabase
    .from('fiches').select('*').eq('episode_id', req.params.episodeId).is('supprime_le', null).order('date_creation');
  if (error) return res.status(500).json({ error: error.message });
  // Même correctif que episodeVersFlat (24/08, audit financier) : marque chaque fiche dont le
  // paiement associé a été annulé, pour que le Calculateur/Fiche Patient (qui consomme cette route
  // pour rouvrir un dossier en cours de facturation) ne compte plus cette fiche dans ses totaux
  // affichés — jusqu'ici seuls Statistiques/Direction/Archives (via episodeVersFlat) avaient ce
  // filtre, cet écran-ci en était encore dépourvu.
  const { data: paiementsAnnules } = await supabase
    .from('paiements').select('fiche_id').eq('episode_id', req.params.episodeId).eq('annule', true).not('fiche_id', 'is', null);
  const fichesAvecPaiementAnnule = new Set((paiementsAnnules || []).map(p => p.fiche_id));
  res.json((data || []).map(f => ({ ...f, paiement_annule: fichesAvecPaiementAnnule.has(f.id) })));
});

// Retour d'Esdras (23/08, bug financier URGENT) : cette route N'EXISTAIT PAS — "🗑️ Supprimer" côté
// client (CalculateurPanel.js) ne faisait qu'un retrait de l'état React local + restitution de
// stock, jamais rien côté serveur. Une fiche "supprimée" réapparaissait donc (avec son paiement)
// dès qu'on rechargeait la page ou rouvrait le dossier, puisqu'elle n'avait jamais quitté la base.
// Supprime aussi les paiements liés (fiche_id) — sans ça, un paiement orphelin resterait compté
// dans les totaux de Caisse/Direction pour une fiche qui n'existe plus.
app.delete('/api/fiches/:id', async (req, res) => {
  if (!(await aPermission(req.user.id, 'dossier_annuler'))) {
    return res.status(403).json({ error: "Permission 'dossier_annuler' requise pour supprimer une fiche." });
  }
  // .is('supprime_le', null) plutôt que juste .select('id') : une fiche déjà à la corbeille
  // (supprimée une 1re fois, rejeu de la file hors ligne) doit rester idempotente, pas se
  // retrouver avec un supprime_le "rafraîchi" à chaque nouvel essai.
  const { data: fiche, error: erreurLecture } = await supabase.from('fiches').select('id, episode_id, numero_fiche').eq('id', req.params.id).is('supprime_le', null).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!fiche) return res.status(200).json({ success: true }); // déjà supprimée (idempotent — utile pour une relecture de la file hors ligne)

  // Corbeille 30 jours (phase 2, même principe que /api/episodes/:id ci-dessus) — UPDATE au lieu
  // de DELETE, cascade manuelle vers les paiements de CETTE fiche (paiements.fiche_id est ON
  // DELETE CASCADE en base, mais seulement pour un vrai DELETE).
  const maintenant = new Date().toISOString();
  // 23/10 : fiche + paiements à la corbeille ET dette des paiements d'après recalculée, en une opération (sql/retrait_fiche_solde.sql) — avant, supprimer une
  // fiche à crédit laissait sa dette recopiée dans les paiements postérieurs. Fonction pas encore collée : ancien chemin.
  const { data: paiementsFiche, error: erreurLecturePaiements } = await supabase.from('paiements').select('id').eq('fiche_id', req.params.id).is('supprime_le', null);
  if (erreurLecturePaiements) return res.status(500).json({ error: erreurLecturePaiements.message });
  const { error: erreurSolde } = await supabase.rpc('retirer_fiche_ajuster_solde', { p_fiche: req.params.id, p_paiements: (paiementsFiche || []).map(p => p.id), p_horodatage: maintenant });
  if (erreurSolde) {
    if (estRefusSolde(erreurSolde)) return res.status(409).json({ error: erreurSolde.message, code: erreurSolde.code });
    if (!estFonctionAbsente(erreurSolde)) return res.status(500).json({ error: erreurSolde.message });
    const { error: erreurPaiements } = await supabase.from('paiements').update({ supprime_le: maintenant }).eq('fiche_id', req.params.id).is('supprime_le', null);
    if (erreurPaiements) return res.status(500).json({ error: erreurPaiements.message });
    const { error: erreurFiche } = await supabase.from('fiches').update({ supprime_le: maintenant }).eq('id', req.params.id).select();
    if (erreurFiche) return res.status(500).json({ error: erreurFiche.message });
  }

  // Les fiches suivantes remontent d'un numéro (14/10, reprise de chf-demo2) : supprimer la Fiche 1 ne laisse pas un dossier qui commence à la
  // Fiche 2. Renumérotation atomique en base (sql/renumerotation_fiches.sql). Si le script n'est pas encore collé, la suppression reste valable
  // (numéros inchangés, comme avant) : on le dit dans `renumerotation: null` plutôt que d'échouer.
  let renumerotation = null;
  if (fiche.episode_id) {
    const { data: numeros, error: erreurRenumerotation } = await supabase.rpc('renumeroter_fiches', { p_episode: fiche.episode_id });
    if (erreurRenumerotation) console.warn('Renumérotation des fiches non faite (script SQL pas collé ?) :', erreurRenumerotation.message);
    else {
      renumerotation = numeros || [];
      enregistrerAuditServeur(req, 'fiches_renumerotees', { episode_id: fiche.episode_id, fiche_supprimee: fiche.id, ancien_numero: fiche.numero_fiche, numeros_apres: renumerotation.map(n => ({ id: n.id, numero_fiche: n.numero_fiche })) });
    }
  }
  res.json({ success: true, renumerotation });
});

// 21/10 (Esdras) : un client prend un service puis n'en veut plus, ou le médecin déplace l'acte — la caisse doit pouvoir retirer
// la fiche déjà encaissée, sans passer par la direction, pour les petits montants. Mêmes effets que DELETE /api/fiches/:id
// (fiche + paiements à la corbeille, renumérotation) ; les limites (montant < paramètre « montantRetraitFicheCaisse », jour même ou
// session de caisse ouverte, dossier non facturé) sont dans utils/retraitFicheCaisse.js. « dossier_annuler »
// (direction) garde son droit sans ces limites. Rejeu hors ligne : jamais refusé pour le délai, seulement signalé dans l'audit.
// 22/10 : « Corriger » (le corps porte `correction: true`) = le même retrait, suivi côté écran de la fiche refaite à la même place ;
// tous les modes de paiement sont acceptés et la DETTE du patient est recalculée par la base (sql/retrait_fiche_solde.sql) : retirer une
// fiche à crédit ou en paiement partiel la retire aussi du solde de chaque paiement d'après.
app.post('/api/fiches/:id/retirer-caisse', async (req, res) => {
  const peutTout = await aPermission(req.user.id, 'dossier_annuler');
  if (!peutTout && !(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise pour retirer une fiche encaissée." });
  }
  const { data: fiche, error: erreurLecture } = await supabase.from('fiches')
    .select('id, episode_id, numero_fiche, total_global, date_creation, cree_par').eq('id', req.params.id).is('supprime_le', null).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!fiche) return res.status(200).json({ success: true }); // déjà retirée (idempotent — rejeu de la file hors ligne)

  const { data: episode } = fiche.episode_id
    ? await supabase.from('episodes').select('id, local_id, verrouille_facture, numero_lot').eq('id', fiche.episode_id).maybeSingle()
    : { data: null };
  let { data: paiements, error: erreurPaiements } = await supabase.from('paiements')
    .select('id, mode, montant, solde_restant, details, date_paiement').eq('fiche_id', fiche.id).is('supprime_le', null).neq('annule', true);
  if (erreurPaiements) return res.status(500).json({ error: erreurPaiements.message });
  // ⚡ Achat Express : le paiement peut n'être relié à sa fiche que par local_id (« <épisode>-paiement »), jamais laissé orphelin.
  if ((!paiements || paiements.length === 0) && episode && episode.local_id) {
    const { data: parLocalId } = await supabase.from('paiements')
      .select('id, mode, montant, solde_restant, details, date_paiement').eq('local_id', `${episode.local_id}-paiement`).is('supprime_le', null).neq('annule', true);
    paiements = parLocalId || [];
  }
  const { data: parametresDoc } = await supabase.from('catalog').select('items').eq('type', 'parametres').maybeSingle();
  // Session de caisse OUVERTE de la personne : un encaissement fait depuis son ouverture compte comme « la même session » (voir utils/retraitFicheCaisse.js).
  const { data: ligneSessions } = await supabase.from('catalog').select('items').eq('type', 'sessions_caisse').maybeSingle();
  const sessionOuverte = ((ligneSessions && ligneSessions.items) || []).find(x => x && x.uid === req.user.id && x.statut === 'ouverte' && !x.fermetureISO);
  const debutSessionMs = sessionOuverte ? Date.parse(sessionOuverte.ouvertureISO) : null;
  const rejeu = estRejeu(req);
  const motif = req.body && req.body.motif;
  const correction = !!(req.body && req.body.correction);
  let horsDelai = false;
  if (!peutTout) {
    const verdict = evaluerRetraitCaisse({ fiche, paiements, episode, parametres: parametresDoc && parametresDoc.items, motif, debutSessionMs, rejeu });
    if (!verdict.ok) {
      enregistrerAuditServeur(req, 'fiche_retrait_caisse_refuse', { fiche_id: fiche.id, numero_fiche: fiche.numero_fiche, total: fiche.total_global, code: verdict.code, correction, rejeu });
      return res.status(403).json({ error: verdict.message, code: verdict.code });
    }
    horsDelai = verdict.horsDelai;
  } else if (String(motif || '').trim().length < MOTIF_MIN) {
    return res.status(400).json({ error: `Un motif d'au moins ${MOTIF_MIN} caractères est obligatoire.`, code: 'MOTIF_REQUIS' });
  }

  const maintenant = new Date().toISOString();
  const idsPaiements = (paiements || []).map(p => p.id);
  // Une seule opération de la base (sql/retrait_fiche_solde.sql) : paiements + fiche à la corbeille ET dette des paiements d'après recalculée,
  // sous le verrou de l'épisode. Fonction pas encore collée (42883 / PGRST202) : ancien chemin, sans recalcul de dette.
  let resultatSolde = null;
  const { data: dataSolde, error: erreurSolde } = await supabase.rpc('retirer_fiche_ajuster_solde', { p_fiche: fiche.id, p_paiements: idsPaiements, p_horodatage: maintenant });
  if (erreurSolde) {
    if (estRefusSolde(erreurSolde)) return res.status(409).json({ error: erreurSolde.message, code: erreurSolde.code });
    if (!estFonctionAbsente(erreurSolde)) return res.status(500).json({ error: erreurSolde.message });
    if (idsPaiements.length > 0) {
      const { error } = await supabase.from('paiements').update({ supprime_le: maintenant }).in('id', idsPaiements).is('supprime_le', null);
      if (error) return res.status(500).json({ error: error.message });
    }
    const { error: erreurFiche } = await supabase.from('fiches').update({ supprime_le: maintenant }).eq('id', fiche.id).select();
    if (erreurFiche) return res.status(500).json({ error: erreurFiche.message });
  } else resultatSolde = dataSolde || null;

  let renumerotation = null;
  if (fiche.episode_id) {
    const { data: numeros, error: erreurRenumerotation } = await supabase.rpc('renumeroter_fiches', { p_episode: fiche.episode_id });
    if (erreurRenumerotation) console.warn('Renumérotation des fiches non faite (script SQL pas collé ?) :', erreurRenumerotation.message);
    else renumerotation = numeros || [];
  }
  enregistrerAuditServeur(req, correction ? 'fiche_corrigee_caisse' : 'fiche_retiree_caisse', {
    fiche_id: fiche.id, episode_id: fiche.episode_id, numero_fiche: fiche.numero_fiche, total: fiche.total_global,
    montant_rembourse: (paiements || []).reduce((s, p) => s + (Number(p.montant) || 0), 0),
    modes: [...new Set((paiements || []).map(p => p.mode))], motif: String(motif).trim(),
    fiche_creee_par: fiche.cree_par || null, avec_droit_direction: peutTout, hors_delai: horsDelai, rejeu,
    dette_retiree: resultatSolde ? Number(resultatSolde.dette_retiree) || 0 : null, paiements_ajustes: resultatSolde ? Number(resultatSolde.paiements_ajustes) || 0 : null,
    session_de_caisse: sessionOuverte ? sessionOuverte.id || null : null,
  });
  res.json({ success: true, renumerotation, dette_retiree: resultatSolde ? Number(resultatSolde.dette_retiree) || 0 : 0 });
});

// Restauration d'une fiche mise à la corbeille — même logique que /api/episodes/:id/restaurer :
// ne restaure que les paiements dont supprime_le correspond exactement à celui de la fiche.
app.post('/api/fiches/:id/restaurer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'dossier_annuler'))) {
    return res.status(403).json({ error: "Permission 'dossier_annuler' requise pour restaurer une fiche." });
  }
  const { data: fiche, error: erreurLecture } = await supabase.from('fiches').select('supprime_le, numero_fiche, episode_id').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!fiche) return res.status(404).json({ error: 'Fiche introuvable.' });
  if (!fiche.supprime_le) return res.status(400).json({ error: "Cette fiche n'est pas à la corbeille." });
  const horodatageSuppression = fiche.supprime_le;
  // Une fiche supprimée a pu lâcher son numéro (NULL, voir renumeroter_fiches) : elle revient à la FIN du dossier, au prochain numéro libre.
  const modifsRestauration = { supprime_le: null };
  if (fiche.numero_fiche == null && fiche.episode_id) {
    const { data: derniere } = await supabase.from('fiches').select('numero_fiche').eq('episode_id', fiche.episode_id).not('numero_fiche', 'is', null)
      .order('numero_fiche', { ascending: false }).limit(1).maybeSingle();
    modifsRestauration.numero_fiche = (derniere?.numero_fiche || 0) + 1;
  }
  const { data: ficheRestauree, error } = await supabase.from('fiches').update(modifsRestauration).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!ficheRestauree || ficheRestauree.length === 0) return res.status(404).json({ error: 'Fiche introuvable.' });
  await supabase.from('paiements').update({ supprime_le: null }).eq('fiche_id', req.params.id).eq('supprime_le', horodatageSuppression).select();
  res.json({ success: true });
});

// Route : récupération du catalogue (médicaments ou actes)
app.get('/api/catalog/:type', async (req, res) => {
  const { type } = req.params;
  const { data, error } = await supabase
    .from('catalog')
    .select('items')
    .eq('type', type)
    .single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  const items = data?.items || [];
  // Audit du 12/10 : les sessions de caisse étaient lisibles EN ENTIER par tout compte connecté
  // (infirmier, visiteur...) — fond d'ouverture, comptant remis, fond conservé, justification d'écart.
  // La liste reste lisible par tous (la cloche et la vérification « poste ouvert ? » en ont besoin
  // pour chaque rôle), mais les montants ne vont qu'aux mêmes permissions que GET /api/paiements.
  if (type === 'sessions_caisse' && !(await peutVoirMontantsCaisse(req.user.id))) {
    return res.json(items.map(({ soldeOuverture, comptantRemis, fondConserve, justification, ...reste }) => reste));
  }
  res.json(items);
});

async function peutVoirMontantsCaisse(uid) {
  for (const permission of ['fiche_patient_voir_finances', 'caisse_travailler', 'demandes_repondre', 'caisse_voir']) {
    if (await aPermission(uid, permission)) return true;
  }
  return false;
}

// Route : mise à jour du catalogue
app.put('/api/catalog/:type', async (req, res) => {
  const { type } = req.params;
  // medicaments/actes n'acceptent PLUS de réécriture complète du tableau ici — cette route
  // réécrivait TOUT le catalogue à chaque appel (lecture d'un instantané côté navigateur, puis
  // ré-enregistrement du tableau entier), ce qui pouvait silencieusement ANNULER un stock ou des
  // dons ONG décrémentés entre-temps par une vente. Voir POST /api/catalog/:type/item,
  // PATCH /api/catalog/:type/champs, DELETE /api/catalog/:type/item/:id ci-dessous (fonctions
  // Postgres atomiques, fonction_champs_catalogue.sql) — seules voies désormais pour ces 2 types.
  if (type === 'medicaments' || type === 'actes') {
    return res.status(410).json({
      error: `PUT /api/catalog/${type} n'accepte plus de réécriture complète du tableau — utilise POST /api/catalog/${type}/item (créer), PATCH /api/catalog/${type}/champs (modifier), ou DELETE /api/catalog/${type}/item/:id (supprimer).`,
    });
  }
  // 'permissions' : réservé à permissions_gerer (écran Rôles & permissions).
  // 'parametres' : réservé à parametres_gerer (écran Paramètres — retour d'Esdras du 24/08,
  // "il me faut un onglet paramètres pour ce genre de truc").
  // 'sessions_caisse' (01/09) : caisse_travailler — voir POST /api/catalog/:type/item plus bas.
  // Tout le reste (types_consultation, services_hospitalisation...) : catalogue_gerer.
  let permissionOk;
  if (type === 'permissions') {
    permissionOk = await aPermission(req.user.id, 'permissions_gerer');
  } else if (type === 'parametres') {
    permissionOk = await aPermission(req.user.id, 'parametres_gerer');
  } else if (type === 'sessions_caisse') {
    permissionOk = await aPermission(req.user.id, 'caisse_travailler');
  } else {
    permissionOk = await aPermission(req.user.id, 'catalogue_gerer');
  }
  if (!permissionOk) return res.status(403).json({ error: `Permission requise pour modifier le catalogue "${type}".` });
  // 'permissions' (09/10, rôles personnalisés) : cette table contient maintenant les rôles créés depuis
  // l'écran Rôles & permissions. Elle ne s'écrit QUE par utils/roles.js : rôle du code non usurpable, nouvelle
  // clé obligatoirement déclarée personnalisée et validée, aucun champ libre, suppression d'un rôle encore
  // attribué refusée (409), changements consignés dans audit_log.
  if (type === 'permissions') {
    const resultat = await appliquerMiseAJourPermissions({
      items: (req.body || {}).items, supabase, utilisateur: req.user,
      clesIntegrees: new Set(['administrateur', ...PERMISSIONS_PAR_DEFAUT.map(r => r.role)]),
      defauts: PERMISSIONS_PAR_DEFAUT, genererId: () => crypto.randomUUID(),
    });
    return res.status(resultat.status).json(resultat.body);
  }
  const { items } = req.body;
  // upsert (pas update) : la toute première écriture doit pouvoir CRÉER la ligne si elle
  // n'existe pas encore — un simple update ne peut jamais créer une ligne absente.
  const { data, error } = await supabase
    .from('catalog')
    .upsert({ type, items, updated_at: new Date().toISOString() }, { onConflict: 'type' })
    .select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) {
    return res.status(500).json({ error: `Échec inattendu de l'enregistrement du catalogue "${type}".` });
  }
  res.json({ success: true });
});

// Ajoute UN article au catalogue (medicaments ou actes) de façon atomique (voir
// fonction_champs_catalogue.sql) — remplace l'ancien read-modify-write complet de
// GrilleEdition.js ("Tarifs Pharma"/"Tarifs Actes"). Pour "medicaments", le stock démarre
// TOUJOURS à 0 (aucun don) quoi que le navigateur envoie — le stock initial se règle ensuite
// depuis "Gestion des stocks", jamais depuis Tarifs Pharma (voir aussi le 410 ci-dessus).
app.post('/api/catalog/:type/item', async (req, res) => {
  const { type } = req.params;
  // 'sessions_caisse' (01/09) : voir le même aparté sur PUT /api/catalog/:type juste au-dessus —
  // un caissier doit pouvoir ouvrir SA session sans avoir catalogue_gerer.
  const permissionOk = type === 'sessions_caisse'
    ? await aPermission(req.user.id, 'caisse_travailler')
    : await aPermission(req.user.id, 'catalogue_gerer');
  if (!permissionOk) {
    return res.status(403).json({ error: "Permission 'catalogue_gerer' requise." });
  }
  const { item } = req.body;
  if (!item || typeof item !== 'object') return res.status(400).json({ error: 'item (objet) requis.' });
  // Rejeu idempotent (28/09) : un poste de caisse ouvert HORS LIGNE part dans la file d'attente de
  // l'app avec l'id de la session, et la file peut le renvoyer plus d'une fois (réponse perdue sur
  // une connexion instable, synchronisation interrompue puis reprise). ajouter_article_catalogue
  // ajoute sans regarder : chaque rejeu créait un poste de plus, en double. Un id déjà présent
  // veut dire "déjà enregistré" — on renvoie l'article existant, sans rien écrire.
  if (item.id !== undefined && item.id !== null && item.id !== '') {
    const { data: ligne, error: erreurLecture } = await supabase.from('catalog').select('items').eq('type', type).maybeSingle();
    if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
    const existant = (ligne?.items || []).find(a => a && a.id === item.id);
    if (existant) return res.status(200).json({ success: true, item: existant, dejaEnregistre: true });
  }
  const { data, error } = await supabase.rpc('ajouter_article_catalogue', { p_type: type, p_item: item });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL ajouter_article_catalogue n'existe pas encore dans Supabase — colle fonction_champs_catalogue.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ success: true, item: data });
});

// Modifie des champs (nom, prix, prixAchat, sub, ordre, nouveauPrix, nbUtilisations...) sur un ou
// plusieurs articles existants, de façon atomique — jamais quantite/seuilAlerte/donsParOng (la
// fonction Postgres retire elle-même ces clés, quoi que req.body contienne). Utilisée par
// GrilleEdition.js (édition, application des nouveaux prix, tri du bon de labo) ET par
// CalculateurPanel.js (compteur de fréquence d'usage) — d'où catalogue_gerer OU
// caisse_travailler, comme avant sur l'ancienne route.
app.patch('/api/catalog/:type/champs', async (req, res) => {
  const { type } = req.params;
  if (!(await aPermission(req.user.id, 'catalogue_gerer')) && !(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'catalogue_gerer' ou 'caisse_travailler' requise." });
  }
  const { maj } = req.body; // [{ id, champs }, ...]
  if (!Array.isArray(maj) || maj.length === 0) return res.status(400).json({ error: 'maj (tableau non vide) requis.' });
  // 'sessions_caisse' (01/09) : cette route est générique et ignore d'ordinaire QUI possède
  // l'article visé — correct pour un tarif (n'importe quel caissier peut incrémenter un compteur
  // d'usage), mais dangereux ici : sans ce contrôle, un simple caisse_travailler (sans
  // catalogue_gerer) pourrait fermer la session ouverte d'un AUTRE caissier par un appel API brut
  // (hors interface), avec un comptant/écart fabriqués — jamais possible depuis l'écran, qui ne
  // cible que sessionActive.id. direction/administrateur (catalogue_gerer) gardent le droit de
  // corriger la session de n'importe qui, comme pour toute autre correction comptable.
  if (type === 'sessions_caisse' && !(await aPermission(req.user.id, 'catalogue_gerer'))) {
    const { data: ligne, error: erreurLecture } = await supabase.from('catalog').select('items').eq('type', 'sessions_caisse').single();
    if (erreurLecture && erreurLecture.code !== 'PGRST116') return res.status(500).json({ error: erreurLecture.message });
    const sessions = ligne?.items || [];
    const idsEtrangers = maj.filter(m => {
      const session = sessions.find(s => s.id === m.id);
      return session && session.uid !== req.user.id;
    });
    if (idsEtrangers.length > 0) {
      return res.status(403).json({ error: "Tu ne peux modifier que ta propre session de caisse." });
    }
  }
  const { data, error } = await supabase.rpc('definir_champs_catalogue_lot', { p_type: type, p_maj: maj });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL definir_champs_catalogue_lot n'existe pas encore dans Supabase — colle fonction_champs_catalogue.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, items: data });
});

// Supprime UN article du catalogue par id, de façon atomique.
app.delete('/api/catalog/:type/item/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!(await aPermission(req.user.id, 'catalogue_gerer'))) {
    return res.status(403).json({ error: "Permission 'catalogue_gerer' requise." });
  }
  const { data, error } = await supabase.rpc('supprimer_article_catalogue', { p_type: type, p_id: id });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL supprimer_article_catalogue n'existe pas encore dans Supabase — colle fonction_champs_catalogue.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, items: data });
});

// Route : récupération des paiements
// Faille trouvée le 27/08 (audit avant mise en production) : cette route renvoyait TOUTE la
// table paiements (montants, modes, motifs de transfert...) à n'importe quel utilisateur
// authentifié, sans vérifier fiche_patient_voir_finances — un archiviste ou un infirmier
// pouvait ainsi contourner, en appelant directement l'API, la même restriction déjà appliquée
// correctement sur GET /api/dossiers/:id/historique ("ne peuvent pas voir si le patient a un
// solde ou statut de paiement", retour d'Esdras du 26/08). caisse_travailler et
// demandes_repondre ajoutés en plus de fiche_patient_voir_finances : Demandes.js (approbation
// d'exonération) en a besoin sans que demandes_repondre implique nécessairement l'autre
// permission. rapport_chf_voir volontairement EXCLU (il ne montre aucun montant). Depuis le 30/09,
// infirmier_chef et medecin voient les paiements via fiche_patient_voir_finances (choix explicite).
app.get('/api/paiements', async (req, res) => {
  // caisse_voir (28/08) ajouté : le tableau de bord Caisse en lecture seule (visiteur) a besoin
  // des mêmes paiements que la version normale pour calculer sa ventilation/rapport partenaire.
  if (!(await aPermission(req.user.id, 'fiche_patient_voir_finances')) && !(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'demandes_repondre')) && !(await aPermission(req.user.id, 'caisse_voir'))) {
    return res.status(403).json({ error: "Permission 'fiche_patient_voir_finances', 'caisse_travailler', 'demandes_repondre' ou 'caisse_voir' requise." });
  }
  // Paginée (voir lireToutesLesPages) : cette route alimente la fiche de caisse, le rapprochement
  // et les rapports partenaires. Un plafond de lignes côté Supabase aurait fait disparaître les
  // paiements les plus ANCIENS sans la moindre erreur — un manque d'argent invisible dans les
  // comptes. `.order('id')` en second rend le tri total, obligatoire dès qu'on pagine.
  try {
    if (req.query.synchro === '1') return res.json(await synchroListes.paiements(req.query.depuis || null));
    res.json(await lireToutesLesPages(
      () => supabase.from('paiements').select('*').is('supprime_le', null).order('date_paiement', { ascending: false }).order('id')));
  } catch (e) {
    console.error('GET /api/paiements: lecture paginée échouée :', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Audit du 21/10 (rappel d'Esdras : exonération et paiement partiel) : le montant d'une LIGNE DE PAIEMENT n'était jamais comparé à sa fiche — une caissière pouvait
// enregistrer 500 Gdes pour une fiche de 5000 en espèces et garder la différence. Total de la fiche = montant versé + dépôt déduit + exonération (accordée par la direction)
// + reste dû plus tard (crédit ou paiement partiel) : voir utils/verificationPrixFiche.js::verifierPaiementContreFiche. Placé AVANT la route (et non dedans) : même patron
// que les autres contrôles, et la route elle-même garde exactement la même forme. Les modes qui ne sont pas une vente (dépôt, remboursements) ne passent pas par ici.
app.use('/api/paiements', async (req, res, next) => {
  if (req.method !== 'POST' || (req.path !== '/' && req.path !== '') || !req.body || !MODES_VENTE.includes(req.body.mode)) return next();
  try {
    if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'demandes_repondre'))) return next(); // la route répondra 403
    const corps = req.body;
    const localId = corps.local_id || corps.localId || null;
    if (localId) {
      const { data: dejaLa } = await supabase.from('paiements').select('id').eq('local_id', localId).maybeSingle();
      if (dejaLa) return next(); // rejeu : déjà enregistré (et déjà vérifié à ce moment-là)
    }
    let fiche = null;
    if (estUnVraiUuid(corps.fiche_id)) {
      ({ data: fiche } = await supabase.from('fiches').select('id, episode_id, total_global, supprime_le').eq('id', corps.fiche_id).maybeSingle());
    }
    if (!fiche && localId) {
      ({ data: fiche } = await supabase.from('fiches').select('id, episode_id, total_global, supprime_le').eq('local_id', localId).maybeSingle());
    }
    if (!fiche && localId && localId.endsWith('-paiement')) { // ⚡ Achat Express : la fiche est créée avec l'épisode, qui porte le même identifiant sans le suffixe
      const { data: episodeExpress } = await supabase.from('episodes').select('id').eq('local_id', localId.slice(0, -'-paiement'.length)).maybeSingle();
      if (episodeExpress) {
        const { data: fichesExpress } = await supabase.from('fiches').select('id, episode_id, total_global, supprime_le').eq('episode_id', episodeExpress.id).is('supprime_le', null);
        if (fichesExpress && fichesExpress.length === 1) fiche = fichesExpress[0];
      }
    }
    // HORS LIGNE (rejeu de la file d'attente) : jamais refusé — l'argent est déjà pris et le reçu remis ; un refus ferait PERDRE la transaction (échec définitif dans la file du
    // téléphone). On enregistre et on SIGNALE à la direction (journal d'audit, action sensible). En ligne, le refus reste immédiat.
    const rejeu = estRejeu(req);
    const refuserOuSignaler = (erreur, details) => {
      if (rejeu) {
        enregistrerAuditServeur(req, 'paiement_suspect', { episode_id: corps.episode_id || null, fiche_id: fiche ? fiche.id : null, montant: corps.montant, mode: corps.mode, erreur, hors_ligne: true, ...details });
        return next();
      }
      enregistrerAuditServeur(req, 'paiement_refuse', { episode_id: corps.episode_id || null, fiche_id: fiche ? fiche.id : null, montant: corps.montant, mode: corps.mode, erreur, ...details });
      return res.status(400).json({ error: erreur, code: 'PAIEMENT_FICHE_INCOHERENT' });
    };
    if (fiche && fiche.supprime_le) return refuserOuSignaler('Cette fiche est supprimée : le paiement ne peut pas lui être rattaché.');
    if (fiche && corps.episode_id && fiche.episode_id !== corps.episode_id) return refuserOuSignaler("Ce paiement est rattaché à la fiche d'un autre dossier.");
    let soldeDepotDisponible = 0;
    if (corps.details && Number(corps.details.montant_depot_utilise) > 0 && corps.episode_id) {
      const { data: paiementsEpisode } = await supabase.from('paiements').select('*').eq('episode_id', corps.episode_id).or('annule.eq.false,annule.is.null').is('supprime_le', null);
      soldeDepotDisponible = calculerSoldeDepot(paiementsEpisode || []).soldeDepot;
    }
    // Trouvé en TESTANT hors ligne sur le vrai site (21/10) : deux ventes de suite hors ligne déduisaient chacune le MÊME dépôt (l'app ne sait pas encore, pendant la coupure, que la
    // 1re vient de le consommer) — 1 100 Gdes de dépôt « utilisés » pour 1 000 déposés, 100 Gdes que le patient ne devait plus au registre. Au REJEU (vente déjà faite, argent déjà
    // pris), le serveur ramène le dépôt à ce qui existe vraiment et met l'EXCÉDENT en dette (reste à payer) : le total de la fiche reste exact, rien n'est refusé, la direction est prévenue.
    const depotDemande = Number(corps.details && corps.details.montant_depot_utilise) || 0;
    if (rejeu && fiche && depotDemande > soldeDepotDisponible + 0.02) {
      const arrondi = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
      const depotReel = Math.max(0, arrondi(soldeDepotDisponible));
      const excedent = arrondi(depotDemande - depotReel);
      corps.details = { ...corps.details, depot_excedentaire_en_dette: excedent };
      if (depotReel > 0) corps.details.montant_depot_utilise = depotReel; else delete corps.details.montant_depot_utilise;
      const montantPaye = Number(corps.montant) || 0;
      if (corps.mode === 'credit') {
        corps.solde_restant = arrondi((Number(corps.solde_restant) || 0) + excedent);
      } else if (corps.details.paiement_partiel === true) {
        corps.solde_restant = arrondi((Number(corps.solde_restant) || 0) + excedent);
        corps.details.reste = arrondi((Number(corps.details.reste) || 0) + excedent);
      } else if (['cash', 'moncash', 'virement', 'cheque'].includes(corps.mode)) {
        if (montantPaye > 0) Object.assign(corps.details, { paiement_partiel: true, total_fiche: Number(fiche.total_global) || 0, montant_paye: montantPaye, reste: excedent }), corps.solde_restant = excedent;
        else { corps.mode = 'credit'; corps.solde_restant = excedent; }
      }
      enregistrerAuditServeur(req, 'paiement_depot_corrige', { episode_id: corps.episode_id || null, fiche_id: fiche.id, depot_demande: depotDemande, depot_disponible: depotReel, mis_en_dette: excedent, mode: corps.mode });
    }
    const verdict = verifierPaiementContreFiche({ corps, fiche, soldeDepotDisponible });
    if (!verdict.ok) return refuserOuSignaler(verdict.erreur);
    return next();
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Route : création d'un paiement — idempotente via local_id, même principe que /api/fiches.
// Appelée depuis la caisse (caisse_travailler), l'approbation d'une exonération
// (demandes_repondre) ET l'enregistrement d'un remboursement de crédit (Fiche Patient) — d'où
// aussi caisse_travailler puisque manier de l'argent reste une action de caisse.
app.post('/api/paiements', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'demandes_repondre'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' ou 'demandes_repondre' requise." });
  }
  // Même correctif que POST /api/fiches ci-dessus (faille d'audit du 21/10) : seule la direction (demandes_repondre) peut enregistrer un paiement d'exonération.
  // 22/10 (Esdras) : la caisse accorde aussi (exoneration_accorder). Hors direction : motif obligatoire (en ligne ; un rejeu hors ligne n'est jamais refusé) et ligne « exoneration_accordee_caisse » dans le journal d'audit.
  let auditExoneration = null; // écrit seulement une fois le paiement réellement enregistré
  if (req.body.mode === 'exoneration') {
    const parLaDirection = await aPermission(req.user.id, 'demandes_repondre');
    if (!parLaDirection && !(await aPermission(req.user.id, 'exoneration_accorder'))) {
      return res.status(403).json({ error: "Tu n'as pas le droit d'accorder une exonération (permission 'exoneration_accorder' ou 'demandes_repondre').", code: 'EXONERATION_NON_AUTORISEE' });
    }
    if (!parLaDirection) {
      const exo = (req.body.exoneration && typeof req.body.exoneration === 'object') ? req.body.exoneration : {};
      const motifExo = typeof exo.motif === 'string' ? exo.motif.trim() : '';
      const rejeuExo = estRejeu(req);
      if (motifExo.length < 3 && !rejeuExo) {
        return res.status(400).json({ error: "Écris le motif de l'exonération (3 caractères au moins).", code: 'MOTIF_EXONERATION_REQUIS' });
      }
      auditExoneration = {
        fiche_id: req.body.fiche_id || req.body.ficheId || null, episode_id: req.body.episode_id || null, patient: req.body.patient_nom || null,
        montant_exonere: Number(exo.montantExonere) || null, pourcentage: Number(exo.pourcentage) || null, motif: motifExo || null, rejeu: rejeuExo,
      };
    }
  }
  const local_id = req.body.local_id || req.body.localId;
  if (local_id) {
    const { data: existant } = await supabase.from('paiements').select('*').eq('local_id', local_id).maybeSingle();
    if (existant) return res.status(200).json(existant);
  }

  const corps = { ...req.body };
  // Heure RÉELLE (13/10) : en direct, l'heure du serveur fait foi ; un rejeu de la file hors ligne garde l'heure corrigée de l'app (jamais dans le futur).
  appliquerHeureAuPaiement(corps, req);

  // Montant contrôlé AVANT tout calcul de solde : un montant négatif ou illisible fausserait les soldes, les totaux et l'écart de caisse.
  const erreurMontant = validerMontantPaiement(corps);
  if (erreurMontant) return res.status(400).json({ error: erreurMontant });
  normaliserMontant(corps);

  // Paiement partiel (13/10) : montant versé + reste dû sur UNE ligne — voir utils/paiementPartiel.js.
  const erreurPartiel = validerPaiementPartiel(corps);
  if (erreurPartiel) return res.status(400).json({ error: erreurPartiel });

  // Solde ATOMIQUE (13/10, liste de contrôle fintech d'Esdras : « deux retraits en même temps ne doivent pas dépenser le même argent »). Lire le dernier solde puis
  // écrire le paiement en deux temps laissait deux paiements simultanés du même épisode partir du même ancien solde (le 2e écrasait le report du 1er). La fonction
  // enregistrer_paiement_atomique (sql/solde_atomique.sql) fait lecture + calcul + écriture d'un seul bloc, sous un verrou par épisode. Tant que ce script SQL n'est pas
  // appliqué en base, on retombe sur l'ancien chemin ci-dessous (inchangé) : jamais une panne.
  if (corps.mode === 'remboursement_credit' && !corps.episode_id) return res.status(400).json({ error: 'episode_id requis pour un remboursement de crédit.' });
  {
    const ajout = corps.mode === 'remboursement_credit' || !corps.episode_id ? 0 : soldeAjouteParPaiement(corps);
    const { data: dataAtomique, error: erreurAtomique } = await supabase.rpc('enregistrer_paiement_atomique', {
      p_corps: { ...corps, local_id: local_id || null }, p_ajout: ajout, p_remboursement_credit: corps.mode === 'remboursement_credit',
      p_heure_serveur: !estRejeu(req), // en direct : la base date le paiement sous le verrou ; rejeu hors ligne : date de l'appareil gardée
    });
    if (!erreurAtomique) { if (auditExoneration) enregistrerAuditServeur(req, 'exoneration_accordee_caisse', auditExoneration); return res.status(201).json(dataAtomique); }
    if (estRefusRemboursement(erreurAtomique)) return res.status(400).json({ error: messageRefusRemboursement(erreurAtomique) });
    if (erreurAtomique.code === '23505') {
      const { data: existant } = local_id ? await supabase.from('paiements').select('*').eq('local_id', local_id).maybeSingle() : { data: null };
      if (existant) return res.status(200).json(existant);
    }
    if (!estFonctionAbsente(erreurAtomique)) return res.status(500).json({ error: erreurAtomique.message });
    // Fonction pas encore en base : ancien chemin (lecture puis écriture), voir plus bas.
  }

  // Le solde de crédit d'un épisode = le solde_restant de son DERNIER paiement non annulé. C'est
  // la définition utilisée partout : Créances (DashboardCaisse), statut et plafond de
  // remboursement (Fiche Patient), solde affiché au Calculateur, et le remboursement ci-dessous.
  // Un paiement ANNULÉ ne doit jamais servir de référence (24/08, audit financier).
  // .is('supprime_le', null) (25/09, audit avant mise en production) : depuis la corbeille 30 jours
  // (12/09), supprimer une fiche ne fait plus disparaître ses paiements, elle les MARQUE — mais
  // cette lecture ne regardait pas la marque. Une fiche à crédit supprimée restait donc la
  // référence du solde : la dette effacée continuait d'être due, et se reportait sur chaque
  // nouveau paiement de l'épisode (voir le report juste en dessous).
  const lireSoldeEpisode = async (episodeId) => {
    const { data, error } = await supabase
      .from('paiements').select('solde_restant').eq('episode_id', episodeId)
      .or('annule.eq.false,annule.is.null').is('supprime_le', null)
      .order('date_paiement', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    return (data && data.solde_restant) || 0;
  };

  // ⚠️ Correctif majeur (audit du 01/09) — une dette pouvait DISPARAÎTRE toute seule.
  // Le navigateur envoie solde_restant = 0 pour tout paiement qui n'est pas à crédit (voir
  // CalculateurPanel.js), et n'en envoie aucun pour un dépôt. Comme le solde de l'épisode se lit
  // sur le DERNIER paiement, n'importe quel paiement postérieur remettait la dette à zéro :
  //   - un patient hospitalisé dont la fiche du lendemain est réglée en cash ;
  //   - un patient qui doit encore de l'argent et qui laisse un dépôt pour une prochaine visite.
  // Dans les deux cas la créance disparaissait de la liste des Créances, du tableau de bord
  // Direction et de la Fiche Patient — et le serveur refusait ensuite tout remboursement
  // ("Aucun solde de crédit à rembourser"). L'hôpital cessait purement et simplement de réclamer
  // cet argent, sans que rien ne le signale.
  // Le solde est donc REPORTÉ sur chaque nouveau paiement de l'épisode : un crédit s'ajoute à ce
  // qui était déjà dû, tout autre mode le laisse inchangé. Sur un épisode sans dette (le cas de
  // loin le plus fréquent), le report vaut 0 : comportement rigoureusement identique à avant.
  if (corps.mode === 'remboursement_credit') {
    if (!corps.episode_id) return res.status(400).json({ error: 'episode_id requis pour un remboursement de crédit.' });
    let soldeActuel;
    try { soldeActuel = await lireSoldeEpisode(corps.episode_id); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    const montant = parseFloat(corps.montant) || 0;
    if (soldeActuel <= 0) return res.status(400).json({ error: 'Aucun solde de crédit à rembourser pour cet épisode.' });
    if (montant <= 0) return res.status(400).json({ error: 'Le montant du remboursement doit être supérieur à 0.' });
    if (montant > soldeActuel) return res.status(400).json({ error: `Le remboursement (${montant} Gdes) dépasse le solde restant (${soldeActuel} Gdes).` });
    corps.solde_restant = soldeActuel - montant;
  } else if (corps.episode_id) {
    let soldeAnterieur;
    try { soldeAnterieur = await lireSoldeEpisode(corps.episode_id); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    const soldeDeCePaiement = soldeAjouteParPaiement(corps);
    corps.solde_restant = soldeAnterieur + soldeDeCePaiement;
  }

  const { data, error } = await supabase
    .from('paiements')
    .insert({ ...corps, local_id: local_id || null })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') {
      const { data: existant } = await supabase.from('paiements').select('*').eq('local_id', local_id).maybeSingle();
      if (existant) return res.status(200).json(existant);
    }
    return res.status(500).json({ error: error.message });
  }
  if (auditExoneration) enregistrerAuditServeur(req, 'exoneration_accordee_caisse', auditExoneration);
  res.status(201).json(data);
});

// Retour d'Esdras (31/08) : "on a l'habitude de retirer de l'argent à la caisse pour faire des
// achats" — une pratique réelle jamais tracée nulle part jusqu'ici (table depenses_caisse déjà
// créée, mais aucune route ni aucun écran ne la touchait — confirmé par recherche dans les 2
// dépôts). Corrigé le même soir : Esdras a précisé que ce n'est PAS le caissier qui décide de
// sortir de l'argent — c'est LA DIRECTION qui le lui demande, et LUI qui accorde ou refuse selon
// ce qu'il a en caisse. Même schéma de verrouillage que demandes_exoneration (Demandes.js) :
// 'en_attente' -> 'accorde'/'refuse' via un UPDATE conditionnel, pour qu'un seul caissier puisse
// traiter une demande donnée même si 2 postes l'ont ouverte en même temps. Passé par le backend
// (comme paiements), pas par le shim db, pour appliquer une vraie permission plutôt que la clé
// anon libre. Fonctionnalité pensée comme TEMPORAIRE : le comptable venu pour la firme a dit que
// ce retrait direct ne durera pas une fois leur propre système en place — d'où le paramètre
// 'sortiesCaisseActivees' (GestionParametres.js) qui masque tout l'écran d'un coup côté navigateur
// le jour où ce n'est plus utile, sans qu'il faille retoucher au code ni perdre l'historique déjà
// enregistré.
app.get('/api/depenses-caisse', async (req, res) => {
  // sortie_caisse_demander (direction, qui veut voir le statut de ses demandes) + caisse_travailler
  // (le caissier, qui doit voir ce qui est en attente) + caisse_voir/fiche_patient_voir_finances
  // (même écran que GET /api/paiements, pour le rapprochement).
  if (!(await aPermission(req.user.id, 'sortie_caisse_demander')) && !(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'caisse_voir')) && !(await aPermission(req.user.id, 'fiche_patient_voir_finances'))) {
    return res.status(403).json({ error: "Permission 'sortie_caisse_demander', 'caisse_travailler', 'caisse_voir' ou 'fiche_patient_voir_finances' requise." });
  }
  try {
    res.json(await lireToutesLesPages(
      () => supabase.from('depenses_caisse').select('*').order('date_demande', { ascending: false }).order('id')));
  } catch (e) {
    console.error('GET /api/depenses-caisse: lecture paginée échouée :', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Crée la DEMANDE (statut 'en_attente') — c'est la direction qui l'initie, jamais le caissier.
app.post('/api/depenses-caisse', async (req, res) => {
  if (!(await aPermission(req.user.id, 'sortie_caisse_demander'))) {
    return res.status(403).json({ error: "Permission 'sortie_caisse_demander' requise." });
  }
  const { motif, montant } = req.body;
  if (!motif || typeof motif !== 'string' || !motif.trim()) return res.status(400).json({ error: 'motif requis.' });
  const montantNombre = parseFloat(montant);
  if (!(montantNombre > 0)) return res.status(400).json({ error: 'montant doit être un nombre supérieur à 0.' });

  // Idempotence via local_id, même principe que /api/paiements et /api/fiches — nécessaire pour
  // que la file hors ligne (api/supabase.js) puisse rejouer cette création sans risquer de la
  // dupliquer si la confirmation du 1er essai s'est perdue en route.
  const local_id = req.body.local_id || req.body.localId;
  if (local_id) {
    const { data: existant } = await supabase.from('depenses_caisse').select('*').eq('local_id', local_id).maybeSingle();
    if (existant) return res.status(200).json(existant);
  }

  const { data, error } = await supabase
    .from('depenses_caisse')
    .insert({
      motif: motif.trim(), montant: montantNombre,
      demandeur: req.user.email || req.user.id, demandeur_uid: req.user.id,
      statut: 'en_attente', local_id: local_id || null,
    })
    .select()
    .single();
  if (error) {
    if (error.code === '23505' && local_id) {
      const { data: existant } = await supabase.from('depenses_caisse').select('*').eq('local_id', local_id).maybeSingle();
      if (existant) return res.status(200).json(existant);
    }
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

// Le caissier accorde (il a l'argent, il le donne) ou refuse (il ne l'a pas) une demande en
// attente. Verrouillage atomique identique à claimerDemande() dans Demandes.js : la clause
// .eq('statut', 'en_attente') sur l'UPDATE garantit que si 2 caissiers répondent à la même
// demande à quelques instants d'écart, un seul des deux modifie réellement une ligne — l'autre
// reçoit 0 ligne modifiée (409) plutôt qu'une double sortie d'argent.
app.patch('/api/depenses-caisse/:id/repondre', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { accorde } = req.body;
  if (typeof accorde !== 'boolean') return res.status(400).json({ error: 'accorde (booléen) requis.' });

  const { data, error } = await supabase
    .from('depenses_caisse')
    .update({
      statut: accorde ? 'accorde' : 'refuse',
      caissier: req.user.email || req.user.id, caissier_uid: req.user.id,
      date_reponse: new Date().toISOString(),
    })
    .eq('id', req.params.id).eq('statut', 'en_attente')
    .select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.status(409).json({ error: "Cette demande a déjà été traitée entre-temps." });
  res.json(data[0]);
});

// Autres revenus (20/10, Esdras) : de l'argent encaissé à la caisse qui ne concerne AUCUN patient (certificat, location, don...). Table à part (sql/autres_revenus.sql) : jamais mélangé aux revenus des soins.
// Même contrôle que les paiements : il faut caisse_travailler pour en enregistrer, paiement_annuler pour en annuler (et jamais soi-même).
const MESSAGE_AUTRE_REVENU_MOTIF = 'Le motif est requis (3 à 300 caractères).';
app.get('/api/autres-revenus', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'caisse_voir')) && !(await aPermission(req.user.id, 'fiche_patient_voir_finances'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler', 'caisse_voir' ou 'fiche_patient_voir_finances' requise." });
  }
  try {
    res.json(await lireToutesLesPages(() => supabase.from('autres_revenus').select('*').order('date_revenu', { ascending: false }).order('id')));
  } catch (e) {
    // Table pas encore créée (script SQL pas collé) : liste vide plutôt que d'empêcher l'app de se charger.
    if (/autres_revenus/.test(String(e.message)) && /does not exist|schema cache|relation/.test(String(e.message))) return res.json([]);
    console.error('GET /api/autres-revenus: lecture paginée échouée :', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/autres-revenus', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  const motif = typeof req.body.motif === 'string' ? req.body.motif.trim().replace(/\s+/g, ' ') : '';
  if (motif.length < 3 || motif.length > 300) return res.status(400).json({ error: MESSAGE_AUTRE_REVENU_MOTIF });
  const montant = Math.round((Number(req.body.montant) + Number.EPSILON) * 100) / 100;
  if (!(montant > 0) || montant > 100000000) return res.status(400).json({ error: 'Le montant doit être supérieur à 0.' });
  const payeur = typeof req.body.payeur === 'string' && req.body.payeur.trim() ? req.body.payeur.trim().replace(/\s+/g, ' ').slice(0, 100) : null;
  const local_id = req.body.local_id || req.body.localId || null;
  if (local_id) {
    const { data: existant } = await supabase.from('autres_revenus').select('*').eq('local_id', local_id).maybeSingle();
    if (existant) return res.status(200).json(existant);
  }
  const { data, error } = await supabase.from('autres_revenus').insert({
    montant, motif, payeur, caissier: req.user.email || req.user.id, caissier_uid: req.user.id, local_id,
  }).select().single();
  if (error) {
    if (error.code === '23505' && local_id) {
      const { data: existant } = await supabase.from('autres_revenus').select('*').eq('local_id', local_id).maybeSingle();
      if (existant) return res.status(200).json(existant);
    }
    return res.status(500).json({ error: error.message });
  }
  await enregistrerAuditServeur(req, 'autre_revenu_enregistre', { id: data.id, montant, motif, payeur });
  res.status(201).json(data);
});
app.patch('/api/autres-revenus/:id/annuler', async (req, res) => {
  if (!(await aPermission(req.user.id, 'paiement_annuler'))) return res.status(403).json({ error: "Permission 'paiement_annuler' requise pour annuler un autre revenu." });
  const motif = typeof req.body.motif === 'string' ? req.body.motif.trim() : '';
  if (motif.length < 5) return res.status(400).json({ error: "Un motif d'annulation (5 caractères au moins) est requis." });
  const { data: revenu, error: erreurLecture } = await supabase.from('autres_revenus').select('*').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!revenu) return res.status(404).json({ error: 'Autre revenu introuvable.' });
  if (revenu.annule) return res.status(400).json({ error: 'Cet autre revenu est déjà annulé.' });
  if (revenu.caissier_uid === req.user.id) return res.status(403).json({ error: "Tu ne peux pas annuler un revenu que tu as toi-même enregistré : demande à la direction." });
  const { data, error } = await supabase.from('autres_revenus')
    .update({ annule: true, annule_par: req.user.email || req.user.id, annule_par_uid: req.user.id, annule_le: new Date().toISOString(), motif_annulation: motif })
    .eq('id', req.params.id).eq('annule', false).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.status(409).json({ error: 'Cet autre revenu vient d\'être annulé par quelqu\'un d\'autre.' });
  await enregistrerAuditServeur(req, 'autre_revenu_annule', { id: revenu.id, montant: revenu.montant, motif: revenu.motif, motifAnnulation: motif });
  res.json(data[0]);
});

// Annulation d'un paiement — réservée à direction/administrateur (jamais celui qui a
// encaissé lui-même, pour éviter qu'une caissière encaisse en cash puis annule pour
// empocher). Le paiement n'est jamais supprimé, juste marqué — la trace reste complète.
app.patch('/api/paiements/:id/annuler', async (req, res) => {
  if (!(await aPermission(req.user.id, 'paiement_annuler'))) {
    return res.status(403).json({ error: "Permission 'paiement_annuler' requise pour annuler une transaction déjà encaissée." });
  }
  const { motif } = req.body;
  if (!motif || !motif.trim()) return res.status(400).json({ error: "Un motif est requis pour annuler une transaction." });

  const { data: paiement, error: erreurLecture } = await supabase.from('paiements').select('*').eq('id', req.params.id).single();
  if (erreurLecture) return res.status(404).json({ error: "Paiement introuvable." });
  if (paiement.annule) return res.status(400).json({ error: "Ce paiement est déjà annulé." });
  // Empêche d'annuler sa propre transaction (une caissière — ou n'importe qui ayant aussi
  // caisse_travailler — ne doit jamais pouvoir encaisser en cash puis annuler pour empocher).
  // traite_par_uid absent (ex: paiement d'exonération) = pas de vérification possible, on laisse
  // passer plutôt que de bloquer une annulation légitime sans piste d'identification.
  if (paiement.traite_par_uid && paiement.traite_par_uid === req.user.id) {
    return res.status(403).json({ error: "Impossible d'annuler une transaction que vous avez vous-même encaissée — demande à quelqu'un d'autre." });
  }

  const { data, error } = await supabase
    .from('paiements')
    .update({ annule: true, annule_par: req.user.email || req.user.id, annule_par_uid: req.user.id, annule_le: new Date().toISOString(), motif_annulation: motif })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Retour d'Esdras (27/08, remplace l'ancienne route POST /api/fiches/:id/rembourser-partenaire du
// 25/08 — même principe étendu à tout un épisode plutôt qu'une fiche à la fois, après un long
// brainstorming) : transformer un patient privé en partenaire distingue 2 cas bien différents.
//
// CAS 1 (ci-dessous, /transferer-partenaire) : le partenaire prend en charge le patient À PARTIR
// DE MAINTENANT (déjà à l'hôpital, payait normalement jusqu'ici) — AUCUN remboursement des
// services déjà rendus (déjà payés, déjà consommés) : ils restent tels quels sur l'épisode
// d'origine, qui se ferme simplement pour laisser place à un nouvel épisode partenaire pour la
// suite. Seul le solde de dépôt NON DÉPENSÉ est remboursé (ce n'est pas un service déjà rendu,
// juste de l'argent que le patient n'a plus besoin de laisser une fois le partenaire responsable).
//
// CAS 2 (plus bas, /rembourser-transferer-partenaire) : le partenaire couvrait DÉJÀ le patient
// (référence, notification de groupe...) mais la notification n'a pas atteint la caisse à temps —
// TOUT ce qui a été payé sur les fiches choisies est remboursé aujourd'hui (cash ET dépôt
// confondus), un solde à crédit (jamais réellement encaissé) est simplement annulé plutôt que
// remboursé, et les fiches choisies sont transférées vers UN SEUL nouvel épisode partenaire.
//
// Les 2 cas restent réservés à paiement_annuler (jamais une caissière, jamais l'auto-traitement
// n'est un souci ici — retour d'Esdras : "la direction ne fait pas de décaissement").
app.post('/api/episodes/:id/transferer-partenaire', async (req, res) => {
  if (!(await aPermission(req.user.id, 'paiement_annuler'))) {
    return res.status(403).json({ error: "Permission 'paiement_annuler' requise." });
  }
  const { ong_partenaire, motif, autorise_par } = req.body;
  if (!ong_partenaire) return res.status(400).json({ error: "Le partenaire est requis." });
  if (!motif || !motif.trim()) return res.status(400).json({ error: "Un motif est requis." });
  if (!autorise_par || !autorise_par.trim()) return res.status(400).json({ error: "Le nom de la personne qui autorise ce changement est requis." });

  const { data: episode, error: erreurEpisode } = await supabase.from('episodes').select('*').eq('id', req.params.id).maybeSingle();
  if (erreurEpisode) return res.status(500).json({ error: erreurEpisode.message });
  if (!episode) return res.status(404).json({ error: "Épisode introuvable." });
  // Sans remboursement n'a de sens que pour un épisode encore ouvert (le patient est encore là,
  // le partenaire prend le relais À PARTIR DE MAINTENANT) — un épisode déjà fermé n'a plus de
  // "suite" à transférer, voir /rembourser-transferer-partenaire pour une correction rétroactive.
  if (episode.statut !== 'ouvert') return res.status(400).json({ error: "Seul un épisode ouvert peut être transféré sans remboursement." });

  const { data: dossier } = await supabase.from('dossiers').select('nom').eq('id', episode.dossier_id).maybeSingle();
  const encaissePar = req.user.email || req.user.id;
  const maintenant = new Date().toISOString();
  const detailsAudit = { motif: motif.trim(), autorise_par: autorise_par.trim(), ong_partenaire };

  const { data: paiements, error: erreurPaiements } = await supabase
    .from('paiements').select('*').eq('episode_id', episode.id).or('annule.eq.false,annule.is.null').is('supprime_le', null);
  if (erreurPaiements) return res.status(500).json({ error: erreurPaiements.message });
  const { soldeDepot } = calculerSoldeDepot(paiements);

  let paiementDepot = null;
  if (soldeDepot > 0) {
    const { data, error } = await supabase.from('paiements').insert({
      episode_id: episode.id, fiche_id: null, patient_nom: dossier?.nom || null,
      montant: soldeDepot, mode: 'remboursement_patient',
      date_paiement: maintenant, encaisse_par: encaissePar, traite_par_uid: req.user.id,
      details: detailsAudit,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    paiementDepot = data;
  }

  const { data: nouvelEpisode, error: erreurNouvelEpisode } = await supabase.from('episodes').insert({
    dossier_id: episode.dossier_id, voie_entree: episode.voie_entree, service: episode.service,
    type_patient: 'partenaire', ong_partenaire, statut: 'ouvert', est_hospitalisation: episode.est_hospitalisation,
  }).select().single();
  if (erreurNouvelEpisode) {
    if (paiementDepot) await supabase.from('paiements').delete().eq('id', paiementDepot.id);
    return res.status(500).json({ error: erreurNouvelEpisode.message });
  }

  // Referme l'épisode d'origine — best-effort, jamais bloquant (la correction ci-dessus est déjà
  // complète et valide à ce stade), même philosophie que le Cas 2 plus bas.
  await supabase.from('episodes').update({ statut: 'ferme' }).eq('id', episode.id).select();

  res.status(201).json({ paiementDepot, nouvelEpisode: await episodeVersFlat(nouvelEpisode) });
});

app.post('/api/episodes/:id/rembourser-transferer-partenaire', async (req, res) => {
  if (!(await aPermission(req.user.id, 'paiement_annuler'))) {
    return res.status(403).json({ error: "Permission 'paiement_annuler' requise." });
  }
  const { ong_partenaire, motif, autorise_par, fiche_ids } = req.body;
  if (!ong_partenaire) return res.status(400).json({ error: "Le partenaire est requis." });
  if (!motif || !motif.trim()) return res.status(400).json({ error: "Un motif est requis." });
  if (!autorise_par || !autorise_par.trim()) return res.status(400).json({ error: "Le nom de la personne qui autorise ce changement est requis." });
  if (!Array.isArray(fiche_ids) || fiche_ids.length === 0) return res.status(400).json({ error: "Au moins une fiche doit être sélectionnée." });

  const { data: episode, error: erreurEpisode } = await supabase.from('episodes').select('*').eq('id', req.params.id).maybeSingle();
  if (erreurEpisode) return res.status(500).json({ error: erreurEpisode.message });
  if (!episode) return res.status(404).json({ error: "Épisode introuvable." });

  const { data: fiches, error: erreurFiches } = await supabase.from('fiches').select('*').eq('episode_id', episode.id).in('id', fiche_ids).is('supprime_le', null);
  if (erreurFiches) return res.status(500).json({ error: erreurFiches.message });
  if ((fiches || []).length !== fiche_ids.length) return res.status(400).json({ error: "Une ou plusieurs fiches sélectionnées n'appartiennent pas à cet épisode." });

  const { data: paiementsEpisode, error: erreurPaiementsEpisode } = await supabase
    .from('paiements').select('*').eq('episode_id', episode.id).or('annule.eq.false,annule.is.null').is('supprime_le', null);
  if (erreurPaiementsEpisode) return res.status(500).json({ error: erreurPaiementsEpisode.message });

  // Validé AVANT de toucher à quoi que ce soit : le paiement "encaissable ou à crédit" d'origine
  // de chaque fiche (pas déjà annulé — donc pas déjà transféré via cette même route, qui annule ou
  // rembourse toujours l'original — ni un mode qui n'a pas de sens ici).
  const paiementsOriginaux = new Map();
  for (const fiche of fiches) {
    const paiementOriginal = paiementsEpisode.find(p => p.fiche_id === fiche.id && !['ong', 'exoneration', 'remboursement_patient', 'remboursement_credit'].includes(p.mode));
    if (!paiementOriginal) {
      return res.status(400).json({ error: `Aucun paiement encaissable ou à crédit trouvé pour la fiche N°${fiche.numero_fiche} (déjà transférée, déjà annulée, ou déjà facturée à un partenaire).` });
    }
    paiementsOriginaux.set(fiche.id, paiementOriginal);
  }

  // Audit du 01/09 : une fiche à crédit voit son solde simplement ANNULÉ (rien n'a été encaissé,
  // donc rien à rendre). Sauf si le patient avait déjà remboursé une partie de ce crédit en
  // espèces : cet argent-là est bien sorti de sa poche et bien entré dans le tiroir. L'annulation
  // ne le lui rend pas, et le partenaire est facturé pour la fiche entière — l'hôpital serait payé
  // deux fois pour la même somme, et le patient perdrait ce qu'il a versé, sans que rien ne
  // l'affiche nulle part.
  // On ne peut pas rembourser automatiquement : un remboursement de crédit est rattaché à
  // l'ÉPISODE, jamais à une fiche précise (voir toPaiementApi côté navigateur, aucun fiche_id) —
  // impossible donc de savoir quelle part revient à quelle fiche. On refuse plutôt que de faire
  // disparaître de l'argent en silence, en disant le montant exact et quoi faire.
  const auMoinsUneFicheACredit = [...paiementsOriginaux.values()].some(p => p.mode === 'credit');
  if (auMoinsUneFicheACredit) {
    const dejaRembourse = paiementsEpisode
      .filter(p => p.mode === 'remboursement_credit')
      .reduce((s, p) => s + (parseFloat(p.montant) || 0), 0);
    if (dejaRembourse > 0) {
      return res.status(409).json({
        error: `Ce patient a déjà remboursé ${dejaRembourse} Gdes de son crédit sur cet épisode. Annuler le crédit ne lui rendrait PAS cet argent, alors que le partenaire serait facturé pour la totalité — l'hôpital serait payé deux fois. Rends-lui d'abord ces ${dejaRembourse} Gdes à la caisse, puis recommence ce transfert. (Ou décoche les fiches payées à crédit.)`,
      });
    }
  }

  const { data: dossier } = await supabase.from('dossiers').select('nom').eq('id', episode.dossier_id).maybeSingle();
  const encaissePar = req.user.email || req.user.id;
  const maintenant = new Date().toISOString();
  const motifTrim = motif.trim(); const autoriseParTrim = autorise_par.trim();
  const detailsAudit = { motif: motifTrim, autorise_par: autoriseParTrim, ong_partenaire };

  // Un seul nouvel épisode, OUVERT (retour d'Esdras, 29/08 : "je vois que le nouvel épisode créé
  // est aussi archivé, il devrait être actif avec les nouvelles fiches non ?") — reçoit TOUTES les
  // fiches transférées, jamais un épisode par fiche. Créé fermé jusqu'ici (pensé comme une pure
  // correction comptable rétroactive, "pas une nouvelle visite") : en pratique le patient est
  // souvent encore à l'hôpital au moment du transfert, et la caisse doit pouvoir continuer à
  // ajouter des fiches sur ce même épisode partenaire par la suite — un épisode 'ferme' l'en
  // empêchait (voir PUT /api/episodes/:id, qui réserve la modif d'un épisode fermé à
  // facturation_modifier). Reste à fermer normalement plus tard, via Archiver, comme tout épisode.
  const { data: nouvelEpisode, error: erreurNouvelEpisode } = await supabase.from('episodes').insert({
    dossier_id: episode.dossier_id, voie_entree: 'consultation', service: episode.service || 'Général',
    type_patient: 'partenaire', ong_partenaire, statut: 'ouvert', est_hospitalisation: false,
  }).select().single();
  if (erreurNouvelEpisode) return res.status(500).json({ error: erreurNouvelEpisode.message });

  // Nettoyage en cas d'échec en cours de route — tout ce qui a déjà été inséré est retiré, dans
  // l'ordre inverse, pour ne jamais laisser une correction financière à moitié faite. Une fiche
  // annulée (cas crédit) n'est PAS ré-activée par ce nettoyage — best-effort, comme partout
  // ailleurs dans ce fichier, mais l'échec se produit avant ou après selon l'étape.
  const aNettoyer = { paiements: [], fiches: [], episodes: [nouvelEpisode.id] };
  const nettoyer = async () => {
    for (const id of aNettoyer.paiements) await supabase.from('paiements').delete().eq('id', id);
    for (const id of aNettoyer.fiches) await supabase.from('fiches').delete().eq('id', id);
    for (const id of aNettoyer.episodes) await supabase.from('episodes').delete().eq('id', id);
  };

  let numeroFiche = 1;
  const resultats = [];
  try {
    for (const fiche of fiches) {
      const paiementOriginal = paiementsOriginaux.get(fiche.id);

      if (paiementOriginal.mode === 'credit') {
        // Rien n'a jamais été réellement encaissé pour cette fiche — pas de sortie de cash, le
        // solde à crédit est simplement annulé (le patient ne le doit plus, transféré au partenaire).
        const { error } = await supabase.from('paiements').update({
          annule: true, annule_par: autoriseParTrim, annule_par_uid: req.user.id,
          annule_le: maintenant, motif_annulation: `Transféré à ${ong_partenaire} : ${motifTrim}`,
        }).eq('id', paiementOriginal.id).select().single();
        if (error) throw new Error(error.message);
      } else {
        const { data: remb, error } = await supabase.from('paiements').insert({
          episode_id: episode.id, fiche_id: fiche.id, patient_nom: paiementOriginal.patient_nom,
          montant: fiche.total_global, mode: 'remboursement_patient',
          date_paiement: maintenant, encaisse_par: encaissePar, traite_par_uid: req.user.id,
          details: detailsAudit,
        }).select().single();
        if (error) throw new Error(error.message);
        aNettoyer.paiements.push(remb.id);
      }

      // Fiche "reconduite" (mêmes articles/montant que l'originale) — aucun nouvel article, donc
      // aucun décrément de stock : les articles ont déjà été distribués à la création d'origine.
      const { data: nouvelleFiche, error: erreurNouvelleFiche } = await supabase.from('fiches').insert({
        episode_id: nouvelEpisode.id, numero_fiche: numeroFiche++, cree_par: encaissePar, cree_par_uid: req.user.id,
        raw_state: fiche.raw_state, total_global: fiche.total_global, breakdown: fiche.breakdown, mode_paiement: 'ong',
      }).select().single();
      if (erreurNouvelleFiche) throw new Error(erreurNouvelleFiche.message);
      aNettoyer.fiches.push(nouvelleFiche.id);

      const { data: paiementOng, error: erreurPaiementOng } = await supabase.from('paiements').insert({
        episode_id: nouvelEpisode.id, fiche_id: nouvelleFiche.id, patient_nom: paiementOriginal.patient_nom,
        montant: fiche.total_global, mode: 'ong', ong_partenaire, solde_restant: 0,
        date_paiement: maintenant, encaisse_par: encaissePar, traite_par_uid: req.user.id,
      }).select().single();
      if (erreurPaiementOng) throw new Error(erreurPaiementOng.message);
      aNettoyer.paiements.push(paiementOng.id);

      resultats.push({ ficheOriginale: fiche.id, nouvelleFiche: nouvelleFiche.id });
    }

    // Solde de dépôt restant sur l'épisode — remboursé une seule fois pour tout l'épisode, jamais
    // par fiche (un dépôt n'est jamais lié à une fiche précise).
    const { soldeDepot } = calculerSoldeDepot(paiementsEpisode);
    let paiementDepot = null;
    if (soldeDepot > 0) {
      const { data, error } = await supabase.from('paiements').insert({
        episode_id: episode.id, fiche_id: null, patient_nom: dossier?.nom || null,
        montant: soldeDepot, mode: 'remboursement_patient',
        date_paiement: maintenant, encaisse_par: encaissePar, traite_par_uid: req.user.id,
        details: detailsAudit,
      }).select().single();
      if (error) throw new Error(error.message);
      paiementDepot = data;
      aNettoyer.paiements.push(paiementDepot.id);
    }

    // Referme l'épisode d'origine — TOUJOURS, même si certaines fiches n'ont pas été incluses
    // (retour d'Esdras, 27/08 : "oui, toujours fermé").
    await supabase.from('episodes').update({ statut: 'ferme' }).eq('id', episode.id).select();

    res.status(201).json({ resultats, paiementDepot, nouvelEpisode: await episodeVersFlat(nouvelEpisode) });
  } catch (e) {
    await nettoyer();
    res.status(500).json({ error: e.message });
  }
});

// Numéro de lot suivant, pour un partenaire — ATOMIQUE (une seule requête SQL qui lit et
// incrémente en même temps), contrairement à l'ancien calcul côté navigateur (max des lots
// existants + 1) qui pouvait attribuer 2 fois le même numéro si généré 2 fois à quelques
// secondes d'écart. ong_partenaires.prochain_numero devient la vraie source, mise à jour à
// chaque appel — plus besoin de la recalculer depuis l'historique des lots.
app.post('/api/lots/prochain-numero', async (req, res) => {
  if (!(await aPermission(req.user.id, 'facturation_exporter'))) {
    return res.status(403).json({ error: "Permission 'facturation_exporter' requise." });
  }
  const { ong_partenaire } = req.body;
  if (!ong_partenaire) return res.status(400).json({ error: 'ong_partenaire requis' });
  const { data, error } = await supabase.rpc('incrementer_prochain_numero_lot', { p_ong: ong_partenaire });
  if (error) return res.status(500).json({ error: error.message });
  if (data === null || data === undefined) return res.status(404).json({ error: `Partenaire "${ong_partenaire}" introuvable.` });
  res.json({ numero: data });
});

// Renommer un partenaire (16/10) : le nom du partenaire, celui de tous ses épisodes et paiements, et la clé de ses dons de médicaments changent EN UN BLOC
// (fonction SQL renommer_partenaire, sql/renommer_partenaire_avec_dons.sql) — l'historique reste d'un seul morceau. RÉSERVÉ aux rôles « administrateur » et « direction »
// (demande d'Esdras) : volontairement un contrôle de rôle et non une permission, comme /api/admin/anomalies, donc pas modifiable par l'écran Rôles & permissions.
app.patch('/api/ong-partenaires/:id/renommer', async (req, res) => {
  const { data: profil, error: erreurProfil } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
  if (erreurProfil) return res.status(500).json({ error: erreurProfil.message });
  if (!profil || !['administrateur', 'direction'].includes(profil.role)) return res.status(403).json({ error: "Réservé à l'administrateur et à la direction." });
  const nouveauNom = typeof req.body.nom === 'string' ? req.body.nom.trim().replace(/\s+/g, ' ') : '';
  if (!nouveauNom) return res.status(400).json({ error: 'Le nouveau nom est requis.' });
  if (nouveauNom.length > 100) return res.status(400).json({ error: 'Le nom est trop long (100 caractères au plus).' });
  const { data: avant } = await supabase.from('ong_partenaires').select('nom').eq('id', req.params.id).is('supprime_le', null).maybeSingle();
  const { data, error } = await supabase.rpc('renommer_partenaire', { p_id: req.params.id, p_nouveau_nom: nouveauNom });
  if (error) {
    const statut = { CHF20: 400, CHF21: 404, CHF22: 409 }[error.code] || 500;
    return res.status(statut).json({ error: error.message });
  }
  if (!data.inchange) await enregistrerAuditServeur(req, 'renommer_partenaire', { id: req.params.id, ancien_nom: avant ? avant.nom : null, nouveau_nom: nouveauNom, episodes: data.episodes, paiements: data.paiements, dons: data.dons });
  res.json({ ...data, nom: nouveauNom });
});

// Décrémente le stock de façon atomique (voir fonction_decrementer_stock_et_numerotation_lots.sql) — remplace le
// calcul côté navigateur + réécriture complète du catalogue, qui pouvait perdre une vente si
// 2 ventes du même médicament arrivaient presque en même temps (2e écriture qui efface la
// 1ère au lieu de s'additionner). Tout-ou-rien : si un seul article manque, rien n'est décrémenté.
app.post('/api/stock/decrementer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { decrements } = req.body; // [{ id, qte }, ...]
  if (!Array.isArray(decrements) || decrements.length === 0) {
    return res.status(400).json({ error: 'decrements (tableau non vide) requis.' });
  }
  // Idempotence (audit hors ligne du 01/09) : c'était la SEULE route d'écriture de la file hors
  // ligne sans protection contre un rejeu. Depuis que syncPending garde les opérations "en vol"
  // jusqu'à confirmation du serveur (api/supabase.js), un arrêt brutal entre l'envoi et sa
  // confirmation fait rejouer l'opération au démarrage suivant — sans garde, le stock aurait été
  // décrémenté deux fois pour une seule vente. La trace est posée dans la MÊME transaction que le
  // décrément (voir decrementer_stock_medicaments(jsonb, text), sql/idempotence_decrement_stock.sql).
  const local_id = req.body.local_id || req.body.localId || null;
  // Retour d'Esdras (29/08) : alerte WhatsApp quand un médicament FRANCHIT son seuil critique —
  // lu AVANT le décrément pour ne comparer qu'à ce moment précis (avant > seuil, après <= seuil),
  // sinon chaque vente suivante d'un article déjà bas redéclencherait une alerte à chaque fois.
  const { data: avantData } = await supabase.from('catalog').select('items').eq('type', 'medicaments').single();
  const avantParId = new Map((avantData?.items || []).map(m => [m.id, m]));

  // 22/10 (Esdras) : un épisode d'un SERVICE puise d'abord dans le stock de ce service (celui de ses réquisitions), puis dans la pharmacie — voir sql/stock_par_service.sql.
  // Sans service (consultation, Achat Express...) : le stock de la pharmacie, comme avant.
  const serviceVente = typeof req.body.service === 'string' ? req.body.service.trim() : '';
  const { data, error } = serviceVente
    ? await supabase.rpc('decrementer_stock_service', { p_service: serviceVente, p_decrements: decrements, p_local_id: local_id })
    : await supabase.rpc('decrementer_stock_medicaments', { p_decrements: decrements, p_local_id: local_id });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL decrementer_stock_medicaments n'existe pas encore dans Supabase — colle fonction_decrementer_stock_et_numerotation_lots.sql puis idempotence_decrement_stock.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  // Rejeu détecté : le stock a déjà été décrémenté par le premier envoi (voir local_id ci-dessus).
  // On répond 200 avec l'état actuel, comme pour un succès — c'est ce que la file hors ligne attend
  // pour considérer l'opération terminée et la sortir définitivement.
  if (data.deja_applique) {
    console.log(`↩️ Décrément de stock déjà appliqué (local_id=${local_id}) — rejeu ignoré.`);
    return res.json({ success: true, deja_applique: true, items: data.items });
  }
  if (!data.succes) {
    const detail = (data.manquants || []).map(m => `${m.nom || m.id} (${m.disponible} restant)`).join(', ');
    return res.status(409).json({ error: `Stock insuffisant : ${detail}`, manquants: data.manquants });
  }

  const { data: parametresData } = await supabase.from('catalog').select('items').eq('type', 'parametres').maybeSingle();
  const seuilParDefaut = parametresData?.items?.seuilStockBas ?? 5;
  const franchissements = decrements
    .map(d => avantParId.get(d.id))
    .filter(Boolean)
    .map(avant => ({ avant, apres: (data.items || []).find(m => m.id === avant.id) }))
    .filter(({ avant, apres }) => apres && (avant.seuilAlerte ?? seuilParDefaut) < avant.quantite && apres.quantite <= (avant.seuilAlerte ?? seuilParDefaut));
  if (franchissements.length > 0) {
    const detail = franchissements.map(({ avant, apres }) => `${avant.nom} (reste ${apres.quantite})`).join(', ');
    envoyerCallMeBot(`📦 CHF : stock bas — ${detail}`); // best-effort, ne bloque jamais la réponse à la caisse
  }

  res.json({ success: true, items: data.items, ...(data.repartition ? { repartition: data.repartition } : {}) });
});

// Restitution d'une vente annulée (fiche supprimée, encaissement échoué) : chaque article revient là où il avait été pris — stock du service ou pharmacie
// (voir restituer_stock_ventes, sql/stock_par_service.sql). entrees : [{ fiche | origine, lignes: [{ id, qte }] }]. Idempotent par local_id.
app.post('/api/stock/restituer', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { entrees } = req.body;
  if (!Array.isArray(entrees) || entrees.length === 0 || entrees.length > 100) {
    return res.status(400).json({ error: 'entrees (1 à 100) requises.' });
  }
  for (const e of entrees) {
    const bonneRef = (typeof e?.fiche === 'string' && e.fiche) || (typeof e?.origine === 'string' && e.origine);
    const bonnesLignes = Array.isArray(e?.lignes) && e.lignes.length > 0 && e.lignes.every(l => l && typeof l.id === 'string' && Number(l.qte) > 0);
    if (!bonneRef || !bonnesLignes) return res.status(400).json({ error: 'Chaque entrée a besoin d\'une fiche (ou origine) et de lignes { id, qte > 0 }.' });
  }
  const local_id = req.body.local_id || req.body.localId || null;
  const { data, error } = await supabase.rpc('restituer_stock_ventes', { p_entrees: entrees, p_local_id: local_id });
  if (error) {
    if (error.code === '42883') return res.status(500).json({ error: "La fonction SQL restituer_stock_ventes n'existe pas encore dans Supabase — colle stock_par_service.sql dans le SQL Editor." });
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, ...(data.deja_applique ? { deja_applique: true } : {}), items: data.items });
});

// ============================================================
// RÉQUISITIONS — retour d'Esdras (23/08) : jusqu'ici, réquisitionner du stock pour un autre
// service voulait dire aller corriger chaque médicament un par un dans "Gestion des stocks"
// (fastidieux, aucune trace de quel service a pris quoi). Réutilise la fonction Postgres
// atomique de décrément déjà utilisée pour les ventes (tout-ou-rien, jamais de survente), avec
// une trace en plus (table requisitions) pour le rapport "médicaments par service".
// ============================================================

// stock_gerer : même permission que le reste de "Gestion des stocks" — une réquisition retire du
// vrai stock, ce n'est pas une vente (donc pas caisse_travailler).
app.post('/api/requisitions', async (req, res) => {
  if (!(await aPermission(req.user.id, 'stock_gerer'))) {
    return res.status(403).json({ error: "Permission 'stock_gerer' requise." });
  }
  const { service_demandeur, lignes, demande_par } = req.body;
  if (!service_demandeur || !String(service_demandeur).trim()) {
    return res.status(400).json({ error: 'service_demandeur est requis.' });
  }
  if (!Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ error: 'lignes (tableau non vide) requis.' });
  }
  // Audit hors ligne du 03/09 : cette route était la PIRE des trois trouvées — un rejeu sortait le
  // stock DEUX fois ET laissait 2 lignes au registre pour une seule demande réelle (le service
  // reçoit 10 sérums, le stock en compte 20 de moins). Le commentaire d'origine justifiait
  // l'absence de local_id par "les réquisitions ne passent jamais par la file hors ligne" — c'était
  // faux : chf.creerRequisition() est un this.request() ordinaire, donc mis en file comme le reste.
  // Double protection, exactement comme dossiers/fiches/paiements :
  //   1. la ligne déjà écrite est renvoyée telle quelle (200) si ce local_id est déjà connu ;
  //   2. le décrément passe par la surcharge idempotente (p_local_id) — donc même si l'insert
  //      ci-dessous échoue et que l'opération est rejouée, le stock ne sort qu'une fois.
  const local_id = req.body.local_id || req.body.localId || null;
  if (local_id) {
    const { data: existante } = await supabase.from('requisitions').select('*').eq('local_id', local_id).maybeSingle();
    if (existante) return res.status(200).json({ ...existante, deja_applique: true });
  }
  // 22/10 (Esdras) : une réquisition DONNE le stock au service (la pharmacie diminue, le stock du service augmente) ; les épisodes de ce service puisent ensuite dedans.
  // Atomique (une seule fonction SQL, voir sql/stock_par_service.sql), tout-ou-rien, idempotente par local_id.
  if (lignes.some(l => !l || !l.id || !(Number(l.qte) > 0))) {
    return res.status(400).json({ error: 'Chaque ligne a besoin d\'un médicament et d\'une quantité supérieure à 0.' });
  }
  const { data, error } = await supabase.rpc('transferer_stock_service', {
    p_service: String(service_demandeur).trim(),
    p_lignes: lignes.map(l => ({ id: l.id, qte: Number(l.qte) })),
    p_local_id: local_id,
  });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL transferer_stock_service n'existe pas encore dans Supabase — colle stock_par_service.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  if (!data.succes) {
    const detail = (data.manquants || []).map(m => `${m.nom || m.id} (${m.disponible} restant à la pharmacie)`).join(', ');
    return res.status(409).json({ error: `Stock insuffisant : ${detail}`, manquants: data.manquants });
  }
  // Les noms viennent du catalogue à jour renvoyé par le décrément (pas de req.body) — la
  // réquisition doit rester lisible même si un médicament est renommé/supprimé plus tard.
  const lignesAvecNoms = lignes.map(l => {
    const article = (data.items || []).find(i => i.id === l.id);
    return { id: l.id, nom: article ? article.nom : l.id, quantite: l.qte };
  });
  const { data: requisition, error: erreurInsert } = await supabase.from('requisitions').insert({
    service_demandeur: service_demandeur.trim(), lignes: lignesAvecNoms,
    demande_par: demande_par || null, demande_par_uid: req.user.id, local_id: local_id || null,
    stock_par_service: true, // les réquisitions d'avant (stock simplement sorti de la pharmacie) gardent l'ancien comportement à l'annulation / modification
  }).select().single();
  if (erreurInsert) {
    // 23505 = ce local_id est déjà en base : un rejeu a doublé l'insert entre la lecture ci-dessus
    // et ici (deux onglets, ou une reprise de file très rapprochée). La ligne existe donc bien —
    // la renvoyer vaut mieux qu'une erreur 500 qui ferait retenter indéfiniment.
    if (erreurInsert.code === '23505' && local_id) {
      const { data: existante } = await supabase.from('requisitions').select('*').eq('local_id', local_id).maybeSingle();
      if (existante) return res.status(200).json({ ...existante, deja_applique: true });
    }
    return res.status(500).json({ error: erreurInsert.message });
  }
  res.status(201).json({ ...requisition, items: data.items });
});

// analytics_voir en plus de stock_gerer : Direction/comptable doivent pouvoir consulter le
// rapport "médicaments par service" sans avoir le droit de sortir du stock eux-mêmes.
app.get('/api/requisitions', async (req, res) => {
  // requisitions_voir (28/08) ajouté : l'écran Réquisitions en lecture seule (visiteur) a besoin
  // de pouvoir lister les réquisitions, sans le droit d'en créer une (stock_gerer, inchangé).
  if (!(await aPermission(req.user.id, 'stock_gerer')) && !(await aPermission(req.user.id, 'analytics_voir')) && !(await aPermission(req.user.id, 'requisitions_voir'))) {
    return res.status(403).json({ error: "Permission 'stock_gerer', 'analytics_voir' ou 'requisitions_voir' requise." });
  }
  // Paginée (25/09, audit avant mise en production) : sans ça, au-delà de 1000 réquisitions, les
  // plus anciennes disparaissaient en silence du rapport "médicaments par service".
  try {
    res.json(await lireToutesLesPages(
      () => supabase.from('requisitions').select('*').order('date_requisition', { ascending: false }).order('id')));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Réception de médicaments, annulation et modification des réquisitions (20/10, Esdras)
//  - La réception (achat ou don) a son propre onglet : on n'ajoute plus de stock « au clic » depuis la liste du stock. Chaque réception laisse une trace (qui, quand, quoi, source).
//    Un médicament reçu en DON peut être marqué « exonération jusqu'à 50 % ».
//  - Une réquisition déjà faite s'annule (le stock revient) ou se modifie (le stock suit la différence) ; jamais supprimée : la trace reste.
// ============================================================
const SOURCES_RECEPTION = ['achat', 'don'];
app.get('/api/receptions-medicaments', async (req, res) => {
  if (!(await aPermission(req.user.id, 'stock_reception')) && !(await aPermission(req.user.id, 'stock_gerer')) && !(await aPermission(req.user.id, 'stock_voir'))) {
    return res.status(403).json({ error: "Permission 'stock_reception', 'stock_gerer' ou 'stock_voir' requise." });
  }
  try {
    res.json(await lireToutesLesPages(() => supabase.from('receptions_medicaments').select('*').order('date_reception', { ascending: false }).order('id')));
  } catch (e) {
    if (/receptions_medicaments/.test(String(e.message)) && /does not exist|schema cache|relation/.test(String(e.message))) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/stock/reception', async (req, res) => {
  if (!(await aPermission(req.user.id, 'stock_reception'))) return res.status(403).json({ error: "Permission 'stock_reception' requise." });
  const { lignes } = req.body;
  if (!Array.isArray(lignes) || lignes.length === 0 || lignes.length > 100) return res.status(400).json({ error: 'lignes (1 à 100) requises.' });
  for (const l of lignes) {
    if (!l || !l.id || !(Number(l.quantite) > 0) || Number(l.quantite) > 10000000) return res.status(400).json({ error: 'Chaque ligne a besoin d\'un médicament et d\'une quantité supérieure à 0.' });
    if (!SOURCES_RECEPTION.includes(l.source)) return res.status(400).json({ error: "Chaque ligne a besoin d'une source : achat ou don." });
    if (l.source === 'don' && typeof l.exoneration_50 !== 'boolean') return res.status(400).json({ error: "Pour un don, indique « exonération jusqu'à 50 % » : oui ou non." });
  }
  const local_id = req.body.local_id || req.body.localId || null;
  const note = typeof req.body.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 300) : null;
  const recuPar = req.user.email || req.user.id;
  let items = null;
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
    const idLigne = local_id ? `${local_id}-l${i}` : null;
    if (idLigne) {
      const { data: deja } = await supabase.from('receptions_medicaments').select('id').eq('local_id', idLigne).maybeSingle();
      if (deja) continue; // rejeu : cette ligne est déjà entrée
    }
    const quantite = Number(l.quantite);
    const { data: item, error } = await supabase.rpc('ajouter_stock_medicament', { p_id: l.id, p_quantite_ajoutee: quantite, p_local_id: idLigne ? `${idLigne}-stock` : null });
    if (error) return res.status(500).json({ error: `Ligne ${i + 1} (${l.id}) : ${error.message}`, lignes_deja_recues: i });
    const nom = (item && (item.item ? item.item.nom : item.nom)) || l.nom || l.id;
    if (l.source === 'don') {
      const { error: erreurFlag } = await supabase.rpc('marquer_exoneration_50_medicament', { p_id: l.id, p_valeur: l.exoneration_50 });
      if (erreurFlag) console.warn('Réception : marque « exonération 50 % » non enregistrée :', erreurFlag.message);
    }
    const { error: erreurTrace } = await supabase.from('receptions_medicaments').insert({
      medicament_id: l.id, nom, quantite, source: l.source, exoneration_50: l.source === 'don' ? l.exoneration_50 : null,
      note, recu_par: recuPar, recu_par_uid: req.user.id, local_id: idLigne,
    });
    if (erreurTrace && erreurTrace.code !== '23505') console.warn('Réception : trace non enregistrée :', erreurTrace.message);
  }
  const { data: catalogue } = await supabase.from('catalog').select('items').eq('type', 'medicaments').maybeSingle();
  items = (catalogue && catalogue.items) || [];
  await enregistrerAuditServeur(req, 'reception_medicaments', { lignes: lignes.map(l => ({ id: l.id, quantite: Number(l.quantite), source: l.source, exoneration_50: l.source === 'don' ? l.exoneration_50 : null })), note });
  res.status(201).json({ success: true, items });
});

// Compare l'ancienne et la nouvelle liste d'une réquisition : { id -> variation } (positif = il faut sortir plus de stock).
function variationsRequisition(anciennes, nouvelles) {
  const delta = new Map();
  for (const l of anciennes || []) delta.set(l.id, (delta.get(l.id) || 0) - (Number(l.quantite) || 0));
  for (const l of nouvelles || []) delta.set(l.id, (delta.get(l.id) || 0) + (Number(l.qte) || 0));
  return [...delta.entries()].filter(([, v]) => v !== 0).map(([id, variation]) => ({ id, variation }));
}
app.patch('/api/requisitions/:id/annuler', async (req, res) => {
  if (!(await aPermission(req.user.id, 'requisition_modifier'))) return res.status(403).json({ error: "Permission 'requisition_modifier' requise." });
  const motif = typeof req.body.motif === 'string' ? req.body.motif.trim() : '';
  if (motif.length < 5) return res.status(400).json({ error: "Un motif d'annulation (5 caractères au moins) est requis." });
  const { data: requisition, error: erreurLecture } = await supabase.from('requisitions').select('*').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!requisition) return res.status(404).json({ error: 'Réquisition introuvable.' });
  if (requisition.annulee) return res.status(400).json({ error: 'Cette réquisition est déjà annulée.' });
  // Réservation : un double clic ou deux postes ne peuvent pas rendre le stock deux fois.
  const { data: reservee, error: erreurReservation } = await supabase.from('requisitions')
    .update({ annulee: true, annulee_par: req.user.email || req.user.id, annulee_par_uid: req.user.id, annulee_le: new Date().toISOString(), motif_annulation: motif })
    .eq('id', req.params.id).eq('annulee', false).select();
  if (erreurReservation) return res.status(500).json({ error: erreurReservation.message });
  if (!reservee || reservee.length === 0) return res.status(409).json({ error: 'Cette réquisition vient d\'être annulée par quelqu\'un d\'autre.' });
  let items = null;
  const rouvrir = () => supabase.from('requisitions').update({ annulee: false, annulee_par: null, annulee_par_uid: null, annulee_le: null, motif_annulation: null }).eq('id', req.params.id).select();
  if (requisition.stock_par_service) {
    // 22/10 : le stock de cette réquisition est dans le service — il retourne à la pharmacie, mais seulement ce que le service n'a pas déjà utilisé.
    const { data, error } = await supabase.rpc('transferer_stock_service', {
      p_service: requisition.service_demandeur,
      p_lignes: (requisition.lignes || []).map(l => ({ id: l.id, qte: -(Number(l.quantite) || 0) })),
      p_local_id: `${requisition.id}-annulation`,
    });
    if (error || !data || !data.succes) {
      await rouvrir();
      if (error) return res.status(500).json({ error: `Stock non remis : ${error.message}` });
      const detail = (data.manquants || []).map(m => `${m.nom || m.id} (il en reste ${m.disponible} dans le service)`).join(', ');
      return res.status(409).json({ error: `Annulation impossible : le service a déjà utilisé une partie de ce stock — ${detail}. Utilise « Retourner à la pharmacie » pour ce qui reste.`, manquants: data.manquants });
    }
  } else {
    for (const l of requisition.lignes || []) {
      const { data, error } = await supabase.rpc('ajouter_stock_medicament', { p_id: l.id, p_quantite_ajoutee: Number(l.quantite) || 0, p_local_id: `${requisition.id}-annulation-${l.id}` });
      if (error) {
        // Le stock n'a pas pu être remis : on rouvre la réquisition (les lignes déjà remises le sont une seule fois grâce à leur identifiant).
        await rouvrir();
        return res.status(500).json({ error: `Stock non remis (${l.nom || l.id}) : ${error.message}` });
      }
    }
  }
  const { data: catalogue } = await supabase.from('catalog').select('items').eq('type', 'medicaments').maybeSingle();
  items = (catalogue && catalogue.items) || [];
  await enregistrerAuditServeur(req, 'requisition_annulee', { id: requisition.id, service: requisition.service_demandeur, lignes: requisition.lignes, motif });
  res.json({ ...reservee[0], items });
});
app.put('/api/requisitions/:id', async (req, res) => {
  if (!(await aPermission(req.user.id, 'requisition_modifier'))) return res.status(403).json({ error: "Permission 'requisition_modifier' requise." });
  const { service_demandeur, lignes } = req.body;
  if (!service_demandeur || !String(service_demandeur).trim()) return res.status(400).json({ error: 'service_demandeur est requis.' });
  if (!Array.isArray(lignes) || lignes.length === 0 || lignes.some(l => !l || !l.id || !(Number(l.qte) > 0))) return res.status(400).json({ error: 'lignes (non vides, quantités supérieures à 0) requises.' });
  const { data: requisition, error: erreurLecture } = await supabase.from('requisitions').select('*').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!requisition) return res.status(404).json({ error: 'Réquisition introuvable.' });
  if (requisition.annulee) return res.status(400).json({ error: 'Une réquisition annulée ne peut plus être modifiée.' });
  const variations = variationsRequisition(requisition.lignes, lignes);
  const jeton = req.body.local_id || req.body.localId || `${Date.now()}`;
  const aSortir = variations.filter(v => v.variation > 0);
  const aRemettre = variations.filter(v => v.variation < 0);
  let items = null;
  if (requisition.stock_par_service) {
    // 22/10 : le stock est dans le service. Changer de service = annuler puis refaire (le stock d'un service ne se déplace pas en douce vers un autre).
    if (String(service_demandeur).trim() !== String(requisition.service_demandeur).trim()) {
      return res.status(400).json({ error: "Pour changer de service, annule cette réquisition puis refais-en une pour le bon service." });
    }
    if (variations.length > 0) {
      const { data, error } = await supabase.rpc('transferer_stock_service', {
        p_service: requisition.service_demandeur,
        p_lignes: variations.map(v => ({ id: v.id, qte: v.variation })),
        p_local_id: `${requisition.id}-modif-${jeton}`,
      });
      if (error) return res.status(500).json({ error: error.message });
      if (!data.succes) {
        const detail = (data.manquants || []).map(m => `${m.nom || m.id} (${m.disponible} disponible ${m.lieu === 'service' ? 'dans le service' : 'à la pharmacie'})`).join(', ');
        return res.status(409).json({ error: `Stock insuffisant : ${detail}`, manquants: data.manquants });
      }
      items = data.items;
    }
  } else {
    if (aSortir.length > 0) {
      const { data, error } = await supabase.rpc('decrementer_stock_medicaments', { p_decrements: aSortir.map(v => ({ id: v.id, qte: v.variation })), p_local_id: `${requisition.id}-modif-${jeton}` });
      if (error) return res.status(500).json({ error: error.message });
      if (!data.succes) {
        const detail = (data.manquants || []).map(m => `${m.nom || m.id} (${m.disponible} disponible)`).join(', ');
        return res.status(409).json({ error: `Stock insuffisant : ${detail}`, manquants: data.manquants });
      }
      items = data.items;
    }
    for (const v of aRemettre) {
      const { error } = await supabase.rpc('ajouter_stock_medicament', { p_id: v.id, p_quantite_ajoutee: -v.variation, p_local_id: `${requisition.id}-modif-${jeton}-${v.id}` });
      if (error) return res.status(500).json({ error: `Stock non remis (${v.id}) : ${error.message}` });
    }
  }
  const { data: catalogue } = await supabase.from('catalog').select('items').eq('type', 'medicaments').maybeSingle();
  items = (catalogue && catalogue.items) || items || [];
  const lignesAvecNoms = lignes.map(l => ({ id: l.id, nom: (items.find(i => i.id === l.id) || {}).nom || l.nom || l.id, quantite: Number(l.qte) }));
  const { data: misAJour, error: erreurMaj } = await supabase.from('requisitions')
    .update({ service_demandeur: String(service_demandeur).trim(), lignes: lignesAvecNoms, modifiee_par: req.user.email || req.user.id, modifiee_par_uid: req.user.id, modifiee_le: new Date().toISOString() })
    .eq('id', req.params.id).eq('annulee', false).select();
  if (erreurMaj || !misAJour || misAJour.length === 0) return res.status(500).json({ error: erreurMaj ? erreurMaj.message : "La réquisition n'a pas pu être mise à jour (elle vient peut-être d'être annulée) : vérifie le stock." });
  await enregistrerAuditServeur(req, 'requisition_modifiee', { id: requisition.id, avant: { service: requisition.service_demandeur, lignes: requisition.lignes }, apres: { service: String(service_demandeur).trim(), lignes: lignesAvecNoms } });
  res.json({ ...misAJour[0], items });
});

// 22/10 (Esdras) : un service n'a pas utilisé tout ce qu'il avait réquisitionné — la pharmacie en chef (requisition_modifier) le RETOURNE à la pharmacie.
// Le stock du service diminue, celui de la pharmacie remonte ; refusé si le service n'en a pas autant. Tracé dans le journal d'audit.
app.post('/api/requisitions/retour', async (req, res) => {
  if (!(await aPermission(req.user.id, 'requisition_modifier'))) return res.status(403).json({ error: "Permission 'requisition_modifier' requise." });
  const { service, lignes } = req.body;
  if (!service || !String(service).trim()) return res.status(400).json({ error: 'service est requis.' });
  if (!Array.isArray(lignes) || lignes.length === 0 || lignes.some(l => !l || !l.id || !(Number(l.qte) > 0))) return res.status(400).json({ error: 'lignes (non vides, quantités supérieures à 0) requises.' });
  const motif = typeof req.body.motif === 'string' ? req.body.motif.trim().slice(0, 300) : '';
  const local_id = req.body.local_id || req.body.localId || null;
  const { data, error } = await supabase.rpc('transferer_stock_service', {
    p_service: String(service).trim(), p_lignes: lignes.map(l => ({ id: l.id, qte: -Number(l.qte) })), p_local_id: local_id ? `${local_id}-retour` : null,
  });
  if (error) {
    if (error.code === '42883') return res.status(500).json({ error: "La fonction SQL transferer_stock_service n'existe pas encore dans Supabase — colle stock_par_service.sql dans le SQL Editor." });
    return res.status(500).json({ error: error.message });
  }
  if (data.deja_applique) return res.json({ success: true, deja_applique: true, items: data.items });
  if (!data.succes) {
    const detail = (data.manquants || []).map(m => `${m.nom || m.id} (il en reste ${m.disponible} dans le service)`).join(', ');
    return res.status(409).json({ error: `Retour impossible : le service n'en a pas autant — ${detail}`, manquants: data.manquants });
  }
  await enregistrerAuditServeur(req, 'stock_service_retourne', { service: String(service).trim(), lignes: lignes.map(l => ({ id: l.id, quantite: Number(l.qte) })), motif: motif || null });
  res.json({ success: true, items: data.items });
});

// Ajoute du stock à UN médicament de façon atomique (voir fonction_maj_stock_medicament.sql) —
// remplace le read-modify-write complet du catalogue fait depuis GestionStock.js (lecture d'un
// instantané frais du catalogue puis réécriture du tableau entier), qui pouvait perdre la
// modification d'un autre poste si 2 personnes modifiaient le stock de 2 médicaments différents
// presque au même moment.
app.post('/api/stock/ajouter', async (req, res) => {
  if (!(await aPermission(req.user.id, 'stock_gerer'))) {
    return res.status(403).json({ error: "Permission 'stock_gerer' requise." });
  }
  const { id, quantite } = req.body;
  if (!id || typeof quantite !== 'number' || quantite <= 0) {
    return res.status(400).json({ error: 'id et quantite (nombre positif) requis.' });
  }
  // Audit hors ligne du 03/09 (Esdras : "vérifie la solidité des transactions hors lignes") :
  // cette route était ADDITIVE et sans protection contre un rejeu — prouvé en exécutant le
  // mécanisme (tests/hors_ligne_bout_en_bout.test.js) : une réception de 50 boîtes dont la
  // confirmation se perd en route entrait DEUX fois (stock fantôme, invisible jusqu'à
  // l'inventaire physique). Même remède que les décréments le 01/09 : surcharge de la fonction
  // Postgres avec un p_local_id, trace posée dans la MÊME transaction que l'ajout.
  const local_id = req.body.local_id || req.body.localId || null;
  const { data, error } = await supabase.rpc('ajouter_stock_medicament', { p_id: id, p_quantite_ajoutee: quantite, p_local_id: local_id });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL ajouter_stock_medicament n'existe pas encore dans Supabase — colle fonction_maj_stock_medicament.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  if (data && data.deja_applique) {
    console.log(`↩️ Ajout de stock déjà appliqué (local_id=${local_id}) — rejeu ignoré.`);
    return res.json({ success: true, deja_applique: true, item: data.item });
  }
  res.json({ success: true, item: data });
});

// Ajoute du stock DONNÉ par un ONG à UN médicament (voir fonction_stock_dons.sql) — séparé du
// stock acheté (catalog.items[].quantite), pour que le don d'un ONG ne se mélange jamais avec le
// stock normal et reste réservé à ses propres patients (voir PLAN_DONS_ONG.md).
app.post('/api/stock/ajouter-don', async (req, res) => {
  if (!(await aPermission(req.user.id, 'stock_gerer'))) {
    return res.status(403).json({ error: "Permission 'stock_gerer' requise." });
  }
  const { id, ong, quantite } = req.body;
  if (!id || !ong || typeof quantite !== 'number' || quantite <= 0) {
    return res.status(400).json({ error: 'id, ong et quantite (nombre positif) requis.' });
  }
  // Même protection contre le rejeu que /api/stock/ajouter juste au-dessus (audit du 03/09) : un
  // don de partenaire compté deux fois fausse en plus la facturation à ce partenaire, pas
  // seulement l'inventaire.
  const local_id = req.body.local_id || req.body.localId || null;
  const { data, error } = await supabase.rpc('ajouter_stock_don_medicament', { p_id: id, p_ong: ong, p_quantite_ajoutee: quantite, p_local_id: local_id });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL ajouter_stock_don_medicament n'existe pas encore dans Supabase — colle fonction_stock_dons.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  if (data && data.deja_applique) {
    console.log(`↩️ Ajout de stock donné déjà appliqué (local_id=${local_id}) — rejeu ignoré.`);
    return res.json({ success: true, deja_applique: true, item: data.item });
  }
  res.json({ success: true, item: data });
});

// Décrémente le stock DONNÉ par un ou plusieurs ONG, de façon atomique (voir
// fonction_stock_dons.sql) — appelé à l'encaissement pour les lignes prises sur un stock donné
// (réservation normale au patient du même ONG, ou déblocage exceptionnel justifié pour un autre
// patient — cette route ne fait pas la distinction, c'est CalculateurPanel.js qui décide et
// journalise le motif si c'est un déblocage). Tout-ou-rien, même principe que
// POST /api/stock/decrementer pour le stock acheté.
app.post('/api/stock/decrementer-dons', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { decrements } = req.body; // [{ id, ong, qte }, ...]
  if (!Array.isArray(decrements) || decrements.length === 0) {
    return res.status(400).json({ error: 'decrements (tableau non vide) requis.' });
  }
  // Même protection que /api/stock/decrementer ci-dessus — le stock donné se décrémente par la
  // même vente, donc il court exactement le même risque de double décrément à un rejeu.
  const local_id = req.body.local_id || req.body.localId || null;
  const { data, error } = await supabase.rpc('decrementer_stock_dons', { p_decrements: decrements, p_local_id: local_id });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL decrementer_stock_dons n'existe pas encore dans Supabase — colle fonction_stock_dons.sql puis idempotence_decrement_stock.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  if (data.deja_applique) {
    console.log(`↩️ Décrément de stock donné déjà appliqué (local_id=${local_id}) — rejeu ignoré.`);
    return res.json({ success: true, deja_applique: true, items: data.items });
  }
  if (!data.succes) {
    const detail = (data.manquants || []).map(m => `${m.nom || m.id} — don ${m.ong} (${m.disponible} restant)`).join(', ');
    return res.status(409).json({ error: `Stock donné insuffisant : ${detail}`, manquants: data.manquants });
  }
  res.json({ success: true, items: data.items });
});

// Modifie stock + seuil d'alerte d'UN médicament de façon atomique (même fonction SQL, même
// raison que ci-dessus).
app.patch('/api/stock/:id', async (req, res) => {
  if (!(await aPermission(req.user.id, 'stock_gerer'))) {
    return res.status(403).json({ error: "Permission 'stock_gerer' requise." });
  }
  const { id } = req.params;
  const { quantite, seuilAlerte } = req.body;
  if (typeof quantite !== 'number' || typeof seuilAlerte !== 'number') {
    return res.status(400).json({ error: 'quantite et seuilAlerte (nombres) requis.' });
  }
  const { data, error } = await supabase.rpc('definir_stock_medicament', { p_id: id, p_quantite: quantite, p_seuil_alerte: seuilAlerte });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL definir_stock_medicament n'existe pas encore dans Supabase — colle fonction_maj_stock_medicament.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, item: data });
});

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

// ============================================================
// SAUVEGARDE AUTOMATIQUE — Backup/Restore (AppHospitaliere.js) reste manuel, dépend de
// quelqu'un qui pense à cliquer. Ceci tourne tout seul, tous les jours, sans dépendre de
// personne. Exporte les tables essentielles vers un bucket Supabase Storage dédié, jamais vers
// le disque du serveur Render (éphémère — perdu à chaque redéploiement).
// ============================================================
const BUCKET_SAUVEGARDES = 'sauvegardes-automatiques';
// Audit du 31/08 : 5 tables réellement utilisées par l'app manquaient à cette liste et n'étaient
// donc sauvegardées NULLE PART — dont demandes_exoneration, qui est la trace de qui a accordé
// quelle remise et pour quel montant (donnée financière sensible). Les 4 autres :
// pieces_jointes (documents des patients), requisitions, transferts_service (mouvements des
// patients entre services) et salaires_service (base du calcul de rentabilité dans Analytics).
// 16/10 : + compteurs (numéros de dossier), doublons_ignores (paires de dossiers que la caisse a écartées) et migrations_appliquees (journal des scripts SQL).
const TABLES_A_SAUVEGARDER = [
  'dossiers', 'episodes', 'fiches', 'paiements', 'catalog', 'cloture_caisse', 'ong_partenaires',
  'users', 'audit_log', 'demandes_exoneration', 'pieces_jointes', 'requisitions',
  'transferts_service', 'salaires_service', 'depenses_caisse', 'autres_revenus', 'receptions_medicaments', 'decrements_stock_appliques',
  'invitations', 'compteurs', 'doublons_ignores', 'migrations_appliquees',
];
// Clé primaire de chaque table quand ce n'est pas "id" (recoupé le 25/09 dans
// information_schema.table_constraints — mêmes valeurs que ORDRE_RESTAURATION plus bas). Sert au
// tri TOTAL qu'exige la lecture paginée de la sauvegarde (voir lireToutesLesPages).
const CLE_PRIMAIRE_SAUVEGARDE = { catalog: 'type', decrements_stock_appliques: 'local_id', invitations: 'token', doublons_ignores: 'dossier_a,dossier_b', migrations_appliquees: 'nom' };

// 16/10 — sauvegarde COMPRESSÉE (format 2) : un dossier par sauvegarde (backup-AAAA-MM-JJ/), une ou plusieurs tranches .ndjson.gz par table (16 Mo de texte au plus chacune,
// donc jamais un énorme fichier unique en mémoire), et un manifeste (sommes SHA-256, nombre de lignes) écrit EN DERNIER. Toute la logique — sauvegarde, vérification,
// conservation (30 jours + 1 par mois sur 12 mois), restauration — vit dans utils/sauvegardeServeur.js, testée contre deux vraies bases PostgreSQL
// (scripts/restauration/essai-restauration.js). Les anciennes sauvegardes .json (format 1) restent lisibles et restaurables.
// Copie HORS SUPABASE (retour d'Esdras, 02/09 : "pourquoi la sauvegarde est sur Supabase ?" — la
// bonne question à se poser). Une sauvegarde qui vit dans le MÊME projet que les données qu'elle
// protège ne protège de rien en cas d'incident sur ce projet précis (panne, suspension pour
// facturation impayée, ou un accès malveillant qui supprime les données ET leur sauvegarde d'un
// seul geste, puisque les deux sont à portée de la même clé).
//
// Hébergée sur Backblaze B2 (10/09) — un stockage objet indépendant, sans AUCUN lien avec
// Supabase, Render ou Google : un incident sur l'un des trois n'emporte jamais les autres. Choisi
// après deux détours : le SMTP direct (nodemailer, ports 465 puis 587) restait bloqué en sortie
// par l'hébergeur, systématiquement, sans la moindre erreur — remplacé par l'API HTTP de Resend
// qui, elle, a marché ; mais joindre le fichier entier à un email a ses propres limites (40 Mo
// chez Resend, 50 Mo en réception Gmail), qu'une base en pleine croissance finirait par dépasser
// (retour d'Esdras : "quel serait la taille du fichier avec des milliers de transactions ?").
// Backblaze B2 n'a pas cette limite pratique (10 Go gratuits, fichiers bien plus gros acceptés) —
// la bonne solution à long terme, pas un simple pansement sur la taille du jour.
// L'API "native" de B2 (b2_authorize_account / b2_list_buckets / b2_get_upload_url, PAS le mode
// compatible S3) est utilisée volontairement : de simples appels HTTP avec fetch(), sans
// signature de requête façon AWS SigV4 — même esprit que CallMeBot/Resend, aucune dépendance
// ajoutée au projet.
// B2_KEY_ID/B2_APPLICATION_KEY : une "clé d'application" limitée à UN SEUL bucket (celui choisi
// à sa création) — jamais un accès à tout le compte Backblaze d'Esdras. Révocable seule depuis
// son tableau de bord, sans toucher au reste, même principe que les clés CallMeBot/Resend et
// l'ancien mot de passe d'application Gmail. Comme elles, best-effort et jamais codée en dur : si
// les variables d'environnement ne sont pas encore posées dans Render, la sauvegarde Supabase (le
// principal) continue normalement, seule cette copie manque, avec un avertissement dans les logs.
// Une notification par email (Resend) accompagne l'envoi — SANS pièce jointe cette fois (le
// fichier vit sur B2, l'email ne fait plus que confirmer que c'est fait) — mais son échec ne doit
// jamais faire échouer la copie B2 elle-même : c'est purement une commodité, pas le mécanisme de
// protection réel.
const DELAI_MAX_APPEL_B2_MS = 15000;

async function appelB2(url, options, gardeFouMs = DELAI_MAX_APPEL_B2_MS) {
  const controleur = new AbortController();
  const gardeFou = setTimeout(() => controleur.abort(), gardeFouMs);
  try {
    const reponse = await fetch(url, { ...options, signal: controleur.signal });
    const corps = await reponse.text();
    if (!reponse.ok) throw new Error(`B2 a refusé l'appel ${url} (HTTP ${reponse.status}) — ${corps}`);
    return JSON.parse(corps);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Aucune réponse de Backblaze B2 après ${gardeFouMs / 1000}s (${url}).`);
    throw e;
  } finally {
    clearTimeout(gardeFou);
  }
}

const DELAI_MAX_ENVOI_B2_MS = 120000; // une tranche compressée pèse jusqu'à quelques Mo : plus de temps que pour un simple appel d'API

// Ouvre UNE session Backblaze B2 pour toute la sauvegarde (authentification et recherche du bucket une seule fois), puis envoie les fichiers un par un.
// Renvoie null si B2 n'est pas configuré (variables d'environnement absentes) : la sauvegarde Supabase continue seule, avec un avertissement dans les logs.
async function ouvrirSessionB2() {
  const keyId = process.env.B2_KEY_ID;
  const applicationKey = process.env.B2_APPLICATION_KEY;
  const nomBucket = process.env.B2_BUCKET_NAME;
  if (!keyId || !applicationKey || !nomBucket) {
    console.warn('Copie hors Supabase NON envoyée — B2_KEY_ID/B2_APPLICATION_KEY/B2_BUCKET_NAME manquant(s) dans les variables d\'environnement Render.');
    return null;
  }
  console.log(`📦 Copie hors Supabase : ouverture de la session Backblaze B2 (bucket "${nomBucket}")...`);
  // 1. S'authentifier — renvoie un jeton + l'URL de l'API à utiliser pour CE compte (varie selon la région Backblaze, jamais fixe).
  const identifiants = Buffer.from(`${keyId}:${applicationKey}`).toString('base64');
  const auth = await appelB2('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', { headers: { Authorization: `Basic ${identifiants}` } });
  const apiUrl = auth.apiInfo?.storageApi?.apiUrl || auth.apiUrl;
  // 2. Retrouver l'ID interne du bucket à partir de son NOM (b2_get_upload_url exige l'ID, pas le nom).
  const listeBuckets = await appelB2(`${apiUrl}/b2api/v2/b2_list_buckets`, {
    method: 'POST', headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: auth.accountId, bucketName: nomBucket }),
  });
  const bucket = (listeBuckets.buckets || [])[0];
  if (!bucket) throw new Error(`Bucket "${nomBucket}" introuvable — vérifie B2_BUCKET_NAME et que la clé d'application y a bien accès.`);

  return {
    // 3+4. Une URL d'envoi à usage unique par fichier, puis l'envoi — B2 exige le SHA1 du contenu en en-tête (il rejette l'envoi si ça ne correspond pas).
    async envoyer(chemin, contenu) {
      const upload = await appelB2(`${apiUrl}/b2api/v2/b2_get_upload_url`, {
        method: 'POST', headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucketId: bucket.bucketId }),
      });
      const sha1 = crypto.createHash('sha1').update(contenu).digest('hex');
      const controleur = new AbortController();
      const gardeFou = setTimeout(() => controleur.abort(), DELAI_MAX_ENVOI_B2_MS);
      let reponse;
      try {
        reponse = await fetch(upload.uploadUrl, {
          method: 'POST', signal: controleur.signal,
          headers: {
            Authorization: upload.authorizationToken, 'X-Bz-File-Name': chemin.split('/').map(encodeURIComponent).join('/'),
            'Content-Type': chemin.endsWith('.json') ? 'application/json' : 'application/gzip', 'X-Bz-Content-Sha1': sha1, 'Content-Length': String(contenu.length),
          },
          body: contenu,
        });
      } catch (e) {
        throw e.name === 'AbortError' ? new Error(`Aucune réponse de Backblaze B2 après ${DELAI_MAX_ENVOI_B2_MS / 1000}s (envoi de ${chemin}).`) : e;
      } finally {
        clearTimeout(gardeFou);
      }
      const corps = await reponse.text();
      if (!reponse.ok) throw new Error(`B2 a refusé l'envoi de ${chemin} (HTTP ${reponse.status}) — ${corps}`);
    },
    // Notification email best-effort, SANS pièce jointe (les fichiers vivent sur B2) — un échec ici ne doit jamais annuler le succès de la copie.
    async terminer({ dossier, manifeste }) {
      console.log(`✅ Copie hors Supabase envoyée vers Backblaze B2 — ${dossier}`);
      const cleApi = process.env.RESEND_API_KEY;
      const destinataire = process.env.EMAIL_SAUVEGARDE_DESTINATAIRE;
      if (!cleApi || !destinataire) return;
      await appelB2('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${cleApi}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Sauvegarde CHF <onboarding@resend.dev>', to: [destinataire], subject: `Sauvegarde CHF — ${dossier}`,
          text: `Sauvegarde automatique du ${new Date().toLocaleDateString('fr-FR', { timeZone: FUSEAU_HAITI })} envoyée sur Backblaze B2 (bucket "${process.env.B2_BUCKET_NAME}") : ${manifeste.totalLignes} lignes, ${manifeste.totalFichiers} fichiers compressés.\n\nPas de pièce jointe — regarde/télécharge les fichiers directement depuis ton tableau de bord Backblaze si besoin.`,
        }),
      });
    },
  };
}

// ============================================================
// RESTAURATION DEPUIS UNE SAUVEGARDE AUTOMATIQUE (13/09) — jusqu'ici la sauvegarde s'écrivait
// fidèlement chaque nuit (voir sauvegarderVersStorage ci-dessus, confirmé fonctionnel le 11/09),
// mais RIEN ne savait la relire : le seul bouton "Restore" côté app (AppHospitaliere.js) attendait
// un format totalement différent (l'ancien export manuel chiffré, { verifications, ongTargets,
// medicaments, actes } — sans même paiements) et affichait "Restauration terminée" même quand 0
// ligne avait été touchée. Testé pour de vrai le 13/09 : base Supabase jetable + vraie sauvegarde
// tirée du bucket + comptage table par table (voir NOTES_POUR_PROCHAIN_CLAUDE.md).
//
// Ordre de restauration : respecte les FK entre les 17 tables sauvegardées (recoupé le 13/09 dans
// information_schema.table_constraints) — dossiers→episodes→fiches→paiements est la seule vraie
// chaîne ; pieces_jointes/transferts_service/demandes_exoneration dépendent chacune d'UNE seule
// des 4 précédentes, jamais entre elles ; les 10 autres tables n'ont aucune dépendance. Clé
// primaire précisée quand ce n'est pas "id" (catalog: type, invitations: token,
// decrements_stock_appliques: local_id).
const ORDRE_RESTAURATION = [
  // ong_partenaires EN PREMIER (16/10, essai de restauration) : le déclencheur rattacher_partenaire_id retrouve l'identifiant du partenaire d'après son NOM à chaque insertion
  // d'épisode ou de paiement ; restauré après eux, le partenaire n'existait pas encore et l'identifiant restait vide.
  ['ong_partenaires', 'id'], ['dossiers', 'id'], ['episodes', 'id'], ['fiches', 'id'], ['paiements', 'id'],
  ['pieces_jointes', 'id'], ['transferts_service', 'id'], ['demandes_exoneration', 'id'],
  ['catalog', 'type'], ['cloture_caisse', 'id'], ['users', 'id'],
  ['audit_log', 'id'], ['requisitions', 'id'], ['salaires_service', 'id'],
  ['depenses_caisse', 'id'], ['autres_revenus', 'id'], ['receptions_medicaments', 'id'], ['decrements_stock_appliques', 'local_id'], ['invitations', 'token'], ['compteurs', 'id'],
  ['doublons_ignores', 'dossier_a,dossier_b'], ['migrations_appliquees', 'nom'],
];

const serviceSauvegarde = creerServiceSauvegarde({
  supabase, bucket: BUCKET_SAUVEGARDES, tables: TABLES_A_SAUVEGARDER, clesPrimaires: CLE_PRIMAIRE_SAUVEGARDE, ordreRestauration: ORDRE_RESTAURATION,
  ouvrirCopieHorsSite: ouvrirSessionB2, journal: console, fuseau: FUSEAU_HAITI,
});

// Une seule sauvegarde à la fois : le minuteur de 6h UTC, le rattrapage au réveil et le bouton « Tester la sauvegarde » peuvent tomber au même moment.
let sauvegardeEnCours = null;
function sauvegarderVersStorage() {
  if (sauvegardeEnCours) return sauvegardeEnCours;
  sauvegardeEnCours = serviceSauvegarde.sauvegarder().finally(() => { sauvegardeEnCours = null; });
  return sauvegardeEnCours;
}

// Corps de la sauvegarde quotidienne, partagé par les DEUX déclencheurs : le minuteur de 6h UTC
// ci-dessous, et le rattrapage au démarrage juste après. Ne lève jamais : tout échec est journalisé
// et signalé par WhatsApp, mais ne doit ni arrêter le serveur ni empêcher le second déclencheur de
// réessayer plus tard.
async function executerSauvegardeQuotidienne(origine) {
  try {
    const resultat = await sauvegarderVersStorage();
    console.log(`✅ Sauvegarde automatique (${origine}) : ${resultat.fichier}`, resultat.nombreLignes);
    // Une sauvegarde PARTIELLE réussit techniquement mais laisse un trou : sans alerte, personne
    // ne saurait qu'une table n'est plus protégée, parfois pendant des mois.
    if (resultat.tablesEnEchec && resultat.tablesEnEchec.length > 0) {
      await envoyerCallMeBot(`⚠️ CHF : sauvegarde faite, mais ${resultat.tablesEnEchec.length} table(s) n'ont PAS pu être sauvegardées — ${resultat.tablesEnEchec.join(' ; ')}`);
    }
    // Relecture de ce qui vient d'être écrit (sommes de contrôle, comptage des lignes) : une sauvegarde abîmée à l'envoi se découvre ce soir, pas le jour de la restauration.
    if (resultat.verification && !resultat.verification.ok) {
      await envoyerCallMeBot(`⚠️ CHF : la sauvegarde du jour est écrite mais sa RELECTURE a trouvé un problème — ${(resultat.verification.erreurs || []).slice(0, 3).join(' ; ')}`);
    }
    // Copie hors Supabase (02/09) — échec séparé de la sauvegarde principale : Supabase a déjà
    // sa copie, celle-ci n'en est qu'une seconde. Un échec ici mérite quand même une alerte : une
    // copie hors site qui ne part plus, en silence, pendant des semaines n'a plus aucune valeur
    // le jour où on en a besoin.
    if (resultat.copie && resultat.copie.erreur) {
      console.error('❌ Échec de la copie de sauvegarde hors Supabase :', resultat.copie.erreur);
      await envoyerCallMeBot(`⚠️ CHF : sauvegarde Supabase faite, mais la copie hors Supabase a échoué (${resultat.copie.erreur}).`);
    }
  } catch (e) {
    console.error(`❌ Échec de la sauvegarde automatique (${origine}) :`, e.message);
    // Retour d'Esdras (29/08) : seul moyen de savoir qu'une sauvegarde a échoué jusqu'ici était de
    // lire les logs Render, que personne ne regarde — une alerte WhatsApp directe comble ce trou.
    await envoyerCallMeBot(`⚠️ CHF : la sauvegarde automatique a échoué (${e.message}). Vérifie les logs Render.`);
  }
}

// Tous les jours à 6h UTC (~1h-2h du matin en Haïti, hors heures de pointe). Déclenchement manuel
// possible via POST /api/admin/backup-manuel.
cron.schedule('0 6 * * *', () => executerSauvegardeQuotidienne('minuteur 6h UTC'));

// ============================================================
// RATTRAPAGE AU DÉMARRAGE (25/09) — le minuteur ci-dessus ne suffit pas, et on l'a payé cher.
//
// Ce service tourne sur le plan gratuit de Render, qui éteint le processus après ~15 minutes sans
// visite. Le minuteur vit DANS ce processus : quand il s'éteint, le minuteur meurt avec lui. Et
// 6h UTC, c'est 1h-2h du matin en Haïti — précisément l'heure où personne n'utilise l'app, donc
// où le serveur est garanti éteint. Constaté le 25/09 en listant le bucket : UNE SEULE sauvegarde
// automatique depuis le 2 septembre. Toutes les autres venaient d'un clic manuel d'Esdras.
//
// Le serveur se réveille en revanche dès que quelqu'un ouvre l'app. On en profite : s'il n'existe
// aucune sauvegarde datée d'aujourd'hui (heure d'Haïti), on la fait maintenant. Ça donne une
// sauvegarde par jour d'utilisation réelle, sans rien payer et sans dépendre d'un service externe.
//
// Ce n'est pas un remplacement parfait d'un vrai minuteur : un jour sans aucune utilisation n'a
// pas de sauvegarde. Mais un jour sans utilisation est aussi un jour sans nouvelle donnée.
const DELAI_RATTRAPAGE_DEMARRAGE_MS = 30000;

const sauvegardeDuJourExisteDeja = () => serviceSauvegarde.sauvegardeDuJourExisteDeja(); // une sauvegarde COMPLÈTE (avec manifeste) datée d'aujourd'hui, heure d'Haïti

async function rattraperSauvegardeAuDemarrage() {
  try {
    if (await sauvegardeDuJourExisteDeja()) {
      console.log('↩️ Sauvegarde du jour déjà présente — rien à rattraper au démarrage.');
      return;
    }
    console.log('⏰ Aucune sauvegarde pour aujourd\'hui — rattrapage au réveil du serveur...');
    await executerSauvegardeQuotidienne('rattrapage au réveil');
  } catch (e) {
    // Un bucket injoignable au démarrage ne doit jamais empêcher le serveur de servir l'app :
    // le prochain réveil réessaiera, et le minuteur de 6h reste en place de son côté.
    console.error('❌ Rattrapage de sauvegarde impossible au démarrage :', e.message);
  }
}

// Décalé de 30 secondes : le serveur répond d'abord aux requêtes qui l'ont réveillé (quelqu'un
// attend devant son écran), la sauvegarde complète des 17 tables vient ensuite. unref() pour que
// ce minuteur n'empêche jamais le processus de s'arrêter proprement.
setTimeout(rattraperSauvegardeAuDemarrage, DELAI_RATTRAPAGE_DEMARRAGE_MS).unref();

// ============================================================
// SURVEILLANCE DE LA QUALITÉ DES DONNÉES (18/10) — chaque jour à 11h UTC (7h en Haïti, avant l'ouverture), et UNE FOIS au réveil du serveur s'il n'y en a pas eu aujourd'hui
// (le plan gratuit de Render éteint le serveur sans visite : même principe que le rattrapage de la sauvegarde). Voir utils/surveillanceQualite.js.
// ============================================================
cron.schedule('0 11 * * *', () => { lancerSurveillanceQualite({ origine: 'minuteur' }); });
setTimeout(async () => {
  try { if (!(await surveillanceQualite.surveillanceDuJourFaite())) await lancerSurveillanceQualite({ origine: 'rattrapage au réveil' }); }
  catch (e) { console.warn('Rattrapage de la surveillance de la qualité impossible :', e.message); }
}, 90000).unref();

// ============================================================
// FERMETURE AUTOMATIQUE DES CONSULTATIONS (19/10, Esdras : « consultation fermée après 1 mois ») — chaque jour à 10h20 UTC (6h20 en Haïti) et au réveil du serveur (idempotent). Voir utils/fermetureConsultations.js.
// ============================================================
cron.schedule('20 10 * * *', () => { fermerConsultationsAnciennes({ supabase }).catch(e => console.warn('Fermeture automatique des consultations :', e.message)); });
setTimeout(() => { fermerConsultationsAnciennes({ supabase }).catch(e => console.warn('Fermeture automatique des consultations :', e.message)); }, 120000).unref();

// ============================================================
// FERMETURE AUTOMATIQUE DES POSTES DE CAISSE (15/10, Esdras) — voir utils/fermetureAutoPostes.js.
// Chaque minute, et UNE FOIS au réveil du serveur (le plan gratuit de Render l'éteint sans visite : un poste dont la limite est passée pendant ce sommeil
// est fermé au réveil, avec comme heure de fermeture sa limite, pas l'heure du réveil).
// ============================================================
cron.schedule('* * * * *', () => { fermerPostesExpires({ supabase }); });
setTimeout(() => { fermerPostesExpires({ supabase }); }, 20000).unref();

// ============================================================
// CORBEILLE CATALOGUE (medicaments/actes) — retour d'Esdras (01/09) : "j'aime pas trop
// suppression irréversible, met une poubelle de 30 jours pour toute action de suppression".
// GrilleEdition.js (chf-app2) ne retire plus jamais un article du tableau JSONB en le supprimant —
// il pose seulement un champ supprimeLe (via definir_champs_catalogue_lot, déjà en prod, aucune
// migration SQL nécessaire pour cette partie). Ce cron fait le ménage réel après 30 jours, via la
// RPC supprimer_article_catalogue qui existe déjà (c'était l'ancien mécanisme de suppression
// directe). Seuls medicaments/actes sont concernés ici — dossiers/fiches/pièces jointes ont leur
// propre fonction de purge, purgerCorbeilleDossiers() juste plus bas (branchée le 10/09) ;
// partenaires ONG a la colonne supprime_le mais aucune route ne les supprime encore aujourd'hui,
// rien à purger tant que cette fonctionnalité n'existe pas.
const JOURS_CORBEILLE_CATALOGUE = 30;
async function purgerCorbeilleCatalogue() {
  const resultats = { medicaments: 0, actes: 0 };
  for (const type of ['medicaments', 'actes']) {
    const { data: ligne, error } = await supabase.from('catalog').select('items').eq('type', type).maybeSingle();
    if (error || !ligne) continue;
    const limite = Date.now() - JOURS_CORBEILLE_CATALOGUE * 86400000;
    const aPurger = (ligne.items || []).filter(i => i.supprimeLe && new Date(i.supprimeLe).getTime() < limite);
    for (const item of aPurger) {
      const { error: erreurSuppr } = await supabase.rpc('supprimer_article_catalogue', { p_type: type, p_id: item.id });
      if (!erreurSuppr) resultats[type]++;
    }
  }
  return resultats;
}

// Corbeille dossiers/fiches/pièces jointes — phase 2 (10/09), enfin branchée : les colonnes
// supprime_le existaient depuis le 01/09 (sql/corbeille_30_jours.sql) mais rien ne les purgeait
// ni ne les restaurait. Un vrai DELETE ici (contrairement aux routes de suppression, qui posent
// juste supprime_le) — les dossiers/épisodes purgés cascadent automatiquement vers leurs
// fiches/paiements (ON DELETE CASCADE en base, qui ne se déclenche que sur un vrai DELETE) ; les
// fiches purgées indépendamment (jamais rattachées à un épisode lui-même purgé) cascadent vers
// LEURS paiements de la même façon. Les pièces jointes perdent aussi leur fichier réel dans
// Storage — SEULEMENT ici, à la purge définitive (la suppression initiale, elle, laisse le
// fichier intact exprès : voir la route DELETE pieces-jointes plus haut).
const JOURS_CORBEILLE_DOSSIERS = 30;
async function purgerCorbeilleDossiers() {
  const limite = new Date(Date.now() - JOURS_CORBEILLE_DOSSIERS * 86400000).toISOString();
  const resultats = { episodes: 0, fiches: 0, piecesJointes: 0 };

  const { data: episodesPurges, error: erreurEpisodes } = await supabase
    .from('episodes').delete().lt('supprime_le', limite).not('supprime_le', 'is', null).select('id');
  if (erreurEpisodes) throw erreurEpisodes;
  resultats.episodes = (episodesPurges || []).length;

  // Fiches restées seules à la corbeille (leur épisode n'a lui-même jamais été supprimé) —
  // celles liées à un épisode déjà purgé ci-dessus sont déjà parties par cascade, cette requête
  // ne retrouve alors plus rien pour elles (0 ligne affectée, jamais une erreur).
  const { data: fichesPurgees, error: erreurFiches } = await supabase
    .from('fiches').delete().lt('supprime_le', limite).not('supprime_le', 'is', null).select('id');
  if (erreurFiches) throw erreurFiches;
  resultats.fiches = (fichesPurgees || []).length;

  const { data: piecesAPurger, error: erreurLecturePieces } = await supabase
    .from('pieces_jointes').select('id, storage_path').lt('supprime_le', limite).not('supprime_le', 'is', null);
  if (erreurLecturePieces) throw erreurLecturePieces;
  for (const piece of (piecesAPurger || [])) {
    // Best-effort sur le fichier, même philosophie que partout ailleurs dans ce fichier : un
    // fichier déjà absent de Storage (incident antérieur, retrait manuel) ne doit jamais
    // empêcher de nettoyer la ligne elle-même — sinon la corbeille grossirait indéfiniment sur
    // ce seul cas.
    const { error: erreurStorage } = await supabase.storage.from(BUCKET_PIECES_JOINTES).remove([piece.storage_path]);
    if (erreurStorage) console.warn(`⚠️ Purge corbeille : fichier Storage introuvable/erreur pour ${piece.storage_path} — ligne supprimée quand même (${erreurStorage.message}).`);
    const { error: erreurSuppr } = await supabase.from('pieces_jointes').delete().eq('id', piece.id);
    if (!erreurSuppr) resultats.piecesJointes++;
  }

  return resultats;
}

// Traces d'idempotence des décréments de stock (voir sql/idempotence_decrement_stock.sql) : une
// ligne par vente, utile seulement le temps qu'un rejeu de la file hors ligne puisse survenir.
// 90 jours est très large pour ça (une file hors ligne se vide en heures, pas en mois) et évite
// une table qui grossit indéfiniment.
const JOURS_TRACES_DECREMENT_STOCK = 90;
async function purgerTracesDecrementStock() {
  const limite = new Date(Date.now() - JOURS_TRACES_DECREMENT_STOCK * 86400000).toISOString();
  const { data, error } = await supabase
    .from('decrements_stock_appliques').delete().lt('applique_le', limite).select('local_id');
  if (error) throw error;
  return (data || []).length;
}

// Liens d'invitation : un lien expire au bout de quelques heures/jours, mais la LIGNE reste
// (c'est la trace de qui a invité qui, avec quel rôle). 90 jours suffisent largement à retrouver
// l'origine d'un compte récent ; au-delà, l'information utile vit dans audit_log
// ('creation_compte_par_invitation'), qui n'est jamais purgé, lui.
const JOURS_CONSERVATION_INVITATIONS = 90;
async function purgerInvitationsAnciennes() {
  const limite = new Date(Date.now() - JOURS_CONSERVATION_INVITATIONS * 86400000).toISOString();
  const { data, error } = await supabase
    .from('invitations').delete().lt('date_creation', limite).select('token');
  if (error) throw error;
  return (data || []).length;
}

// Même heure creuse que la sauvegarde (6h UTC) — l'ordre entre les deux jobs n'a pas d'importance,
// ils touchent des données différentes. Ne bloque jamais le serveur si ça échoue.
cron.schedule('0 6 * * *', async () => {
  try {
    const resultat = await purgerCorbeilleCatalogue();
    const total = resultat.medicaments + resultat.actes;
    if (total > 0) console.log(`🗑️ Corbeille catalogue purgée : ${resultat.medicaments} médicament(s), ${resultat.actes} acte(s)`);
  } catch (e) {
    console.error('❌ Échec de la purge de la corbeille catalogue :', e.message);
  }
  // Purge indépendante de la précédente : un échec de l'une ne doit pas empêcher l'autre.
  try {
    const purgees = await purgerTracesDecrementStock();
    if (purgees > 0) console.log(`🧹 ${purgees} trace(s) d'idempotence de décrément de stock purgée(s) (> ${JOURS_TRACES_DECREMENT_STOCK} jours).`);
  } catch (e) {
    console.error('❌ Échec de la purge des traces de décrément de stock :', e.message);
  }
  // Clés d'idempotence (28/09) : utiles quelques jours au plus (rejeu après une coupure).
  try {
    const r = await purgerClesIdempotence(supabase);
    if (r.erreur) console.error("❌ Échec de la purge des clés d'idempotence :", r.erreur);
  } catch (e) {
    console.error("❌ Échec de la purge des clés d'idempotence :", e.message);
  }
  try {
    const purgees = await purgerInvitationsAnciennes();
    if (purgees > 0) console.log(`🧹 ${purgees} lien(s) d'invitation périmé(s) purgé(s) (> ${JOURS_CONSERVATION_INVITATIONS} jours).`);
  } catch (e) {
    console.error('❌ Échec de la purge des invitations périmées :', e.message);
  }
  // Traces de suppression de la synchro incrémentale (12/10) : utiles quelques jours au plus.
  try {
    await synchroListes.purgerLignesEffacees();
  } catch (e) {
    console.error('❌ Échec de la purge des traces de suppression (synchro) :', e.message);
  }
  // Purge indépendante des précédentes — un échec ici ne doit jamais empêcher le reste.
  try {
    const resultat = await purgerCorbeilleDossiers();
    const total = resultat.episodes + resultat.fiches + resultat.piecesJointes;
    if (total > 0) console.log(`🗑️ Corbeille dossiers purgée : ${resultat.episodes} dossier(s), ${resultat.fiches} fiche(s), ${resultat.piecesJointes} pièce(s) jointe(s).`);
  } catch (e) {
    console.error('❌ Échec de la purge de la corbeille dossiers :', e.message);
  }
});

// Déclenchement manuel — pour vérifier tout de suite sans attendre 6h UTC.
app.post('/api/admin/purger-corbeille-catalogue', async (req, res) => {
  if (!(await aPermission(req.user.id, 'catalogue_gerer'))) {
    return res.status(403).json({ error: "Permission 'catalogue_gerer' requise." });
  }
  try {
    const resultat = await purgerCorbeilleCatalogue();
    res.json({ success: true, ...resultat });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Déclenchement manuel — même principe que ci-dessus, pour la corbeille dossiers/fiches/pièces
// jointes.
app.post('/api/admin/purger-corbeille-dossiers', async (req, res) => {
  if (!(await aPermission(req.user.id, 'facturation_supprimer'))) {
    return res.status(403).json({ error: "Permission 'facturation_supprimer' requise." });
  }
  try {
    const resultat = await purgerCorbeilleDossiers();
    res.json({ success: true, ...resultat });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Déclenchement manuel — pour vérifier que la sauvegarde automatique fonctionne réellement sans
// attendre la prochaine exécution planifiée, ou en cas de doute avant une opération risquée.
app.post('/api/admin/backup-manuel', async (req, res) => {
  if (!(await aPermission(req.user.id, 'sauvegarde_gerer'))) {
    return res.status(403).json({ error: "Permission 'sauvegarde_gerer' requise." });
  }
  // Log d'entrée (09/09) : sans ça, un clic sur "Tester la sauvegarde" ne laisse AUCUNE trace
  // dans les logs Render en cas de succès — impossible de distinguer "il n'a jamais cliqué"/"la
  // requête n'est jamais arrivée jusqu'ici" de "elle est arrivée mais qqch a échoué en silence".
  console.log(`🧪 Sauvegarde manuelle demandée par ${req.user.email || req.user.id}...`);
  try {
    const resultat = await sauvegarderVersStorage();
    console.log(`✅ Sauvegarde manuelle vers Storage réussie : ${resultat.fichier}`);
    // La copie hors Supabase (B2) ne transforme jamais un succès Supabase réel en 500 — mais l'appelant (qui a justement cliqué pour vérifier que tout fonctionne) mérite de
    // savoir si cette 2e copie est vraiment partie, pas seulement la 1re (champs copieEnvoyee / erreurCopie, lus par l'écran).
    res.json({ success: true, ...resultat, copieEnvoyee: !!resultat.copie.envoyee, erreurCopie: resultat.copie.erreur });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Indicateur "dernière sauvegarde réussie" (retour d'Esdras, perfectionnement du 24/08) — la
// sauvegarde automatique tourne seule tous les jours à 6h UTC, mais rien n'affichait jusqu'ici
// que ça avait vraiment marché. Le nom de fichier (backup-YYYY-MM-DD.json) suffit pour dater la
// plus récente sans dépendre des métadonnées du Storage.
app.get('/api/admin/derniere-sauvegarde', async (req, res) => {
  if (!(await aPermission(req.user.id, 'sauvegarde_gerer'))) {
    return res.status(403).json({ error: "Permission 'sauvegarde_gerer' requise." });
  }
  try {
    res.json({ date: await serviceSauvegarde.dateDerniereSauvegarde() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// (La liste ORDRE_RESTAURATION et la restauration vivent plus haut, avec la sauvegarde — voir utils/sauvegardeServeur.js.)

// Liste les sauvegardes disponibles dans Storage — alimente le sélecteur côté app (jamais une
// restauration "à l'aveugle" sur la dernière en date sans que l'admin choisisse explicitement).
// 16/10 : anciens fichiers backup-AAAA-MM-JJ.json (format 1) ET dossiers backup-AAAA-MM-JJ (format 2, seulement s'ils sont COMPLETS).
app.get('/api/admin/sauvegardes', async (req, res) => {
  if (!(await aPermission(req.user.id, 'sauvegarde_gerer'))) {
    return res.status(403).json({ error: "Permission 'sauvegarde_gerer' requise." });
  }
  try {
    res.json(await serviceSauvegarde.listerSauvegardes());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Corps : { fichier, verifierSeulement? }. verifierSeulement: true relit la sauvegarde (sommes de contrôle, décompression, comptage) SANS rien écrire — le test à faire régulièrement.
app.post('/api/admin/restaurer-sauvegarde', async (req, res) => {
  if (!(await aPermission(req.user.id, 'sauvegarde_gerer'))) {
    return res.status(403).json({ error: "Permission 'sauvegarde_gerer' requise." });
  }
  const { fichier, verifierSeulement } = req.body || {};
  if (!fichier || typeof fichier !== 'string') return res.status(400).json({ error: 'fichier requis (voir GET /api/admin/sauvegardes).' });
  console.log(`🧪 ${verifierSeulement === true ? 'Vérification' : 'Restauration'} de sauvegarde demandée par ${req.user.email || req.user.id} : ${fichier}`);
  try {
    const resultat = await serviceSauvegarde.restaurer(fichier, { verifierSeulement: verifierSeulement === true });
    if (resultat.verification) return res.json(resultat);
    console.log(`${resultat.totalEnEchec > 0 ? '⚠️' : '✅'} Restauration ${fichier} : ${resultat.totalInsere} ligne(s) insérée(s), ${resultat.totalEnEchec} en échec.`);
    // Pas de champ "success" générique volontairement — l'appelant DOIT lire rapport/totalInsere/
    // totalEnEchec, jamais afficher "réussi" sans avoir vraiment regardé ce qui a été écrit.
    res.json(resultat);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend CHF demarré sur le port ${PORT}`);
});
