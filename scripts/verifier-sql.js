// scripts/verifier-sql.js — compare les scripts de sql/ au journal des scripts appliqués en production (voir sql/journal_migrations.sql).
//   node scripts/verifier-sql.js            → liste : ✅ noté / ⚠️ noté mais fichier modifié depuis / ⛔ jamais noté (code de sortie 1 s'il y en a)
//   node scripts/verifier-sql.js --sql      → écrit les INSERT à coller dans Supabase pour noter les scripts « jamais notés » (à confirmer avant de coller)
//   node scripts/verifier-sql.js --local    → sans base : seulement les scripts du dépôt et leur empreinte
// Prérequis (sauf --local) : .env avec SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY, et le journal créé (sql/journal_migrations.sql).
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { empreinte, comparerJournal, sqlPourNoter } = require('../utils/journalSql');

const DOSSIER_SQL = path.join(__dirname, '..', 'sql');
const fichiers = fs.readdirSync(DOSSIER_SQL).filter(n => n.endsWith('.sql')).sort()
  .map(nom => ({ nom, contenu: fs.readFileSync(path.join(DOSSIER_SQL, nom), 'utf8') }));

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--local')) {
    for (const f of fichiers) console.log(`${empreinte(f.contenu).slice(0, 12)}  ${f.nom}`);
    console.log(`\n${fichiers.length} scripts dans sql/.`);
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants dans .env (ou utilise --local).'); process.exit(2); }
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.from('migrations_appliquees').select('nom, somme_controle');
  if (error) {
    console.error(error.code === '42P01' || error.code === 'PGRST205'
      ? "❌ Le journal n'existe pas encore : colle sql/journal_migrations.sql dans l'éditeur SQL de Supabase."
      : '❌ Lecture du journal impossible : ' + error.message);
    process.exit(2);
  }
  const r = comparerJournal(fichiers, data);
  if (args.includes('--sql')) {
    const sql = sqlPourNoter(fichiers, r.absents, { par: process.env.USER || 'script', remarque: 'noté après coup — appliqué avant le journal (à confirmer)' });
    console.log(sql || '-- Rien à noter : tous les scripts du dépôt sont dans le journal.');
    return;
  }
  for (const n of r.notes) console.log(`✅ ${n}`);
  for (const n of r.modifies) console.log(`⚠️  ${n} — le fichier a changé depuis qu'il a été appliqué : le coller à nouveau ?`);
  for (const n of r.absents) console.log(`⛔ ${n} — jamais noté dans le journal`);
  for (const n of r.inconnus) console.log(`❓ ${n} — noté dans le journal mais absent du dépôt`);
  console.log(`\n${r.notes.length} notés, ${r.modifies.length} modifiés, ${r.absents.length} jamais notés, ${r.inconnus.length} inconnus du dépôt.`);
  if (r.modifies.length + r.absents.length + r.inconnus.length > 0) process.exit(1);
})();
