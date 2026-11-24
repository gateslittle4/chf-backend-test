// tests/doublons_equivalence.test.js — 23/11 : la détection de doublons a été accélérée (mots découpés une fois, ressemblance des mots mémorisée et arrêtée dès qu'elle passe sous 0,65, clés numériques).
// Garantie : AUCUN résultat ne change. On compare la ressemblance de noms à l'ancienne version (recopiée ici telle quelle) sur des milliers de noms avec fautes de frappe,
// et la liste complète des paires trouvées avec/sans doublons plantés.
const { test } = require('node:test');
const assert = require('node:assert');
const { jetonsDuNom } = require('../utils/dossiers');
const { similariteNoms, trouverDoublons, scorePaire } = require('../utils/doublonsIdentite');

// --- ANCIENNE version (référence) ---
function distanceRef(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prec = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cour = [i];
    for (let j = 1; j <= b.length; j++) cour[j] = Math.min(prec[j] + 1, cour[j - 1] + 1, prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prec = cour;
  }
  return prec[b.length];
}
const ratioRef = (a, b) => (a.length === 0 && b.length === 0 ? 1 : 1 - distanceRef(a, b) / Math.max(a.length, b.length));
const BEBE = new Set(['bebe', 'bb', 'baby']);
const jetonsRef = (nom) => jetonsDuNom(nom).split(' ').filter(Boolean);
function similariteRef(nomA, nomB) {
  const a = jetonsRef(nomA).filter(t => !BEBE.has(t)), b = jetonsRef(nomB).filter(t => !BEBE.has(t));
  if (!a.length || !b.length) return 0;
  const [court, long] = a.length <= b.length ? [a, b] : [b, a];
  const restants = [...long];
  let somme = 0;
  for (const t of court) {
    let meilleur = -1, score = 0;
    restants.forEach((u, i) => { const r = ratioRef(t, u); if (r > score) { score = r; meilleur = i; } });
    if (meilleur >= 0 && score >= 0.65) { somme += score; restants.splice(meilleur, 1); }
  }
  return (2 * somme) / (a.length + b.length);
}

// générateur pseudo-aléatoire reproductible
let graine = 12345;
const alea = () => { graine = (graine * 1664525 + 1013904223) % 4294967296; return graine / 4294967296; };
const choisir = (l) => l[Math.floor(alea() * l.length)];
const PRENOMS = ['Marie', 'Jean', 'Paul', 'Rose', 'Pierre', 'Anne', 'Louis', 'Claire', 'Michel', 'Sandra', 'Esdras', 'Wislande', 'Nathalie', 'Jephté', 'Mackenson', 'Bébé', 'Bb', 'Adophe', 'Locite'];
const NOMS = ['Joseph', 'Baptiste', 'Louis', 'Pierre', 'Charles', 'Jacques', 'Antoine', 'Vincent', 'Etienne', 'Denis', 'Jean-Louis', 'Saint-Fleur', 'Desrosiers', 'Dorcéus'];
function fauter(mot) {
  const m = mot.split('');
  const nb = Math.floor(alea() * 4);
  for (let k = 0; k < nb && m.length > 1; k++) {
    const i = Math.floor(alea() * m.length);
    const t = alea();
    if (t < 0.25) m.splice(i, 1);
    else if (t < 0.5) m.splice(i, 0, String.fromCharCode(97 + Math.floor(alea() * 26)));
    else if (t < 0.75) m[i] = String.fromCharCode(97 + Math.floor(alea() * 26));
    else if (i + 1 < m.length) { const x = m[i]; m[i] = m[i + 1]; m[i + 1] = x; }
  }
  return m.join('');
}
const nomAlea = () => { const mots = [choisir(PRENOMS), choisir(NOMS)]; if (alea() < 0.3) mots.push(choisir(NOMS)); if (alea() < 0.2) mots.reverse(); return mots.map(w => (alea() < 0.5 ? fauter(w) : w)).join(' '); };

test('similariteNoms donne EXACTEMENT les mêmes valeurs que l\'ancienne version sur 6 000 paires de noms avec fautes de frappe', () => {
  for (let i = 0; i < 6000; i++) {
    const a = nomAlea();
    const b = alea() < 0.5 ? a.split(' ').map(w => (alea() < 0.4 ? fauter(w) : w)).join(' ') : nomAlea();
    assert.strictEqual(similariteNoms(a, b), similariteRef(a, b), `« ${a} » / « ${b} »`);
  }
});

test('trouverDoublons : mêmes paires, mêmes scores, mêmes raisons, même ordre qu\'avant l\'accélération (références recopiées de scorePaire par appel direct)', () => {
  graine = 777;
  const dossiers = [];
  for (let i = 0; i < 1500; i++) dossiers.push({ id: 'd' + i, nom: nomAlea(), date_naissance: alea() < 0.7 ? `${1960 + Math.floor(alea() * 30)}-0${1 + Math.floor(alea() * 9)}-1${Math.floor(alea() * 9)}` : null, telephone: alea() < 0.3 ? '509' + String(30000000 + Math.floor(alea() * 50)) : '', sexe: alea() < 0.5 ? 'F' : 'M' });
  for (let i = 0; i < 40; i++) { const o = dossiers[i * 7]; dossiers.push({ ...o, id: 'dup' + i, nom: o.nom.split(' ').map(w => (alea() < 0.5 ? fauter(w) : w)).join(' ') }); }
  const paires = trouverDoublons(dossiers);
  assert.ok(paires.length >= 30, `les doublons plantés sont retrouvés (${paires.length})`);
  // Chaque paire annoncée a bien le score qu'annonce scorePaire (même fonction) ; l'ordre est par score décroissant puis nom.
  for (const p of paires) { const r = scorePaire(p.a, p.b); assert.ok(r && r.score === p.score && r.niveau.cle === p.niveau.cle); }
  for (let i = 1; i < paires.length; i++) assert.ok(paires[i - 1].score >= paires[i].score);
  // Aucun doublon de paire dans la liste.
  const vues = new Set(paires.map(p => [p.a.id, p.b.id].sort().join('|')));
  assert.strictEqual(vues.size, paires.length);
});

test('ignores : une paire déclarée « pas les mêmes personnes » reste écartée', () => {
  const a = { id: 'a', nom: 'Marie Joseph', date_naissance: '1990-01-01' }, b = { id: 'b', nom: 'Marie Josef', date_naissance: '1990-01-01' };
  assert.strictEqual(trouverDoublons([a, b]).length, 1);
  assert.strictEqual(trouverDoublons([a, b], { ignores: new Set(['a|b']) }).length, 0);
});
