// tests/demandes_commande.test.js — « médicaments à commander » (26/11, Esdras) : la pharmacienne en chef envoie la liste à la direction ; la direction la marque « commandée ». Routes extraites du serveur, base simulée.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = require('./serveurSource').lireServeur();
const debut = source.indexOf('const tableCommandeAbsente');
const marqueFin = "res.json({ success: true, demande: data });\n});";
const fin = source.indexOf(marqueFin, debut);
assert.ok(debut > 0 && fin > debut, 'routes introuvables dans le serveur');
const code = source.slice(debut, fin + marqueFin.length);

function monter({ droits = ['stock_gerer'], demandes = [], tableAbsente = false } = {}) {
  const routes = {}; const audit = [];
  const app = { get: (c, f) => { routes['GET ' + c] = f; }, post: (c, f) => { routes['POST ' + c] = f; }, patch: (c, f) => { routes['PATCH ' + c] = f; } };
  const erreurAbsente = { message: 'relation "public.demandes_commande" does not exist', code: '42P01' };
  const supabase = {
    from: (table) => {
      assert.strictEqual(table, 'demandes_commande');
      const f = []; let action = 'select'; let corps = null;
      const c = {
        select: () => c, order: () => c, eq: (k, v) => { f.push(r => r[k] === v); return c; },
        insert: (v) => { action = 'insert'; corps = v; return c; }, update: (v) => { action = 'update'; corps = v; return c; },
        maybeSingle: async () => { if (tableAbsente) return { data: null, error: erreurAbsente }; return { data: demandes.find(r => f.every(g => g(r))) || null, error: null }; },
        single: async () => {
          if (tableAbsente) return { data: null, error: erreurAbsente };
          if (corps.local_id && demandes.some(d => d.local_id === corps.local_id)) return { data: null, error: { code: '23505', message: 'doublon' } };
          const ligne = { id: 'd' + (demandes.length + 1), statut: 'envoyee', date_envoi: new Date().toISOString(), ...corps }; demandes.push(ligne); return { data: ligne, error: null };
        },
        then: (ok) => {
          if (tableAbsente) return ok({ data: null, error: erreurAbsente });
          if (action === 'update') { const r = demandes.filter(x => f.every(g => g(x))); r.forEach(x => Object.assign(x, corps)); return ok({ data: r, error: null }); }
          return ok({ data: demandes.filter(r => f.every(g => g(r))), error: null });
        },
      };
      // update(...).select().maybeSingle() : applique la mise à jour puis renvoie la ligne touchée
      const maybeSingleOrigine = c.maybeSingle;
      c.maybeSingle = async () => {
        if (action === 'update' && !tableAbsente) { const r = demandes.filter(x => f.every(g => g(x))); r.forEach(x => Object.assign(x, corps)); return { data: r[0] || null, error: null }; }
        return maybeSingleOrigine();
      };
      return c;
    },
  };
  const aPermission = async (_uid, cle) => droits.includes(cle);
  const lireToutesLesPages = async (fabrique) => { const r = await fabrique(); if (r.error) throw new Error(r.error.message); return r.data; };
  const enregistrerAuditServeur = async (_req, action, d) => { audit.push({ action, d }); };
  new Function('app', 'supabase', 'aPermission', 'lireToutesLesPages', 'enregistrerAuditServeur', code)(app, supabase, aPermission, lireToutesLesPages, enregistrerAuditServeur);
  return { routes, demandes, audit };
}
const reponse = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.corps = b; return r; }; return r; };
const requete = (corps = {}, params = {}) => ({ user: { id: 'u1', email: 'pharma@chf.com' }, body: corps, params });
const LIGNES = [{ id: 'm1', nom: 'Amoxicilline', stock: 2, seuil: 5, quantite: 20 }, { id: 'm2', nom: 'Paracétamol', stock: 0, seuil: 5, quantite: 30 }];

test('La pharmacienne en chef envoie une demande : lignes nettoyées, qui/quand gardés, audit posé', async () => {
  const { routes, demandes, audit } = monter();
  const res = reponse();
  await routes['POST /api/demandes-commande'](requete({ lignes: LIGNES, note: '  Urgent  ', local_id: 'x1' }), res);
  assert.strictEqual(res.code, 201);
  assert.strictEqual(demandes.length, 1);
  assert.strictEqual(demandes[0].envoyee_par, 'pharma@chf.com');
  assert.strictEqual(demandes[0].note, 'Urgent');
  assert.deepStrictEqual(demandes[0].lignes[0], { id: 'm1', nom: 'Amoxicilline', stock: 2, seuil: 5, quantite: 20 });
  assert.strictEqual(audit[0].action, 'demande_commande_envoyee');
});

test('Rejeu hors ligne (même local_id) : une seule demande', async () => {
  const { routes, demandes } = monter();
  await routes['POST /api/demandes-commande'](requete({ lignes: LIGNES, local_id: 'x2' }), reponse());
  const res = reponse();
  await routes['POST /api/demandes-commande'](requete({ lignes: LIGNES, local_id: 'x2' }), res);
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.corps.deja_enregistree, true);
  assert.strictEqual(demandes.length, 1);
});

test('Refus : sans droit stock_gerer, liste vide, quantité nulle ou négative, trop de lignes', async () => {
  const sans = monter({ droits: ['direction_voir'] });
  let res = reponse(); await sans.routes['POST /api/demandes-commande'](requete({ lignes: LIGNES }), res); assert.strictEqual(res.code, 403);
  const { routes, demandes } = monter();
  for (const lignes of [[], undefined, [{ id: 'm1', nom: 'A', quantite: 0 }], [{ id: 'm1', nom: 'A', quantite: -3 }], [{ nom: 'A', quantite: 3 }], Array.from({ length: 201 }, (_, i) => ({ id: 'm' + i, quantite: 1 }))]) {
    res = reponse(); await routes['POST /api/demandes-commande'](requete({ lignes }), res); assert.strictEqual(res.code, 400, JSON.stringify(lignes && lignes.slice(0, 1)));
  }
  assert.strictEqual(demandes.length, 0);
});

test('Lecture : stock_gerer ou direction_voir ; autrement refus', async () => {
  const ok = monter({ demandes: [{ id: 'd1', statut: 'envoyee', lignes: LIGNES }] });
  let res = reponse(); await ok.routes['GET /api/demandes-commande'](requete(), res); assert.strictEqual(res.corps.length, 1);
  const direction = monter({ droits: ['direction_voir'], demandes: [{ id: 'd1' }] });
  res = reponse(); await direction.routes['GET /api/demandes-commande'](requete(), res); assert.strictEqual(res.corps.length, 1);
  const rien = monter({ droits: ['caisse_travailler'] });
  res = reponse(); await rien.routes['GET /api/demandes-commande'](requete(), res); assert.strictEqual(res.code, 403);
});

test('La direction marque « commandée » une demande envoyée, une seule fois ; la pharmacienne ne le peut pas', async () => {
  const { routes, demandes } = monter({ droits: ['direction_voir'], demandes: [{ id: 'd1', statut: 'envoyee', lignes: LIGNES }] });
  let res = reponse(); await routes['PATCH /api/demandes-commande/:id/commandee'](requete({}, { id: 'd1' }), res);
  assert.strictEqual(res.code, 200); assert.strictEqual(demandes[0].statut, 'commandee'); assert.strictEqual(demandes[0].traitee_par, 'pharma@chf.com');
  res = reponse(); await routes['PATCH /api/demandes-commande/:id/commandee'](requete({}, { id: 'd1' }), res);
  assert.strictEqual(res.code, 404);
  const pharma = monter({ droits: ['stock_gerer'], demandes: [{ id: 'd1', statut: 'envoyee' }] });
  res = reponse(); await pharma.routes['PATCH /api/demandes-commande/:id/commandee'](requete({}, { id: 'd1' }), res);
  assert.strictEqual(res.code, 403);
});

test('Table pas encore créée (SQL non appliqué) : lecture = liste vide ; envoi = 503 avec la consigne', async () => {
  const { routes } = monter({ tableAbsente: true });
  let res = reponse(); await routes['GET /api/demandes-commande'](requete(), res); assert.deepStrictEqual(res.corps, []);
  res = reponse(); await routes['POST /api/demandes-commande'](requete({ lignes: LIGNES }), res);
  assert.strictEqual(res.code, 503); assert.match(res.corps.error, /demandes_commande\.sql/);
});

test('Le script SQL est additif : une table, RLS activée, aucune suppression', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'demandes_commande.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.demandes_commande/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /\bDELETE\b|\bTRUNCATE\b|\bDROP\b|\bUPDATE\b|\bALTER\s+TABLE\s+public\.(?!demandes_commande)/i);
});
