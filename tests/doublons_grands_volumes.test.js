// tests/doublons_grands_volumes.test.js — la détection de doublons et la recherche tiennent avec des milliers de dossiers (15/10).
// Mesure d'origine : avec des doublons PLANTÉS dans des dossiers fictifs, la détection en retrouvait 98 % à 1 000 dossiers mais 75-78 % dès 5 000 (les groupes de noms trop gros étaient ignorés).
const { test } = require('node:test');
const assert = require('node:assert');
const { trouverDoublons, trouverDoublonsSansBloquer } = require('../utils/doublonsIdentite');
const { creerFauxSupabase } = require('./aides/fauxSupabase');
const { creerAppFausse } = require('./aides/appFausse');
const { creerRoutesDoublons } = require('../utils/routesDoublons');

// Générateur déterministe (le test donne toujours le même résultat).
function alea(graine) { let s = graine; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
const PRENOMS = ['Marie', 'Jean', 'Joseph', 'Rose', 'Paul', 'Esther', 'Pierre', 'Anne', 'Louis', 'Claire', 'Michel', 'Sophia', 'Wilson', 'Nadège', 'Frantz', 'Carline', 'Jacques', 'Fabiola', 'Kervens', 'Guerline'];
const NOMS = ['Joseph', 'Pierre', 'Jean', 'Louis', 'Baptiste', 'Charles', 'Alexis', 'Saint Georges', 'Paul', 'Jeune', 'Michel', 'Etienne', 'Francois', 'Desir', 'Noel', 'Exantus'];

function fabriquer(n, nbDoublons, graine = 777) {
  const r = alea(graine); const pick = (l) => l[Math.floor(r() * l.length)];
  const a = []; const plantes = [];
  for (let i = 0; i < n; i++) {
    const nom = `${pick(PRENOMS)} ${pick(NOMS)}`;
    a.push({ id: 'd' + i, numero_dossier: String(1e8 + i), nom, nom_origine: nom, date_naissance: `${1940 + Math.floor(r() * 80)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`, telephone: r() < 0.5 ? '3' + String(Math.floor(r() * 1e7)).padStart(7, '0') : null, sexe: r() < 0.5 ? 'M' : 'F' });
  }
  for (let k = 0; k < nbDoublons; k++) {
    const o = a[Math.floor(r() * n)];
    const mots = o.nom.split(' '); const i = Math.floor(r() * mots[0].length); mots[0] = mots[0].slice(0, i) + mots[0].slice(i + 1); // une lettre oubliée
    const nais = r() < 0.7 ? o.date_naissance : o.date_naissance.slice(0, 8) + String(1 + Math.floor(r() * 28)).padStart(2, '0'); // parfois un autre jour
    a.push({ id: 'x' + k, numero_dossier: String(2e8 + k), nom: mots.join(' '), nom_origine: mots.join(' '), date_naissance: nais, telephone: r() < 0.5 ? o.telephone : null, sexe: o.sexe });
    plantes.push([o.id, 'x' + k]);
  }
  return { a, plantes };
}
const rappel = (paires, plantes) => {
  const trouvees = new Set(paires.map(p => [p.a.id, p.b.id].sort().join('|')));
  return plantes.filter(([x, y]) => trouvees.has([x, y].sort().join('|'))).length / plantes.length;
};

test("Rappel : 5 000 dossiers fictifs + 100 doublons plantés (une faute de frappe, parfois un autre jour de naissance, téléphone souvent absent) → tous retrouvés", () => {
  const { a, plantes } = fabriquer(5000, 100);
  assert.ok(rappel(trouverDoublons(a), plantes) >= 0.98, 'au moins 98 % retrouvés');
});

test("Rappel à 20 000 dossiers aussi (avant : environ 84 %)", { timeout: 120000 }, () => {
  const { a, plantes } = fabriquer(20000, 100);
  assert.ok(rappel(trouverDoublons(a), plantes) >= 0.98);
});

test("La version « sans bloquer » donne exactement le même résultat, et laisse passer le reste du serveur pendant le calcul", async () => {
  const { a } = fabriquer(3000, 60, 4242);
  const attendu = trouverDoublons(a);
  let ticks = 0; const minuteur = setInterval(() => { ticks++; }, 1);
  const obtenu = await trouverDoublonsSansBloquer(a, { pas: 500 });
  clearInterval(minuteur);
  assert.deepStrictEqual(obtenu.map(p => [p.a.id, p.b.id, p.score]), attendu.map(p => [p.a.id, p.b.id, p.score]));
  assert.ok(ticks > 0, "le serveur a pu traiter d'autres choses entre deux morceaux");
});

test("Faute de frappe sur le début du prénom (« Mrie » pour « Marie ») : retrouvé même avec un autre jour de naissance, parmi des centaines de Marie", () => {
  const { a } = fabriquer(2000, 0, 99);
  const o = a.find(d => d.nom.startsWith('Marie ') && d.date_naissance);
  const copie = { ...o, id: 'copie', numero_dossier: 'copie-1', nom: o.nom.replace('Marie', 'Mrie'), nom_origine: o.nom.replace('Marie', 'Mrie'), date_naissance: o.date_naissance.slice(0, 8) + (o.date_naissance.endsWith('01') ? '02' : '01'), telephone: null };
  const paires = trouverDoublons([...a, copie]);
  assert.ok(paires.some(p => [p.a.id, p.b.id].sort().join('|') === [o.id, 'copie'].sort().join('|')));
});

// --- Lecture par différence du cache des dossiers ---
const lireToutesLesPages = async (construire) => { const { data, error } = await construire().range(0, 99999); if (error) throw error; return data; };
function monter(dossiers) {
  const supabase = creerFauxSupabase({ dossiers, episodes: [], audit_log: [], doublons_ignores: [] });
  const { app, appeler } = creerAppFausse();
  let t = 0;
  creerRoutesDoublons({ supabase, aPermission: async () => true, lireToutesLesPages, maintenant: () => t }).monter(app);
  return { supabase, appeler, avancer: (ms) => { t += ms; } };
}
const D = (id, nom, extra = {}) => ({ id, numero_dossier: `N-${id}`, nom, nom_origine: nom, modifie_le: '2026-10-15T10:00:00.000Z', ...extra });

test("Après 60 s, seuls les dossiers MODIFIÉS depuis sont relus (pas toute la liste) ; un dossier créé entre-temps est pris en compte", async () => {
  const base = [D('a', 'Marie Joseph', { date_naissance: '1995-03-02' }), D('b', 'Paul Louis', { date_naissance: '1980-01-01' })];
  const { supabase, appeler, avancer } = monter(base);
  const lecturesDossiers = () => supabase.journal.filter(j => j.table === 'dossiers' && j.op === 'select').length;
  assert.strictEqual((await appeler('GET', '/api/dossiers/similaires?nom=Marie%20Josef&date_naissance=1995-03-02')).corps.length, 1);
  const apres1 = lecturesDossiers();
  avancer(61000);
  supabase.tables.dossiers.push(D('c', 'Marie Josef', { date_naissance: '1995-03-02', modifie_le: '2026-10-15T10:05:00.000Z' }));
  const r = await appeler('GET', '/api/dossiers/similaires?nom=Marie%20Josef&date_naissance=1995-03-02');
  assert.deepStrictEqual(r.corps.map(x => x.id).sort(), ['a', 'c'], 'le nouveau dossier est vu');
  assert.strictEqual(lecturesDossiers() - apres1, 1, 'une seule lecture, filtrée sur modifie_le');
});

test("Une modification est prise en compte ; la liste complète est relue au bout de 30 minutes (rattrape les suppressions)", async () => {
  const { supabase, appeler, avancer } = monter([D('a', 'Marie Joseph', { date_naissance: '1995-03-02' }), D('b', 'Marie Josef', { date_naissance: '1995-03-02' })]);
  assert.strictEqual((await appeler('GET', '/api/dossiers/doublons-possibles')).corps.total, 1);
  avancer(61000);
  Object.assign(supabase.tables.dossiers.find(d => d.id === 'b'), { fusionne_dans: 'a', modifie_le: '2026-10-15T10:10:00.000Z' });
  assert.strictEqual((await appeler('GET', '/api/dossiers/doublons-possibles')).corps.total, 0, 'dossier fusionné entre-temps : plus proposé');
  supabase.tables.dossiers.splice(supabase.tables.dossiers.findIndex(d => d.id === 'b'), 1); // suppression dure : invisible à la lecture par différence
  avancer(31 * 60000);
  const avant = supabase.journal.filter(j => j.table === 'dossiers').length;
  await appeler('GET', '/api/dossiers/similaires?nom=Marie%20Joseph');
  assert.strictEqual(supabase.journal.filter(j => j.table === 'dossiers').length - avant, 1, 'relecture complète après 30 minutes');
});

test("Sans date de modification (base pas encore migrée) : relectures complètes comme avant, tout fonctionne", async () => {
  const sans = [{ id: 'a', numero_dossier: 'N-a', nom: 'Marie Joseph', nom_origine: 'Marie Joseph', date_naissance: '1995-03-02' }];
  const { appeler, avancer } = monter(sans);
  assert.strictEqual((await appeler('GET', '/api/dossiers/similaires?nom=Marie%20Josef&date_naissance=1995-03-02')).corps.length, 1);
  avancer(61000);
  assert.strictEqual((await appeler('GET', '/api/dossiers/similaires?nom=Marie%20Josef&date_naissance=1995-03-02')).corps.length, 1);
});

test("Les paires déjà calculées sont gardées tant que rien ne change (pas de recalcul toutes les 60 s) ; une fusion ou une paire ignorée les invalide", async () => {
  const { appeler, avancer, supabase } = monter([D('a', 'Marie Joseph', { date_naissance: '1995-03-02' }), D('b', 'Marie Josef', { date_naissance: '1995-03-02' })]);
  const r1 = await appeler('GET', '/api/dossiers/doublons-possibles');
  avancer(90000);
  const r2 = await appeler('GET', '/api/dossiers/doublons-possibles');
  assert.deepStrictEqual(r2.corps, r1.corps);
  await appeler('POST', '/api/dossiers/doublons-ignores', { body: { a: 'a', b: 'b' } });
  assert.strictEqual((await appeler('GET', '/api/dossiers/doublons-possibles')).corps.total, 0);
  assert.ok(supabase.tables.doublons_ignores.length === 1);
});
