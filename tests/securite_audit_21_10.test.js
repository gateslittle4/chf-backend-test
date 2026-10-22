// tests/securite_audit_21_10.test.js — corrections d'un audit de sécurité (21/10, Esdras : « essaie de le hacker, corrige les faiblesses »).
// Chaque test prouve le scénario d'attaque AVANT (en relisant le code), puis que le correctif ferme bien ce chemin précis.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function bloc(debutMarqueur, finMarqueur) {
  const d = src.indexOf(debutMarqueur);
  assert.ok(d >= 0, `marqueur introuvable : ${debutMarqueur}`);
  const f = src.indexOf(finMarqueur, d + 1);
  assert.ok(f > d, `marqueur de fin introuvable après ${debutMarqueur}`);
  return src.slice(d, f);
}

test("POST /api/fiches : une fiche d'exonération exige demandes_repondre OU exoneration_accorder (22/10 : la caisse accorde), pas seulement caisse_travailler (sinon un caissier quelconque s'auto-accorde une remise)", () => {
  const b = bloc("app.post('/api/fiches'", "app.get('/api/fiches/episode/:episodeId'");
  assert.match(b, /mode_paiement === 'exoneration' && !\(await aPermission\(req\.user\.id, 'demandes_repondre'\)\) && !\(await aPermission\(req\.user\.id, 'exoneration_accorder'\)\)/);
});

test("POST /api/paiements : un paiement en mode exoneration exige demandes_repondre OU exoneration_accorder, même chose", () => {
  const b = bloc("app.post('/api/paiements'", "app.get('/api/depenses-caisse'");
  assert.match(b, /if \(req\.body\.mode === 'exoneration'\) \{\s*const parLaDirection = await aPermission\(req\.user\.id, 'demandes_repondre'\);\s*if \(!parLaDirection && !\(await aPermission\(req\.user\.id, 'exoneration_accorder'\)\)\)/);
});

test("Lecture d'un dossier, recherche, épisodes ouverts, liste des épisodes, fiches d'un épisode : exigent au moins fiche_patient_voir (fermeture d'un trou structurel, aucun rôle actuel n'est affecté)", () => {
  for (const [debut, fin] of [
    ["app.get('/api/dossiers/recherche'", "app.get('/api/dossiers/liste-hors-ligne'"],
    ["app.get('/api/dossiers/:id'", "app.put('/api/dossiers/:id'"],
    ["app.get('/api/dossiers/:id/episodes-ouverts'", "app.post('/api/fiches'"],
    ["app.get('/api/fiches/episode/:episodeId'", "app.post('/api/paiements'"],
  ]) {
    assert.match(bloc(debut, fin), /aPermission\(req\.user\.id, 'fiche_patient_voir'\)/, `${debut} doit exiger fiche_patient_voir`);
  }
  // GET /api/episodes (liste complète) : même correctif, cherché séparément (plusieurs routes portent ce nom).
  const debutEp = src.indexOf("app.get('/api/episodes', async (req, res) => {");
  assert.match(src.slice(debutEp, debutEp + 600), /aPermission\(req\.user\.id, 'fiche_patient_voir'\)/);
});

test("Le lien signé vers une pièce jointe exige fiche_patient_voir (sinon un compte quelconque pouvait télécharger le document — pièce d'identité — de n'importe quel dossier)", () => {
  const b = bloc("app.get('/api/dossiers/:id/pieces-jointes/:fichierId/lien'", "app.delete('/api/dossiers/:id/pieces-jointes/:fichierId'");
  assert.match(b, /aPermission\(req\.user\.id, 'fiche_patient_voir'\)/);
});

test("La LISTE des pièces jointes reste volontairement ouverte (comme GET /api/dossiers/:id) : seul le FICHIER (ci-dessus) est protégé — design existant, pas touché", () => {
  const b = bloc("app.get('/api/dossiers/:id/pieces-jointes'", "app.post('/api/dossiers/:id/pieces-jointes'");
  assert.doesNotMatch(b, /aPermission/);
});

test("Création et modification d'un dossier : nom/adresse/téléphone/conjoint bornés en longueur (sinon un compte avec dossier_creer ou caisse_travailler pouvait gonfler la base avec du texte énorme)", () => {
  const creation = bloc("app.post('/api/dossiers'", "app.get('/api/dossiers/:id'");
  assert.match(creation, /nomSaisi\.length > 200/);
  assert.match(creation, /adresse\.length > 300/);
  assert.match(creation, /telephone\.length > 40/);
  const modification = bloc("app.put('/api/dossiers/:id'", "app.get('/api/dossiers/:id/historique'");
  assert.match(modification, /nomSaisi\.length > 200/);
  assert.match(modification, /conjointSaisi\.length > 200/);
});
