// utils/synchroListes.js — lecture INCRÉMENTALE des listes d'épisodes et de paiements (12/10).
//
// Avant : chaque poste retéléchargeait TOUT l'historique toutes les 45 s (~4 Ko par épisode, fiches et
// paiements compris). À 2 000 épisodes, ~1 Mo compressé par poste et par rafraîchissement ; à 5 000, le
// serveur assemble ~20 Mo de JSON à chaque appel. Maintenant l'app ne demande que ce qui a changé depuis
// sa dernière lecture (`?synchro=1&depuis=<curseur>`), et reçoit la liste complète seulement à l'ouverture
// et périodiquement, par sécurité.
//
// Repose sur sql/synchro_incrementale.sql : colonne modifie_le (tenue à jour par déclencheur) sur
// episodes / dossiers / fiches / paiements, et table lignes_effacees (suppressions définitives). Tant que
// ce SQL n'est pas appliqué, tout retombe sur la liste complète, sans curseur : exactement le
// comportement d'avant, jamais une erreur.
//
// Format de réponse (seulement quand l'app demande synchro=1 ; sans ce paramètre, les routes renvoient
// toujours le tableau d'avant, pour les anciennes versions de l'app encore en cache sur les appareils) :
//   { mode: 'complet', curseur, lignes }             — remplace toute la liste
//   { mode: 'delta', curseur, lignes, supprimes }    — lignes à ajouter/remplacer (par id), ids à retirer
// curseur = null : la synchro incrémentale n'est pas disponible, redemander la liste complète.

// Marge de recouvrement : chaque delta relit les 2 dernières minutes avant le curseur. Couvre l'écart
// d'horloge serveur/base et une écriture validée juste après le début de la lecture précédente. Relire
// une ligne en double est sans effet (remplacement par id) ; en manquer une ne l'est pas.
const MARGE_MS = 2 * 60 * 1000;
// Au-delà, liste complète : les suppressions définitives ne sont gardées que quelques jours
// (RETENTION_LIGNES_EFFACEES_MS), et un appareil resté fermé longtemps repart sur une base propre.
const ANCIENNETE_MAX_MS = 6 * 60 * 60 * 1000;
const RETENTION_LIGNES_EFFACEES_MS = 2 * 24 * 60 * 60 * 1000;
// La vérification « le SQL est-il appliqué ? » n'est refaite qu'à cet intervalle.
const VALIDITE_VERIFICATION_MS = 10 * 60 * 1000;

const TABLES_SUIVIES = ['episodes', 'dossiers', 'fiches', 'paiements'];

function estAbsenceDuSqlSynchro(erreur) {
  if (!erreur) return false;
  const code = String(erreur.code || '');
  // 42703 : colonne inexistante ; 42P01 : table inexistante ; PGRST204/205 : colonne/table absente du
  // cache de schéma de PostgREST (formulation des versions récentes).
  if (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(code)) return true;
  return /modifie_le|lignes_effacees/.test(String(erreur.message || '')) && /exist|schema cache/i.test(String(erreur.message || ''));
}

function creerSynchroListes({ supabase, lireToutesLesPages, lireParLotsDIds, episodesVersFlatEnLot, maintenant = () => Date.now() }) {
  let verification = { disponible: false, le: -Infinity };

  async function synchroDisponible() {
    if (maintenant() - verification.le < VALIDITE_VERIFICATION_MS) return verification.disponible;
    let disponible = true;
    try {
      for (const table of TABLES_SUIVIES) {
        const { error } = await supabase.from(table).select('modifie_le').limit(1);
        if (error) { disponible = false; break; }
      }
      if (disponible) {
        const { error } = await supabase.from('lignes_effacees').select('id').limit(1);
        if (error) disponible = false;
      }
    } catch (_) {
      disponible = false;
    }
    // Un « non » n'est gardé qu'une minute : le SQL vient peut-être d'être collé.
    verification = { disponible, le: disponible ? maintenant() : maintenant() - VALIDITE_VERIFICATION_MS + 60 * 1000 };
    return disponible;
  }

  // Borne basse du delta (curseur moins la marge), ou null s'il faut la liste complète.
  function borneDelta(depuis) {
    if (!depuis) return null;
    const t = Date.parse(depuis);
    if (!Number.isFinite(t)) return null;
    const ecart = maintenant() - t;
    if (ecart > ANCIENNETE_MAX_MS || ecart < -60 * 1000) return null; // trop ancien, ou horloge douteuse
    return new Date(t - MARGE_MS).toISOString();
  }

  async function avecRepliComplet(depuis, lireDelta, lireComplet) {
    // Curseur pris AVANT toute lecture : ce qui change pendant la lecture sera relu la fois suivante.
    const curseur = new Date(maintenant()).toISOString();
    const borne = borneDelta(depuis);
    if (borne && await synchroDisponible()) {
      try {
        return { mode: 'delta', curseur, ...(await lireDelta(borne)) };
      } catch (e) {
        if (!estAbsenceDuSqlSynchro(e)) throw e;
        verification = { disponible: false, le: -Infinity };
      }
    }
    const disponible = await synchroDisponible();
    return { mode: 'complet', curseur: disponible ? curseur : null, lignes: await lireComplet() };
  }

  const lignesEffacees = (borne) => lireToutesLesPages(() => supabase.from('lignes_effacees')
    .select('table_nom, ligne_id, episode_id').gte('efface_le', borne).order('id'));

  // ---------- épisodes ----------
  async function episodesComplet() {
    const episodes = await lireToutesLesPages(
      () => supabase.from('episodes').select('*').is('supprime_le', null).order('date_ouverture', { ascending: false }).order('id'));
    return episodesVersFlatEnLot(episodes);
  }

  // Un épisode tel que l'app le reçoit est assemblé depuis 4 tables (voir episodesVersFlatEnLot) : il
  // est « touché » si sa ligne, son dossier (nom, téléphone...), une de ses fiches ou un de ses
  // paiements (annulation → fiche marquée annulée) a changé ou a été effacé.
  async function episodesDelta(borne) {
    const [episodes, dossiers, fiches, paiements, effaces] = await Promise.all([
      lireToutesLesPages(() => supabase.from('episodes').select('id').gte('modifie_le', borne).order('id')),
      lireToutesLesPages(() => supabase.from('dossiers').select('id').gte('modifie_le', borne).order('id')),
      lireToutesLesPages(() => supabase.from('fiches').select('id, episode_id').gte('modifie_le', borne).order('id')),
      lireToutesLesPages(() => supabase.from('paiements').select('id, episode_id').gte('modifie_le', borne).order('id')),
      lignesEffacees(borne),
    ]);
    const touches = new Set(episodes.map(e => e.id));
    for (const l of [...fiches, ...paiements]) if (l.episode_id) touches.add(l.episode_id);
    // Un épisode effacé est relu comme les autres : c'est l'état de la base à cet instant qui décide
    // (une restauration de sauvegarde peut l'avoir réinséré depuis), la trace d'effacement ne sert
    // qu'à savoir qu'il faut le regarder.
    for (const e of effaces) {
      if (e.table_nom === 'episodes') touches.add(e.ligne_id);
      else if (e.episode_id) touches.add(e.episode_id);
    }
    const idsDossiers = dossiers.map(d => d.id);
    if (idsDossiers.length) {
      const duDossier = await lireParLotsDIds(idsDossiers, lot => supabase.from('episodes').select('id').in('dossier_id', lot).order('id'));
      for (const e of duDossier) touches.add(e.id);
    }

    const lues = touches.size ? await lireParLotsDIds([...touches], lot => supabase.from('episodes').select('*').in('id', lot).order('id')) : [];
    const supprimes = new Set();
    const vivants = [];
    const vus = new Set();
    for (const ep of lues) {
      vus.add(ep.id);
      if (ep.supprime_le) supprimes.add(ep.id); else vivants.push(ep);
    }
    // Touché mais introuvable : effacé entre-temps (sa propre trace a pu être purgée) → à retirer.
    for (const id of touches) if (!vus.has(id)) supprimes.add(id);
    return { lignes: await episodesVersFlatEnLot(vivants), supprimes: [...supprimes] };
  }

  // ---------- paiements ----------
  const paiementsComplet = () => lireToutesLesPages(
    () => supabase.from('paiements').select('*').is('supprime_le', null).order('date_paiement', { ascending: false }).order('id'));

  async function paiementsDelta(borne) {
    const [modifies, effaces] = await Promise.all([
      lireToutesLesPages(() => supabase.from('paiements').select('*').gte('modifie_le', borne).order('id')),
      lignesEffacees(borne),
    ]);
    const supprimes = new Set(effaces.filter(e => e.table_nom === 'paiements').map(e => e.ligne_id));
    const lignes = [];
    for (const p of modifies) {
      if (p.supprime_le) supprimes.add(p.id); else lignes.push(p);
    }
    for (const p of lignes) supprimes.delete(p.id);
    return { lignes, supprimes: [...supprimes] };
  }

  return {
    episodes: (depuis) => avecRepliComplet(depuis, episodesDelta, episodesComplet),
    paiements: (depuis) => avecRepliComplet(depuis, paiementsDelta, paiementsComplet),
    // Ménage quotidien (tâche planifiée) : sans effet si la table n'existe pas encore.
    async purgerLignesEffacees() {
      const limite = new Date(maintenant() - RETENTION_LIGNES_EFFACEES_MS).toISOString();
      const { error } = await supabase.from('lignes_effacees').delete().lt('efface_le', limite);
      if (error && !estAbsenceDuSqlSynchro(error)) throw new Error(error.message);
    },
  };
}

module.exports = { creerSynchroListes, estAbsenceDuSqlSynchro, MARGE_MS, ANCIENNETE_MAX_MS, RETENTION_LIGNES_EFFACEES_MS };
