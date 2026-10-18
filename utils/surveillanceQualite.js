// utils/surveillanceQualite.js — SURVEILLANCE de la qualité des données (18/10, Esdras : « je veux faire une surveillance totale des données, comme un gestionnaire de données »).
// Chaque nuit (et au réveil du serveur s'il n'y en a pas eu aujourd'hui) :
//   1. corrections de FORME, sans risque et toutes écrites au journal d'audit (avant → après) : espaces en trop, nom tout en minuscules ou tout en MAJUSCULES, téléphone/adresse espacés ;
//   2. tous les contrôles de « Qualité des données » + le nombre de doublons possibles ;
//   3. un instantané gardé dans le journal (action « surveillance_qualite ») : c'est l'historique qu'affiche l'onglet, et le compteur du menu ;
//   4. une alerte WhatsApp avec les NOMS (jamais d'autres détails médicaux) quand il y a quelque chose à faire.
// Rien d'autre n'est modifié automatiquement : réunir deux dossiers, deviner un sexe ou une date, fermer un séjour… restent des décisions d'une personne, dans l'onglet.
// Tout ce qui sort (base, alerte, horloge) est injecté : testable sans réseau (tests/surveillance_qualite.test.js).
const crypto = require('node:crypto');
const { controlerQualite } = require('./qualiteDonnees');
const { trouverDoublonsSansBloquer } = require('./doublonsIdentite');
const { formaterNomPropre } = require('./dossiers');

const ACTION_INSTANTANE = 'surveillance_qualite';
const ACTION_CORRECTION = 'correction_auto_forme';
const MAX_CORRECTIONS_PAR_NUIT = 500;
const MAX_NOMS_PAR_LIGNE = 8;
const TAILLE_MESSAGE = 800;   // caractères par message WhatsApp (l'adresse d'envoi ne supporte pas de très longs textes)
const MAX_MESSAGES = 3;
const FUSEAU_DEFAUT = 'America/Port-au-Prince';

const espaces = (t) => String(t).replace(/\s+/g, ' ').trim();

// Un nom « de forme douteuse » : espaces en trop, tout en minuscules ou tout en MAJUSCULES. Un nom déjà écrit avec des majuscules mêlées (McDonald, de la Cruz…) n'est JAMAIS touché.
function nomCorrige(nom) {
  if (nom === null || nom === undefined) return null;
  const actuel = String(nom);
  const propre = espaces(actuel);
  const lettres = propre.replace(/[^\p{L}]/gu, '');
  const toutMin = lettres.length > 0 && lettres === lettres.toLowerCase();
  const toutMaj = lettres.length > 1 && lettres === lettres.toUpperCase();
  const cible = (toutMin || toutMaj) ? formaterNomPropre(propre) : propre;
  return cible !== actuel ? cible : null;
}
const champCorrige = (v) => { if (v === null || v === undefined) return null; const c = espaces(v); return c !== String(v) ? c : null; };

// dossiers : lignes { id, nom, telephone, adresse, fusionne_dans? }. Renvoie [{ id, nom_dossier, champ, avant, apres }], au plus `max`.
function corrections(dossiers, max = MAX_CORRECTIONS_PAR_NUIT) {
  const resultat = [];
  for (const d of dossiers || []) {
    if (!d || !d.id || d.fusionne_dans) continue;
    for (const [champ, apres] of [['nom', nomCorrige(d.nom)], ['telephone', champCorrige(d.telephone)], ['adresse', champCorrige(d.adresse)]]) {
      if (apres !== null && apres !== '') resultat.push({ id: d.id, nom_dossier: champ === 'nom' ? apres : (d.nom || null), champ, avant: d[champ], apres });
      if (resultat.length >= max) return resultat;
    }
  }
  return resultat;
}

const dateJour = (maintenant, fuseau) => maintenant().toLocaleDateString('en-CA', { timeZone: fuseau });

// Texte(s) de l'alerte WhatsApp : par contrôle, les premiers noms puis « … et N autres » ; coupé en messages de TAILLE_MESSAGE caractères au plus.
function composerAlerte({ controles, doublons, nbCorrections, date }) {
  const lignes = [];
  const aCorriger = (controles || []).filter(c => c.nombre > 0);
  const dateFr = date ? date.split('-').reverse().join('/') : '';
  lignes.push(`📋 CHF — Qualité des données ${dateFr}`.trim());
  if (nbCorrections > 0) lignes.push(`✅ ${nbCorrections} correction(s) de forme faite(s) automatiquement (espaces, majuscules) — détail dans l'onglet.`);
  for (const c of aCorriger) {
    const noms = [...new Set(c.exemples.map(x => (x.nom || '').trim()).filter(Boolean))];
    const montres = noms.slice(0, MAX_NOMS_PAR_LIGNE);
    const reste = c.nombre - montres.length;
    lignes.push(`• ${c.titre} (${c.nombre}) : ${montres.join(', ')}${reste > 0 ? ` … et ${reste} autre(s)` : ''}`);
  }
  if (doublons && doublons.total > 0) {
    const paires = (doublons.paires || []).slice(0, 4).map(p => `${p.a.nom} ↔ ${p.b.nom}`);
    lignes.push(`• Doublons possibles (${doublons.total}) : ${paires.join(' ; ')}${doublons.total > paires.length ? ' …' : ''}`);
  }
  lignes.push('👉 Onglet Pilotage → Qualité des données.');
  // coupe en messages
  const messages = [];
  let courant = '';
  for (const l of lignes) {
    const ligne = l.length > TAILLE_MESSAGE ? `${l.slice(0, TAILLE_MESSAGE - 1)}…` : l;
    if ((courant + '\n' + ligne).length > TAILLE_MESSAGE && courant) { messages.push(courant); courant = ligne; }
    else courant = courant ? `${courant}\n${ligne}` : ligne;
  }
  if (courant) messages.push(courant);
  if (messages.length > MAX_MESSAGES) { const garde = messages.slice(0, MAX_MESSAGES); garde[MAX_MESSAGES - 1] += '\n… (suite dans l\'onglet Qualité des données)'; return garde; }
  return messages;
}

function creerSurveillance({ supabase, lireToutesLesPages, envoyerAlerte = async () => {}, maintenant = () => new Date(), fuseau = FUSEAU_DEFAUT, journal = console }) {
  const COLONNES = 'id, numero_dossier, nom, nom_origine, date_naissance, telephone, adresse, sexe';

  async function lireDonnees() {
    let dossiers;
    try { dossiers = await lireToutesLesPages(() => supabase.from('dossiers').select(`${COLONNES}, mere_dossier_id, fusionne_dans, anciens_noms`).order('id')); }
    catch (e) { if (e && e.code === '42703') dossiers = await lireToutesLesPages(() => supabase.from('dossiers').select(COLONNES).order('id')); else throw e; }
    const episodes = await lireToutesLesPages(() => supabase.from('episodes')
      .select('id, dossier_id, statut, est_hospitalisation, voie_entree, date_ouverture, type_patient, ong_partenaire, motif_fermeture, service, supprime_le').order('id'));
    return { dossiers, episodes };
  }

  async function lireIgnores() {
    try {
      const lignes = await lireToutesLesPages(() => supabase.from('doublons_ignores').select('dossier_a, dossier_b').order('dossier_a').order('dossier_b'));
      return new Set(lignes.map(l => [l.dossier_a, l.dossier_b].sort().join('|')));
    } catch (e) { return new Set(); }
  }

  async function doublonsPossibles(dossiers) {
    const ignores = await lireIgnores();
    const paires = await trouverDoublonsSansBloquer(dossiers, { ignores, seuil: 70 });
    return { total: paires.length, paires: paires.slice(0, 20).map(p => ({ a: { id: p.a.id, nom: p.a.nom }, b: { id: p.b.id, nom: p.b.nom } })) };
  }

  // Applique les corrections de forme (une par une, seulement si la valeur n'a pas changé entre-temps) et les écrit au journal. Renvoie les corrections réellement appliquées.
  async function appliquerCorrections(liste) {
    const faites = [];
    for (const c of liste) {
      const { data, error } = await supabase.from('dossiers').update({ [c.champ]: c.apres }).eq('id', c.id).eq(c.champ, c.avant).select('id');
      if (!error && (data || []).length > 0) faites.push(c);
      else if (error) journal.warn(`Correction de forme (${c.champ}) refusée : ${error.message}`);
    }
    if (faites.length > 0) {
      const date = maintenant().toISOString();
      const { error } = await supabase.from('audit_log').insert(faites.map(c => ({
        id: crypto.randomUUID(), action: ACTION_CORRECTION, effectue_par: 'système (surveillance de nuit)', effectue_par_uid: null, date,
        details: { dossier_id: c.id, nom: c.nom_dossier, champ: c.champ, avant: c.avant, apres: c.apres },
      })));
      if (error) journal.warn(`Journal des corrections de forme non écrit : ${error.message}`);
    }
    return faites;
  }

  // Un passage complet. Ne lève jamais vers l'appelant : renvoie { ok, ... } (une panne de la surveillance ne doit jamais gêner le serveur).
  async function executer({ origine = 'nuit', alerter = true } = {}) {
    try {
      let { dossiers, episodes } = await lireDonnees();
      const faites = await appliquerCorrections(corrections(dossiers));
      if (faites.length > 0) ({ dossiers, episodes } = await lireDonnees());
      const qualite = controlerQualite({ dossiers, episodes, maintenantMs: maintenant().getTime() });
      const doublons = await doublonsPossibles(dossiers);
      const date = dateJour(maintenant, fuseau);
      const details = {
        date_jour: date, origine, total: qualite.total, doublons: doublons.total, corrections: faites.length, dossiers: qualite.dossiersAnalyses, episodes: qualite.episodesAnalyses,
        par_controle: Object.fromEntries(qualite.controles.map(c => [c.cle, { titre: c.titre, gravite: c.gravite, nombre: c.nombre }])),
      };
      const { error } = await supabase.from('audit_log').insert({ id: crypto.randomUUID(), action: ACTION_INSTANTANE, effectue_par: 'système (surveillance de nuit)', effectue_par_uid: null, date: maintenant().toISOString(), details });
      if (error) journal.warn(`Instantané de surveillance non écrit : ${error.message}`);
      let alerte = false;
      if (alerter && (qualite.total > 0 || doublons.total > 0 || faites.length > 0)) {
        for (const message of composerAlerte({ controles: qualite.controles, doublons, nbCorrections: faites.length, date })) await envoyerAlerte(message);
        alerte = true;
      }
      return { ok: true, ...details, alerte };
    } catch (e) {
      journal.error(`❌ Surveillance de la qualité des données : ${e.message}`);
      return { ok: false, erreur: e.message };
    }
  }

  async function dernierInstantane() {
    const { data, error } = await supabase.from('audit_log').select('date, details').eq('action', ACTION_INSTANTANE).order('date', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    const l = (data || [])[0];
    return l ? { date: l.date, ...l.details } : null;
  }
  async function surveillanceDuJourFaite() {
    const dernier = await dernierInstantane();
    return !!dernier && dernier.date_jour === dateJour(maintenant, fuseau);
  }
  async function historique(n = 30) {
    const { data, error } = await supabase.from('audit_log').select('date, details').eq('action', ACTION_INSTANTANE).order('date', { ascending: false }).limit(n);
    if (error) throw new Error(error.message);
    return (data || []).map(l => ({ date: l.date, ...l.details }));
  }
  async function correctionsRecentes(n = 100) {
    const { data, error } = await supabase.from('audit_log').select('date, details').eq('action', ACTION_CORRECTION).order('date', { ascending: false }).limit(n);
    if (error) throw new Error(error.message);
    return (data || []).map(l => ({ date: l.date, ...l.details }));
  }

  return { executer, dernierInstantane, surveillanceDuJourFaite, historique, correctionsRecentes, lireDonnees, doublonsPossibles };
}

module.exports = { creerSurveillance, corrections, nomCorrige, composerAlerte, ACTION_INSTANTANE, ACTION_CORRECTION, MAX_CORRECTIONS_PAR_NUIT };
