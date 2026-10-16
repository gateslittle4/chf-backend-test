// Reproduit sauvegarderVersStorage() : toutes les lignes en mémoire -> JSON.stringify -> Buffer.from. Tailles de ligne = mesurées en production (JSON : épisode 784 o, fiche 787 o, paiement 658 o, dossier 513 o, audit 308 o).
const rows = (n, taille, extra = {}) => { const pad = 'x'.repeat(Math.max(0, taille - 160)); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = { id: '3f2b8c1e-5a7d-4e9a-b6c3-' + String(i).padStart(12, '0'), t: 'a'.repeat(20), d: '2026-10-14T17:28:01.504175+00:00', p: pad, ...extra }; return a; };
const mo = (o) => (o / 1048576).toFixed(0);
const echelles = [['1 an', 14000], ['2 ans', 28000], ['3 ans', 42000], ['5 ans', 70000]];
(async () => {
  for (const [nom, eps] of echelles) {
    global.gc && global.gc();
    const rss0 = process.memoryUsage().rss; let pic = rss0; const mesure = setInterval(() => { pic = Math.max(pic, process.memoryUsage().rss); }, 20);
    const t0 = Date.now();
    try {
      const contenu = { dossiers: rows(Math.round(eps / 1.75), 513), episodes: rows(eps, 784), fiches: rows(Math.round(eps * 2.3), 787), paiements: rows(Math.round(eps * 1.95), 658), audit_log: rows(Math.round(eps * 10.4), 308) };
      pic = Math.max(pic, process.memoryUsage().rss);
      const json = JSON.stringify(contenu); pic = Math.max(pic, process.memoryUsage().rss);
      const buf = Buffer.from(json); pic = Math.max(pic, process.memoryUsage().rss);
      console.log(`${nom.padEnd(6)} ${String(eps).padStart(6)} épisodes : fichier ${mo(buf.length).padStart(4)} Mo | mémoire du serveur au pire moment ${mo(pic).padStart(5)} Mo (512 Mo disponibles sur Render gratuit / Starter) | ${((Date.now() - t0) / 1000).toFixed(1)} s ${pic > 512 * 1048576 ? ' → SERVEUR TUÉ (mémoire)' : ''}`);
    } catch (e) { console.log(`${nom.padEnd(6)} ${String(eps).padStart(6)} épisodes : ÉCHEC — ${e.message}`); }
    clearInterval(mesure);
  }
})();
