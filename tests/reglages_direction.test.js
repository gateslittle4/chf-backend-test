// tests/reglages_direction.test.js — réglages de la direction relus par le serveur (28/10, Esdras) : plafond de dette par épisode, % d'exonération de la caisse, heures de fin de poste.
const { test } = require('node:test');
const assert = require('node:assert');
const reg = require('../utils/reglagesDirection');
const { soldeAjouteParPaiement } = require('../utils/paiementPartiel');

const src = require('./serveurSource').lireServeur();
const debut = src.indexOf('  // 28/10 : plafond de dette par épisode réglé par la direction');
const finBloc = src.indexOf('  {\n    const ajout = corps.mode === ', debut);
assert.ok(debut > 0 && finBloc > debut, 'bloc du plafond introuvable');
const bloc = src.slice(debut, finBloc);

// Exécute le bloc du plafond de crédit de POST /api/paiements ; renvoie { code, corps } si refusé, { passe: true } sinon.
async function appeler({ corps, droits = ['caisse_travailler'], rejeu = false, reglages = {}, dernierSolde = 0, erreurSolde = null }) {
  const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
  const requete = { select: () => requete, eq: () => requete, or: () => requete, is: () => requete, order: () => requete, limit: () => requete, maybeSingle: async () => ({ data: dernierSolde === null ? null : { solde_restant: dernierSolde }, error: erreurSolde }) };
  const supabase = { from: () => requete };
  const f = new (Object.getPrototypeOf(async function () {}).constructor)('req', 'res', 'corps', 'estRejeu', 'aPermission', 'supabase', 'lireReglagesDirection', 'plafondCredit', 'messagePlafondCredit', 'soldeAjouteParPaiement', `${bloc}\nreturn { passe: true };`);
  const r = await f({ user: { id: 'u1' } }, res, corps, () => rejeu, async (_u, cle) => droits.includes(cle), supabase, async () => reglages, reg.plafondCredit, reg.messagePlafondCredit, soldeAjouteParPaiement);
  return r && r.passe ? { passe: true } : res;
}
const CREDIT = (solde) => ({ mode: 'credit', episode_id: 'e1', montant: 0, solde_restant: solde });
const PARTIEL = (reste) => ({ mode: 'cash', episode_id: 'e1', montant: 100, solde_restant: reste, details: { paiement_partiel: true, reste, montant_paye: 100, total_fiche: 100 + reste } });

test("sans réglage (0 = pas de limite), rien n'est refusé : comportement d'avant", async () => {
  assert.strictEqual((await appeler({ corps: CREDIT(900000) })).passe, true);
  assert.strictEqual(reg.plafondCredit({}), 0);
  assert.strictEqual(reg.plafondCredit({ plafondCreditEpisode: 'abc' }), 0);
  assert.strictEqual(reg.plafondCredit({ plafondCreditEpisode: -5 }), 0);
});

test("plafond réglé : un crédit ou un paiement partiel qui ferait dépasser la dette de l'épisode est refusé (400 PLAFOND_CREDIT_DEPASSE) ; pile au plafond passe ; la dette déjà portée compte", async () => {
  const r = { plafondCreditEpisode: 5000 };
  assert.strictEqual((await appeler({ corps: CREDIT(5000), reglages: r })).passe, true, 'pile au plafond');
  const refus = await appeler({ corps: CREDIT(5001), reglages: r });
  assert.strictEqual(refus.code, 400);
  assert.strictEqual(refus.corps.code, 'PLAFOND_CREDIT_DEPASSE');
  assert.deepStrictEqual([refus.corps.plafond, refus.corps.dette], [5000, 5001]);
  assert.match(refus.corps.error, /5001 Gdes.*5000 Gdes/);
  assert.strictEqual((await appeler({ corps: PARTIEL(3000), reglages: r, dernierSolde: 2000 })).passe, true, '2000 déjà dus + 3000 = 5000');
  assert.strictEqual((await appeler({ corps: PARTIEL(3000), reglages: r, dernierSolde: 2500 })).code, 400, '2500 déjà dus + 3000 > 5000');
  assert.strictEqual((await appeler({ corps: CREDIT(100), reglages: r, dernierSolde: null })).passe, true, 'épisode sans paiement : dette 0');
});

test("jamais refusé : la direction, un rejeu hors ligne, un paiement qui ne crée pas de dette, un remboursement de crédit, un paiement sans épisode", async () => {
  const r = { plafondCreditEpisode: 1000 };
  assert.strictEqual((await appeler({ corps: CREDIT(9000), reglages: r, droits: ['caisse_travailler', 'demandes_repondre'] })).passe, true, 'direction');
  assert.strictEqual((await appeler({ corps: CREDIT(9000), reglages: r, rejeu: true })).passe, true, 'rejeu hors ligne');
  assert.strictEqual((await appeler({ corps: { mode: 'cash', episode_id: 'e1', montant: 9000, solde_restant: 0 }, reglages: r, dernierSolde: 800 })).passe, true, 'comptant intégral');
  assert.strictEqual((await appeler({ corps: { mode: 'remboursement_credit', episode_id: 'e1', montant: 500 }, reglages: r, dernierSolde: 3000 })).passe, true, 'remboursement');
  assert.strictEqual((await appeler({ corps: { mode: 'credit', montant: 0, solde_restant: 9000 }, reglages: r })).passe, true, 'sans épisode');
});

test("réglages illisibles ou erreur de lecture du solde : jamais un blocage silencieux (réglage invalide = pas de limite ; erreur de base = 500 explicite)", async () => {
  assert.strictEqual((await appeler({ corps: CREDIT(9000), reglages: { plafondCreditEpisode: 'x' } })).passe, true);
  const panne = await appeler({ corps: CREDIT(900), reglages: { plafondCreditEpisode: 500 }, erreurSolde: { message: 'base indisponible' } });
  assert.strictEqual(panne.code, 500);
});

test("exonération de la caisse et heures de poste : valeurs d'origine, bornes", () => {
  assert.strictEqual(reg.exonerationMaxCaisse({}), 100);
  assert.strictEqual(reg.exonerationMaxCaisse({ exonerationPourcentageMaxCaisse: 30 }), 30);
  for (const mauvais of [101, -1, 'x', null]) assert.strictEqual(reg.exonerationMaxCaisse({ exonerationPourcentageMaxCaisse: mauvais }), 100, String(mauvais));
  assert.deepStrictEqual(reg.DEFAUTS, { exonerationPourcentageMaxCaisse: 100, plafondCreditEpisode: 0, heureFinPosteJour: 16, heureFinPosteNuit: 8 });
});
