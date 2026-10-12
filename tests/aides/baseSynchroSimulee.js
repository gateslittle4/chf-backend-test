// tests/aides/baseSynchroSimulee.js — base simulée en mémoire qui se comporte comme sql/synchro_incrementale.sql
// (modifie_le posé par la base à chaque écriture, trace dans lignes_effacees à chaque suppression définitive), et le
// VRAI module utils/synchroListes.js branché dessus. Partagée par tests/synchro_listes.test.js et par le test
// d'intégration de l'app (chf-app2/tests/synchro_listes_integration.test.js), qui y branche le module de l'app.
const { creerSynchroListes } = require('../../utils/synchroListes');

function creerBase({ avecSqlSynchro = true } = {}) {
  const tables = { dossiers: [], episodes: [], fiches: [], paiements: [], lignes_effacees: [] };
  const base = { tables, horloge: 1_800_000_000_000, avecSqlSynchro, retardCommit: 0, compteurId: 0, panne: null };
  const maintenantIso = () => new Date(base.horloge - base.retardCommit).toISOString();
  base.inserer = (table, ligne) => { const l = { ...ligne }; if (base.avecSqlSynchro) l.modifie_le = maintenantIso(); tables[table].push(l); return l; };
  base.modifier = (table, id, champs) => { const l = tables[table].find(x => x.id === id); Object.assign(l, champs); if (base.avecSqlSynchro) l.modifie_le = maintenantIso(); };
  base.effacer = (table, id) => {
    const i = tables[table].findIndex(x => x.id === id);
    if (i < 0) return;
    const [l] = tables[table].splice(i, 1);
    if (base.avecSqlSynchro) tables.lignes_effacees.push({ id: ++base.compteurId, table_nom: table, ligne_id: l.id, episode_id: l.episode_id || null, efface_le: maintenantIso() });
    if (table === 'episodes') { // ON DELETE CASCADE
      for (const t of ['fiches', 'paiements']) for (const x of tables[t].filter(y => y.episode_id === id)) base.effacer(t, x.id);
    }
  };
  return base;
}

function requete(base, table) {
  const filtres = []; let tri = []; let plage = null; let limite = null; let colonnes = '*'; let suppression = false;
  const colonneAbsente = (c) => !base.avecSqlSynchro && (c === 'modifie_le' || table === 'lignes_effacees');
  let erreur = !base.avecSqlSynchro && table === 'lignes_effacees' ? { code: 'PGRST205', message: "Could not find the table 'public.lignes_effacees' in the schema cache" } : null;
  const q = {
    select(c) { colonnes = c; if (c.split(',').some(x => colonneAbsente(x.trim()))) erreur = erreur || { code: '42703', message: `column ${table}.modifie_le does not exist` }; return q; },
    gte(c, v) { if (colonneAbsente(c)) erreur = erreur || { code: '42703', message: `column ${table}.${c} does not exist` }; filtres.push(l => l[c] >= v); return q; },
    lt(c, v) { filtres.push(l => l[c] < v); return q; },
    is(c, v) { filtres.push(l => (l[c] ?? null) === v); return q; },
    in(c, v) { const s = new Set(v); filtres.push(l => s.has(l[c])); return q; },
    order(c, o = {}) { tri.push([c, o.ascending !== false]); return q; },
    range(a, b) { plage = [a, b]; return q; },
    limit(n) { limite = n; return q; },
    delete() { suppression = true; return q; },
    then(ok, ko) {
      return Promise.resolve().then(() => {
        if (base.panne) return { data: null, error: base.panne };
        if (erreur) return { data: null, error: erreur };
        let lignes = base.tables[table].filter(l => filtres.every(f => f(l)));
        if (suppression) { for (const l of lignes) base.tables[table].splice(base.tables[table].indexOf(l), 1); return { data: null, error: null }; }
        lignes = [...lignes].sort((x, y) => { for (const [c, asc] of tri) { if (x[c] < y[c]) return asc ? -1 : 1; if (x[c] > y[c]) return asc ? 1 : -1; } return 0; });
        if (plage) lignes = lignes.slice(plage[0], plage[1] + 1);
        if (limite !== null) lignes = lignes.slice(0, limite);
        if (colonnes !== '*') { const cs = colonnes.split(',').map(x => x.trim()); lignes = lignes.map(l => Object.fromEntries(cs.map(c => [c, l[c]]))); }
        return { data: lignes.map(l => ({ ...l })), error: null };
      }).then(ok, ko);
    },
  };
  return q;
}

function creerServeur(base, { decalageHorlogeMs = 0 } = {}) {
  const supabase = { from: (t) => requete(base, t) };
  // Pages et lots minuscules : la pagination est exercée à chaque lecture.
  const lireToutesLesPages = async (construire) => {
    const out = [];
    for (let debut = 0; ; ) {
      const { data, error } = await construire().range(debut, debut + 2);
      if (error) throw error;
      if (!data.length) break;
      out.push(...data); debut += data.length;
    }
    return out;
  };
  const lireParLotsDIds = async (ids, construire) => {
    const out = [];
    for (let i = 0; i < ids.length; i += 4) out.push(...await lireToutesLesPages(() => construire(ids.slice(i, i + 4))));
    return out;
  };
  // Assemblage fidèle au principe d'episodesVersFlatEnLot : dossier + fiches non supprimées + fiches annulées.
  const episodesVersFlatEnLot = async (episodes) => episodes.map(ep => {
    const dossier = base.tables.dossiers.find(d => d.id === ep.dossier_id);
    const annulees = new Set(base.tables.paiements.filter(p => p.episode_id === ep.id && p.annule).map(p => p.fiche_id));
    return {
      id: ep.id, timestamp: Date.parse(ep.date_ouverture), statut: ep.statut, nomPatient: dossier?.nom,
      fiches: base.tables.fiches.filter(f => f.episode_id === ep.id && !f.supprime_le).sort((a, b) => a.id < b.id ? -1 : 1)
        .map(f => ({ id: f.id, total: f.total, annulee: annulees.has(f.id) })),
    };
  });
  return creerSynchroListes({ supabase, lireToutesLesPages, lireParLotsDIds, episodesVersFlatEnLot, maintenant: () => base.horloge + decalageHorlogeMs });
}

module.exports = { creerBase, creerServeur };
