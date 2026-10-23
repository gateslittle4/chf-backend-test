// tests/dossier_meme_patient.test.js — « quand le net est tombé, il n'y aura plus de connexion entre les deux
// ordinateurs » (Esdras, 09/10). La porte et la caisse peuvent créer, chacune hors ligne, le dossier du MÊME patient avec
// le MÊME numéro. Au retour d'internet, le 2e dossier envoyé était refusé (numéro déjà pris) et l'épisode, la fiche et le
// PAIEMENT de la caisse qui en dépendent étaient abandonnés avec lui. Maintenant : même numéro ET même nom = même patient,
// le serveur ne réunit JAMAIS tout seul (13/10, Esdras) : il refuse (409 PATIENT_DEJA_ENREGISTRE) en renvoyant le dossier en place, et l'app demande
// à une personne ; avec `reunir: true` (confirmé) il renvoie le dossier existant (200). Un nom différent reste un vrai conflit (409).
// Ces tests EXÉCUTENT la vraie route POST /api/dossiers (extraite de server.js) contre un faux Supabase.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { jetonsDuNom, memePatient } = require('../utils/dossiers');

const serverSrc = require('./serveurSource').lireServeur();

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
function fauxSupabase({ dossiers = [], auditRefuse = null, conflitSansDossier = false, colonnesAbsentes = [] } = {}) {
  const audits = [];
  return {
    dossiers, audits,
    from(table) {
      if (table === 'dossiers') return {
        insert: (ligne) => ({ select: () => ({ single: async () => {
          if (colonnesAbsentes.some(c => c in ligne)) return { data: null, error: { code: '42703', message: 'column does not exist' } };
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
  // `sansCaisse` : un rôle qui a le droit de créer un dossier mais PAS celui de la caisse (infirmier, archiviste) — il ne peut pas donner de numéro (16/10).
  const aPermission = async (_uid, cle) => options.permission !== false && !(options.sansCaisse && cle === 'caisse_travailler');
  const avertissements = [];
  const console_ = { warn: (...a) => avertissements.push(a.join(' ')), log() {}, error() {} };
  new Function('app', 'supabase', 'aPermission', 'dateOuNull', 'memePatient', 'formaterNomPropre', 'crypto', 'console', 'verifierMere', 'erreurIdentiteDossier', 'numeroProvisoire', 'erreurNumeroDossier', serverSrc.slice(debut, fin))(
    app, supabase, aPermission, (v) => (v ? v : null), memePatient, require('../utils/dossiers').formaterNomPropre, crypto, console_, require('../utils/naissance').verifierMere, require('../utils/dossiers').erreurIdentiteDossier, require('../utils/numeroDossier').numeroProvisoire, require('../utils/numeroDossier').erreurNumeroDossier);
  const appeler = async (corps, utilisateur = { id: 'uid-caisse', email: 'caisse@chf.com' }) => {
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    // 15/10 : sexe et date de naissance sont obligatoires à la création ; ces tests parlent d'AUTRE chose (doublons, réunion…), donc ils en reçoivent par défaut.
    await gestionnaire({ body: { sexe: 'F', date_naissance: '1990-05-05', ...corps }, user: utilisateur }, res);
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

test("POST /api/dossiers : porte ET caisse créent le même patient → la 2e création est REFUSÉE tant que personne n'a confirmé (rien n'est réuni tout seul)", async () => {
  const { appeler, supabase } = routeCreationDossier();
  const porte = await appeler({ numero_dossier: '1234', nom: 'Jean Baptiste', local_id: 'local-porte-1' }, { id: 'uid-porte', email: 'porte@chf.com' });
  assert.strictEqual(porte.code, 201);
  const caisse = await appeler({ numero_dossier: '1234', nom: 'Jean Baptiste', local_id: 'local-caisse-1' });
  assert.strictEqual(caisse.code, 409);
  assert.strictEqual(caisse.corps.error, 'PATIENT_DEJA_ENREGISTRE');
  assert.match(caisse.corps.message, /Le dossier N° 1234 existe déjà au nom de « Jean Baptiste »\. Est-ce la même personne \?/);
  assert.deepStrictEqual(caisse.corps.dossierExistant, { id: porte.corps.id, numero_dossier: '1234', nom: 'Jean Baptiste', date_naissance: '1990-05-05', telephone: null }, "l'app montre ce dossier à la personne qui décide");
  assert.strictEqual(caisse.corps.dejaEnregistre, undefined);
  assert.strictEqual(supabase.dossiers.length, 1, 'aucun doublon, aucune réunion');
  assert.deepStrictEqual(supabase.audits, [], 'rien n\'est journalisé tant que personne n\'a confirmé');
});

test("POST /api/dossiers : après CONFIRMATION (reunir: true) la 2e création renvoie le dossier existant — l'épisode, la fiche et le paiement de la caisse peuvent suivre", async () => {
  const { appeler, supabase } = routeCreationDossier();
  const porte = await appeler({ numero_dossier: '1234', nom: 'Jean Baptiste', local_id: 'local-porte-1' }, { id: 'uid-porte', email: 'porte@chf.com' });
  const caisse = await appeler({ numero_dossier: '1234', nom: 'Jean Baptiste', local_id: 'local-caisse-1', reunir: true });
  assert.strictEqual(caisse.code, 200);
  assert.strictEqual(caisse.corps.id, porte.corps.id, "l'app rattachera tout au dossier existant");
  assert.strictEqual(caisse.corps.dejaEnregistre, true);
  assert.strictEqual(supabase.dossiers.length, 1, 'aucun doublon');
  // `reunir` ne sert qu'à CONFIRMER : un autre nom reste refusé même avec reunir: true.
  const autre = await appeler({ numero_dossier: '1234', nom: 'Pierre Joseph', local_id: 'local-caisse-2', reunir: true });
  assert.strictEqual(autre.code, 409);
  assert.notStrictEqual(autre.corps.error, 'PATIENT_DEJA_ENREGISTRE');
  assert.strictEqual(supabase.dossiers.length, 1);
  // Seul `true` confirme : pas une chaîne, pas 1.
  for (const faux of ['true', 1, 'oui']) {
    const r = await appeler({ numero_dossier: '1234', nom: 'Jean Baptiste', local_id: 'local-c-' + faux, reunir: faux });
    assert.strictEqual(r.code, 409, JSON.stringify(faux));
  }
});

test("POST /api/dossiers : la réunion CONFIRMÉE est consignée au journal (qui, quel numéro, quels noms, quel dossier) pour que la direction la voie", async () => {
  const { appeler, supabase } = routeCreationDossier({ dossiers: [{ id: 'd-existant', numero_dossier: '1234', nom: 'Jean Baptiste', nom_origine: 'Jean Baptiste', local_id: 'local-porte-1' }] });
  await appeler({ numero_dossier: '1234', nom: 'BAPTISTE Jean', local_id: 'local-caisse-1', reunir: true });
  assert.strictEqual(supabase.audits.length, 1);
  const a = supabase.audits[0];
  assert.strictEqual(a.action, 'dossier_deja_enregistre');
  assert.strictEqual(a.effectue_par, 'caisse@chf.com');
  assert.strictEqual(a.effectue_par_uid, 'uid-caisse');
  assert.deepStrictEqual(a.details, { numero_dossier: '1234', nom_recu: 'BAPTISTE Jean', nom_existant: 'Jean Baptiste', dossier_id: 'd-existant', confirme: true });
  assert.ok(a.id && a.date, 'identifiant et date renseignés');
});

test("POST /api/dossiers : accents, majuscules, ponctuation et ordre des mots : reconnu comme le même patient (à confirmer)", async () => {
  for (const nomRecu of ['jean-baptiste marié', 'MARIÉ Jean Baptiste', 'Jean  Baptiste   Marie']) {
    const { appeler, supabase } = routeCreationDossier({ dossiers: [{ id: 'd1', numero_dossier: '77', nom: 'Jean Baptiste Marie', nom_origine: 'Jean Baptiste Marie' }] });
    const demande = await appeler({ numero_dossier: '77', nom: nomRecu, local_id: 'local-x' });
    assert.strictEqual(demande.code, 409, nomRecu);
    assert.strictEqual(demande.corps.error, 'PATIENT_DEJA_ENREGISTRE', nomRecu);
    const r = await appeler({ numero_dossier: '77', nom: nomRecu, local_id: 'local-x', reunir: true });
    assert.strictEqual(r.code, 200, nomRecu);
    assert.strictEqual(r.corps.id, 'd1', nomRecu);
    assert.strictEqual(supabase.dossiers.length, 1, nomRecu);
  }
});

test("POST /api/dossiers : un bébé renommé reste le même patient pour qui arrive encore avec son nom d'origine", async () => {
  const { appeler, supabase } = routeCreationDossier({ dossiers: [{ id: 'd2', numero_dossier: '88', nom: 'Marie Louise Joseph', nom_origine: 'Bébé Marie Joseph' }] });
  const r = await appeler({ numero_dossier: '88', nom: 'Bébé Marie Joseph', local_id: 'local-y', reunir: true });
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
    const r = await appeler({ numero_dossier: '1234', nom: 'Jean Baptiste', local_id: 'local-w', reunir: true });
    assert.strictEqual(r.code, 200, auditRefuse);
    assert.strictEqual(r.corps.dejaEnregistre, true, auditRefuse);
    assert.strictEqual(supabase.dossiers.length, 1, auditRefuse);
    assert.ok(avertissements.some(a => /non enregistré/.test(a)), `${auditRefuse} : l'échec du journal est signalé dans les journaux du serveur`);
  }
});

test("POST /api/dossiers : les contrôles d'avant restent en place (permission 403, nom requis 400) ; sans numéro, le dossier est créé « en attente » (16/10)", async () => {
  const sans = routeCreationDossier({ permission: false });
  assert.strictEqual((await sans.appeler({ numero_dossier: '1', nom: 'X Y' })).code, 403);
  const { appeler, supabase } = routeCreationDossier();
  assert.strictEqual((await appeler({ numero_dossier: '1' })).code, 400);
  assert.strictEqual(supabase.dossiers.length, 0);
  const attente = await appeler({ nom: 'Jean Baptiste' });
  assert.strictEqual(attente.code, 201);
  assert.match(attente.corps.numero_dossier, /^EN-ATTENTE-[0-9A-F]{10}$/, 'numéro provisoire, la caisse le remplacera');
  assert.strictEqual(supabase.dossiers.length, 1);
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
  const iDemande = post.indexOf("error: 'PATIENT_DEJA_ENREGISTRE'");
  const iConfirme = post.indexOf('req.body.reunir !== true');
  const i409 = post.indexOf('return res.status(409).json({ error: `Le numéro de dossier');
  assert.ok(iLocal > 0 && iNumero > iLocal && iMeme > iNumero && iConfirme > iMeme && iDemande > iConfirme && iAudit > iDemande && iReponse > iAudit && i409 > iReponse, "ordre : local_id, numéro, même patient, confirmation (sinon 409 à confirmer), journal, réponse 200, sinon 409");
  assert.match(post, /if \(error\.code === '23505'\) \{/);
  const put = serverSrc.slice(serverSrc.indexOf("app.put('/api/dossiers/:id'"), serverSrc.indexOf("app.get('/api/dossiers/:id/historique'"));
  assert.doesNotMatch(put, /memePatient|dejaEnregistre/, "changer le numéro d'un dossier vers un numéro déjà pris reste un conflit : jamais de réunion silencieuse");
});

test("POST /api/dossiers : sexe (M ou F) et date de naissance sont OBLIGATOIRES à la création (400, rien créé) ; un sexe invalide est refusé — le numéro, lui, ne l'est plus (16/10)", async () => {
  const { appeler, supabase } = routeCreationDossier();
  const f = await appeler({ numero_dossier: '1', nom: 'Marie Joseph', sexe: 'F', date_naissance: '1990-05-17', local_id: 'l-1' });
  assert.strictEqual(f.code, 201);
  assert.strictEqual(supabase.dossiers[0].sexe, 'F');
  const m = await appeler({ numero_dossier: '2', nom: 'Jean Paul', sexe: 'M', local_id: 'l-2' });
  assert.strictEqual(supabase.dossiers[1].sexe, 'M');
  const base = { numero_dossier: '9', nom: 'Incomplet', local_id: 'l-9' };
  const refus = [
    [{ sexe: '' }, /sexe est obligatoire/], [{ sexe: null }, /sexe est obligatoire/], [{ sexe: 'X' }, /sexe est obligatoire/], [{ sexe: 'f' }, /sexe est obligatoire/], [{ sexe: 1 }, /sexe est obligatoire/],
    [{ date_naissance: '' }, /date de naissance est obligatoire/], [{ date_naissance: null }, /date de naissance est obligatoire/],
    [{ date_naissance: '31/02/1990' }, /pas valide/], [{ date_naissance: '1990-02-31' }, /pas valide/], [{ date_naissance: '1850-01-01' }, /pas valide/], [{ date_naissance: '2999-01-01' }, /pas valide/],
  ];
  for (const [champs, motif] of refus) {
    const r = await appeler({ ...base, ...champs });
    assert.strictEqual(r.code, 400, JSON.stringify(champs));
    assert.match(r.corps.error, motif, JSON.stringify(champs));
    assert.strictEqual(r.corps.code, 'IDENTITE_INCOMPLETE');
  }
  assert.strictEqual(supabase.dossiers.length, 2, 'aucun dossier créé par une identité incomplète');
});

test("POST /api/dossiers : le rejeu d'un dossier DÉJÀ créé (même local_id) est renvoyé tel quel, même s'il avait été créé avant la règle", async () => {
  const { appeler, supabase } = routeCreationDossier();
  supabase.dossiers.push({ id: 'd-vieux', numero_dossier: '55', nom: 'Ancien', local_id: 'l-vieux', sexe: null, date_naissance: null });
  const r = await appeler({ numero_dossier: '55', nom: 'Ancien', local_id: 'l-vieux', sexe: '', date_naissance: '' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.corps.id, 'd-vieux');
});

test("POST /api/dossiers : colonne sexe absente de la base (script SQL pas collé) → le dossier est quand même créé, sans le sexe ; si seul nom_origine manque, le sexe est GARDÉ", async () => {
  const sansSexe = routeCreationDossier({ colonnesAbsentes: ['sexe'] });
  const r1 = await sansSexe.appeler({ numero_dossier: '1', nom: 'Marie', sexe: 'F', local_id: 'a' });
  assert.strictEqual(r1.code, 201);
  assert.strictEqual('sexe' in sansSexe.supabase.dossiers[0], false);
  const sansOrigine = routeCreationDossier({ colonnesAbsentes: ['nom_origine'] });
  const r2 = await sansOrigine.appeler({ numero_dossier: '2', nom: 'Marie', sexe: 'F', local_id: 'b' });
  assert.strictEqual(r2.code, 201);
  assert.strictEqual(sansOrigine.supabase.dossiers[0].sexe, 'F', 'le sexe n\'est pas perdu parce qu\'une AUTRE colonne manque');
});

test("POST /api/dossiers : un nouveau-né est lié à sa mère (mere_dossier_id) ; mère introuvable, homme ou sans la colonne → refus clair, aucun bébé créé", async () => {
  const mere = { id: 'mere-1', numero_dossier: 'M-1', nom: 'Marie Joseph', sexe: 'F' };
  const homme = { id: 'homme-1', numero_dossier: 'H-1', nom: 'Paul', sexe: 'M' };
  const { appeler, supabase } = routeCreationDossier({ dossiers: [mere, homme] });
  const ok = await appeler({ numero_dossier: 'B-1', nom: 'Bébé Marie Joseph', sexe: 'M', mere_dossier_id: 'mere-1', local_id: 'l-b1' });
  assert.strictEqual(ok.code, 201);
  assert.strictEqual(supabase.dossiers.find(d => d.numero_dossier === 'B-1').mere_dossier_id, 'mere-1');
  assert.strictEqual((await appeler({ numero_dossier: 'B-2', nom: 'Bébé X', mere_dossier_id: 'inconnue', local_id: 'l-b2' })).code, 404);
  const refusHomme = await appeler({ numero_dossier: 'B-3', nom: 'Bébé Y', mere_dossier_id: 'homme-1', local_id: 'l-b3' });
  assert.strictEqual(refusHomme.code, 400);
  assert.match(refusHomme.corps.error, /mère doit être une femme/);
  assert.strictEqual(supabase.dossiers.filter(d => /^B-/.test(d.numero_dossier)).length, 1, 'aucun bébé créé par un refus');
});

// --- Noms de personnes : majuscule au début de chaque mot, aussi côté serveur (14/10, demande d'Esdras)
test("formaterNomPropre (serveur) : même règle que l'application — majuscule à chaque mot, accents, tirets, apostrophes ; vide/absent -> ''", () => {
  const { formaterNomPropre } = require('../utils/dossiers');
  const cas = [['marie exemple', 'Marie Exemple'], ['JEAN PIERRE', 'Jean Pierre'], ['  jean   baptiste ', 'Jean Baptiste'], ['élodie ève', 'Élodie Ève'],
    ['marie-ève', 'Marie-Ève'], ["o'neil", "O'Neil"], ['', ''], [null, ''], [undefined, '']];
  for (const [entree, attendu] of cas) assert.strictEqual(formaterNomPropre(entree), attendu, String(entree));
});

test("Le serveur enregistre le nom avec des majuscules même si le navigateur a envoyé des minuscules (POST /api/dossiers, PUT /api/dossiers/:id, PUT /api/episodes/:id, POST /api/episodes)", () => {
  const src = serverSrc;
  assert.match(src, /const nom = formaterNomPropre\(nomSaisi\); \/\/ majuscule au début de chaque mot/);
  assert.match(src, /conjoint = typeof conjointSaisi === 'string' \? formaterNomPropre\(conjointSaisi\) : conjointSaisi/);
  assert.match(src, /nom: formaterNomPropre\(d\.nom_patient\), date_naissance/);
  assert.match(src, /update\(\{ nom: formaterNomPropre\(d\.nom_patient\) \}\)/);
});

test("POST /api/dossiers : un nom tapé en minuscules est enregistré avec des majuscules (nom et nom d'origine) ; en majuscules aussi", async () => {
  const { appeler, supabase } = routeCreationDossier();
  const r = await appeler({ numero_dossier: '2001', nom: 'marie-ève jean baptiste', local_id: 'local-maj-1' });
  assert.strictEqual(r.code, 201);
  assert.strictEqual(supabase.dossiers[0].nom, 'Marie-Ève Jean Baptiste');
  assert.strictEqual(supabase.dossiers[0].nom_origine, 'Marie-Ève Jean Baptiste');
  const r2 = await appeler({ numero_dossier: '2002', nom: 'PAUL EXEMPLE', local_id: 'local-maj-2' });
  assert.strictEqual(r2.code, 201);
  assert.strictEqual(supabase.dossiers[1].nom, 'Paul Exemple');
});
