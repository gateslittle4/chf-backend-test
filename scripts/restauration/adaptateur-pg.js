// scripts/restauration/adaptateur-pg.js — un « faux Supabase » branché sur une VRAIE base PostgreSQL jetable (psql), pour le test de restauration.
// Ne sait faire que ce dont la sauvegarde et la restauration ont besoin : from(t).select(cols).order(col).range(a,b), from(t).insert(lignes).select(cols),
// from(t).update(patch).eq(col, val), rpc(nom, args) — et un stockage de fichiers sur disque (storage.from(bucket).upload/download/list/remove).
// Chaque appel lance psql : lent (~40 ms), mais c'est du vrai SQL, avec les vraies contraintes, déclencheurs et fonctions de la base.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ident = (n) => { if (!/^[a-z_][a-z0-9_]*$/.test(n)) throw new Error('identifiant refusé : ' + n); return n; };
const litteral = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

function creerClientPg({ port, base, hote = '/tmp', dossierTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chf-pg-')) }) {
  let compteur = 0;
  function executer(sql) {
    const fichier = path.join(dossierTmp, `req-${process.pid}-${compteur++}.sql`);
    fs.writeFileSync(fichier, sql);
    const r = spawnSync('psql', ['-h', hote, '-p', String(port), '-U', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-d', base, '-f', fichier], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
    fs.rmSync(fichier, { force: true });
    if (r.status !== 0) {
      const m = /ERROR:\s+(.*)/.exec(r.stderr || '');
      return { data: null, error: { message: m ? m[1].trim() : (r.stderr || 'erreur psql').trim(), code: /does not exist/.test(r.stderr || '') ? '42883' : undefined } };
    }
    const sortie = (r.stdout || '').trim();
    try { return { data: sortie ? JSON.parse(sortie) : null, error: null }; }
    catch (e) { return { data: null, error: { message: 'réponse illisible : ' + sortie.slice(0, 200) } }; }
  }

  function construire(table) {
    const t = ident(table);
    const etat = { op: 'select', cols: '*', ordres: [], debut: null, fin: null, lignes: null, patch: null, filtres: [] };
    const q = {
      select(cols = '*') { etat.cols = cols; return q; },
      order(col, opts = {}) { etat.ordres.push(`${ident(col)} ${opts.ascending === false ? 'DESC' : 'ASC'}`); return q; },
      range(a, b) { etat.debut = a; etat.fin = b; return q; },
      insert(lignes) { etat.op = 'insert'; etat.lignes = lignes; etat.cols = '*'; return q; },
      update(patch) { etat.op = 'update'; etat.patch = patch; return q; },
      eq(col, val) { etat.filtres.push(`${ident(col)} = ${litteral(val)}`); return q; },
      then(ok, ko) { return Promise.resolve(lancer()).then(ok, ko); },
    };
    const colonnes = () => (etat.cols === '*' ? '*' : etat.cols.split(',').map(c => ident(c.trim())).join(', '));
    function lancer() {
      if (etat.op === 'select') {
        const ordre = etat.ordres.length ? ` ORDER BY ${etat.ordres.join(', ')}` : '';
        const limite = etat.debut !== null ? ` LIMIT ${etat.fin - etat.debut + 1} OFFSET ${etat.debut}` : '';
        const filtre = etat.filtres.length ? ` WHERE ${etat.filtres.join(' AND ')}` : '';
        return executer(`select coalesce(json_agg(t.j order by t.n), '[]'::json) from (select row_to_json(x) j, row_number() over () n from (select ${colonnes()} from public.${t}${filtre}${ordre}${limite}) x) t;`);
      }
      if (etat.op === 'insert') {
        const json = JSON.stringify(etat.lignes);
        if (json.includes('$chf$')) return { data: null, error: { message: 'contenu refusé' } };
        return executer(`with ins as (insert into public.${t} select * from json_populate_recordset(null::public.${t}, $chf$${json}$chf$::json) returning ${colonnes()}) select coalesce(json_agg(ins), '[]'::json) from ins;`);
      }
      const set = Object.entries(etat.patch).map(([c, v]) => `${ident(c)} = ${litteral(v)}`).join(', ');
      const filtre = etat.filtres.length ? ` WHERE ${etat.filtres.join(' AND ')}` : '';
      return executer(`with u as (update public.${t} set ${set}${filtre} returning 1) select coalesce(json_agg(u), '[]'::json) from u;`);
    }
    return q;
  }

  return {
    from: construire,
    async rpc(nom, args = {}) {
      const params = Object.entries(args).map(([k, v]) => `${ident(k)} => $chf$${JSON.stringify(v)}$chf$::jsonb`).join(', ');
      return executer(`select to_json(public.${ident(nom)}(${params}));`);
    },
    // Pour les vérifications du test : une requête libre qui renvoie du JSON.
    json(sql) { const r = executer(`select coalesce(to_json((${sql})), 'null'::json);`); if (r.error) throw new Error(r.error.message); return r.data; },
    brut(sql) { return executer(sql); },
    storage: null,
  };
}

// Stockage de fichiers sur disque, avec la partie de l'API Storage de Supabase que le service utilise.
function creerStockageFichiers(racine) {
  fs.mkdirSync(racine, { recursive: true });
  const horloge = { ecriture: 0 };
  const chemin = (bucket, p) => path.join(racine, bucket, ...p.split('/').filter(Boolean));
  const blob = (tampon) => ({ arrayBuffer: async () => tampon.buffer.slice(tampon.byteOffset, tampon.byteOffset + tampon.byteLength), text: async () => tampon.toString('utf8') });
  return {
    racine,
    async listBuckets() { return { data: fs.existsSync(racine) ? fs.readdirSync(racine).map(name => ({ name })) : [], error: null }; },
    async createBucket(nom) { fs.mkdirSync(path.join(racine, nom), { recursive: true }); return { error: null }; },
    from(bucket) {
      return {
        async upload(p, contenu) { fs.mkdirSync(path.dirname(chemin(bucket, p)), { recursive: true }); fs.writeFileSync(chemin(bucket, p), contenu); horloge.ecriture++; return { error: null }; },
        async download(p) { try { return { data: blob(fs.readFileSync(chemin(bucket, p))), error: null }; } catch (e) { return { data: null, error: { message: 'Object not found' } }; } },
        async list(prefixe = '') {
          const dossier = chemin(bucket, prefixe);
          if (!fs.existsSync(dossier)) return { data: [], error: null };
          return { data: fs.readdirSync(dossier, { withFileTypes: true }).map(e => e.isDirectory()
            ? { name: e.name, id: null, metadata: null }
            : { name: e.name, id: e.name, created_at: new Date(fs.statSync(path.join(dossier, e.name)).mtimeMs).toISOString(), metadata: { size: fs.statSync(path.join(dossier, e.name)).size } }), error: null };
        },
        async remove(chemins) { for (const p of chemins) fs.rmSync(chemin(bucket, p), { force: true, recursive: true }); return { data: chemins, error: null }; },
      };
    },
  };
}

module.exports = { creerClientPg, creerStockageFichiers };
