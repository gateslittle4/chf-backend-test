// utils/journalSql.js — compare les scripts de sql/ au journal des scripts appliqués (voir sql/journal_migrations.sql). Fonctions pures (testées) ; le script
// scripts/verifier-sql.js les branche sur les fichiers et sur la base.
const crypto = require('node:crypto');

const empreinte = (contenu) => crypto.createHash('sha256').update(String(contenu).replace(/\r\n/g, '\n')).digest('hex');

// fichiers : [{ nom, contenu }] ; lignes : [{ nom, somme_controle }] lues dans migrations_appliquees.
// Renvoie { notes, modifies, absents, inconnus } : appliqué et identique, appliqué mais le fichier a changé depuis, jamais noté, noté mais fichier disparu.
function comparerJournal(fichiers, lignes) {
  const parNom = new Map((lignes || []).map(l => [l.nom, l]));
  const notes = [], modifies = [], absents = [];
  for (const f of fichiers || []) {
    const ligne = parNom.get(f.nom);
    if (!ligne) { absents.push(f.nom); continue; }
    if (ligne.somme_controle && ligne.somme_controle !== empreinte(f.contenu)) modifies.push(f.nom); else notes.push(f.nom);
  }
  const presents = new Set((fichiers || []).map(f => f.nom));
  const inconnus = (lignes || []).map(l => l.nom).filter(n => !presents.has(n));
  return { notes: notes.sort(), modifies: modifies.sort(), absents: absents.sort(), inconnus: inconnus.sort() };
}

const echapper = (s) => String(s).replace(/'/g, "''");

// Les INSERT à coller pour noter des scripts (ON CONFLICT : rejouable sans danger).
function sqlPourNoter(fichiers, noms, { par = 'esdras', remarque = '' } = {}) {
  const choisis = (fichiers || []).filter(f => (noms || []).includes(f.nom));
  if (choisis.length === 0) return '';
  const valeurs = choisis.map(f => `('${echapper(f.nom)}', '${empreinte(f.contenu)}', '${echapper(par)}', ${remarque ? `'${echapper(remarque)}'` : 'NULL'})`).join(',\n  ');
  return `INSERT INTO public.migrations_appliquees (nom, somme_controle, applique_par, remarque) VALUES\n  ${valeurs}\nON CONFLICT (nom) DO UPDATE SET somme_controle = EXCLUDED.somme_controle, applique_le = now();`;
}

module.exports = { empreinte, comparerJournal, sqlPourNoter };
