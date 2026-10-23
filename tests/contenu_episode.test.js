// tests/contenu_episode.test.js — les épisodes ouverts disent s'ils contiennent déjà des examens / des médicaments (15/10).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { contenuDesFiches } = require('../utils/contenuEpisode');

test("Aucune fiche, ou des fiches sans examen ni médicament → rien", () => {
  assert.deepStrictEqual(contenuDesFiches([]), { examens: false, medicaments: false });
  assert.deepStrictEqual(contenuDesFiches(undefined), { examens: false, medicaments: false });
  assert.deepStrictEqual(contenuDesFiches([{ breakdown: { service: 500, hospit: 750 } }]), { examens: false, medicaments: false });
  assert.deepStrictEqual(contenuDesFiches([{ breakdown: { labo: 0, med: 0 } }]), { examens: false, medicaments: false });
});

test("Laboratoire, sonographie ou ECG = examen ; pharmacie = médicament ; les deux dans des fiches différentes se cumulent", () => {
  assert.deepStrictEqual(contenuDesFiches([{ breakdown: { labo: 300 } }]), { examens: true, medicaments: false });
  assert.deepStrictEqual(contenuDesFiches([{ breakdown: { sono: 800 } }]), { examens: true, medicaments: false });
  assert.deepStrictEqual(contenuDesFiches([{ breakdown: { ecg: 400 } }]), { examens: true, medicaments: false });
  assert.deepStrictEqual(contenuDesFiches([{ breakdown: { med: 120 } }]), { examens: false, medicaments: true });
  assert.deepStrictEqual(contenuDesFiches([{ breakdown: { service: 500 } }, { breakdown: { labo: 300 } }, { breakdown: { med: 90 } }]), { examens: true, medicaments: true });
});

test("Une fiche à la corbeille ne compte pas ; à défaut de détail par catégorie, les lignes de la fiche sont lues", () => {
  assert.deepStrictEqual(contenuDesFiches([{ breakdown: { med: 120 }, supprime_le: '2026-10-15T10:00:00Z' }]), { examens: false, medicaments: false });
  assert.deepStrictEqual(contenuDesFiches([{ breakdown: {}, raw_state: { lignesCalcul: [{ type: 'med', qte: 2 }, { type: 'acte', sub: 'labo', qte: 1 }] } }]), { examens: true, medicaments: true });
  assert.deepStrictEqual(contenuDesFiches([{ raw_state: { lignesCalcul: [{ type: 'med', qte: 0 }] } }]), { examens: false, medicaments: false }, 'quantité 0 : pas pris');
  assert.deepStrictEqual(contenuDesFiches([null, { breakdown: null, raw_state: null }]), { examens: false, medicaments: false }, 'données absentes : jamais d\'erreur');
});

test("GET /api/dossiers/:id/episodes-ouverts ajoute `contenu` à chaque épisode, sans jamais échouer si les fiches sont illisibles", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.get('/api/dossiers/:id/episodes-ouverts'");
  const bloc = src.slice(i, i + 1600);
  assert.match(bloc, /\.from\('fiches'\)\.select\('episode_id, breakdown, raw_state, supprime_le'\)\.in\('episode_id'/);
  assert.match(bloc, /contenu: contenuDesFiches\(/);
  assert.match(bloc, /if \(erreurFiches\) return res\.json\(episodes\);/);
});
