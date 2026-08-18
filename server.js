require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const admin = require('firebase-admin');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_ANON_KEY manquants.');
  console.error('   → Copiez .env.example vers .env et remplissez vos vraies valeurs');
  console.error('   → (Supabase → Project Settings → API)');
  process.exit(1);
}
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT manquant.');
  console.error('   → Firebase Console → ⚙️ Paramètres du projet → Comptes de service');
  console.error('   → "Générer une nouvelle clé privée" → collez le JSON entier (une seule ligne) dans .env');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});

const app = express();

// Base de données : reste Supabase, sans changement. RLS n'est pas encore activé
// sur ces tables (chantier séparé, déjà connu) — donc la clé anon suffit pour
// l'instant, la vraie porte d'entrée est maintenant la vérification Firebase ci-dessous.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

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
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { id: decoded.uid, email: decoded.email, nom: decoded.name || decoded.email };
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

// Version PURE (aucun appel réseau) de episodeVersFlat, pour la liste : au lieu de
// refaire 2 requêtes Supabase par épisode (dossier + fiches), GET /api/episodes ci-dessous
// demande à Supabase de faire la jointure en une seule requête (embedded resources —
// nécessite les clés étrangères episodes.dossier_id -> dossiers.id et
// fiches.episode_id -> episodes.id, voir verifier_cles_etrangeres_dossier_episode.sql).
// episodeVersFlat (ci-dessus) reste inchangée : elle continue de faire ses propres
// requêtes pour les routes à UN SEUL épisode (création, modification), où 2 requêtes
// ne posent aucun problème d'échelle.
function episodeEmbedVersFlat(ep) {
  const dossier = ep.dossiers || {};
  const fiches = [...(ep.fiches || [])].sort((a, b) => new Date(a.date_creation) - new Date(b.date_creation));
  return {
    id: ep.id,
    nomPatient: dossier.nom, dateNaissance: dossier.date_naissance,
    telephone: dossier.telephone, adresse: dossier.adresse, numDossier: dossier.numero_dossier,
    typePatient: typePatientVersFlat(ep.type_patient),
    ongPartenaire: ep.ong_partenaire || null,
    serviceChoisi: ep.service,
    status: statutVersFlat(ep),
    dateSuspension: ep.date_suspension, moisReport: ep.mois_report,
    numeroLot: ep.numero_lot, verrouilleFacture: ep.verrouille_facture,
    dateHeure: new Date(ep.date_ouverture).toLocaleDateString('fr-FR'),
    timestamp: new Date(ep.date_ouverture).getTime(),
    fiches: fiches.map(ficheVersFlat),
  };
}

app.get('/api/episodes', async (req, res) => {
  const { data: episodes, error } = await supabase
    .from('episodes')
    .select('*, dossiers(nom, date_naissance, telephone, adresse, numero_dossier), fiches(*)')
    .order('date_ouverture', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json((episodes || []).map(episodeEmbedVersFlat));
});

// Création : DEUX formats arrivent sur ce même chemin, distingués par la présence de
// dossier_id. Ces deux routes existaient SÉPARÉMENT avant (même chemin, même méthode) —
// Express n'exécutait alors QUE la première (ci-dessous), la seconde (l'anti-doublon,
// via l'onglet Dossier/Épisode) n'était donc jamais atteinte. Fusionnées ici pour de bon.
async function creerEpisodeFormatCompatibilite(d, res) {
  // Ancien flux (CalculateurPanel) : pas de dossier_id, il ne connaît que la création
  // directe → on crée un dossier ET un épisode ensemble. Pas de vérif anti-doublon ici :
  // ce flux n'a pas d'écran pour afficher un avertissement/blocage à l'utilisateur.
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
}

async function creerEpisodeFormatDossierExistant(d, res) {
  // Nouveau flux (onglet 🔍 Dossier/Épisode) : le dossier a déjà été trouvé ou créé
  // séparément via /api/dossiers — la règle anti-doublon s'applique ICI, pas seulement
  // à l'écran, pour qu'un appel direct à cette route ne puisse pas la contourner.
  const { dossier_id, voie_entree, service, type_patient, ong_partenaire, est_hospitalisation, forcerMalgreAvertissement } = d;
  if (!voie_entree || !service || !type_patient) {
    return res.status(400).json({ error: 'dossier_id, voie_entree, service et type_patient sont requis' });
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
    .insert({ dossier_id, voie_entree, service, type_patient, ong_partenaire: ong_partenaire || null, est_hospitalisation: !!est_hospitalisation })
    .select().single();
  if (error) {
    // Garde-fou côté base (voir securite_anti_doublon_hospitalisation.sql) : la vérification
    // ci-dessus fait 2 appels séparés (lire puis écrire) donc 2 requêtes simultanées peuvent
    // toutes les deux la passer avant que l'une des deux insertions ne soit visible de l'autre.
    // L'index unique partiel côté Postgres est la vraie garantie — s'il rejette l'insertion
    // (code 23505 = violation de contrainte unique), c'est exactement la même situation que
    // le blocage ci-dessus, donc on renvoie la même réponse 409 plutôt qu'une erreur 500.
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'BLOCAGE_HOSPITALISATION',
        message: "Ce patient a déjà un épisode hospitalisation ouvert — impossible d'en créer un nouveau.",
      });
    }
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
}

app.post('/api/episodes', async (req, res) => {
  const d = req.body;
  // Le nouveau flux fournit toujours dossier_id (dossier déjà choisi séparément) ;
  // l'ancien flux ne le connaît pas et fournit nomPatient à la place — c'est ce qui
  // distingue les deux cas sur ce même chemin.
  if (d.dossier_id) return creerEpisodeFormatDossierExistant(d, res);
  return creerEpisodeFormatCompatibilite(d, res);
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

// Création d'un épisode — règle anti-doublon appliquée dans creerEpisodeFormatDossierExistant
// ci-dessus (fusionnée avec la route de compatibilité, voir commentaire plus haut).

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
  const { episode_id } = req.body;
  if (!episode_id) return res.status(400).json({ error: 'episode_id est requis' });
  const { data, error } = await supabase
    .from('fiches').insert({ episode_id, ...ficheVersColonnes(req.body) }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Modification d'une fiche déjà créée (ex: correction après "encaisser")
app.patch('/api/fiches/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('fiches').update(ficheVersColonnes(req.body)).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/fiches/episode/:episodeId', async (req, res) => {
  const { data, error } = await supabase
    .from('fiches').select('*').eq('episode_id', req.params.episodeId).order('date_creation');
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(ficheVersFlat));
});

// ============================================================
// DEMANDES D'EXONÉRATION — remplace la collection Firestore 'demandes_exoneration'.
// Reliées à un vrai episode_id (clé étrangère Supabase) au lieu du seul nom du patient
// en texte. Pas d'abonnement temps réel ici (le front interroge par sondage) pour rester
// cohérent avec le reste de cette API — voir migration SQL fournie séparément.
// ============================================================

app.post('/api/demandes-exoneration', async (req, res) => {
  const { episode_id, patient_nom, montant_total, pourcentage_demande, montant_exonere, motif } = req.body;
  if (!episode_id || !patient_nom || pourcentage_demande == null || montant_exonere == null) {
    return res.status(400).json({ error: 'episode_id, patient_nom, pourcentage_demande et montant_exonere sont requis' });
  }
  const { data, error } = await supabase
    .from('demandes_exoneration')
    .insert({ episode_id, patient_nom, montant_total, pourcentage_demande, montant_exonere, motif, demandeur: req.user.nom })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.get('/api/demandes-exoneration', async (req, res) => {
  let requete = supabase.from('demandes_exoneration').select('*').order('date_demande', { ascending: false });
  if (req.query.statut) requete = requete.eq('statut', req.query.statut);
  const { data, error } = await requete;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Pour que la caisse sache si SA demande a été traitée (sondage, voir commentaire plus haut)
app.get('/api/demandes-exoneration/:id', async (req, res) => {
  const { data, error } = await supabase.from('demandes_exoneration').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Demande introuvable' });
  res.json(data);
});

app.patch('/api/demandes-exoneration/:id', async (req, res) => {
  const { statut } = req.body;
  if (!['accepte', 'refuse'].includes(statut)) return res.status(400).json({ error: "statut doit être 'accepte' ou 'refuse'" });
  const { data, error } = await supabase
    .from('demandes_exoneration')
    .update({ statut, reponse_par: req.user.nom, date_reponse: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
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
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Route : création d'un paiement
app.post('/api/paiements', async (req, res) => {
  const { data, error } = await supabase
    .from('paiements')
    .insert(req.body)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data[0]);
});

// Route : création d'un utilisateur par un administrateur (remplace
// auth.createUserWithEmailAndPassword de Firebase, qui n'a pas d'équivalent sûr côté
// client avec Supabase — créer un compte via le SDK client déconnecterait
// l'administrateur en le remplaçant par la session du nouveau compte).
// Protégée : seul un appelant dont la ligne dans la table "users" a role =
// 'administrateur' peut l'utiliser.
// Vérifie que l'appelant est administrateur (table users, pas juste "connecté").
// Utilisé par toutes les routes admin/users — la création de compte (ci-dessous) le
// faisait déjà en dur ; ce qui n'était PAS protégé pareil côté serveur, c'était la
// lecture de la liste et la modification de rôle/statut, qui passaient jusqu'ici par un
// accès Supabase direct depuis le navigateur (clé anon, voir components/GestionUtilisateurs.js
// et le shim api/firebase.js) — donc en pratique protégées seulement par l'interface (le
// bouton caché), pas par le serveur. N'importe quel compte connecté pouvait en théorie
// s'auto-promouvoir administrateur directement via ce chemin. Corrigé ci-dessous.
async function exigerAdministrateur(req, res) {
  const { data: profil } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
  if (!profil || profil.role !== 'administrateur') {
    res.status(403).json({ error: "Réservé aux administrateurs." });
    return false;
  }
  return true;
}

app.get('/api/admin/users', async (req, res) => {
  if (!(await exigerAdministrateur(req, res))) return;
  const { data, error } = await supabase.from('users').select('*').order('display_name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/admin/users/:id', async (req, res) => {
  if (!(await exigerAdministrateur(req, res))) return;
  const { role, active, display_name } = req.body;
  const maj = {};
  if (role !== undefined) maj.role = role;
  if (active !== undefined) maj.active = active;
  if (display_name !== undefined) maj.display_name = display_name;
  const { data, error } = await supabase.from('users').update(maj).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Crée la ligne "profil" (rôle) pour un compte Firebase déjà créé via /api/admin/users.
app.post('/api/admin/users/:id/profil', async (req, res) => {
  if (!(await exigerAdministrateur(req, res))) return;
  const { email, display_name, role } = req.body;
  const { data, error } = await supabase.from('users')
    .insert({ id: req.params.id, email, display_name, role, active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.post('/api/admin/users', async (req, res) => {
  if (!(await exigerAdministrateur(req, res))) return;
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email et password requis.' });
  try {
    const nouvelUtilisateur = await admin.auth().createUser({ email, password, emailVerified: true });
    res.status(201).json({ uid: nouvelUtilisateur.uid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Un utilisateur Firebase valide peut s'assurer que SA PROPRE ligne de profil existe,
// avec un rôle par défaut fixe et non modifiable ici — pas besoin d'être administrateur
// puisque ça ne touche jamais que sa propre ligne (req.user.id vient du token vérifié,
// pas du corps de la requête), avec toujours le même rôle prudent par défaut.
app.post('/api/mon-profil', async (req, res) => {
  const { data: existant } = await supabase.from('users').select('*').eq('id', req.user.id).maybeSingle();
  if (existant) return res.json(existant);
  const { data, error } = await supabase.from('users').insert({
    id: req.user.id, email: req.user.email, display_name: req.user.nom, role: 'auditeur', active: true
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend CHF demarré sur le port ${PORT}`);
});
