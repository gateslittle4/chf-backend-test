require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
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
const PERMISSIONS_PAR_DEFAUT = [
  { role: 'direction', permissions: ['episode_creer','fiche_patient_voir','fiche_patient_voir_finances','caisse_travailler','demandes_voir','demandes_repondre','dossier_annuler','paiement_annuler','facturation_supprimer','facturation_modifier','facturation_exporter','direction_voir','analytics_voir','rapport_chf_voir','catalogue_gerer','stock_gerer','partenaires_gerer'] },
  { role: 'comptable', permissions: ['episode_creer','fiche_patient_voir','fiche_patient_voir_finances','caisse_travailler','demandes_voir','facturation_modifier','facturation_exporter','rapport_chf_voir'] },
  { role: 'auditeur', permissions: ['episode_creer','fiche_patient_voir','fiche_patient_voir_finances','facturation_exporter','rapport_chf_voir','facturation_voir'] },
  { role: 'lecteur', permissions: ['episode_creer','fiche_patient_voir','facturation_voir'] },
  { role: 'archiviste', permissions: ['fiche_patient_voir','facturation_voir'] },
  // Retour d'Esdras (28/08) : "l'infirmier ne peut voir que Dossier/Épisode et Fiche Patient" —
  // rapport_chf_voir déplacé vers infirmier_chef (nouveau rôle, ci-dessous) ; facturation_voir
  // jamais accordé ici (Calcul Facture/Facturation exclus, c'est justement ce qu'on retire).
  { role: 'infirmier', permissions: ['dossier_creer','fiche_patient_voir'] },
  { role: 'infirmier_chef', permissions: ['dossier_creer','fiche_patient_voir','rapport_chf_voir'] },
  // Retour d'Esdras (27/08) : "je veux créer un rôle pour visiteur, voir mais ne peut rien
  // modifier" — que des permissions "voir", jamais une action (créer/modifier/annuler/gérer).
  // analytics_voir (inclut les salaires du personnel) volontairement exclu.
  { role: 'visiteur', permissions: ['fiche_patient_voir','fiche_patient_voir_finances','direction_voir','rapport_chf_voir','audit_voir','caisse_voir','hospitalisation_voir','stock_voir','catalogue_voir','requisitions_voir','facturation_voir'] },
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
}));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ statut: 'CHF backend (Firebase Auth + Supabase DB) en ligne' }));

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

  // Même message d'erreur générique dans TOUS les cas de désaccord (dossier introuvable, date ou
  // nom qui ne correspond pas) — ne jamais laisser deviner QUELLE information était fausse.
  const echec = () => res.status(404).json({ error: "Aucun dossier ne correspond à ces informations." });

  const { data: dossier } = await supabase.from('dossiers').select('*')
    .eq('numero_dossier', numero_dossier).eq('date_naissance', date_naissance).maybeSingle();
  if (!dossier || motsDuNom(dossier.nom) !== motsDuNom(nom)) return echec();

  // Succès : la personne a bien prouvé qui elle est, on lui laisse le bénéfice du doute pour ses
  // prochaines recherches (n'accumule plus contre le compteur ci-dessus).
  tentativesPortailPatient.delete(cle);

  const { data: episodes } = await supabase.from('episodes').select('id').eq('dossier_id', dossier.id);
  const episodeIds = (episodes || []).map(e => e.id);
  const { data: fiches } = episodeIds.length === 0 ? { data: [] } : await supabase
    .from('fiches').select('date_creation, raw_state').in('episode_id', episodeIds)
    .order('date_creation', { ascending: false }).limit(5);

  const historique = (fiches || []).map(f => ({
    date: f.date_creation,
    // lignesCalcul (voir CalculateurPanel.js) porte nom/qte/prix par article — seuls nom et qte
    // quittent ce backend, jamais le prix.
    articles: (f.raw_state?.lignesCalcul || []).map(l => ({ nom: l.nom, quantite: l.qte })),
  }));
  res.json({ nomPatient: dossier.nom, historique });
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
    return res.status(401).json({ error: 'Token manquant ou invalide' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decoded = await getAuth().verifyIdToken(token);
    // "Désactiver un compte" (Gestion des utilisateurs) et l'accès à durée limitée (date
    // d'expiration) n'étaient vérifiés NULLE PART jusqu'ici — ni ici, ni côté écran : le bouton
    // "Désactiver" ne faisait qu'écrire un booléen que rien ne lisait jamais, un compte
    // "désactivé" pouvait continuer à se connecter et travailler normalement. Vérifié à chaque
    // requête, pas seulement à la connexion, pour qu'une désactivation en cours de session soit
    // immédiate (pas besoin d'attendre que le token expire).
    const { data: profil } = await supabase.from('users').select('active, date_expiration').eq('id', decoded.uid).maybeSingle();
    if (profil) {
      if (profil.active === false) {
        return res.status(403).json({ error: 'Ce compte a été désactivé.' });
      }
      if (profil.date_expiration && new Date(profil.date_expiration) < new Date()) {
        return res.status(403).json({ error: "Cet accès a expiré. Contacte l'administrateur pour le renouveler." });
      }
    }
    req.user = { id: decoded.uid, email: decoded.email };
    next();
  } catch (e) {
    console.warn(`verifyToken: jeton invalide ou expiré (${req.method} ${req.path}):`, e.message);
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

// Application du middleware sur toutes les routes API
app.use('/api', verifyToken);

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

async function episodeVersFlat(ep) {
  const { data: dossier, error: erreurDossier } = await supabase.from('dossiers').select('*').eq('id', ep.dossier_id).single();
  // Avant : cette erreur était silencieusement ignorée — un épisode dont le dossier ne pouvait
  // pas être lu (ligne orpheline, incident Supabase transitoire) apparaissait comme un patient
  // "sans nom" dans Archives/Analytics sans le moindre signal qu'une donnée manque vraiment.
  if (erreurDossier) console.error(`⚠️ episodeVersFlat: dossier introuvable pour l'épisode ${ep.id} (dossier_id=${ep.dossier_id}) :`, erreurDossier.message);
  // .order('id') en second : départage deux fiches créées à la même seconde, pour que cette
  // version unitaire et la version groupée (episodesVersFlatEnLot) donnent le MÊME ordre.
  const { data: fiches } = await supabase.from('fiches').select('*').eq('episode_id', ep.id).order('date_creation').order('id');
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
    nomPatient: dossier?.nom, dateNaissance: dossier?.date_naissance,
    telephone: dossier?.telephone, adresse: dossier?.adresse, numDossier: dossier?.numero_dossier,
    typePatient: typePatientVersFlat(ep.type_patient),
    ongPartenaire: ep.ong_partenaire || null,
    serviceChoisi: ep.service,
    status: statutVersFlat(ep),
    dateSuspension: ep.date_suspension, moisReport: ep.mois_report,
    numeroLot: ep.numero_lot, verrouilleFacture: ep.verrouille_facture,
    estHospitalisation: ep.est_hospitalisation,
    motifFermeture: ep.motif_fermeture, dateFermeture: ep.date_fermeture,
    lit: ep.lit || null,
    // Distingue Consultation de Vente comptoir (Achat Express) — les deux ont
    // estHospitalisation: false, seul voie_entree ('consultation' vs 'vente_comptoir') les sépare.
    voieEntree: ep.voie_entree,
    dateHeure: new Date(ep.date_ouverture).toLocaleDateString('fr-FR'),
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
    lireParLotsDIds(idsEpisodes, lot => supabase.from('fiches').select('*').in('episode_id', lot).order('date_creation').order('id')),
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
  const totalDepots = (paiements || []).filter(p => p.mode === 'depot').reduce((s, p) => s + (Number(p.montant) || 0), 0);
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
    .or('annule.eq.false,annule.is.null');
  if (error) return res.status(500).json({ error: error.message });
  res.json(calculerSoldeDepot(paiements));
});

app.get('/api/episodes', async (req, res) => {
  // Lecture groupée (voir episodesVersFlatEnLot) : un nombre constant de requêtes par lot au lieu
  // de 3 par épisode. Résultat strictement identique — les deux chemins partagent le même
  // assemblage (assemblerEpisodeFlat).
  try {
    // Paginée elle aussi : sans ça, un plafond de lignes côté Supabase aurait tronqué la liste
    // des épisodes EN SILENCE (les plus anciens auraient simplement disparu des rapports, sans
    // erreur) — le reste du correctif n'y aurait rien changé, puisque tout part de cette lecture.
    const episodes = await lireToutesLesPages(
      () => supabase.from('episodes').select('*').order('date_ouverture', { ascending: false }).order('id'));
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
  const { data: dossier, error: erreurDossier } = await supabase
    .from('dossiers')
    .insert({
      numero_dossier: d.numero_dossier || `AUTO-${Date.now()}`,
      nom: d.nom_patient, date_naissance: dateOuNull(d.date_naissance), telephone: d.telephone, adresse: d.adresse,
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
    })
    .select().single();
  if (erreurEpisode) return res.status(500).json({ error: erreurEpisode.message });

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

  if (Object.keys(maj).length > 0) {
    const { data, error } = await supabase.from('episodes').update(maj).eq('id', req.params.id).select();
    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.status(404).json({ error: "Dossier introuvable — rien n'a été modifié." });
  }

  // Le nom du patient vit sur la table dossiers, pas episodes — cette route ne le touchait
  // jamais, donc corriger un nom depuis Archives affichait "succès" sans rien enregistrer.
  if (d.nom_patient !== undefined && String(d.nom_patient).trim() && episodeActuel) {
    const { data: nomMaj, error: erreurNom } = await supabase.from('dossiers').update({ nom: d.nom_patient }).eq('id', episodeActuel.dossier_id).select();
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
        const { data: fd, error: fe } = await supabase.from('fiches').update(ficheVersColonnes(f)).eq('id', f.id).select();
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
  const { error } = await supabase.from('episodes').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
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
  const nom = (req.query.nom || '').trim();
  const numero = (req.query.numero || '').trim();
  if (!nom && !numero) return res.json([]);

  if (numero) {
    const { data, error } = await supabase.from('dossiers').select('*').eq('numero_dossier', numero);
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }

  const { data, error } = await supabase.rpc('rechercher_dossiers_flou', { p_nom: nom });
  if (error) {
    if (error.code === '42883') {
      const { data: repli, error: erreurRepli } = await supabase.from('dossiers').select('*').ilike('nom', `%${nom}%`);
      if (erreurRepli) return res.status(500).json({ error: erreurRepli.message });
      return res.json(repli);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

app.post('/api/dossiers', async (req, res) => {
  if (!(await aPermission(req.user.id, 'dossier_creer'))) {
    return res.status(403).json({ error: "Permission 'dossier_creer' requise." });
  }
  const { numero_dossier, nom, date_naissance, telephone, adresse, local_id } = req.body;
  if (!nom) return res.status(400).json({ error: 'Le nom est requis' });
  if (!numero_dossier) return res.status(400).json({ error: 'Le numéro de dossier est requis' });
  // Idempotence : mêmes principes que /api/fiches et /api/paiements — nécessaire maintenant que
  // apiDossierEpisode passe par la file d'attente hors-ligne (avant, cette route n'était jamais
  // rejouée automatiquement, donc jamais appelée deux fois pour la même action).
  if (local_id) {
    const { data: existant } = await supabase.from('dossiers').select('*').eq('local_id', local_id).maybeSingle();
    if (existant) return res.status(200).json(existant);
  }
  const { data, error } = await supabase
    .from('dossiers').insert({ numero_dossier, nom, date_naissance: dateOuNull(date_naissance), telephone, adresse, local_id: local_id || null }).select().single();
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
      return res.status(409).json({ error: `Le numéro de dossier "${numero_dossier}" est déjà utilisé par un autre patient.` });
    }
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

// Fiche patient — infos de base (nom, tél, adresse, date de naissance), pour affichage/préremplissage.
app.get('/api/dossiers/:id', async (req, res) => {
  const { data, error } = await supabase.from('dossiers').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Dossier introuvable' });
  res.json(data);
});

// Modifier les infos de base d'un patient (ex : nouveau numéro de téléphone) — n'importe qui de
// connecté peut le faire (comme la création), pas une action sensible comme l'annulation d'un paiement.
// Retour d'Esdras (29/08) : poids et conjoint ajoutés aux données personnelles, et un endroit pour
// corriger le numéro de dossier "au cas où" (ex. faute de frappe à la création) — poids/conjoint
// (nouvelles colonnes, voir sql/ajoute_poids_conjoint_dossiers.sql) toujours acceptés tels quels
// (pas de contrainte d'unicité), numero_dossier réutilise le même traitement du conflit 23505 que
// POST /api/dossiers ci-dessus (déjà utilisé par un AUTRE patient).
app.put('/api/dossiers/:id', async (req, res) => {
  if (!(await aPermission(req.user.id, 'fiche_patient_modifier'))) {
    return res.status(403).json({ error: "Permission 'fiche_patient_modifier' requise." });
  }
  const { nom, date_naissance, telephone, adresse, poids, conjoint, numero_dossier } = req.body;
  if (!nom || !String(nom).trim()) return res.status(400).json({ error: 'Le nom est requis' });
  const maj = { nom, date_naissance: dateOuNull(date_naissance), telephone, adresse, poids: poids || null, conjoint };
  if (numero_dossier !== undefined) {
    if (!String(numero_dossier).trim()) return res.status(400).json({ error: 'Le numéro de dossier est requis' });
    maj.numero_dossier = numero_dossier;
  }
  const { data, error } = await supabase.from('dossiers').update(maj).eq('id', req.params.id).select();
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
    .from('episodes').select('*').eq('dossier_id', req.params.id).order('date_ouverture', { ascending: false });
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
      .or('annule.eq.false,annule.is.null')
      .order('date_paiement', { ascending: false });
    // Intervention (accouchement/césarienne/chirurgie) : jamais une donnée financière, toujours
    // incluse même sans fiche_patient_voir_finances — voir extraireIntervention ci-dessus.
    const { data: fiches } = await supabase.from('fiches').select('raw_state, date_creation').eq('episode_id', ep.id);
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
    .from('pieces_jointes').select('*').eq('dossier_id', req.params.id).order('date_ajout', { ascending: false });
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
  const { error: erreurSuppressionFichier } = await supabase.storage.from(BUCKET_PIECES_JOINTES).remove([piece.storage_path]);
  if (erreurSuppressionFichier) return res.status(500).json({ error: erreurSuppressionFichier.message });
  const { error } = await supabase.from('pieces_jointes').delete().eq('id', req.params.fichierId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Épisodes ouverts d'un dossier — la question centrale du flux anti-doublon
app.get('/api/dossiers/:id/episodes-ouverts', async (req, res) => {
  const { data, error } = await supabase
    .from('episodes').select('*').eq('dossier_id', req.params.id).eq('statut', 'ouvert');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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

  const { data: episodesOuverts, error: erreurRecherche } = await supabase
    .from('episodes').select('*').eq('dossier_id', dossier_id).eq('statut', 'ouvert');
  if (erreurRecherche) return res.status(500).json({ error: erreurRecherche.message });

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

  // Règle souple : tout épisode ouvert (hospitalisation ou consultation) → avertissement
  // contournable, sauf le cas bloqué ci-dessus (2 hospitalisations).
  if (episodesOuverts.length > 0 && !forcerMalgreAvertissement) {
    return res.status(409).json({
      error: 'AVERTISSEMENT_EPISODE_OUVERT',
      message: 'Un épisode ouvert existe déjà pour ce dossier.',
      episodesExistants: episodesOuverts,
    });
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
  res.status(201).json(data);
});

// Bascule est_hospitalisation : Non → Oui uniquement (sens unique confirmé, jamais de retour arrière).
app.patch('/api/episodes/:id/hospitaliser', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' requise." });
  }
  const { data: episode, error: erreurLecture } = await supabase
    .from('episodes').select('est_hospitalisation').eq('id', req.params.id).single();
  if (erreurLecture) return res.status(404).json({ error: 'Épisode introuvable' });
  if (episode.est_hospitalisation) {
    return res.status(400).json({ error: 'Déjà en hospitalisation — pas de retour en arrière possible.' });
  }
  const { data, error } = await supabase
    .from('episodes').update({ est_hospitalisation: true }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
      .from('episodes').select('id').eq('service', episode.service).eq('lit', lit).eq('statut', 'ouvert').neq('id', req.params.id);
    if (erreurOccupants) return res.status(500).json({ error: erreurOccupants.message });
    if (occupants && occupants.length > 0) return res.status(409).json({ error: `${lit} est déjà occupé par un autre patient de ${episode.service}.` });
  }

  const { data, error } = await supabase
    .from('episodes').update({ lit: lit || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Fiches — rattachées à un épisode. Appelée depuis le Calculateur (caisse_travailler) ET
// depuis l'approbation d'une exonération (demandes_repondre) — voir Demandes.js.
app.post('/api/fiches', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'demandes_repondre'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' ou 'demandes_repondre' requise." });
  }
  const { episode_id, cree_par, cree_par_uid, raw_state, local_id, total_global, breakdown, mode_paiement } = req.body;
  if (!episode_id) return res.status(400).json({ error: 'episode_id est requis' });

  // Idempotence : si cette transaction précise a déjà été enregistrée (réponse perdue
  // lors d'une coupure réseau, puis renvoyée par la file d'attente), on renvoie
  // l'enregistrement existant au lieu d'en créer un doublon.
  if (local_id) {
    const { data: existante } = await supabase.from('fiches').select('*').eq('local_id', local_id).maybeSingle();
    if (existante) return res.status(200).json(existante);
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
    const { data: derniere, error: erreurDerniere } = await supabase
      .from('fiches').select('numero_fiche').eq('episode_id', episode_id)
      .order('numero_fiche', { ascending: false }).limit(1).maybeSingle();
    if (erreurDerniere) return res.status(500).json({ error: erreurDerniere.message });
    const numero_fiche = (derniere?.numero_fiche || 0) + 1;

    // total_global/breakdown/mode_paiement sont écrits dès la création (pas seulement à
    // l'archivage) — sinon un dossier encore actif affiche un total de 0 malgré des
    // transactions déjà encaissées.
    const { data, error } = await supabase
      .from('fiches').insert({
        episode_id, numero_fiche, cree_par, cree_par_uid: cree_par_uid || null,
        raw_state: raw_state || {}, local_id: local_id || null,
        total_global: total_global || 0, breakdown: breakdown || {}, mode_paiement: mode_paiement || null,
      }).select().single();
    if (!error) return res.status(201).json(data);

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
  const { data, error } = await supabase
    .from('fiches').select('*').eq('episode_id', req.params.episodeId).order('date_creation');
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
  const { data: fiche, error: erreurLecture } = await supabase.from('fiches').select('id').eq('id', req.params.id).maybeSingle();
  if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
  if (!fiche) return res.status(200).json({ success: true }); // déjà supprimée (idempotent — utile pour une relecture de la file hors ligne)

  const { error: erreurPaiements } = await supabase.from('paiements').delete().eq('fiche_id', req.params.id);
  if (erreurPaiements) return res.status(500).json({ error: erreurPaiements.message });

  const { error: erreurFiche } = await supabase.from('fiches').delete().eq('id', req.params.id);
  if (erreurFiche) return res.status(500).json({ error: erreurFiche.message });

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
  res.json(data?.items || []);
});

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
  // Tout le reste (types_consultation, services_hospitalisation...) : catalogue_gerer.
  let permissionOk;
  if (type === 'permissions') {
    permissionOk = await aPermission(req.user.id, 'permissions_gerer');
  } else if (type === 'parametres') {
    permissionOk = await aPermission(req.user.id, 'parametres_gerer');
  } else {
    permissionOk = await aPermission(req.user.id, 'catalogue_gerer');
  }
  if (!permissionOk) return res.status(403).json({ error: `Permission requise pour modifier le catalogue "${type}".` });
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
  if (!(await aPermission(req.user.id, 'catalogue_gerer'))) {
    return res.status(403).json({ error: "Permission 'catalogue_gerer' requise." });
  }
  const { item } = req.body;
  if (!item || typeof item !== 'object') return res.status(400).json({ error: 'item (objet) requis.' });
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
// permission. rapport_chf_voir volontairement EXCLU : infirmier_chef l'a aussi, et ne doit
// justement jamais voir les paiements.
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
    res.json(await lireToutesLesPages(
      () => supabase.from('paiements').select('*').order('date_paiement', { ascending: false }).order('id')));
  } catch (e) {
    console.error('GET /api/paiements: lecture paginée échouée :', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Route : création d'un paiement — idempotente via local_id, même principe que /api/fiches.
// Appelée depuis la caisse (caisse_travailler), l'approbation d'une exonération
// (demandes_repondre) ET l'enregistrement d'un remboursement de crédit (Fiche Patient) — d'où
// aussi caisse_travailler puisque manier de l'argent reste une action de caisse.
app.post('/api/paiements', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'demandes_repondre'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' ou 'demandes_repondre' requise." });
  }
  const local_id = req.body.local_id || req.body.localId;
  if (local_id) {
    const { data: existant } = await supabase.from('paiements').select('*').eq('local_id', local_id).maybeSingle();
    if (existant) return res.status(200).json(existant);
  }

  const corps = { ...req.body };

  // Remboursement de crédit : le solde de référence vient TOUJOURS du dernier paiement connu
  // en base, jamais de ce que le navigateur affichait au moment du clic — sinon une donnée
  // locale périmée (ou 2 remboursements lancés au même instant) pourrait faire passer le solde
  // sous zéro sans que personne ne le remarque. solde_restant envoyé par le client est ignoré.
  if (corps.mode === 'remboursement_credit') {
    if (!corps.episode_id) return res.status(400).json({ error: 'episode_id requis pour un remboursement de crédit.' });
    // Un paiement ANNULÉ ne doit jamais servir de référence pour le solde — voir le même
    // correctif sur GET /api/dossiers/:id/historique (24/08, audit financier).
    const { data: dernierPaiement, error: erreurLecture } = await supabase
      .from('paiements').select('solde_restant').eq('episode_id', corps.episode_id)
      .or('annule.eq.false,annule.is.null')
      .order('date_paiement', { ascending: false }).limit(1).maybeSingle();
    if (erreurLecture) return res.status(500).json({ error: erreurLecture.message });
    const soldeActuel = (dernierPaiement && dernierPaiement.solde_restant) || 0;
    const montant = parseFloat(corps.montant) || 0;
    if (soldeActuel <= 0) return res.status(400).json({ error: 'Aucun solde de crédit à rembourser pour cet épisode.' });
    if (montant <= 0) return res.status(400).json({ error: 'Le montant du remboursement doit être supérieur à 0.' });
    if (montant > soldeActuel) return res.status(400).json({ error: `Le remboursement (${montant}) dépasse le solde restant (${soldeActuel}).` });
    corps.solde_restant = soldeActuel - montant;
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
  res.status(201).json(data);
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
    .from('paiements').select('*').eq('episode_id', episode.id).or('annule.eq.false,annule.is.null');
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

  const { data: fiches, error: erreurFiches } = await supabase.from('fiches').select('*').eq('episode_id', episode.id).in('id', fiche_ids);
  if (erreurFiches) return res.status(500).json({ error: erreurFiches.message });
  if ((fiches || []).length !== fiche_ids.length) return res.status(400).json({ error: "Une ou plusieurs fiches sélectionnées n'appartiennent pas à cet épisode." });

  const { data: paiementsEpisode, error: erreurPaiementsEpisode } = await supabase
    .from('paiements').select('*').eq('episode_id', episode.id).or('annule.eq.false,annule.is.null');
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
  // Retour d'Esdras (29/08) : alerte WhatsApp quand un médicament FRANCHIT son seuil critique —
  // lu AVANT le décrément pour ne comparer qu'à ce moment précis (avant > seuil, après <= seuil),
  // sinon chaque vente suivante d'un article déjà bas redéclencherait une alerte à chaque fois.
  const { data: avantData } = await supabase.from('catalog').select('items').eq('type', 'medicaments').single();
  const avantParId = new Map((avantData?.items || []).map(m => [m.id, m]));

  const { data, error } = await supabase.rpc('decrementer_stock_medicaments', { p_decrements: decrements });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL decrementer_stock_medicaments n'existe pas encore dans Supabase — colle fonction_decrementer_stock_et_numerotation_lots.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
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

  res.json({ success: true, items: data.items });
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
  const { data, error } = await supabase.rpc('decrementer_stock_medicaments', {
    p_decrements: lignes.map(l => ({ id: l.id, qte: l.qte })),
  });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL decrementer_stock_medicaments n'existe pas encore dans Supabase — colle fonction_decrementer_stock_et_numerotation_lots.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  if (!data.succes) {
    const detail = (data.manquants || []).map(m => `${m.nom || m.id} (${m.disponible} restant)`).join(', ');
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
    demande_par: demande_par || null, demande_par_uid: req.user.id,
  }).select().single();
  if (erreurInsert) return res.status(500).json({ error: erreurInsert.message });
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
  const { data, error } = await supabase.from('requisitions').select('*').order('date_requisition', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
  const { data, error } = await supabase.rpc('ajouter_stock_medicament', { p_id: id, p_quantite_ajoutee: quantite });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL ajouter_stock_medicament n'existe pas encore dans Supabase — colle fonction_maj_stock_medicament.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
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
  const { data, error } = await supabase.rpc('ajouter_stock_don_medicament', { p_id: id, p_ong: ong, p_quantite_ajoutee: quantite });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL ajouter_stock_don_medicament n'existe pas encore dans Supabase — colle fonction_stock_dons.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
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
  const { data, error } = await supabase.rpc('decrementer_stock_dons', { p_decrements: decrements });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL decrementer_stock_dons n'existe pas encore dans Supabase — colle fonction_stock_dons.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
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
    const lien = await getAuth().generatePasswordResetLink(email.trim(), { url: process.env.FRONTEND_URL || 'https://chf-app2.onrender.com' });
    res.json({ lien });
  } catch (e) {
    if (e.code === 'auth/user-not-found') return res.status(404).json({ error: 'Aucun compte avec cet email.' });
    res.status(500).json({ error: e.message });
  }
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
  const { patientNom, montantExonere, pourcentage, demandeur } = req.body || {};
  envoyerCallMeBot(`🎯 CHF : demande d'exonération de ${demandeur || 'inconnu'} pour ${patientNom || 'un patient'} — ${pourcentage || '?'}% (${Math.round(montantExonere) || '?'} Gdes). À approuver dans l'app.`);
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
const TABLES_A_SAUVEGARDER = [
  'dossiers', 'episodes', 'fiches', 'paiements', 'catalog', 'cloture_caisse', 'ong_partenaires',
  'users', 'audit_log', 'demandes_exoneration', 'pieces_jointes', 'requisitions',
  'transferts_service', 'salaires_service',
];

async function sauvegarderVersStorage() {
  const contenu = { genere_le: new Date().toISOString() };
  // Une table illisible (pas encore créée, renommée, RLS trop stricte) faisait échouer la
  // sauvegarde ENTIÈRE : plus aucune donnée protégée, pour une seule table en défaut. On continue
  // désormais table par table et on remonte la liste des échecs — une sauvegarde partielle vaut
  // infiniment mieux que pas de sauvegarde du tout, à condition que le trou soit annoncé (il
  // l'est : dans le fichier lui-même, dans les logs, et dans l'alerte WhatsApp quotidienne).
  const tablesEnEchec = [];
  for (const table of TABLES_A_SAUVEGARDER) {
    const { data, error } = await supabase.from(table).select('*');
    if (error) {
      console.error(`⚠️ Sauvegarde : table "${table}" illisible — ${error.message}`);
      tablesEnEchec.push(`${table} (${error.message})`);
      continue;
    }
    contenu[table] = data;
  }
  if (tablesEnEchec.length > 0) contenu._tables_en_echec = tablesEnEchec;
  if (Object.keys(contenu).filter(k => !k.startsWith('_') && k !== 'genere_le').length === 0) {
    throw new Error(`Aucune table n'a pu être lue : ${tablesEnEchec.join(' ; ')}`);
  }

  const { data: buckets, error: erreurListeBuckets } = await supabase.storage.listBuckets();
  if (erreurListeBuckets) throw new Error(`Liste des buckets : ${erreurListeBuckets.message}`);
  if (!buckets.some(b => b.name === BUCKET_SAUVEGARDES)) {
    const { error: erreurCreation } = await supabase.storage.createBucket(BUCKET_SAUVEGARDES, { public: false });
    if (erreurCreation) throw new Error(`Création du bucket : ${erreurCreation.message}`);
  }

  const nomFichier = `backup-${new Date().toISOString().slice(0, 10)}.json`;
  const { error: erreurUpload } = await supabase.storage
    .from(BUCKET_SAUVEGARDES)
    .upload(nomFichier, Buffer.from(JSON.stringify(contenu)), { contentType: 'application/json', upsert: true });
  if (erreurUpload) throw new Error(`Envoi vers Storage : ${erreurUpload.message}`);

  // Rétention : garde les 30 dernières sauvegardes quotidiennes (~1 mois), supprime le reste —
  // sinon le bucket grossit indéfiniment. upsert:true ci-dessus évite déjà les doublons si le
  // job tourne 2 fois le même jour (même nom de fichier, écrase plutôt que d'empiler).
  const { data: fichiers, error: erreurListeFichiers } = await supabase.storage.from(BUCKET_SAUVEGARDES).list();
  if (!erreurListeFichiers && fichiers && fichiers.length > 30) {
    const aSupprimer = fichiers.sort((a, b) => a.name.localeCompare(b.name)).slice(0, fichiers.length - 30).map(f => f.name);
    await supabase.storage.from(BUCKET_SAUVEGARDES).remove(aSupprimer);
  }

  const nombreLignes = Object.fromEntries(
    TABLES_A_SAUVEGARDER.filter(t => contenu[t]).map(t => [t, contenu[t].length])
  );
  return { fichier: nomFichier, nombreLignes, tablesEnEchec };
}

// Tous les jours à 6h UTC (~1h-2h du matin en Haïti, hors heures de pointe). Ne bloque jamais le
// serveur si ça échoue (ex: bucket pas encore créé, quota Storage) — juste journalisé, à vérifier
// dans les logs Render au besoin. Déclenchement manuel possible via POST /api/admin/backup-manuel.
cron.schedule('0 6 * * *', async () => {
  try {
    const resultat = await sauvegarderVersStorage();
    console.log(`✅ Sauvegarde automatique : ${resultat.fichier}`, resultat.nombreLignes);
    // Une sauvegarde PARTIELLE réussit techniquement mais laisse un trou : sans alerte, personne
    // ne saurait qu'une table n'est plus protégée, parfois pendant des mois.
    if (resultat.tablesEnEchec && resultat.tablesEnEchec.length > 0) {
      await envoyerCallMeBot(`⚠️ CHF : sauvegarde faite, mais ${resultat.tablesEnEchec.length} table(s) n'ont PAS pu être sauvegardées — ${resultat.tablesEnEchec.join(' ; ')}`);
    }
  } catch (e) {
    console.error('❌ Échec de la sauvegarde automatique :', e.message);
    // Retour d'Esdras (29/08) : seul moyen de savoir qu'une sauvegarde a échoué jusqu'ici était de
    // lire les logs Render, que personne ne regarde — une alerte WhatsApp directe comble ce trou.
    await envoyerCallMeBot(`⚠️ CHF : la sauvegarde automatique a échoué (${e.message}). Vérifie les logs Render.`);
  }
});

// Déclenchement manuel — pour vérifier que la sauvegarde automatique fonctionne réellement sans
// attendre la prochaine exécution planifiée, ou en cas de doute avant une opération risquée.
app.post('/api/admin/backup-manuel', async (req, res) => {
  if (!(await aPermission(req.user.id, 'sauvegarde_gerer'))) {
    return res.status(403).json({ error: "Permission 'sauvegarde_gerer' requise." });
  }
  try {
    const resultat = await sauvegarderVersStorage();
    res.json({ success: true, ...resultat });
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
    const { data: fichiers, error } = await supabase.storage.from(BUCKET_SAUVEGARDES).list();
    if (error) throw new Error(error.message);
    if (!fichiers || fichiers.length === 0) return res.json({ date: null });
    const plusRecent = fichiers.sort((a, b) => b.name.localeCompare(a.name))[0];
    const date = (plusRecent.name.match(/backup-(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
    res.json({ date });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend CHF demarré sur le port ${PORT}`);
});
