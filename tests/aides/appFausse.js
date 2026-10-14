// tests/aides/appFausse.js — « app Express » minimale : enregistre les routes et permet de les appeler sans réseau.
function creerAppFausse() {
  const routes = [];
  const enregistrer = (methode) => (chemin, ...fns) => { routes.push({ methode, chemin, fn: fns[fns.length - 1] }); };
  const app = { get: enregistrer('GET'), post: enregistrer('POST'), put: enregistrer('PUT'), patch: enregistrer('PATCH'), delete: enregistrer('DELETE') };
  async function appeler(methode, url, { body = {}, user = { id: 'u1', email: 'admin@chf.com' } } = {}) {
    const [chemin, qs] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    for (const r of routes) {
      if (r.methode !== methode) continue;
      const noms = [];
      const motif = new RegExp('^' + r.chemin.replace(/:([a-zA-Z]+)/g, (_, n) => { noms.push(n); return '([^/]+)'; }) + '$');
      const m = motif.exec(chemin);
      if (!m) continue;
      const params = Object.fromEntries(noms.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const res = { code: 200, corps: undefined, status(c) { this.code = c; return this; }, json(b) { this.corps = b; return this; }, end() { return this; } };
      await r.fn({ body, query, params, user, headers: {}, get: () => null }, res);
      return res;
    }
    throw new Error(`Aucune route ${methode} ${chemin}`);
  }
  return { app, appeler, routes };
}
module.exports = { creerAppFausse };
