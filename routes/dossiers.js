// routes/dossiers.js — Dossiers des patients : création, fiche, historique, pièces jointes, solde, ouverture d'un épisode.
// Découpé de server.js le 23/10 sans changer une ligne de logique : le texte des routes est celui d'avant. Ce module reçoit de server.js
// l'application Express et ses dépendances partagées (base, droits, journal d'audit, lecteurs communs) ; voir « montage des routes » dans server.js.
const { compterActesNaissance, conflitActeNaissance, motifDerogationValide } = require('../utils/actesNaissance');
const crypto = require('crypto');
const { validerCreationEpisode } = require('../utils/validationEpisode');
const { memePatient, formaterNomPropre, erreurIdentiteDossier } = require('../utils/dossiers');
const { numeroProvisoire, erreurNumeroDossier, erreurNumeroDepart, donnerNumeroAuPremierEpisode, marquerExamensSeulement } = require('../utils/numeroDossier');
const { contenuDesFiches } = require('../utils/contenuEpisode');
const { anciensNomsApresRenommage, verifierMere } = require('../utils/naissance');

module.exports = function monterDossiers(app, { BUCKET_PIECES_JOINTES, aPermission, calculerSoldeDepot, dateOuNull, enregistrerAuditServeur, extraireFichesDetail, extraireIntervention, lireParLotsDIds, supabase }) { // @enveloppe
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
}; // @enveloppe
