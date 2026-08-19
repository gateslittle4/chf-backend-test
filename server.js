require('dotenv').config();
const express = require('express');
const cors = require('cors');
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

async function episodeVersFlat(ep) {
  const { data: dossier } = await supabase.from('dossiers').select('*').eq('id', ep.dossier_id).single();
  const { data: fiches } = await supabase.from('fiches').select('*').eq('episode_id', ep.id).order('date_creation');
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
    dateHeure: new Date(ep.date_ouverture).toLocaleDateString('fr-FR'),
    timestamp: new Date(ep.date_ouverture).getTime(),
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
  const d = req.body;
  const { data: dossier, error: erreurDossier } = await supabase
    .from('dossiers')
    .insert({
      numero_dossier: d.numDossier || `AUTO-${Date.now()}`,
      nom: d.nomPatient, date_naissance: d.dateNaissance, telephone: d.telephone, adresse: d.adresse,
    })
    .select().single();
  if (erreurDossier) return res.status(500).json({ error: erreurDossier.message });

  const { data: episode, error: erreurEpisode } = await supabase
    .from('episodes')
    .insert({
      dossier_id: dossier.id,
      voie_entree: 'consultation', service: d.serviceChoisi || 'Général',
      type_patient: flatVersTypePatient(d.typePatient), ong_partenaire: d.ongPartenaire || null,
      statut: flatVersStatut(d.status), est_hospitalisation: false,
    })
    .select().single();
  if (erreurEpisode) return res.status(500).json({ error: erreurEpisode.message });

  if (Array.isArray(d.fiches) && d.fiches.length > 0) {
    await supabase.from('fiches').insert(d.fiches.map(f => ({ episode_id: episode.id, ...ficheVersColonnes(f) })));
  }
  res.status(201).json(await episodeVersFlat(episode));
});

app.put('/api/episodes/:id', async (req, res) => {
  const d = req.body;
  const maj = {};
  if (d.serviceChoisi !== undefined) maj.service = d.serviceChoisi;
  if (d.typePatient !== undefined) maj.type_patient = flatVersTypePatient(d.typePatient);
  if (d.ongPartenaire !== undefined) maj.ong_partenaire = d.ongPartenaire;
  if (d.status !== undefined) {
    maj.statut = flatVersStatut(d.status);
    maj.date_suspension = d.status === 'suspendu' ? (d.dateSuspension || new Date().toISOString()) : null;
    maj.mois_report = d.status === 'reporte' ? (d.moisReport || null) : null;
  }
  if (d.numeroLot !== undefined) maj.numero_lot = d.numeroLot;
  if (d.verrouilleFacture !== undefined) maj.verrouille_facture = d.verrouilleFacture;

  if (Object.keys(maj).length > 0) {
    const { error } = await supabase.from('episodes').update(maj).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
  }

  // Fiches : upsert (id fourni = mise à jour, sinon = nouvelle fiche). Ne supprime
  // jamais une fiche absente du tableau reçu — cette route ne gère que l'ajout/modif,
  // pas la suppression de fiches individuelles (aucun ancien appel ne l'utilisait ainsi).
  if (Array.isArray(d.fiches)) {
    for (const f of d.fiches) {
      if (f.id) await supabase.from('fiches').update(ficheVersColonnes(f)).eq('id', f.id);
      else await supabase.from('fiches').insert({ episode_id: req.params.id, ...ficheVersColonnes(f) });
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
    const { data: profil } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
    if (!profil || !(profil.role === 'direction' || profil.role === 'administrateur')) {
      return res.status(403).json({ error: "Seule la direction peut supprimer un dossier déjà archivé." });
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
  requete = numero ? requete.eq('numero_dossier', numero) : requete.ilike('nom', nom);

  const { data, error } = await requete;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/dossiers', async (req, res) => {
  const { numero_dossier, nom, date_naissance, telephone, adresse } = req.body;
  if (!nom) return res.status(400).json({ error: 'Le nom est requis' });
  if (!numero_dossier) return res.status(400).json({ error: 'Le numéro de dossier est requis' });
  const { data, error } = await supabase
    .from('dossiers').insert({ numero_dossier, nom, date_naissance, telephone, adresse }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
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
  const dossier_id = req.params.dossierId;
  const { voie_entree, service, type_consultation, type_patient, ong_partenaire, est_hospitalisation, forcerMalgreAvertissement } = req.body;
  if (!dossier_id || !voie_entree || !service || !type_patient) {
    return res.status(400).json({ error: 'dossier_id (dans l\'URL), voie_entree, service et type_patient sont requis' });
  }

  const { data: episodesOuverts, error: erreurRecherche } = await supabase
    .from('episodes').select('*').eq('dossier_id', dossier_id).eq('statut', 'ouvert');
  if (erreurRecherche) return res.status(500).json({ error: erreurRecherche.message });

  const episodeHospitalisationOuvert = (episodesOuverts || []).find(e => e.est_hospitalisation === true);

  // Règle stricte : un patient hospitalisé ne peut JAMAIS avoir un 2e dossier ouvert.
  // Aucun moyen de passer outre, même avec forcerMalgreAvertissement.
  if (episodeHospitalisationOuvert) {
    return res.status(409).json({
      error: 'BLOCAGE_HOSPITALISATION',
      message: "Ce patient a déjà un épisode hospitalisation ouvert — impossible d'en créer un nouveau.",
      episodeExistant: episodeHospitalisationOuvert,
    });
  }

  // Règle souple : épisode ouvert non-hospitalisation → avertissement contournable.
  if (episodesOuverts.length > 0 && !forcerMalgreAvertissement) {
    return res.status(409).json({
      error: 'AVERTISSEMENT_EPISODE_OUVERT',
      message: 'Un épisode ouvert existe déjà pour ce dossier.',
      episodesExistants: episodesOuverts,
    });
  }

  const { data, error } = await supabase
    .from('episodes')
    .insert({ dossier_id, voie_entree, service: service || null, type_consultation: type_consultation || null, type_patient, ong_partenaire: ong_partenaire || null, est_hospitalisation: !!est_hospitalisation })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Bascule est_hospitalisation : Non → Oui uniquement (sens unique confirmé, jamais de retour arrière).
app.patch('/api/episodes/:id/hospitaliser', async (req, res) => {
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
  const { en_attente } = req.body;
  const { data, error } = await supabase
    .from('episodes').update({ en_attente_resultats: !!en_attente }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Fiches — rattachées à un épisode
app.post('/api/fiches', async (req, res) => {
  const { episode_id, numero_fiche, cree_par, raw_state, local_id } = req.body;
  if (!episode_id) return res.status(400).json({ error: 'episode_id est requis' });

  // Idempotence : si cette transaction précise a déjà été enregistrée (réponse perdue
  // lors d'une coupure réseau, puis renvoyée par la file d'attente), on renvoie
  // l'enregistrement existant au lieu d'en créer un doublon.
  if (local_id) {
    const { data: existante } = await supabase.from('fiches').select('*').eq('local_id', local_id).maybeSingle();
    if (existante) return res.status(200).json(existante);
  }

  const { data, error } = await supabase
    .from('fiches').insert({ episode_id, numero_fiche, cree_par, raw_state: raw_state || {}, local_id: local_id || null }).select().single();
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
  const { items } = req.body;
  const { error } = await supabase
    .from('catalog')
    .update({ items, updated_at: new Date().toISOString() })
    .eq('type', type);
  if (error) return res.status(500).json({ error: error.message });
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
app.post('/api/paiements', async (req, res) => {
  const local_id = req.body.local_id || req.body.localId;
  if (local_id) {
    const { data: existant } = await supabase.from('paiements').select('*').eq('local_id', local_id).maybeSingle();
    if (existant) return res.status(200).json(existant);
  }
  const { data, error } = await supabase
    .from('paiements')
    .insert({ ...req.body, local_id: local_id || null })
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
  const { data: profil } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
  if (!profil || !(profil.role === 'direction' || profil.role === 'administrateur')) {
    return res.status(403).json({ error: "Seule la direction peut annuler une transaction déjà encaissée." });
  }
  const { motif } = req.body;
  if (!motif || !motif.trim()) return res.status(400).json({ error: "Un motif est requis pour annuler une transaction." });

  const { data: paiement, error: erreurLecture } = await supabase.from('paiements').select('*').eq('id', req.params.id).single();
  if (erreurLecture) return res.status(404).json({ error: "Paiement introuvable." });
  if (paiement.annule) return res.status(400).json({ error: "Ce paiement est déjà annulé." });

  const { data, error } = await supabase
    .from('paiements')
    .update({ annule: true, annule_par: req.user.email || req.user.id, annule_par_uid: req.user.id, annule_le: new Date().toISOString(), motif_annulation: motif })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Route : création d'un utilisateur par un administrateur (remplace
// auth.createUserWithEmailAndPassword de Firebase, qui n'a pas d'équivalent sûr côté
// client avec Supabase — créer un compte via le SDK client déconnecterait
// l'administrateur en le remplaçant par la session du nouveau compte).
// Protégée : seul un appelant dont la ligne dans la table "users" a role =
// 'administrateur' peut l'utiliser.
app.post('/api/admin/users', async (req, res) => {
  const { data: profil } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
  if (!profil || profil.role !== 'administrateur') {
    return res.status(403).json({ error: "Réservé aux administrateurs." });
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend CHF demarré sur le port ${PORT}`);
});
