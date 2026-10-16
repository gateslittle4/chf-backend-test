// tests/identite_dossier_obligatoire.test.js — sexe et date de naissance obligatoires à la création d'un dossier (15/10). 16/10 : le NUMÉRO ne l'est plus (la caisse le donne après le paiement).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { erreurIdentiteDossier } = require('../utils/dossiers');

const serveur = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const MAINTENANT = new Date('2026-10-15T12:00:00Z').getTime();
const ok = { sexe: 'F', date_naissance: '2025-08-20' };

test("erreurIdentiteDossier : identité complète → aucune erreur (date estimée par âge comprise, bébé né aujourd'hui compris)", () => {
  assert.strictEqual(erreurIdentiteDossier(ok, MAINTENANT), null);
  assert.strictEqual(erreurIdentiteDossier({ ...ok, date_naissance: '1990-01-01' }, MAINTENANT), null, 'date estimée (1er janvier)');
  assert.strictEqual(erreurIdentiteDossier({ ...ok, sexe: 'M', date_naissance: '2026-10-15' }, MAINTENANT), null, "né aujourd'hui");
  assert.strictEqual(erreurIdentiteDossier({ ...ok, date_naissance: '2026-10-16' }, MAINTENANT), null, 'un jour de marge pour le fuseau');
  assert.strictEqual(erreurIdentiteDossier({ ...ok, date_naissance: '2025-08-20T00:00:00.000Z' }, MAINTENANT), null, 'date avec heure (colonne date renvoyée par la base)');
});

test("erreurIdentiteDossier : chaque champ manquant ou faux donne un message précis", () => {
  assert.match(erreurIdentiteDossier({ ...ok, sexe: undefined }, MAINTENANT), /sexe est obligatoire/);
  assert.match(erreurIdentiteDossier({ ...ok, date_naissance: undefined }, MAINTENANT), /date de naissance est obligatoire/);
  assert.match(erreurIdentiteDossier({ ...ok, date_naissance: '2026-13-40' }, MAINTENANT), /pas valide/);
  assert.match(erreurIdentiteDossier({ ...ok, date_naissance: '1899-12-31' }, MAINTENANT), /pas valide/);
  assert.match(erreurIdentiteDossier({ ...ok, date_naissance: '2026-12-31' }, MAINTENANT), /pas valide/);
  assert.match(erreurIdentiteDossier({}, MAINTENANT), /sexe est obligatoire/);
  assert.match(erreurIdentiteDossier(undefined, MAINTENANT), /sexe est obligatoire/);
});

test("le numéro de dossier n'est PLUS exigé à la création (16/10) : c'est la caisse qui le donne après le paiement, même si un numéro arrive en trop il n'est pas jugé ici", () => {
  assert.strictEqual(erreurIdentiteDossier({ ...ok, numero_dossier: undefined }, MAINTENANT), null);
  assert.strictEqual(erreurIdentiteDossier({ ...ok, numero_dossier: '  ' }, MAINTENANT), null);
  assert.strictEqual(erreurIdentiteDossier({ ...ok, numero_dossier: '123' }, MAINTENANT), null);
});

test("POST /api/episodes (qui crée aussi le dossier) applique la même règle, sauf vente comptoir (Express) et import de sauvegarde", () => {
  const i = serveur.indexOf("app.post('/api/episodes'");
  const bloc = serveur.slice(i, i + 5200);
  assert.match(bloc, /const exempteIdentite = d\.voie_entree === 'vente_comptoir' \|\| d\.import_sauvegarde === true;/);
  assert.match(bloc, /erreurIdentiteDossier\(\{ sexe: d\.sexe, date_naissance: d\.date_naissance \}\)/);
  assert.ok(bloc.indexOf('erreurIdentiteDossier') < bloc.indexOf(".from('dossiers')"), 'le contrôle précède la création du dossier');
  assert.ok(bloc.indexOf("dejaCree") < bloc.indexOf('erreurIdentiteDossier'), "un rejeu d'un dossier déjà créé reste renvoyé tel quel");
});

test("PUT /api/dossiers/:id : un sexe ou une date de naissance déjà connus ne peuvent plus être effacés (corrigés seulement)", () => {
  const i = serveur.indexOf("app.put('/api/dossiers/:id'");
  const bloc = serveur.slice(i, i + 5000);
  assert.match(bloc, /select\('nom, anciens_noms, sexe, date_naissance'\)/);
  assert.match(bloc, /avant\.sexe && !sexe/);
  assert.match(bloc, /avant\.date_naissance && !date_naissance/);
});
