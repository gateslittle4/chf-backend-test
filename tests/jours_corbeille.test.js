// tests/jours_corbeille.test.js — 26/11 (Esdras : paramètres supplémentaires). La durée de la corbeille (30 jours jusqu'ici, écrite en dur) devient un réglage de la direction :
// Paramètres > joursCorbeille, de 7 à 365 jours, lu par le SERVEUR au moment de la purge quotidienne. Absent ou illisible : 30 jours — jamais plus court par accident (une purge est irréversible).
const { test } = require('node:test');
const assert = require('node:assert');
const { joursCorbeille, DEFAUTS } = require('../utils/reglagesDirection');

test('joursCorbeille : 30 par défaut ; entier de 7 à 365 accepté ; tout le reste retombe sur 30', () => {
  assert.strictEqual(DEFAUTS.joursCorbeille, 30);
  assert.strictEqual(joursCorbeille({}), 30);
  assert.strictEqual(joursCorbeille(null), 30);
  assert.strictEqual(joursCorbeille(undefined), 30);
  for (const ok of [7, 14, 30, 90, 365, '60']) assert.strictEqual(joursCorbeille({ joursCorbeille: ok }), Number(ok), String(ok));
  for (const invalide of [0, 1, 6, 366, 1000, -5, 10.5, 'abc', '', null, NaN, true]) assert.strictEqual(joursCorbeille({ joursCorbeille: invalide }), 30, String(invalide));
});

test('Les deux purges (catalogue et dossiers/fiches/pièces jointes) relisent le réglage au moment d\'agir ; la valeur d\'origine reste 30', () => {
  const src = require('./serveurSource').lireServeur();
  assert.match(src, /const JOURS_CORBEILLE_CATALOGUE = 30;/);
  assert.match(src, /const JOURS_CORBEILLE_DOSSIERS = 30;/);
  const catalogue = src.slice(src.indexOf('async function purgerCorbeilleCatalogue'), src.indexOf('async function purgerCorbeilleDossiers'));
  assert.match(catalogue, /const jours = joursCorbeille\(await lireReglagesDirection\(supabase\), JOURS_CORBEILLE_CATALOGUE\);/);
  assert.match(catalogue, /const limite = Date\.now\(\) - jours \* 86400000;/);
  assert.doesNotMatch(catalogue, /JOURS_CORBEILLE_CATALOGUE \* 86400000/, 'plus de durée en dur dans le calcul');
  const dossiers = src.slice(src.indexOf('async function purgerCorbeilleDossiers'), src.indexOf('const JOURS_TRACES_DECREMENT_STOCK'));
  assert.match(dossiers, /const jours = joursCorbeille\(await lireReglagesDirection\(supabase\), JOURS_CORBEILLE_DOSSIERS\);/);
  assert.match(dossiers, /const limite = new Date\(Date\.now\(\) - jours \* 86400000\)\.toISOString\(\);/);
  assert.doesNotMatch(dossiers, /JOURS_CORBEILLE_DOSSIERS \* 86400000/);
});
