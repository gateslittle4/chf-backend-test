// tests/motif_fermeture_contrainte.test.js — 23/11 : l'archivage d'une hospitalisation était refusé par la base (contrainte episodes_motif_fermeture_check).
// Les motifs que l'application envoie (formulaire Hébergement) et ceux que le serveur pose lui-même doivent TOUS figurer dans le dernier script qui définit la contrainte.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'corrige_motif_fermeture.sql'), 'utf8');
const MOTIFS_APP = ['normale', 'sans_autorisation', 'transfert', 'deces'];
const MOTIFS_SERVEUR = ['hospitalise', 'fermeture_automatique'];

test('la contrainte des motifs de fermeture accepte tous les motifs de l\'application et du serveur', () => {
  const liste = sql.slice(sql.indexOf('array['));
  for (const m of [...MOTIFS_APP, ...MOTIFS_SERVEUR, 'exeat_normal', 'exeat_sans_autorisation']) assert.ok(liste.includes(`'${m}'`), `motif manquant : ${m}`);
});

test('le serveur n\'écrit que des motifs autorisés (hospitalisation et fermeture automatique)', () => {
  for (const f of ['utils/hospitalisation.js', 'utils/fermetureConsultations.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const m of [...src.matchAll(/motif_fermeture: '([a-z_]+)'/g)].map(x => x[1])) assert.ok(MOTIFS_SERVEUR.includes(m), `${f} : motif ${m} non autorisé`);
  }
});
