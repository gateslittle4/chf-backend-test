// tests/exoneration_par_la_caisse.test.js — la caisse peut accorder une exonération (22/10, Esdras) : motif obligatoire, tracée au journal d'audit.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = require('./serveurSource').lireServeur();
const d = src.indexOf("app.post('/api/paiements', async (req, res) => {");
const debutCorps = src.indexOf('\n', d) + 1;
const fin = src.indexOf('  const local_id = req.body.local_id || req.body.localId;', d);
assert.ok(d > 0 && fin > d, 'route introuvable');
const garde = src.slice(debutCorps, fin);

// Exécute uniquement les contrôles d'entrée de POST /api/paiements ; renvoie { code, corps } ou { passe: true, auditExoneration }.
async function appeler({ droits, corps, rejeu = false, reglages = {} }) {
  const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
  const f = new (Object.getPrototypeOf(async function () {}).constructor)('req', 'res', 'aPermission', 'estRejeu', 'enregistrerAuditServeur', 'supabase', 'lireReglagesDirection', 'exonerationMaxCaisse', 'messageExonerationTropElevee', `${garde}\nreturn { passe: true, auditExoneration };`);
  const reg = require('../utils/reglagesDirection');
  const r = await f({ user: { id: 'u1' }, body: corps, headers: {} }, res, async (_u, cle) => droits.includes(cle), () => rejeu, () => {}, null, async () => reglages, reg.exonerationMaxCaisse, reg.messageExonerationTropElevee);
  return r && r.passe ? { passe: true, auditExoneration: r.auditExoneration } : res;
}
const EXO = (motif) => ({ mode: 'exoneration', montant: 0, fiche_id: 'f1', episode_id: 'e1', patient_nom: 'Marie', exoneration: { pourcentage: 100, montantExonere: 5000, motif } });

test('direction (demandes_repondre) : accorde comme avant, sans motif obligatoire ni ligne « par la caisse »', async () => {
  const r = await appeler({ droits: ['caisse_travailler', 'demandes_repondre'], corps: EXO('') });
  assert.strictEqual(r.passe, true);
  assert.strictEqual(r.auditExoneration, null);
});

test('caisse avec exoneration_accorder : accorde, avec motif ; l\'audit est préparé (écrit après l\'enregistrement du paiement)', async () => {
  const r = await appeler({ droits: ['caisse_travailler', 'exoneration_accorder'], corps: EXO('  Patient indigent, accord oral du directeur  ') });
  assert.strictEqual(r.passe, true);
  assert.deepStrictEqual(r.auditExoneration, { fiche_id: 'f1', episode_id: 'e1', patient: 'Marie', montant_exonere: 5000, pourcentage: 100, motif: 'Patient indigent, accord oral du directeur', rejeu: false });
});

test('caisse : sans motif → 400 MOTIF_EXONERATION_REQUIS, rien n\'est enregistré', async () => {
  for (const motif of [undefined, '', '  ', 'ok']) {
    const r = await appeler({ droits: ['caisse_travailler', 'exoneration_accorder'], corps: EXO(motif) });
    assert.strictEqual(r.passe, undefined);
    assert.strictEqual(r.code, 400);
    assert.strictEqual(r.corps.code, 'MOTIF_EXONERATION_REQUIS');
  }
});

test('caisse : un rejeu de la file hors ligne n\'est jamais refusé (motif ou pas) — il est tracé avec rejeu = true', async () => {
  const r = await appeler({ droits: ['caisse_travailler', 'exoneration_accorder'], corps: EXO(''), rejeu: true });
  assert.strictEqual(r.passe, true);
  assert.strictEqual(r.auditExoneration.rejeu, true);
});

test('caisse SANS exoneration_accorder (droit retiré dans Rôles & permissions) : 403, comme avant', async () => {
  const r = await appeler({ droits: ['caisse_travailler'], corps: EXO('motif valable') });
  assert.strictEqual(r.code, 403);
  assert.strictEqual(r.corps.code, 'EXONERATION_NON_AUTORISEE');
});

test('les autres modes de paiement ne sont pas concernés', async () => {
  const r = await appeler({ droits: ['caisse_travailler'], corps: { mode: 'cash', montant: 100 } });
  assert.strictEqual(r.passe, true);
  assert.strictEqual(r.auditExoneration, null);
});

test('l\'audit « exoneration_accordee_caisse » n\'est écrit qu\'APRÈS l\'enregistrement du paiement (deux chemins de succès)', () => {
  const route = src.slice(d, src.indexOf("app.get('/api/depenses-caisse'", d));
  assert.strictEqual((route.match(/enregistrerAuditServeur\(req, 'exoneration_accordee_caisse', auditExoneration\)/g) || []).length, 2);
  assert.ok(route.indexOf("enregistrerAuditServeur(req, 'exoneration_accordee_caisse'") > route.indexOf('enregistrer_paiement_atomique'));
});

test('la caisse (comptable, pharmacien, pharmacien en chef) a le droit par défaut ; la direction l\'a via demandes_repondre', () => {
  const bloc = src.slice(src.indexOf('const PERMISSIONS_PAR_DEFAUT'), src.indexOf('async function aPermission'));
  for (const role of ['comptable', 'pharmacien', 'pharmacien_chef']) {
    const ligne = bloc.slice(bloc.indexOf(`{ role: '${role}'`), bloc.indexOf('\n', bloc.indexOf(`{ role: '${role}'`)));
    assert.match(ligne, /'exoneration_accorder'/, role);
  }
});

test("28/10 : plafond du % d'exonération de la CAISSE réglé par la direction (exonerationPourcentageMaxCaisse) — la direction n'est jamais limitée, un rejeu hors ligne n'est jamais refusé, sans réglage : 100 %", async () => {
  const exo = (pourcentage) => ({ ...EXO('motif valable'), exoneration: { pourcentage, montantExonere: 500, motif: 'motif valable' } });
  const caisse = ['caisse_travailler', 'exoneration_accorder'];
  assert.strictEqual((await appeler({ droits: caisse, corps: exo(100) })).passe, true, 'sans réglage : tout reste permis');
  const r = await appeler({ droits: caisse, corps: exo(60), reglages: { exonerationPourcentageMaxCaisse: 50 } });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(r.corps.code, 'POURCENTAGE_EXONERATION_TROP_ELEVE');
  assert.strictEqual(r.corps.max, 50);
  assert.match(r.corps.error, /50 %.*60 %/);
  assert.strictEqual((await appeler({ droits: caisse, corps: exo(50), reglages: { exonerationPourcentageMaxCaisse: 50 } })).passe, true, 'pile au plafond : accepté');
  assert.strictEqual((await appeler({ droits: [...caisse, 'demandes_repondre'], corps: exo(100), reglages: { exonerationPourcentageMaxCaisse: 50 } })).passe, true, 'la direction passe toujours');
  assert.strictEqual((await appeler({ droits: caisse, corps: exo(100), reglages: { exonerationPourcentageMaxCaisse: 50 }, rejeu: true })).passe, true, 'rejeu hors ligne : jamais refusé');
  assert.strictEqual((await appeler({ droits: caisse, corps: exo(100), reglages: { exonerationPourcentageMaxCaisse: 'n importe quoi' } })).passe, true, 'réglage invalide : 100 %');
  assert.strictEqual((await appeler({ droits: caisse, corps: exo(1), reglages: { exonerationPourcentageMaxCaisse: 0 } })).code, 400, '0 % : la caisse ne peut plus rien accorder, la direction seule');
});
