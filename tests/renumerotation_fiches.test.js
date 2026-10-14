// tests/renumerotation_fiches.test.js — insertion d'une fiche oubliée entre deux fiches, et renumérotation à la suppression (14/10, reprise de chf-demo2).
// Les vraies routes de server.js sont extraites et exécutées contre une base simulée qui rejoue les deux fonctions SQL
// (sql/renumerotation_fiches.sql, vérifiées sur la vraie base) et la contrainte UNIQUE (episode_id, numero_fiche).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function monter(fichesInitiales, { sansFonctions = false } = {}) {
  const fiches = fichesInitiales.map((f, i) => ({ id: f.id, episode_id: 'ep1', numero_fiche: f.numero_fiche, numero_fiche_avant: null, supprime_le: f.supprime_le || null, date_creation: `2026-10-14T10:0${i}:00Z`, total_global: 100, raw_state: {} }));
  const paiements = [];
  const audits = [];
  const verifierUnicite = () => {
    const vus = new Set();
    for (const f of fiches) {
      if (f.numero_fiche == null) continue;
      const cle = `${f.episode_id}#${f.numero_fiche}`;
      if (vus.has(cle)) { const e = new Error('duplicate key value violates unique constraint "fiches_episode_id_numero_fiche_key"'); e.code = '23505'; throw e; }
      vus.add(cle);
    }
  };
  const construire = (nom) => {
    const etat = { op: 'select', filtres: [], tri: null, limite: null, payload: null };
    const table = nom === 'fiches' ? fiches : nom === 'paiements' ? paiements : [];
    const executer = () => {
      let lignes = table.filter(l => etat.filtres.every(f => f(l)));
      if (etat.op === 'insert') {
        const l = { id: 'nouvelle-' + (fiches.length + 1), numero_fiche_avant: null, supprime_le: null, date_creation: '2026-10-14T12:00:00Z', ...etat.payload };
        const copie = [...fiches]; fiches.push(l);
        try { verifierUnicite(); } catch (e) { fiches.length = 0; fiches.push(...copie); return { data: null, error: { code: e.code, message: e.message } }; }
        return { data: [l], error: null };
      }
      if (etat.op === 'update') { lignes.forEach(l => Object.assign(l, etat.payload)); try { verifierUnicite(); } catch (e) { return { data: null, error: { code: e.code, message: e.message } }; } return { data: lignes, error: null }; }
      if (etat.tri) { const [col, asc] = etat.tri; lignes = [...lignes].sort((a, b) => ((a[col] ?? Infinity) - (b[col] ?? Infinity)) * (asc ? 1 : -1)); }
      if (etat.limite) lignes = lignes.slice(0, etat.limite);
      return { data: lignes, error: null };
    };
    const chaine = {
      select: () => chaine,
      insert: (p) => { etat.op = 'insert'; etat.payload = p; return chaine; },
      update: (p) => { etat.op = 'update'; etat.payload = p; return chaine; },
      eq: (c, v) => { etat.filtres.push(l => l[c] === v); return chaine; },
      in: (c, vs) => { etat.filtres.push(l => vs.includes(l[c])); return chaine; },
      is: (c, v) => { etat.filtres.push(l => (l[c] ?? null) === v); return chaine; },
      not: (c, _op, v) => { etat.filtres.push(l => (l[c] ?? null) !== v); return chaine; },
      order: (c, o) => { etat.tri = [c, !(o && o.ascending === false)]; return chaine; },
      limit: (n) => { etat.limite = n; return chaine; },
      maybeSingle: async () => { const r = executer(); return { data: r.data && r.data[0] ? { ...r.data[0] } : null, error: r.error }; }, // copie : comme une vraie lecture, la ligne lue ne bouge plus ensuite
      single: async () => { const r = executer(); return { data: r.data && r.data[0] ? { ...r.data[0] } : null, error: r.error }; },
      then: (resolve, rejeter) => Promise.resolve(executer()).then(resolve, rejeter),
    };
    return chaine;
  };
  const supabase = {
    from: construire,
    rpc: async (nom, args) => {
      if (sansFonctions) return { data: null, error: { code: '42883', message: 'function does not exist' } };
      const sauvegarde = fiches.map(f => ({ ...f }));
      try {
        if (nom === 'decaler_fiches') {
          let n = 0;
          fiches.filter(f => f.episode_id === args.p_episode && f.numero_fiche != null && f.numero_fiche >= args.p_a_partir_de).forEach(f => { f.numero_fiche += 1; n++; });
          verifierUnicite(); return { data: n, error: null };
        }
        if (nom === 'renumeroter_fiches') {
          fiches.filter(f => f.episode_id === args.p_episode && f.supprime_le && f.numero_fiche != null).forEach(f => { f.numero_fiche_avant = f.numero_fiche_avant ?? f.numero_fiche; f.numero_fiche = null; });
          const actives = fiches.filter(f => f.episode_id === args.p_episode && !f.supprime_le).sort((a, b) => (a.numero_fiche ?? Infinity) - (b.numero_fiche ?? Infinity) || a.date_creation.localeCompare(b.date_creation));
          actives.forEach((f, i) => { f.numero_fiche = i + 1; });
          verifierUnicite();
          return { data: actives.map(f => ({ id: f.id, numero_fiche: f.numero_fiche })), error: null };
        }
      } catch (e) { fiches.splice(0, fiches.length, ...sauvegarde); return { data: null, error: { code: e.code, message: e.message } }; }
      return { data: null, error: { code: '42883', message: 'fonction inconnue' } };
    },
  };
  const gestionnaires = {};
  const app = { post: (c, fn) => { gestionnaires['POST ' + c] = fn; }, get: (c, fn) => { gestionnaires['GET ' + c] = fn; }, delete: (c, fn) => { gestionnaires['DELETE ' + c] = fn; } };
  const debut = serverSrc.indexOf("app.post('/api/fiches', async");
  const fin = serverSrc.indexOf('// Route : récupération du catalogue');
  assert.ok(debut > 0 && fin > debut);
  const auditer = async (_req, action, details) => { audits.push({ action, details }); };
  new Function('app', 'supabase', 'aPermission', 'estUnVraiUuid', 'enregistrerAuditServeur', 'reactiverEpisodeSuspendu', 'console', serverSrc.slice(debut, fin))(
    app, supabase, async () => true, (v) => /^[0-9a-f-]{8,}$/i.test(String(v)) || String(v).startsWith('f') || String(v).startsWith('nouvelle'), auditer, async () => {}, { ...console, warn() {} });
  const appeler = async (cle, { corps = {}, params = {} } = {}) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    await gestionnaires[cle]({ body: corps, params, user: { id: 'u1', email: 'caisse@chf.test' } }, res);
    return res;
  };
  const numeros = () => fiches.filter(f => !f.supprime_le).sort((a, b) => a.numero_fiche - b.numero_fiche).map(f => `${f.id}=${f.numero_fiche}`).join(' ');
  return { appeler, fiches, audits, numeros };
}
const quatre = () => monter([{ id: 'f1', numero_fiche: 1 }, { id: 'f2', numero_fiche: 2 }, { id: 'f3', numero_fiche: 3 }, { id: 'f4', numero_fiche: 4 }]);

test("Supprimer la fiche 1 : les suivantes remontent (2→1, 3→2, 4→3), la réponse donne les nouveaux numéros, l'action est tracée", async () => {
  const m = quatre();
  const r = await m.appeler('DELETE /api/fiches/:id', { params: { id: 'f1' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(m.numeros(), 'f2=1 f3=2 f4=3');
  assert.deepStrictEqual(r.corps.renumerotation.map(n => [n.id, n.numero_fiche]), [['f2', 1], ['f3', 2], ['f4', 3]]);
  assert.strictEqual(m.fiches.find(f => f.id === 'f1').numero_fiche, null, 'la fiche à la corbeille libère son numéro');
  assert.strictEqual(m.fiches.find(f => f.id === 'f1').numero_fiche_avant, 1, "…mais garde son ancien numéro (numero_fiche_avant)");
  assert.strictEqual(m.audits.length, 1);
  assert.strictEqual(m.audits[0].action, 'fiches_renumerotees');
  assert.strictEqual(m.audits[0].details.ancien_numero, 1);
});

test("Supprimer deux fois la même fiche (rejeu de la file hors ligne) ne renumérote pas une seconde fois", async () => {
  const m = quatre();
  await m.appeler('DELETE /api/fiches/:id', { params: { id: 'f2' } });
  const apres = m.numeros();
  const r2 = await m.appeler('DELETE /api/fiches/:id', { params: { id: 'f2' } });
  assert.strictEqual(r2.code, 200);
  assert.strictEqual(m.numeros(), apres);
  assert.strictEqual(m.audits.length, 1);
});

test("Insérer après la fiche 1 : la nouvelle fiche prend le N°2, les suivantes avancent, la réponse liste la numérotation complète", async () => {
  const m = quatre();
  const r = await m.appeler('POST /api/fiches', { corps: { episode_id: 'ep1', inserer_apres: 'f1', local_id: 'loc-1', total_global: 50 } });
  assert.strictEqual(r.code, 201);
  assert.strictEqual(r.corps.numero_fiche, 2);
  assert.strictEqual(m.numeros(), 'f1=1 nouvelle-5=2 f2=3 f3=4 f4=5');
  assert.deepStrictEqual(r.corps.renumerotation.map(n => n.numero_fiche), [1, 2, 3, 4, 5]);
  assert.strictEqual(m.audits[0].action, 'fiche_inseree');
});

test("Insérer « au début » : la nouvelle fiche devient la N°1 et toutes les autres avancent", async () => {
  const m = quatre();
  const r = await m.appeler('POST /api/fiches', { corps: { episode_id: 'ep1', inserer_apres: 'DEBUT', local_id: 'loc-2' } });
  assert.strictEqual(r.code, 201);
  assert.strictEqual(r.corps.numero_fiche, 1);
  assert.strictEqual(m.numeros(), 'nouvelle-5=1 f1=2 f2=3 f3=4 f4=5');
});

test("Insérer après la DERNIÈRE fiche = ajout normal à la suite, sans décalage ni renumérotation", async () => {
  const m = quatre();
  const r = await m.appeler('POST /api/fiches', { corps: { episode_id: 'ep1', inserer_apres: 'f4', local_id: 'loc-3' } });
  assert.strictEqual(r.code, 201);
  assert.strictEqual(r.corps.numero_fiche, 5);
  assert.strictEqual(r.corps.renumerotation, undefined);
  assert.strictEqual(m.numeros(), 'f1=1 f2=2 f3=3 f4=4 nouvelle-5=5');
});

test("Insertion refusée proprement : fiche cible d'un AUTRE dossier, supprimée, ou id invalide → 400, rien ne bouge", async () => {
  const m = quatre();
  m.fiches.push({ id: 'fautre', episode_id: 'ep2', numero_fiche: 1, numero_fiche_avant: null, supprime_le: null, date_creation: '2026-10-14T09:00:00Z' });
  const avant = m.numeros();
  for (const cible of ['fautre', 'f-inconnue', '!!']) {
    const r = await m.appeler('POST /api/fiches', { corps: { episode_id: 'ep1', inserer_apres: cible, local_id: 'loc-x-' + cible } });
    assert.strictEqual(r.code, 400, cible);
  }
  assert.strictEqual(m.numeros(), avant);
  assert.ok(!m.fiches.some(f => String(f.id).startsWith('nouvelle')), 'aucune fiche créée');
});

test("Une fiche à la corbeille qui a lâché son numéro (NULL) ne fait pas repartir la numérotation à 1 : la fiche suivante prend le vrai prochain numéro", async () => {
  const m = quatre();
  await m.appeler('DELETE /api/fiches/:id', { params: { id: 'f2' } }); // f1=1 f3=2 f4=3, f2 → NULL
  const r = await m.appeler('POST /api/fiches', { corps: { episode_id: 'ep1', local_id: 'loc-4' } });
  assert.strictEqual(r.code, 201);
  assert.strictEqual(r.corps.numero_fiche, 4);
});

test("Restaurer une fiche supprimée : elle revient à la FIN du dossier, au prochain numéro libre (son ancien numéro est déjà repris)", async () => {
  const m = quatre();
  await m.appeler('DELETE /api/fiches/:id', { params: { id: 'f1' } }); // f2=1 f3=2 f4=3
  const r = await m.appeler('POST /api/fiches/:id/restaurer', { params: { id: 'f1' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(m.numeros(), 'f2=1 f3=2 f4=3 f1=4');
});

test("Script SQL pas encore collé (fonctions absentes) : la suppression reste valable, renumerotation: null ; l'insertion répond une erreur claire et ne crée rien", async () => {
  const m = monter([{ id: 'f1', numero_fiche: 1 }, { id: 'f2', numero_fiche: 2 }], { sansFonctions: true });
  const suppression = await m.appeler('DELETE /api/fiches/:id', { params: { id: 'f1' } });
  assert.strictEqual(suppression.code, 200);
  assert.strictEqual(suppression.corps.renumerotation, null);
  assert.ok(m.fiches.find(f => f.id === 'f1').supprime_le, 'la fiche est bien supprimée');
  const insertion = await m.appeler('POST /api/fiches', { corps: { episode_id: 'ep1', inserer_apres: 'DEBUT', local_id: 'loc-sans-sql' } });
  assert.strictEqual(insertion.code, 500);
  assert.match(insertion.corps.error, /sql\/renumerotation_fiches\.sql/);
  assert.ok(!m.fiches.some(f => String(f.id).startsWith('nouvelle')), 'aucune fiche créée');
});

test("PUT /api/episodes/:id ne réécrit JAMAIS le numéro d'une fiche existante (un écran resté sur d'anciens numéros écraserait la renumérotation)", () => {
  const i = serverSrc.indexOf("if (Array.isArray(d.fiches)) {");
  const bloc = serverSrc.slice(i, i + 1600);
  assert.match(bloc, /const \{ numero_fiche: _numeroIgnore, \.\.\.colonnesSansNumero \} = ficheVersColonnes\(f\);/);
  assert.match(bloc, /\.update\(colonnesSansNumero\)\.eq\('id', f\.id\)/);
  assert.match(bloc, /\.insert\(\{ episode_id: req\.params\.id, \.\.\.ficheVersColonnes\(f\) \}\)/, "une NOUVELLE fiche garde son numéro");
});
