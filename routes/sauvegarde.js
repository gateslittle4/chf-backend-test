// routes/sauvegarde.js — Sauvegarde quotidienne, purges de la corbeille, restauration, tâches planifiées.
// Découpé de server.js le 23/10 sans changer une ligne de logique : le texte des routes est celui d'avant. Ce module reçoit de server.js
// l'application Express et ses dépendances partagées (base, droits, journal d'audit, lecteurs communs) ; voir « montage des routes » dans server.js.
const cron = require('node-cron');
const { fermerConsultationsAnciennes } = require('../utils/fermetureConsultations');
const crypto = require('crypto');
const { creerServiceSauvegarde } = require('../utils/sauvegardeServeur');
const { fermerPostesExpires } = require('../utils/fermetureAutoPostes');
const { creerMiddlewareIdempotence, purgerClesIdempotence } = require('../utils/idempotence');

module.exports = function monterSauvegarde(app, { BUCKET_PIECES_JOINTES, FUSEAU_HAITI, aPermission, envoyerCallMeBot, lancerSurveillanceQualite, supabase, surveillanceQualite, synchroListes }) { // @enveloppe
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
}; // @enveloppe
