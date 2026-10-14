// tests/aides/fauxSupabase.js — mini Supabase en mémoire pour tester les routes (select/insert/upsert/update/delete, filtres usuels, rpc).
// Simule aussi une base « pas encore migrée » : colonnesAbsentes = { table: [colonnes] } → 42703 ; tablesAbsentes = [tables] → 42P01.
function creerFauxSupabase(tables = {}, { rpcs = {}, colonnesAbsentes = {}, tablesAbsentes = [] } = {}) {
  let compteur = 0;
  const journal = [];
  const lignes = (nom) => (tables[nom] = tables[nom] || []);
  const erreurTable = (nom) => (tablesAbsentes.includes(nom) ? { code: '42P01', message: `relation "public.${nom}" does not exist` } : null);
  const colonnesManquantes = (nom, cols) => (colonnesAbsentes[nom] || []).filter(c => cols.includes(c));

  function from(nom) {
    const etat = { filtres: [], op: 'select', colonnes: '*', valeur: null, tri: null, limite: null, plage: null, unique: null, onConflict: null };
    const q = {
      select(c = '*') { if (etat.op === 'select') etat.colonnes = c; return q; },
      insert(v) { etat.op = 'insert'; etat.valeur = v; return q; },
      upsert(v, o = {}) { etat.op = 'upsert'; etat.valeur = v; etat.onConflict = o.onConflict || 'id'; return q; },
      update(v) { etat.op = 'update'; etat.valeur = v; return q; },
      delete() { etat.op = 'delete'; return q; },
      eq(c, v) { etat.filtres.push(l => l[c] === v); return q; },
      neq(c, v) { etat.filtres.push(l => l[c] !== v); return q; },
      is(c, v) { etat.filtres.push(l => (v === null ? (l[c] === null || l[c] === undefined) : l[c] === v)); return q; },
      in(c, liste) { etat.filtres.push(l => liste.includes(l[c])); return q; },
      gte(c, v) { etat.filtres.push(l => l[c] >= v); return q; },
      order(c, o = {}) { etat.tri = { c, asc: o.ascending !== false }; return q; },
      limit(n) { etat.limite = n; return q; },
      range(a, b) { etat.plage = [a, b]; return q; },
      maybeSingle() { etat.unique = 'maybe'; return q; },
      single() { etat.unique = 'single'; return q; },
      then(resolve, reject) { return Promise.resolve(executer()).then(resolve, reject); },
    };
    function executer() {
      journal.push({ table: nom, op: etat.op, valeur: etat.valeur });
      const erreur = erreurTable(nom);
      if (erreur) return { data: null, error: erreur };
      const colsEcrites = etat.valeur ? Object.keys(Array.isArray(etat.valeur) ? (etat.valeur[0] || {}) : etat.valeur) : [];
      const colsLues = etat.colonnes === '*' ? [] : etat.colonnes.split(',').map(c => c.trim());
      const manquantes = colonnesManquantes(nom, [...colsEcrites, ...colsLues]);
      if (manquantes.length) return { data: null, error: { code: '42703', message: `column ${nom}.${manquantes[0]} does not exist` } };
      const t = lignes(nom);
      const correspond = (l) => etat.filtres.every(f => f(l));
      let data;
      if (etat.op === 'insert') {
        const ajout = (Array.isArray(etat.valeur) ? etat.valeur : [etat.valeur]).map(v => ({ id: v.id || `${nom}-${++compteur}`, ...v }));
        ajout.forEach(l => t.push(l)); data = ajout;
      } else if (etat.op === 'upsert') {
        data = (Array.isArray(etat.valeur) ? etat.valeur : [etat.valeur]).map(v => {
          const cles = etat.onConflict.split(',').map(c => c.trim());
          const existant = t.find(l => cles.every(c => l[c] === v[c]));
          if (existant) { Object.assign(existant, v); return existant; }
          const l = { ...v }; t.push(l); return l;
        });
      } else if (etat.op === 'update') {
        data = t.filter(correspond); data.forEach(l => Object.assign(l, etat.valeur));
      } else if (etat.op === 'delete') {
        data = t.filter(correspond); data.forEach(l => t.splice(t.indexOf(l), 1));
      } else {
        data = t.filter(correspond);
        if (etat.tri) data = [...data].sort((a, b) => (a[etat.tri.c] > b[etat.tri.c] ? 1 : a[etat.tri.c] < b[etat.tri.c] ? -1 : 0) * (etat.tri.asc ? 1 : -1));
        if (etat.plage) data = data.slice(etat.plage[0], etat.plage[1] + 1);
        if (etat.limite !== null) data = data.slice(0, etat.limite);
        data = data.map(l => ({ ...l }));
      }
      if (etat.unique) {
        if (data.length === 0) return etat.unique === 'single' ? { data: null, error: { code: 'PGRST116', message: 'no rows' } } : { data: null, error: null };
        return { data: data[0], error: null };
      }
      return { data, error: null };
    }
    return q;
  }
  async function rpc(nom, args) {
    journal.push({ rpc: nom, args });
    if (!rpcs[nom]) return { data: null, error: { code: '42883', message: `function ${nom} does not exist` } };
    return rpcs[nom](args, tables);
  }
  return { from, rpc, tables, journal };
}
module.exports = { creerFauxSupabase };
