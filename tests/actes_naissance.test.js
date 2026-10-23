// tests/actes_naissance.test.js — un seul acte de naissance par épisode (19/10).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { estActeNaissance, compterActesNaissance, conflitActeNaissance, motifDerogationValide } = require('../utils/actesNaissance');

const acte = (nom, sub, qte = 1) => ({ type: 'acte', nom, sub, qte });
const fiche = (...lignes) => ({ raw_state: { lignesCalcul: lignes } });

test('actes de naissance : rubriques Accouchement et Césarienne, plus toute délivrance ; jamais un médicament ni un autre acte', () => {
  assert.ok(estActeNaissance(acte('Accouchement Physiologique', 'accouchement')));
  assert.ok(estActeNaissance(acte('Accouchement Gémellaire', 'accouchement')));
  assert.ok(estActeNaissance(acte('Césarienne UC2', 'cesarienne')));
  assert.ok(estActeNaissance(acte('Délivrance Placentaire Artificielle', 'chirurgie')));
  assert.ok(estActeNaissance(acte('Délivrance', 'accouchement')));
  assert.ok(estActeNaissance(acte('delivrance', undefined)));
  assert.ok(!estActeNaissance(acte('Consultation Générale', 'service')));
  assert.ok(!estActeNaissance(acte('Curettage avec anesthésie', 'curetage')));
  assert.ok(!estActeNaissance({ type: 'med', nom: 'Ocytocine délivrance', sub: '', qte: 1 }));
  assert.ok(!estActeNaissance(null));
});

test('le conflit : deux accouchements, deux césariennes, accouchement + césarienne, quantité 2, délivrance + accouchement', () => {
  const nouvelle = (...l) => conflitActeNaissance({ lignesNouvelles: l });
  assert.strictEqual(nouvelle(acte('Accouchement Physiologique', 'accouchement')).conflit, false, 'un seul : permis');
  assert.strictEqual(nouvelle(acte('Accouchement Physiologique', 'accouchement'), acte('Accouchement Gémellaire', 'accouchement')).conflit, true);
  assert.strictEqual(nouvelle(acte('Césarienne Simple', 'cesarienne'), acte('Césarienne UC2', 'cesarienne')).conflit, true);
  assert.strictEqual(nouvelle(acte('Accouchement Physiologique', 'accouchement'), acte('Césarienne Simple', 'cesarienne')).conflit, true);
  assert.strictEqual(nouvelle(acte('Césarienne Simple', 'cesarienne', 2)).conflit, true, 'quantité 2');
  assert.strictEqual(nouvelle(acte('Accouchement Physiologique', 'accouchement'), acte('Délivrance Placentaire Artificielle', 'chirurgie')).conflit, true, 'aucune exemption pour la délivrance');
});

test('les fiches déjà enregistrées de l\'épisode comptent ; un autre acte (consultation, labo) ne gêne jamais', () => {
  const avant = [fiche(acte('Accouchement Physiologique', 'accouchement'), acte('Consultation Générale', 'service'))];
  const v = conflitActeNaissance({ fichesExistantes: avant, lignesNouvelles: [acte('Césarienne Simple', 'cesarienne')] });
  assert.strictEqual(v.conflit, true); assert.strictEqual(v.deja, 1); assert.match(v.message, /déjà un acte de naissance/);
  assert.strictEqual(conflitActeNaissance({ fichesExistantes: avant, lignesNouvelles: [acte('Hemogramme', 'labo'), acte('Pansement simple', 'pansement')] }).conflit, false);
  assert.strictEqual(conflitActeNaissance({ fichesExistantes: [{ rawState: { lignesCalcul: [acte('Césarienne Simple', 'cesarienne')] } }], lignesNouvelles: [acte('Délivrance', 'accouchement')] }).conflit, true, 'forme camelCase aussi');
  assert.strictEqual(conflitActeNaissance({ fichesExistantes: [], lignesNouvelles: [] }).conflit, false);
});

test('dérogation : motif d\'au moins 5 caractères', () => {
  assert.strictEqual(motifDerogationValide({ motif: 'Complication, accord du Dr X' }), true);
  assert.strictEqual(motifDerogationValide({ motif: '  ok ' }), false);
  assert.strictEqual(motifDerogationValide(null), false);
});

// Le contrôle serveur est extrait du code réel (server.js) et exécuté avec une base simulée.
function fabriquer({ fiches = [], annules = [], permissions = ['acte_naissance_derogation'] } = {}) {
  const serveur = require('./serveurSource').lireServeur();
  const debut = serveur.indexOf("app.use('/api/fiches', async (req, res, next) => {");
  const fin = serveur.indexOf("app.use('/api/episodes', (req, res, next) => {");
  const finEpisodes = serveur.indexOf('\n});\n', fin) + 5;
  const supabase = {
    from: (table) => {
      const filtres = {};
      const chaine = {
        select: () => chaine,
        eq: (c, v) => { filtres[c] = v; return chaine; },
        is: () => chaine,
        not: () => chaine,
        maybeSingle: async () => ({ data: table === 'fiches' ? (fiches.find(f => f.local_id && f.local_id === filtres.local_id) || null) : null, error: null }),
        then: (resolve) => resolve({ data: table === 'fiches' ? fiches.filter(f => f.episode_id === filtres.episode_id) : annules, error: null }),
      };
      return chaine;
    },
  };
  const mw = {};
  const app = { use: (chemin, fn) => { mw[chemin] = fn; } };
  const aPermission = async (_id, cle) => permissions.includes(cle);
  new Function('app', 'supabase', 'aPermission', 'compterActesNaissance', 'conflitActeNaissance', 'motifDerogationValide', serveur.slice(debut, finEpisodes))(app, supabase, aPermission, require('../utils/actesNaissance').compterActesNaissance, conflitActeNaissance, motifDerogationValide);
  const appeler = async (chemin, corps, methode = 'POST') => {
    const req = { method: methode, path: '/', body: corps, user: { id: 'u1' } };
    const res = { code: 200, corps: null, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; } };
    let suite = false;
    await mw[chemin](req, res, () => { suite = true; });
    return { suite, code: res.code, corps: res.corps, req };
  };
  return { appeler };
}
const ficheEnBase = (...l) => ({ id: 'f1', episode_id: 'e1', raw_state: { lignesCalcul: l } });
const corps = (...l) => ({ episode_id: 'e1', raw_state: { lignesCalcul: l } });

test('serveur : une 2e fiche avec un acte de naissance est refusée (409), la 1re passe, les autres actes passent', async () => {
  const vide = fabriquer();
  assert.strictEqual((await vide.appeler('/api/fiches', corps(acte('Césarienne Simple', 'cesarienne')))).suite, true);
  const deja = fabriquer({ fiches: [ficheEnBase(acte('Accouchement Physiologique', 'accouchement'))] });
  const refus = await deja.appeler('/api/fiches', corps(acte('Césarienne Simple', 'cesarienne')));
  assert.strictEqual(refus.suite, false); assert.strictEqual(refus.code, 409); assert.strictEqual(refus.corps.code, 'ACTE_NAISSANCE_MULTIPLE');
  assert.strictEqual((await deja.appeler('/api/fiches', corps(acte('Hemogramme', 'labo')))).suite, true);
  assert.strictEqual((await deja.appeler('/api/fiches', corps(acte('Accouchement Physiologique', 'accouchement')), 'GET')).suite, true, 'seulement POST');
});

test('serveur : une fiche au paiement annulé ne compte pas ; un rejeu (local_id déjà enregistré) n\'est jamais refusé', async () => {
  const f = fabriquer({ fiches: [ficheEnBase(acte('Accouchement Physiologique', 'accouchement'))], annules: [{ fiche_id: 'f1' }] });
  assert.strictEqual((await f.appeler('/api/fiches', corps(acte('Césarienne Simple', 'cesarienne')))).suite, true);
  const rejeu = fabriquer({ fiches: [{ ...ficheEnBase(acte('Accouchement Physiologique', 'accouchement')), local_id: 'L1' }] });
  assert.strictEqual((await rejeu.appeler('/api/fiches', { ...corps(acte('Accouchement Physiologique', 'accouchement')), local_id: 'L1' })).suite, true);
});

test('serveur : la dérogation exige le droit ET un motif d\'au moins 5 caractères ; elle est transmise à la route pour l\'audit', async () => {
  const deja = [ficheEnBase(acte('Accouchement Physiologique', 'accouchement'))];
  const avecDroit = fabriquer({ fiches: deja });
  const sansMotif = await avecDroit.appeler('/api/fiches', { ...corps(acte('Césarienne Simple', 'cesarienne')), derogation_naissance: { motif: 'x' } });
  assert.strictEqual(sansMotif.code, 409);
  const ok = await avecDroit.appeler('/api/fiches', { ...corps(acte('Césarienne Simple', 'cesarienne')), derogation_naissance: { motif: 'Accouchement compliqué, césarienne décidée par le médecin' } });
  assert.strictEqual(ok.suite, true); assert.strictEqual(ok.req.derogationNaissanceAAuditer.deja, 1); assert.match(ok.req.derogationNaissanceAAuditer.motif, /compliqué/);
  const sansDroit = fabriquer({ fiches: deja, permissions: [] });
  const refus = await sansDroit.appeler('/api/fiches', { ...corps(acte('Césarienne Simple', 'cesarienne')), derogation_naissance: { motif: 'Accouchement compliqué, césarienne décidée par le médecin' } });
  assert.strictEqual(refus.code, 409);
});

test('serveur : Achat Express (fiches créées avec l\'épisode) : deux actes de naissance refusés, sans dérogation ; la route audite la dérogation', async () => {
  const f = fabriquer();
  const un = await f.appeler('/api/episodes', { fiches: [{ rawState: { lignesCalcul: [acte('Délivrance', 'accouchement')] } }] });
  assert.strictEqual(un.suite, true);
  const deux = await f.appeler('/api/episodes', { fiches: [{ rawState: { lignesCalcul: [acte('Délivrance', 'accouchement'), acte('Césarienne Simple', 'cesarienne')] } }], derogation_naissance: { motif: 'peu importe, pas permis ici' } });
  assert.strictEqual(deux.code, 409); assert.strictEqual(deux.corps.code, 'ACTE_NAISSANCE_MULTIPLE');
  const src = require('./serveurSource').lireServeur();
  assert.match(src, /if \(req\.derogationNaissanceAAuditer\) enregistrerAuditServeur\(req, 'derogation_acte_naissance'/);
  assert.match(src.slice(src.indexOf("{ role: 'direction'"), src.indexOf("{ role: 'direction'") + 600), /'acte_naissance_derogation'/);
});
