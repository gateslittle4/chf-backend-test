// tests/synchro_listes.test.js — synchronisation incrémentale (utils/synchroListes.js), contre une base simulée en
// mémoire qui se comporte comme sql/synchro_incrementale.sql (modifie_le posé par la base à chaque écriture, trace
// dans lignes_effacees à chaque suppression définitive — ce comportement-là est vérifié sur un vrai Postgres par
// scripts/test-synchro-incrementale-sql.py).
//
// Le test principal est un test au hasard : des centaines d'opérations (créations, modifications de dossier, fiches,
// annulations, corbeille, restauration, suppressions définitives, écritures validées en retard), avec une horloge
// serveur décalée de celle de la base. Après chaque rafraîchissement, la liste reconstruite à partir des deltas doit
// être IDENTIQUE à une relecture complète. C'est la seule propriété qui compte : un delta incomplet = un dossier ou
// un paiement qui manque sur un poste, sans que personne ne le voie.
const { test } = require('node:test');
const assert = require('node:assert');
const { creerSynchroListes, MARGE_MS } = require('../utils/synchroListes');

// ---------- base simulée ----------
function creerBase({ avecSqlSynchro = true } = {}) {
  const tables = { dossiers: [], episodes: [], fiches: [], paiements: [], lignes_effacees: [] };
  const base = { tables, horloge: 1_800_000_000_000, avecSqlSynchro, retardCommit: 0, compteurId: 0, panne: null };
  const maintenantIso = () => new Date(base.horloge - base.retardCommit).toISOString();
  base.inserer = (table, ligne) => { const l = { ...ligne }; if (avecSqlSynchro) l.modifie_le = maintenantIso(); tables[table].push(l); return l; };
  base.modifier = (table, id, champs) => { const l = tables[table].find(x => x.id === id); Object.assign(l, champs); if (avecSqlSynchro) l.modifie_le = maintenantIso(); };
  base.effacer = (table, id) => {
    const i = tables[table].findIndex(x => x.id === id);
    if (i < 0) return;
    const [l] = tables[table].splice(i, 1);
    if (avecSqlSynchro) tables.lignes_effacees.push({ id: ++base.compteurId, table_nom: table, ligne_id: l.id, episode_id: l.episode_id || null, efface_le: maintenantIso() });
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

// Côté app, réduit à l'essentiel : remplacement par id, retrait des supprimés.
function appliquer(etat, rep) {
  if (rep.mode === 'complet') etat.parId = new Map(rep.lignes.map(l => [l.id, l]));
  else { for (const l of rep.lignes) etat.parId.set(l.id, l); for (const id of rep.supprimes) etat.parId.delete(id); }
  etat.curseur = rep.curseur;
}
const trie = (m) => [...m.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

// ---------- tests ----------
test("sans le SQL : liste complète, curseur null — le comportement d'avant, jamais une erreur", async () => {
  const base = creerBase({ avecSqlSynchro: false });
  base.inserer('dossiers', { id: 'd1', nom: 'A' });
  base.inserer('episodes', { id: 'e1', dossier_id: 'd1', date_ouverture: '2026-10-01T10:00:00Z', supprime_le: null });
  const serveur = creerServeur(base);
  const r1 = await serveur.episodes(null);
  assert.strictEqual(r1.mode, 'complet'); assert.strictEqual(r1.curseur, null); assert.strictEqual(r1.lignes.length, 1);
  const r2 = await serveur.episodes(new Date(base.horloge).toISOString());
  assert.strictEqual(r2.mode, 'complet', "un curseur ne sert à rien tant que le SQL n'est pas appliqué");
  assert.strictEqual((await serveur.paiements(null)).curseur, null);
  await serveur.purgerLignesEffacees(); // ne doit pas lever
});

test("curseur trop ancien, illisible ou dans le futur : liste complète", async () => {
  const base = creerBase();
  base.inserer('dossiers', { id: 'd1', nom: 'A' });
  const serveur = creerServeur(base);
  for (const depuis of [new Date(base.horloge - 7 * 3600e3).toISOString(), 'pas-une-date', new Date(base.horloge + 5 * 60e3).toISOString()]) {
    const r = await serveur.episodes(depuis);
    assert.strictEqual(r.mode, 'complet', depuis);
    assert.ok(r.curseur, 'avec un curseur pour la suite');
  }
  assert.strictEqual((await serveur.episodes(new Date(base.horloge - 60e3).toISOString())).mode, 'delta');
});

test("une panne de la base pendant un delta est une ERREUR visible, pas une liste vide ni une liste complète en silence", async () => {
  const base = creerBase();
  const serveur = creerServeur(base);
  const { curseur } = await serveur.episodes(null);
  base.panne = { code: '57014', message: 'canceling statement due to statement timeout' };
  await assert.rejects(() => serveur.episodes(curseur), (e) => /statement timeout/.test(e.message));
});

test("au hasard : la liste reconstruite par deltas est toujours identique à une relecture complète", async () => {
  for (const graine of [1, 2, 3, 4, 5, 6]) {
    let s = graine * 7919;
    const hasard = () => { s = (s * 48271) % 2147483647; return s / 2147483647; };
    const choisir = (t) => t[Math.floor(hasard() * t.length)];
    const base = creerBase();
    // Horloge du serveur décalée de celle de la base (jusqu'à ±40 s), comme Render et Supabase.
    const serveur = creerServeur(base, { decalageHorlogeMs: Math.round((hasard() - 0.5) * 80e3) });
    const app = { ep: { parId: new Map(), curseur: null }, pa: { parId: new Map(), curseur: null } };
    let n = 0;
    const id = (p) => `${p}${++n}`;
    for (let etape = 0; etape < 400; etape++) {
      base.horloge += Math.round(hasard() * 20e3);
      base.retardCommit = hasard() < 0.1 ? Math.round(hasard() * 60e3) : 0; // écriture validée jusqu'à 60 s après son horodatage
      const vivants = (t) => base.tables[t];
      const op = hasard();
      if (op < 0.15 || !vivants('episodes').length) {
        const d = hasard() < 0.5 && vivants('dossiers').length ? choisir(vivants('dossiers')) : base.inserer('dossiers', { id: id('d'), nom: id('Nom') });
        base.inserer('episodes', { id: id('e'), dossier_id: d.id, statut: 'ouvert', date_ouverture: new Date(base.horloge).toISOString(), supprime_le: null });
      } else if (op < 0.25) base.modifier('dossiers', choisir(vivants('dossiers')).id, { nom: id('Renomme') });
      else if (op < 0.40) base.inserer('fiches', { id: id('f'), episode_id: choisir(vivants('episodes')).id, total: Math.round(hasard() * 1000), supprime_le: null });
      else if (op < 0.50 && vivants('fiches').length) base.modifier('fiches', choisir(vivants('fiches')).id, { total: Math.round(hasard() * 1000) });
      else if (op < 0.62) {
        const ep = choisir(vivants('episodes'));
        const f = vivants('fiches').find(x => x.episode_id === ep.id);
        base.inserer('paiements', { id: id('p'), episode_id: ep.id, fiche_id: f ? f.id : null, montant: 100, annule: false, supprime_le: null });
      } else if (op < 0.68 && vivants('paiements').length) base.modifier('paiements', choisir(vivants('paiements')).id, { annule: true });
      else if (op < 0.74) base.modifier('episodes', choisir(vivants('episodes')).id, { statut: choisir(['ouvert', 'ferme']) });
      else if (op < 0.80) { // corbeille, ou restauration
        const ep = choisir(vivants('episodes'));
        const quand = ep.supprime_le ? null : new Date(base.horloge).toISOString();
        base.modifier('episodes', ep.id, { supprime_le: quand });
        for (const t of ['fiches', 'paiements']) for (const x of vivants(t).filter(y => y.episode_id === ep.id)) base.modifier(t, x.id, { supprime_le: quand });
      } else if (op < 0.84 && vivants('fiches').length) { const f = choisir(vivants('fiches')); base.modifier('fiches', f.id, { supprime_le: f.supprime_le ? null : new Date(base.horloge).toISOString() }); }
      else if (op < 0.88) base.effacer('episodes', choisir(vivants('episodes')).id); // suppression définitive (purge, annulation d'opération)
      else if (op < 0.91 && vivants('fiches').length) base.effacer('fiches', choisir(vivants('fiches')).id);
      else if (op < 0.94 && vivants('paiements').length) base.effacer('paiements', choisir(vivants('paiements')).id);
      base.retardCommit = 0;

      if (hasard() < 0.5) { // rafraîchissement de l'app (delta si elle a un curseur)
        appliquer(app.ep, await serveur.episodes(app.ep.curseur));
        appliquer(app.pa, await serveur.paiements(app.pa.curseur));
        const completEp = await serveur.episodes(null);
        const completPa = await serveur.paiements(null);
        assert.deepStrictEqual(trie(app.ep.parId), trie(new Map(completEp.lignes.map(l => [l.id, l]))), `épisodes divergents (graine ${graine}, étape ${etape})`);
        assert.deepStrictEqual(trie(app.pa.parId), trie(new Map(completPa.lignes.map(l => [l.id, l]))), `paiements divergents (graine ${graine}, étape ${etape})`);
      }
    }
    assert.ok(n > 150, 'le scénario a bien produit des données');
  }
});

test("la marge de recouvrement couvre une écriture validée après le début de la lecture précédente", async () => {
  assert.ok(MARGE_MS >= 60 * 1000);
  const base = creerBase();
  const serveur = creerServeur(base);
  base.inserer('dossiers', { id: 'd1', nom: 'A' });
  const app = { parId: new Map(), curseur: null };
  appliquer(app, await serveur.episodes(null));
  // Écriture horodatée 90 s AVANT le curseur (transaction validée en retard) : sans marge, jamais vue.
  base.retardCommit = 90e3;
  base.inserer('episodes', { id: 'e-tard', dossier_id: 'd1', statut: 'ouvert', date_ouverture: '2026-10-01T10:00:00Z', supprime_le: null });
  base.retardCommit = 0;
  base.horloge += 45e3;
  appliquer(app, await serveur.episodes(app.curseur));
  assert.ok(app.parId.has('e-tard'));
});
