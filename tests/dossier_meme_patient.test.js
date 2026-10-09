// tests/dossier_meme_patient.test.js — « quand le net est tombé, il n'y aura plus de connexion entre les deux
// ordinateurs » (Esdras, 09/10). La porte et la caisse peuvent créer, chacune hors ligne, le dossier du MÊME patient avec
// le MÊME numéro. Au retour d'internet, le 2e dossier envoyé était refusé (numéro déjà pris) et l'épisode, la fiche et le
// PAIEMENT de la caisse qui en dépendent étaient abandonnés avec lui. Maintenant : même numéro ET même nom = même patient,
// le serveur renvoie le dossier existant (200) ; un nom différent reste un vrai conflit (409).
// Ces tests EXÉCUTENT la vraie route POST /api/dossiers (extraite de server.js) contre un faux Supabase.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { jetonsDuNom, memePatient } = require('../utils/dossiers');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ---------------------------------------------------------------------------------------------------------
// Comparaison de noms
// ---------------------------------------------------------------------------------------------------------
test("jetonsDuNom : sans accent, sans majuscule, sans ponctuation, sans ordre des mots", () => {
  assert.strictEqual(jetonsDuNom('  Jean-Baptiste   MARIE '), 'baptiste jean marie');
  assert.strictEqual(jetonsDuNom('Michaël'), jetonsDuNom('michael'));
  assert.strictEqual(jetonsDuNom("N'Guyen"), jetonsDuNom('n guyen'));
  assert.strictEqual(jetonsDuNom('BAPTISTE Jean'), jetonsDuNom('Jean Baptiste'));
  assert.strictEqual(jetonsDuNom(null), '');
  assert.strictEqual(jetonsDuNom(undefined), '');
  assert.strictEqual(jetonsDuNom(' - ., '), '');
  assert.strictEqual(jetonsDuNom('Bébé 2'), '2 bebe');
});

test("memePatient : même nom à l'accent, à la casse, à la ponctuation et à l'ordre près → oui ; tout le reste → non", () => {
  const dossier = { id: 'd1', nom: 'Jean-Baptiste Marie', nom_origine: 'Jean-Baptiste Marie' };
  for (const nom of ['Jean-Baptiste Marie', 'jean baptiste marie', 'MARIE Jean Baptiste', 'Jean  Baptiste,  Marié']) {
    assert.strictEqual(memePatient(dossier, nom), true, nom);
  }
  for (const nom of ['Jean Baptiste', 'Jean Baptiste Marie Louise', 'Jean Babtiste Marie', 'Jeanne Baptiste Marie', 'Marie Joseph', '', '   ', '---', null, undefined]) {
    assert.strictEqual(memePatient(dossier, nom), false, JSON.stringify(nom));
  }
  assert.strictEqual(memePatient(null, 'Jean'), false);
  assert.strictEqual(memePatient(undefined, 'Jean'), false);
  assert.strictEqual(memePatient('texte', 'texte'), false);
  assert.strictEqual(memePatient({ nom: '' }, ''), false, 'deux noms vides ne sont jamais « le même patient »');
  assert.strictEqual(memePatient({ nom: 'Bébé 1' }, 'Bébé 2'), false, 'un chiffre de différence = un autre patient');
});

test("memePatient : le nom d'ORIGINE compte (un bébé renommé reste le même patient pour qui arrive avec l'ancien nom)", () => {
  const bebe = { id: 'd2', nom: 'Marie Louise Joseph', nom_origine: 'Bébé Marie Joseph' };
  assert.strictEqual(memePatient(bebe, 'Bébé Marie Joseph'), true);
  assert.strictEqual(memePatient(bebe, 'Marie Louise Joseph'), true);
  assert.strictEqual(memePatient(bebe, 'Marie Joseph'), false);
  assert.strictEqual(memePatient({ nom: 'Marie Louise Joseph' }, 'Bébé Marie Joseph'), false, 'sans nom_origine (colonne absente) : seul le nom actuel compte');
});

// ---------------------------------------------------------------------------------------------------------
// La vraie route POST /api/dossiers, contre un faux Supabase
// ---------------------------------------------------------------------------------------------------------
function fauxSupabase({ dossiers = [], auditRefuse = null, conflitSansDossier = false } = {}) {
  const audits = [];
  return {
    dossiers, audits,
    from(table) {
      if (table === 'dossiers') return {
        insert: (ligne) => ({ select: () => ({ single: async () => {
          const pris = conflitSansDossier
            || dossiers.some(d => d.numero_dossier === ligne.numero_dossier)
            || (ligne.local_id && dossiers.some(d => d.local_id === ligne.local_id));
          if (pris) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          const d = { id: `d-${dossiers.length + 1}`, ...ligne };
          dossiers.push(d);
          return { data: d, error: null };
        } }) }),
        select: () => ({ eq: (col, val) => ({ maybeSingle: async () => ({ data: dossiers.find(d => d[col] === val) || null, error: null }) }) }),
      };
      if (table === 'audit_log') return {
        insert: async (ligne) => {
          if (auditRefuse === 'jette') throw new Error('réseau coupé');
          if (auditRefuse) return { error: { message: 'journal plein' } };
          audits.push(ligne);
          return { error: null };
        },
      };
      throw new Error('table inattendue : ' + table);
    },
  };
}

function routeCreationDossier(options = {}) {
  const debut = serverSrc.indexOf("app.post('/api/dossiers', async (req, res) => {");
  const fin = serverSrc.indexOf("app.get('/api/dossiers/:id'", debut);
  assert.ok(debut !== -1 && fin > debut, 'route POST /api/dossiers introuvable');
  const supabase = fauxSupabase(options);
  let gestionnaire;
  const app = { post: (_chemin, fn) => { gestionnaire = fn; } };
  const aPermission = async () => options.permission !== false;
  const avertissements = [];
  const console_ = { warn: (...a) => avertissements.push(a.join(' ')), log() {}, error() {} };
  new Function('app', 'supabase', 'aPermission', 'dateOuNull', 'memePatient', 'crypto', 'console', serverSrc.slice(debut, fin))(
    app, supabase, aPermission, (v) => (v ? v : null), memePatient, crypto, console_);
  const appeler = async (corps, utilisateur = { id: 'uid-caisse', email: 'caisse@chf.com' }) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    await gestionnaire({ body: corps, user: utilisateur }, res);
    return res;
  };
  return { appeler, supabase, avertissements };
}

test("POST /api/dossiers : une création normale reste une création (201), sans trace de réunion", async () => {
  const { appeler, supabase } = routeCreationDossier();
  const r = await appeler({ numero_dossier: '1234', nom: 'Jean Baptiste', local_id: 'local-1-a' });
  assert.strictEqual(r.code, 201);
  assert.strictEqual(r.corps.dejaEnregistre, undefined);
  assert.strictEqual(supabase.dossiers.length, 1);
  assert.deepStrictEqual(supabase.audits, []);
});

test("POST /api/dossiers : le rejeu de la MÊME création (même local_id) renvoie le dossier, sans rien réunir ni journaliser", async () => {
  const { appeler, supabase } = routeCreationDossier();
  const corps = { numero_dossier: '1234', nom: 'Jean Baptiste', local_id: 'local-1-a' };
  const r1 = await appeler(corps);
  const r2 = await appeler(corps);
  assert.strictEqual(r2.code, 200);
  assert.strictEqual(r2.corps.id, r1.corps.id);
  assert.strictEqual(r2.corps.dejaEnregistre, undefined, "ce n'est pas une réunion de deux enregistrements : simple rejeu");
  assert.strictEqual(supabase.dossiers.length, 1);
  assert.deepStrictEqual(supabase.audits, []);
});

test("POST /api/dossiers : porte ET caisse créent le même patient (même numéro, même nom, local_id différents) → UN seul dossier, la 2e création renvoie le dossier existant", async () => {
  const { appeler, supabase } = routeCreationDossier();
  const porte = await appeler({ numero_dossier: '1234', nom: 'Jean Baptiste', local_id: 'local-porte-1' }, { id: 'uid-porte', email: 'porte@chf.com' });
  assert.strictEqual(porte.code, 201);
  const caisse = await appeler({ numero_dossier: '1234', nom: 'Jean Baptiste', local_id: 'local-caisse-1' });
  assert.strictEqual(caisse.code, 200, 'jamais un échec : sinon l\'épisode, la fiche et le paiement de la caisse seraient abandonnés en cascade');
  assert.strictEqual(caisse.corps.id, porte.corps.id, "l'app rattachera tout au dossier existant");
  assert.strictEqual(caisse.corps.dejaEnregistre, true);
  assert.strictEqual(supabase.dossiers.length, 1, 'aucun doublon');
  // Dans l'autre ordre de synchronisation, même résultat.
  const rejeu = await appeler({ numero_dossier: '1234', nom: 'Jean Baptiste', local_id: 'local-caisse-1' });
  assert.strictEqual(rejeu.code, 200);
  assert.strictEqual(rejeu.corps.id, porte.corps.id, 'le rejeu de la réponse perdue donne le même dossier');
  assert.strictEqual(supabase.dossiers.length, 1);
});

test("POST /api/dossiers : la réunion est consignée au journal (qui, quel numéro, quels noms, quel dossier) pour que la direction la voie", async () => {
  const { appeler, supabase } = routeCreationDossier({ dossiers: [{ id: 'd-existant', numero_dossier: '1234', nom: 'Jean Baptiste', nom_origine: 'Jean Baptiste', local_id: 'local-porte-1' }] });
  await appeler({ numero_dossier: '1234', nom: 'BAPTISTE Jean', local_id: 'local-caisse-1' });
  assert.strictEqual(supabase.audits.length, 1);
  const a = supabase.audits[0];
  assert.strictEqual(a.action, 'dossier_deja_enregistre');
  assert.strictEqual(a.effectue_par, 'caisse@chf.com');
  assert.strictEqual(a.effectue_par_uid, 'uid-caisse');
  assert.deepStrictEqual(a.details, { numero_dossier: '1234', nom_recu: 'BAPTISTE Jean', nom_existant: 'Jean Baptiste', dossier_id: 'd-existant' });
  assert.ok(a.id && a.date, 'identifiant et date renseignés');
});

test("POST /api/dossiers : accents, majuscules, ponctuation et ordre des mots ne font pas deux patients", async () => {
  for (const nomRecu of ['jean-baptiste marié', 'MARIÉ Jean Baptiste', 'Jean  Baptiste   Marie']) {
    const { appeler, supabase } = routeCreationDossier({ dossiers: [{ id: 'd1', numero_dossier: '77', nom: 'Jean Baptiste Marie', nom_origine: 'Jean Baptiste Marie' }] });
    const r = await appeler({ numero_dossier: '77', nom: nomRecu, local_id: 'local-x' });
    assert.strictEqual(r.code, 200, nomRecu);
    assert.strictEqual(r.corps.id, 'd1', nomRecu);
    assert.strictEqual(supabase.dossiers.length, 1, nomRecu);
  }
});

test("POST /api/dossiers : un bébé renommé reste le même patient pour qui arrive encore avec son nom d'origine", async () => {
  const { appeler, supabase } = routeCreationDossier({ dossiers: [{ id: 'd2', numero_dossier: '88', nom: 'Marie Louise Joseph', nom_origine: 'Bébé Marie Joseph' }] });
  const r = await appeler({ numero_dossier: '88', nom: 'Bébé Marie Joseph', local_id: 'local-y' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.corps.id, 'd2');
  assert.strictEqual(supabase.dossiers.length, 1);
});

test("POST /api/dossiers : même numéro mais nom DIFFÉRENT = vrai conflit (409), avec le nom du dossier en place pour corriger vite ; rien n'est réuni ni journalisé", async () => {
  for (const nomRecu of ['Jean Babtiste', 'Jean Baptiste Louis', 'Jeanne Baptiste', 'Pierre Joseph']) {
    const { appeler, supabase } = routeCreationDossier({ dossiers: [{ id: 'd1', numero_dossier: '1234', nom: 'Jean Baptiste', nom_origine: 'Jean Baptiste' }] });
    const r = await appeler({ numero_dossier: '1234', nom: nomRecu, local_id: 'local-z' });
    assert.strictEqual(r.code, 409, nomRecu);
    assert.match(r.corps.error, /Le numéro de dossier "1234" est déjà utilisé par un autre patient \(« Jean Baptiste »\)\./, nomRecu);
    assert.strictEqual(supabase.dossiers.length, 1, nomRecu);
    assert.deepStrictEqual(supabase.audits, [], nomRecu);
  }
});

test("POST /api/dossiers : un conflit que le numéro n'explique pas (autre contrainte) reste un 409 simple, sans nom inventé", async () => {
  const { appeler } = routeCreationDossier({ conflitSansDossier: true });
  const r = await appeler({ numero_dossier: '555', nom: 'Marie Joseph', local_id: 'local-q' });
  assert.strictEqual(r.code, 409);
  assert.strictEqual(r.corps.error, 'Le numéro de dossier "555" est déjà utilisé par un autre patient.');
});

test("POST /api/dossiers : un journal qui refuse la ligne (ou plante) n'empêche JAMAIS la caisse de continuer", async () => {
  for (const auditRefuse of ['refuse', 'jette']) {
    const { appeler, supabase, avertissements } = routeCreationDossier({ dossiers: [{ id: 'd1', numero_dossier: '1234', nom: 'Jean Baptiste' }], auditRefuse });
    const r = await appeler({ numero_dossier: '1234', nom: 'Jean Baptiste', local_id: 'local-w' });
    assert.strictEqual(r.code, 200, auditRefuse);
    assert.strictEqual(r.corps.dejaEnregistre, true, auditRefuse);
    assert.strictEqual(supabase.dossiers.length, 1, auditRefuse);
    assert.ok(avertissements.some(a => /non enregistré/.test(a)), `${auditRefuse} : l'échec du journal est signalé dans les journaux du serveur`);
  }
});

test("POST /api/dossiers : les contrôles d'avant restent en place (permission 403, nom et numéro requis 400)", async () => {
  const sans = routeCreationDossier({ permission: false });
  assert.strictEqual((await sans.appeler({ numero_dossier: '1', nom: 'X Y' })).code, 403);
  const { appeler, supabase } = routeCreationDossier();
  assert.strictEqual((await appeler({ numero_dossier: '1' })).code, 400);
  assert.strictEqual((await appeler({ nom: 'Jean Baptiste' })).code, 400);
  assert.strictEqual(supabase.dossiers.length, 0);
});

// ---------------------------------------------------------------------------------------------------------
// Câblage
// ---------------------------------------------------------------------------------------------------------
test("server.js : la réunion n'a lieu qu'à la CRÉATION, après le contrôle du local_id — jamais quand on CHANGE le numéro d'un dossier existant (PUT)", () => {
  const post = serverSrc.slice(serverSrc.indexOf("app.post('/api/dossiers', async (req, res) => {"), serverSrc.indexOf("app.get('/api/dossiers/:id'"));
  const iLocal = post.indexOf(".eq('local_id', local_id).maybeSingle();\n        if (existant) return res.status(200).json(existant);");
  const iNumero = post.indexOf(".eq('numero_dossier', numero_dossier).maybeSingle()");
  const iMeme = post.indexOf('memePatient(memeNumero, nom)');
  const iAudit = post.indexOf("action: 'dossier_deja_enregistre'");
  const iReponse = post.indexOf('dejaEnregistre: true');
  const i409 = post.indexOf('return res.status(409)');
  assert.ok(iLocal > 0 && iNumero > iLocal && iMeme > iNumero && iAudit > iMeme && iReponse > iAudit && i409 > iReponse, "ordre : local_id, numéro, même patient, journal, réponse 200, sinon 409");
  assert.match(post, /if \(error\.code === '23505'\) \{/);
  const put = serverSrc.slice(serverSrc.indexOf("app.put('/api/dossiers/:id'"), serverSrc.indexOf("app.get('/api/dossiers/:id/historique'"));
  assert.doesNotMatch(put, /memePatient|dejaEnregistre/, "changer le numéro d'un dossier vers un numéro déjà pris reste un conflit : jamais de réunion silencieuse");
});
