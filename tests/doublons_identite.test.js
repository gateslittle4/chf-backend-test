// tests/doublons_identite.test.js — détection des dossiers qui sont probablement la même personne (14/10).
const { test } = require('node:test');
const assert = require('node:assert');
const { similariteNoms, normaliserTel, scorePaire, trouverDoublons, candidatsPour } = require('../utils/doublonsIdentite');

let n = 0;
const d = (nom, extra = {}) => ({ id: `d-${String(++n).padStart(3, '0')}`, numero_dossier: `N-${n}`, nom, nom_origine: nom, ...extra });

test('similariteNoms : ordre inversé, accents, majuscules, faute de frappe → proche ; autre personne → faible', () => {
  assert.ok(similariteNoms('Marie Joseph', 'JOSEPH Marie') >= 0.999);
  assert.ok(similariteNoms('Jean-Baptiste Marie', 'jean baptiste  marié') >= 0.999);
  assert.ok(similariteNoms('Marie Joseph', 'Marie Josef') >= 0.8, 'variante d\'écriture courante (Joseph / Josef)');
  assert.ok(similariteNoms('Marie Joseph', 'Marie Josep') >= 0.85, 'une lettre de différence');
  assert.ok(similariteNoms('Marie Joseph', 'Marie Josephine') >= 0.7);
  assert.ok(similariteNoms('Marie Joseph', 'Paul Louis') < 0.3);
  assert.strictEqual(similariteNoms('', 'Marie'), 0);
  assert.ok(similariteNoms('Bébé Marie Joseph', 'Marie Joseph') >= 0.999, 'le mot Bébé est ignoré pour la ressemblance (les garde-fous décident ensuite)');
});

test('normaliserTel : 8 derniers chiffres, indicatif ignoré, numéro trop court ignoré', () => {
  assert.strictEqual(normaliserTel('+509 3456-7890'), '34567890');
  assert.strictEqual(normaliserTel('34567890'), '34567890');
  assert.strictEqual(normaliserTel('509-1234'), '');
  assert.strictEqual(normaliserTel(null), '');
});

test('Même nom + même date de naissance → très probable, avec les raisons', () => {
  const r = scorePaire(d('Marie Joseph', { date_naissance: '1995-03-02' }), d('Joseph Marie', { date_naissance: '1995-03-02' }));
  assert.strictEqual(r.niveau.cle, 'forte');
  assert.deepStrictEqual(r.raisons, ['Même nom', 'Même date de naissance']);
});
test('Nom proche + même téléphone + même naissance → très probable', () => {
  const r = scorePaire(d('Marie Joseph', { date_naissance: '1995-03-02', telephone: '3456 7890' }), d('Marie Josef', { date_naissance: '1995-03-02', telephone: '+509 34567890' }));
  assert.ok(r.score >= 85);
  assert.ok(r.raisons.includes('Même téléphone') && r.raisons.some(x => /Noms (très proches|qui se ressemblent)/.test(x)));
});
test('Même nom seul (rien d\'autre en commun) → seulement « possible » ; une date inconnue d\'un côté ne pénalise pas', () => {
  const r = scorePaire(d('Marie Joseph'), d('Marie Joseph', { date_naissance: '1990-01-01' }));
  assert.strictEqual(r.niveau.cle, 'possible');
});
test('Garde-fous : dates éloignées, sexes différents → écartés (père/fils, mère/enfant)', () => {
  assert.strictEqual(scorePaire(d('Jean Baptiste', { date_naissance: '1960-01-01' }), d('Jean Baptiste', { date_naissance: '1990-01-01' })), null, 'père et fils');
  assert.strictEqual(scorePaire(d('Jean Baptiste', { sexe: 'M' }), d('Jean Baptiste', { sexe: 'F' })), null, 'sexes différents');
});
test('Garde-fous : un bébé et sa mère ne sont JAMAIS proposés (lien, ou nom Bébé d\'un seul côté)', () => {
  const mere = d('Marie Joseph', { telephone: '34567890', date_naissance: '1995-03-02' });
  const bebe = d('Bébé Marie Joseph', { telephone: '34567890', mere_dossier_id: mere.id, date_naissance: '2026-10-01' });
  assert.strictEqual(scorePaire(mere, bebe), null, 'lien explicite');
  const bebeSansLien = d('Bébé Marie Joseph', { telephone: '34567890' });
  assert.strictEqual(scorePaire(mere, bebeSansLien), null, 'ancien dossier de bébé sans lien : nom Bébé d\'un seul côté');
  const deuxBebes = scorePaire(d('Bébé Marie Joseph', { date_naissance: '2026-10-01' }), d('Bébé Joseph Marie', { date_naissance: '2026-10-01' }));
  assert.ok(deuxBebes && deuxBebes.score >= 85, 'deux dossiers « Bébé » identiques restent des doublons possibles');
});
test('Un téléphone partagé ne suffit pas quand les noms sont différents (famille)', () => {
  assert.strictEqual(scorePaire(d('Marie Joseph', { telephone: '34567890' }), d('Paul Louis', { telephone: '34567890' })), null);
});
test('Un dossier déjà fusionné n\'est jamais proposé', () => {
  assert.strictEqual(scorePaire(d('Marie Joseph', { date_naissance: '1995-03-02' }), d('Marie Joseph', { date_naissance: '1995-03-02', fusionne_dans: 'x' })), null);
});
test('Un ancien nom compte : un bébé renommé est reconnu sous son nom de naissance', () => {
  const a = d('Marie Louise Joseph', { anciens_noms: [{ nom: 'Bébé Marie Joseph' }], nom_origine: 'Bébé Marie Joseph', date_naissance: '2026-10-01' });
  const b = d('Bébé Marie Joseph', { date_naissance: '2026-10-01' });
  assert.ok(scorePaire(a, b).score >= 85);
});

test('trouverDoublons : paires triées par score, paires ignorées exclues, pas de doublon de paire, dossiers sans lien omis', () => {
  n = 0;
  const A = d('Marie Joseph', { date_naissance: '1995-03-02', telephone: '34567890' });
  const B = d('Marie Josef', { date_naissance: '1995-03-02', telephone: '34567890' });
  const C = d('Paul Louis', { date_naissance: '1980-01-01' });
  const D = d('Paul Louis', { date_naissance: '1980-01-01' });
  const E = d('Sans Rapport', { date_naissance: '1999-09-09' });
  const paires = trouverDoublons([A, B, C, D, E]);
  assert.strictEqual(paires.length, 2);
  assert.ok(paires[0].score >= paires[1].score);
  const ensembles = paires.map(p => [p.a.id, p.b.id].sort().join('|'));
  assert.ok(ensembles.includes([A.id, B.id].sort().join('|')) && ensembles.includes([C.id, D.id].sort().join('|')));
  const ignore = new Set([[C.id, D.id].sort().join('|')]);
  assert.strictEqual(trouverDoublons([A, B, C, D, E], { ignores: ignore }).length, 1);
});

test('trouverDoublons tient sur beaucoup de dossiers (10 000 en moins de quelques secondes) et ne perd pas la paire cachée dedans', () => {
  n = 0;
  const prenoms = ['Marie', 'Jean', 'Paul', 'Rose', 'Pierre', 'Anne', 'Louis', 'Claire', 'Michel', 'Sandra'];
  const noms = ['Joseph', 'Baptiste', 'Louis', 'Pierre', 'Charles', 'Jacques', 'Antoine', 'Vincent', 'Etienne', 'Denis'];
  const tous = [];
  for (let i = 0; i < 10000; i++) tous.push(d(`${prenoms[i % 10]} ${noms[Math.floor(i / 10) % 10]} ${String.fromCharCode(97 + (i % 26))}${i}`, { date_naissance: `${1950 + (i % 60)}-0${1 + (i % 9)}-1${i % 9}` }));
  const cache1 = d('Zacharie Quintilien', { date_naissance: '1971-02-03' });
  const cache2 = d('Quintilien Zacharie', { date_naissance: '1971-02-03' });
  tous.push(cache1, cache2);
  const debut = Date.now();
  const paires = trouverDoublons(tous);
  assert.ok(Date.now() - debut < 8000, `trop lent : ${Date.now() - debut} ms`);
  assert.ok(paires.some(p => [p.a.id, p.b.id].includes(cache1.id) && [p.a.id, p.b.id].includes(cache2.id)));
});

test('candidatsPour : propose les dossiers qui ressemblent à une personne qu\'on va créer', () => {
  n = 0;
  const existants = [d('Marie Joseph', { date_naissance: '1995-03-02', numero_dossier: 'N-12' }), d('Paul Louis')];
  const c = candidatsPour({ nom: 'Josef Marie', date_naissance: '1995-03-02', sexe: 'F' }, existants);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].dossier.numero_dossier, 'N-12');
  assert.deepStrictEqual(candidatsPour({ nom: 'Quelqu\'un d\'autre' }, existants), []);
});
