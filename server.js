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

// Miroir exact de utils/permissions.js côté front (mêmes valeurs par défaut) — nécessaire pour
// que le serveur puisse vérifier une permission même si la table catalog('permissions') est
// encore vide (avant le premier enregistrement depuis l'écran "Rôles & permissions").
const PERMISSIONS_PAR_DEFAUT = [
  { role: 'administrateur', permissions: ['dossier_creer','episode_creer','fiche_patient_voir','caisse_travailler','demandes_voir','demandes_repondre','dossier_annuler','paiement_annuler','facturation_supprimer','facturation_modifier','facturation_exporter','direction_voir','analytics_voir','rapport_chf_voir','catalogue_gerer','stock_gerer','partenaires_gerer','utilisateurs_gerer','permissions_gerer','sauvegarde_gerer'] },
  { role: 'direction', permissions: ['dossier_creer','episode_creer','fiche_patient_voir','caisse_travailler','demandes_voir','demandes_repondre','dossier_annuler','paiement_annuler','facturation_supprimer','facturation_modifier','facturation_exporter','direction_voir','analytics_voir','rapport_chf_voir','catalogue_gerer','stock_gerer','partenaires_gerer'] },
  { role: 'comptable', permissions: ['dossier_creer','episode_creer','fiche_patient_voir','caisse_travailler','demandes_voir','facturation_modifier','facturation_exporter','rapport_chf_voir'] },
  { role: 'auditeur', permissions: ['dossier_creer','episode_creer','fiche_patient_voir','facturation_exporter','rapport_chf_voir'] },
  { role: 'lecteur', permissions: ['dossier_creer','episode_creer','fiche_patient_voir'] },
  { role: 'archiviste', permissions: ['dossier_creer','fiche_patient_voir'] },
  { role: 'infirmier', permissions: ['dossier_creer','fiche_patient_voir','rapport_chf_voir'] },
];

// Vérifie qu'un utilisateur a une permission donnée : lit son rôle, puis la table des
// permissions par rôle (catalog/permissions), avec repli sur les valeurs par défaut si cette
// table n'a jamais été enregistrée. Utilisé partout où une route exige un droit précis, pour que
// le backend reste toujours d'accord avec ce qu'affiche/autorise le front (pas 2 systèmes qui
// pourraient diverger).
async function aPermission(userId, cle) {
  const { data: profil } = await supabase.from('users').select('role').eq('id', userId).maybeSingle();
  if (!profil) return false;
  const { data: catalogue } = await supabase.from('catalog').select('items').eq('type', 'permissions').maybeSingle();
  const table = (catalogue && catalogue.items && catalogue.items.length > 0) ? catalogue.items : PERMISSIONS_PAR_DEFAUT;
  const entree = table.find(r => r.role === profil.role);
  return !!(entree && entree.permissions && entree.permissions.includes(cle));
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ statut: 'CHF backend (Firebase Auth + Supabase DB) en ligne' }));

// Vérification via Firebase Admin SDK — remplace la vérification Supabase.
// req.user.id remplace l'ancien req.user.id Supabase ; c'est un UID Firebase (texte),
// pas un UUID — voir le schéma (users.id, audit_log.effectue_par_uid sont en TEXT).
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant ou invalide' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decoded = await getAuth().verifyIdToken(token);
    req.user = { id: decoded.uid, email: decoded.email };
    next();
  } catch (e) {
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

function ficheVersFlat(f) {
  return {
    id: f.id, numeroFiche: f.numero_fiche, dateCreation: f.date_creation,
    creePar: f.cree_par, probleme: f.probleme, noteProbleme: f.note_probleme,
    totalGlobal: f.total_global, breakdown: f.breakdown, modePaiement: f.mode_paiement,
    rawState: f.raw_state,
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
  const { data: fiches } = await supabase.from('fiches').select('*').eq('episode_id', ep.id).order('date_creation');
  // episodes n'a pas de colonne total_global — ce total n'existait qu'en mémoire côté
  // navigateur, calculé une fois à l'archivage (executerArchivage) et jamais recalculé au
  // chargement suivant. Tout dossier rechargé depuis le serveur (nouvel onglet, F5, écran
  // Lots & Facturation qui lit ce total pour chaque dossier) affichait donc 0 Gdes malgré des
  // fiches réelles en base. Recalculé ici à chaque lecture, à partir des vraies fiches — source
  // unique de vérité, plutôt que de rapiécer chaque écran qui lit ce total un par un.
  const totalGlobal = (fiches || []).reduce((s, f) => s + (Number(f.total_global) || 0), 0);
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
    // Distingue Consultation de Vente comptoir (Achat Express) — les deux ont
    // estHospitalisation: false, seul voie_entree ('consultation' vs 'vente_comptoir') les sépare.
    voieEntree: ep.voie_entree,
    dateHeure: new Date(ep.date_ouverture).toLocaleDateString('fr-FR'),
    timestamp: new Date(ep.date_ouverture).getTime(),
    totalGlobal,
    fiches: (fiches || []).map(ficheVersFlat),
  };
}

app.get('/api/episodes', async (req, res) => {
  const { data: episodes, error } = await supabase.from('episodes').select('*').order('date_ouverture', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const resultats = await Promise.all((episodes || []).map(episodeVersFlat));
  res.json(resultats);
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

// Recherche simple par nom exact (insensible à la casse). La version floue
// (fautes de frappe/variantes) est volontairement pas encore construite —
// en attente de décision sur le niveau de tolérance.
// Recherche par nom exact OU par numéro de dossier (si le patient a sa carte)
app.get('/api/dossiers/recherche', async (req, res) => {
  const nom = (req.query.nom || '').trim();
  const numero = (req.query.numero || '').trim();
  if (!nom && !numero) return res.json([]);

  let requete = supabase.from('dossiers').select('*');
  // Recherche PARTIELLE (%nom%), pas exacte — avant, taper "Jean" ne retrouvait jamais "Jean
  // Baptiste Pierre", et la moindre variation (espace en trop, faute de frappe) faisait croire
  // qu'aucun dossier n'existait, créant un doublon au lieu de retrouver le patient existant.
  // Reste sensible aux vraies fautes de frappe/accents (tolérance complète = extension Postgres
  // pg_trgm, pas encore activée — voir NOTES_POUR_PROCHAIN_CLAUDE.md).
  requete = numero ? requete.eq('numero_dossier', numero) : requete.ilike('nom', `%${nom}%`);

  const { data, error } = await requete;
  if (error) return res.status(500).json({ error: error.message });
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
    if (error.code === '23505' && local_id) {
      const { data: existant } = await supabase.from('dossiers').select('*').eq('local_id', local_id).maybeSingle();
      if (existant) return res.status(200).json(existant);
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
app.put('/api/dossiers/:id', async (req, res) => {
  if (!(await aPermission(req.user.id, 'fiche_patient_modifier'))) {
    return res.status(403).json({ error: "Permission 'fiche_patient_modifier' requise." });
  }
  const { nom, date_naissance, telephone, adresse } = req.body;
  if (!nom || !String(nom).trim()) return res.status(400).json({ error: 'Le nom est requis' });
  const { data, error } = await supabase
    .from('dossiers').update({ nom, date_naissance: dateOuNull(date_naissance), telephone, adresse }).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
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
  const enrichis = await Promise.all((episodes || []).map(async (ep) => {
    const { data: paiements } = await supabase
      .from('paiements').select('*').eq('episode_id', ep.id).order('date_paiement', { ascending: false }).limit(1);
    return { ...ep, dernierPaiement: (paiements && paiements[0]) || null };
  }));
  res.json(enrichis);
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

// Fiches — rattachées à un épisode. Appelée depuis le Calculateur (caisse_travailler) ET
// depuis l'approbation d'une exonération (demandes_repondre) — voir Demandes.js.
app.post('/api/fiches', async (req, res) => {
  if (!(await aPermission(req.user.id, 'caisse_travailler')) && !(await aPermission(req.user.id, 'demandes_repondre'))) {
    return res.status(403).json({ error: "Permission 'caisse_travailler' ou 'demandes_repondre' requise." });
  }
  const { episode_id, numero_fiche, cree_par, cree_par_uid, raw_state, local_id, total_global, breakdown, mode_paiement } = req.body;
  if (!episode_id) return res.status(400).json({ error: 'episode_id est requis' });

  // Idempotence : si cette transaction précise a déjà été enregistrée (réponse perdue
  // lors d'une coupure réseau, puis renvoyée par la file d'attente), on renvoie
  // l'enregistrement existant au lieu d'en créer un doublon.
  if (local_id) {
    const { data: existante } = await supabase.from('fiches').select('*').eq('local_id', local_id).maybeSingle();
    if (existante) return res.status(200).json(existante);
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
  if (error) {
    if (error.code === '23505') { // violation de contrainte unique — quelqu'un d'autre l'a inséré entre-temps
      const { data: existante } = await supabase.from('fiches').select('*').eq('local_id', local_id).maybeSingle();
      if (existante) return res.status(200).json(existante);
    }
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

app.get('/api/fiches/episode/:episodeId', async (req, res) => {
  const { data, error } = await supabase
    .from('fiches').select('*').eq('episode_id', req.params.episodeId).order('date_creation');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
  // 'permissions' : réservé à permissions_gerer (écran Rôles & permissions).
  // 'medicaments'/'actes' : catalogue_gerer (Tarifs Pharma/Actes) OU caisse_travailler — cette
  // même route sert aussi à incrémenter un simple compteur d'usage depuis le Calculateur
  // (CalculateurPanel.js), utilisé par tout caissier qui n'a pas forcément catalogue_gerer.
  // Tout le reste (types_consultation, services_hospitalisation...) : catalogue_gerer.
  let permissionOk;
  if (type === 'permissions') {
    permissionOk = await aPermission(req.user.id, 'permissions_gerer');
  } else if (type === 'medicaments' || type === 'actes') {
    permissionOk = (await aPermission(req.user.id, 'catalogue_gerer')) || (await aPermission(req.user.id, 'caisse_travailler'));
  } else {
    permissionOk = await aPermission(req.user.id, 'catalogue_gerer');
  }
  if (!permissionOk) return res.status(403).json({ error: `Permission requise pour modifier le catalogue "${type}".` });
  const { items } = req.body;
  // upsert (pas update) : la toute première écriture doit pouvoir CRÉER la ligne "medicaments"/
  // "actes" si elle n'existe pas encore — un simple update ne peut jamais créer une ligne absente,
  // ce qui rendait "Ajouter" impossible à utiliser tant que la table catalog était vide.
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

// Route : récupération des paiements
app.get('/api/paiements', async (req, res) => {
  const { data, error } = await supabase
    .from('paiements')
    .select('*')
    .order('date_paiement', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
    const { data: dernierPaiement, error: erreurLecture } = await supabase
      .from('paiements').select('solde_restant').eq('episode_id', corps.episode_id)
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

// Décrémente le stock de façon atomique (voir fonction_decrementer_stock.sql) — remplace le
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
  const { data, error } = await supabase.rpc('decrementer_stock_medicaments', { p_decrements: decrements });
  if (error) {
    if (error.code === '42883') {
      return res.status(500).json({ error: "La fonction SQL decrementer_stock_medicaments n'existe pas encore dans Supabase — colle fonction_decrementer_stock.sql dans le SQL Editor." });
    }
    return res.status(500).json({ error: error.message });
  }
  if (!data.succes) {
    const detail = (data.manquants || []).map(m => `${m.nom || m.id} (${m.disponible} restant)`).join(', ');
    return res.status(409).json({ error: `Stock insuffisant : ${detail}`, manquants: data.manquants });
  }
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
// SAUVEGARDE AUTOMATIQUE — Backup/Restore (AppHospitaliere.js) reste manuel, dépend de
// quelqu'un qui pense à cliquer. Ceci tourne tout seul, tous les jours, sans dépendre de
// personne. Exporte les tables essentielles vers un bucket Supabase Storage dédié, jamais vers
// le disque du serveur Render (éphémère — perdu à chaque redéploiement).
// ============================================================
const BUCKET_SAUVEGARDES = 'sauvegardes-automatiques';
const TABLES_A_SAUVEGARDER = ['dossiers', 'episodes', 'fiches', 'paiements', 'catalog', 'cloture_caisse', 'ong_partenaires', 'users', 'audit_log'];

async function sauvegarderVersStorage() {
  const contenu = { genere_le: new Date().toISOString() };
  for (const table of TABLES_A_SAUVEGARDER) {
    const { data, error } = await supabase.from(table).select('*');
    if (error) throw new Error(`Lecture de "${table}" : ${error.message}`);
    contenu[table] = data;
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

  const nombreLignes = Object.fromEntries(TABLES_A_SAUVEGARDER.map(t => [t, contenu[t].length]));
  return { fichier: nomFichier, nombreLignes };
}

// Tous les jours à 6h UTC (~1h-2h du matin en Haïti, hors heures de pointe). Ne bloque jamais le
// serveur si ça échoue (ex: bucket pas encore créé, quota Storage) — juste journalisé, à vérifier
// dans les logs Render au besoin. Déclenchement manuel possible via POST /api/admin/backup-manuel.
cron.schedule('0 6 * * *', async () => {
  try {
    const resultat = await sauvegarderVersStorage();
    console.log(`✅ Sauvegarde automatique : ${resultat.fichier}`, resultat.nombreLignes);
  } catch (e) {
    console.error('❌ Échec de la sauvegarde automatique :', e.message);
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend CHF demarré sur le port ${PORT}`);
});
