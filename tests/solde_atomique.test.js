// tests/solde_atomique.test.js — 13/10 : « Send 20 withdrawals against the same balance simultaneously » (liste de contrôle fintech d'Esdras).
// Le paiement et son solde s'écrivent en UNE opération de la base, sous un verrou par épisode (sql/solde_atomique.sql, testé avec 20 sessions simultanées
// sur un vrai Postgres par scripts/test-solde-atomique-sql.py). Ici : la route POST /api/paiements EXÉCUTÉE (extraite de server.js) contre une fausse base.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { estFonctionAbsente, estRefusRemboursement, CODES_REFUS_REMBOURSEMENT } = require('../utils/soldeAtomique');
const { appliquerHeureAuPaiement, estRejeu } = require('../utils/heureServeur');
const { validerMontantPaiement, normaliserMontant } = require('../utils/validationMontant');
const { validerPaiementPartiel, soldeAjouteParPaiement } = require('../utils/paiementPartiel');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test("estFonctionAbsente : PGRST202, 42883 ou un message « introuvable » sur la fonction ; jamais une autre erreur", () => {
  assert.strictEqual(estFonctionAbsente({ code: 'PGRST202', message: 'Could not find the function public.enregistrer_paiement_atomique(...) in the schema cache' }), true);
  assert.strictEqual(estFonctionAbsente({ code: '42883', message: 'function public.enregistrer_paiement_atomique(jsonb, numeric, boolean) does not exist' }), true);
  assert.strictEqual(estFonctionAbsente({ code: '', message: 'Could not find the function public.enregistrer_paiement_atomique' }), true);
  for (const e of [null, undefined, {}, { code: '23505', message: 'duplicate key' }, { code: 'CHF03', message: 'dépasse' }, { code: '57014', message: 'canceling statement due to statement timeout' }, { code: '42883', message: 'x' } && { code: '08006', message: 'connection failure' }]) {
    assert.strictEqual(estFonctionAbsente(e), false, JSON.stringify(e));
  }
});

test("estRefusRemboursement : CHF01 (rien à rembourser), CHF02 (montant ≤ 0), CHF03 (dépasse la dette)", () => {
  for (const code of CODES_REFUS_REMBOURSEMENT) assert.strictEqual(estRefusRemboursement({ code }), true, code);
  assert.deepStrictEqual(CODES_REFUS_REMBOURSEMENT, ['CHF01', 'CHF02', 'CHF03']);
  for (const e of [null, {}, { code: '23505' }, { code: 'CHF04' }, { code: 'PGRST202' }]) assert.strictEqual(estRefusRemboursement(e), false);
});

// ---------------------------------------------------------------------------------------------------------
// La vraie route, contre une fausse base
// ---------------------------------------------------------------------------------------------------------
function routePaiements({ rpc, existants = [], insererHistorique = null } = {}) {
  const appels = { rpc: [], insertions: [], lectures: [] };
  const supabase = {
    rpc: async (nom, args) => { appels.rpc.push({ nom, args }); return rpc ? rpc(nom, args) : { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.enregistrer_paiement_atomique' } }; },
    from(table) {
      const q = {
        _filtres: {}, _op: null,
        select() { q._op = q._op || 'select'; return q; },
        insert(v) { q._op = 'insert'; q._v = v; return q; },
        eq(c, v) { q._filtres[c] = v; return q; },
        or() { return q; }, is() { return q; }, order() { return q; }, limit() { return q; },
        single: async () => { appels.insertions.push(q._v); return insererHistorique ? insererHistorique(q._v) : { data: { id: 'ligne-historique', ...q._v }, error: null }; },
        maybeSingle: async () => {
          appels.lectures.push({ table, filtres: { ...q._filtres } });
          if (q._filtres.local_id !== undefined) return { data: existants.find(e => e.local_id === q._filtres.local_id) || null, error: null };
          return { data: { solde_restant: 100 }, error: null };
        },
      };
      return q;
    },
  };
  let gestionnaire = null;
  const app = { post: (chemin, fn) => { if (chemin === '/api/paiements') gestionnaire = fn; } };
  const debut = src.indexOf("app.post('/api/paiements'");
  const fin = src.indexOf('\napp.', debut + 10);
  new Function('app', 'supabase', 'aPermission', 'appliquerHeureAuPaiement', 'validerMontantPaiement', 'normaliserMontant', 'validerPaiementPartiel', 'soldeAjouteParPaiement', 'estFonctionAbsente', 'estRefusRemboursement', 'estRejeu',
    src.slice(debut, fin))(app, supabase, async () => true, appliquerHeureAuPaiement, validerMontantPaiement, normaliserMontant, validerPaiementPartiel, soldeAjouteParPaiement, estFonctionAbsente, estRefusRemboursement, estRejeu);
  const appeler = async (corps, headers = {}) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    await gestionnaire({ body: corps, user: { id: 'uid-caisse' }, headers }, res);
    return res;
  };
  return { appeler, appels };
}
const paiement = (extra = {}) => ({ episode_id: 'ep-1', mode: 'cash', montant: 60, solde_restant: 0, local_id: 'L-1', ...extra });

test("Chemin normal : UN seul appel à la fonction atomique (lecture + calcul + écriture dans la base), réponse 201 avec la ligne écrite ; plus aucune lecture ni écriture séparée du serveur", async () => {
  const { appeler, appels } = routePaiements({ rpc: async (nom, args) => ({ data: { id: 'p-1', ...args.p_corps, solde_restant: 100 }, error: null }) });
  const r = await appeler(paiement({ mode: 'credit', montant: 0, solde_restant: 100 }));
  assert.strictEqual(r.code, 201);
  assert.strictEqual(r.corps.id, 'p-1');
  assert.strictEqual(appels.rpc.length, 1);
  assert.strictEqual(appels.rpc[0].nom, 'enregistrer_paiement_atomique');
  assert.strictEqual(appels.rpc[0].args.p_ajout, 100, 'une vente à crédit ajoute sa dette');
  assert.strictEqual(appels.rpc[0].args.p_remboursement_credit, false);
  assert.strictEqual(appels.rpc[0].args.p_corps.local_id, 'L-1');
  assert.strictEqual(appels.rpc[0].args.p_corps.montant, 0);
  assert.ok(appels.rpc[0].args.p_corps.date_paiement, 'heure du serveur déjà appliquée');
  assert.strictEqual(appels.insertions.length, 0, 'aucune écriture séparée');
  assert.strictEqual(appels.lectures.filter(l => l.filtres.local_id === undefined).length, 0, 'aucune lecture séparée du solde : c\'est la base qui la fait, sous verrou (seul le contrôle d\'idempotence par local_id reste)');
});

test("Date du paiement : en direct, la base date l'écriture sous le verrou (p_heure_serveur vrai) ; un rejeu de la file hors ligne garde la date de l'appareil (p_heure_serveur faux)", async () => {
  const drapeau = async (headers) => { const { appeler, appels } = routePaiements({ rpc: async () => ({ data: { id: 'x' }, error: null }) }); await appeler(paiement(), headers); return appels.rpc[0].args.p_heure_serveur; };
  assert.strictEqual(await drapeau({}), true);
  assert.strictEqual(await drapeau({ 'x-chf-rejeu': '1' }), false);
});

test("Ce que CE paiement ajoute au solde : crédit → sa dette, paiement partiel → son reste, comptant / dépôt → 0 ; remboursement de crédit : drapeau levé, rien ajouté", async () => {
  const ajout = async (corps) => { const { appeler, appels } = routePaiements({ rpc: async () => ({ data: { id: 'x' }, error: null }) }); await appeler(corps); return appels.rpc[0].args; };
  assert.strictEqual((await ajout(paiement({ mode: 'cash', montant: 400, solde_restant: 600, details: { paiement_partiel: true, reste: 600 } }))).p_ajout, 600);
  assert.strictEqual((await ajout(paiement({ mode: 'cash' }))).p_ajout, 0);
  assert.strictEqual((await ajout(paiement({ mode: 'depot', montant: 50 }))).p_ajout, 0);
  const remb = await ajout(paiement({ mode: 'remboursement_credit', montant: 40, solde_restant: undefined }));
  assert.strictEqual(remb.p_remboursement_credit, true);
  assert.strictEqual(remb.p_ajout, 0);
  assert.strictEqual((await ajout({ mode: 'cash', montant: 5, local_id: 'L-9' })).p_ajout, 0, 'sans épisode : rien à reporter');
});

test("Remboursement de crédit refusé par la base (CHF01 / CHF02 / CHF03) → 400 avec son message ; jamais 500", async () => {
  for (const [code, message] of [['CHF01', 'Aucun solde de crédit à rembourser pour cet épisode.'], ['CHF02', 'Le montant du remboursement doit être supérieur à 0.'], ['CHF03', 'Le remboursement (500) dépasse le solde restant (110).']]) {
    const { appeler, appels } = routePaiements({ rpc: async () => ({ data: null, error: { code, message } }) });
    const r = await appeler(paiement({ mode: 'remboursement_credit', montant: 500, solde_restant: undefined }));
    assert.strictEqual(r.code, 400, code);
    assert.strictEqual(r.corps.error, message);
    assert.strictEqual(appels.insertions.length, 0, 'aucun repli : le refus est la réponse');
  }
});

test("Remboursement sans épisode : 400 sans même appeler la base", async () => {
  const { appeler, appels } = routePaiements({ rpc: async () => ({ data: { id: 'x' }, error: null }) });
  const r = await appeler({ mode: 'remboursement_credit', montant: 10 });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(r.corps.error, 'episode_id requis pour un remboursement de crédit.');
  assert.strictEqual(appels.rpc.length, 0);
});

test("Rejeu d'un paiement déjà enregistré (même local_id, refus 23505 de la base) → 200 avec le paiement existant, jamais un doublon ni une erreur", async () => {
  const { appeler, appels } = routePaiements({ rpc: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "paiements_local_id_key"' } }), existants: [{ local_id: 'L-1', id: 'deja-la', montant: 60 }] });
  // Le contrôle de local_id AVANT l'écriture renvoie déjà le paiement existant ; la course (deux requêtes en même temps) passe par le refus 23505.
  const r = await appeler(paiement({ local_id: 'L-2' }));
  assert.strictEqual(r.code, 500, 'local_id inconnu mais refus 23505 sans ligne retrouvée : erreur franche, pas de faux succès');
  const r2 = await appeler(paiement({ local_id: 'L-1' }));
  assert.strictEqual(r2.code, 200);
  assert.strictEqual(r2.corps.id, 'deja-la');
  assert.strictEqual(appels.rpc.length, 1, 'le 2e appel est arrêté avant la base (contrôle du local_id)');
});

test("Fonction PAS ENCORE en base (script SQL pas collé) : l'ancien chemin prend le relais — lecture du solde puis écriture, comme avant, jamais une panne", async () => {
  const { appeler, appels } = routePaiements({}); // la fausse base répond PGRST202
  const r = await appeler(paiement({ mode: 'credit', montant: 0, solde_restant: 100 }));
  assert.strictEqual(r.code, 201);
  assert.strictEqual(appels.rpc.length, 1, 'une tentative avec la fonction');
  assert.strictEqual(appels.insertions.length, 1, 'puis l\'écriture de l\'ancien chemin');
  assert.strictEqual(appels.insertions[0].solde_restant, 200, 'ancien solde 100 + dette 100, calculé par le serveur');
  assert.strictEqual(appels.insertions[0].local_id, 'L-1');
});

test("Autre erreur de la base : 500 avec son message (pas de repli silencieux qui écrirait un paiement avec un solde possiblement faux)", async () => {
  const { appeler, appels } = routePaiements({ rpc: async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) });
  const r = await appeler(paiement());
  assert.strictEqual(r.code, 500);
  assert.match(r.corps.error, /statement timeout/);
  assert.strictEqual(appels.insertions.length, 0);
});

test("Les contrôles d'avant restent devant : montant négatif et paiement partiel invalide refusés AVANT toute base", async () => {
  const { appeler, appels } = routePaiements({ rpc: async () => ({ data: { id: 'x' }, error: null }) });
  assert.strictEqual((await appeler(paiement({ montant: -5 }))).code, 400);
  assert.strictEqual((await appeler(paiement({ mode: 'credit', details: { paiement_partiel: true }, solde_restant: 10 }))).code, 400);
  assert.strictEqual(appels.rpc.length, 0);
});

test("sql/solde_atomique.sql : verrou par épisode, même règle de solde, codes de refus, sans DROP ni REVOKE", () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'solde_atomique.sql'), 'utf8');
  assert.match(sql, /create or replace function public\.enregistrer_paiement_atomique\(p_corps jsonb, p_ajout numeric default 0, p_remboursement_credit boolean default false, p_heure_serveur boolean default true\)/i);
  assert.match(sql, /clock_timestamp\(\)/, 'la date d\'un paiement en direct est prise sous le verrou');
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('chf:paiement:' \|\| v_episode::text, 0\)\)/);
  assert.match(sql, /\(annule = false or annule is null\) and supprime_le is null\s*\n\s*order by date_paiement desc, numero_paiement desc/, 'même définition du solde que lireSoldeEpisode, départagée par le numéro de paiement');
  for (const code of CODES_REFUS_REMBOURSEMENT) assert.match(sql, new RegExp(`errcode = '${code}'`));
  assert.doesNotMatch(sql, /^\s*(drop|revoke)\b/im);
  assert.doesNotMatch(sql, /security definer/i, 'SECURITY INVOKER : la sécurité par lignes de paiements s\'applique à l\'appelant');
});

test("server.js : l'appel atomique vient AVANT l'ancien chemin, qui reste en secours inchangé", () => {
  const debut = src.indexOf("app.post('/api/paiements'");
  const route = src.slice(debut, src.indexOf('\napp.', debut + 10));
  const iRpc = route.indexOf("supabase.rpc('enregistrer_paiement_atomique'");
  const iAncien = route.indexOf('const lireSoldeEpisode = async (episodeId) => {');
  const iInsertAncien = route.indexOf(".insert({ ...corps, local_id: local_id || null })");
  assert.ok(iRpc > 0 && iRpc < iAncien && iAncien < iInsertAncien, 'fonction atomique, puis ancien chemin en secours');
  assert.ok(route.indexOf('validerMontantPaiement(corps)') < iRpc && route.indexOf('validerPaiementPartiel(corps)') < iRpc, 'les contrôles passent avant la base');
  assert.match(route, /if \(!estFonctionAbsente\(erreurAtomique\)\) return res\.status\(500\)/);
});
