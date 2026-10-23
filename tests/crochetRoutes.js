// tests/crochetRoutes.js — préchargé par tests/routes_enregistrees.test.js : note chaque route/middleware enregistré par server.js (méthode + chemin, dans l'ordre)
// et remplace firebase-admin par un faux, pour démarrer le VRAI server.js sans clés.
const express = require('express');
const journal = [];
for (const m of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
  const o = express.application[m];
  express.application[m] = function (...a) { if (m === 'get' && a.length === 1) return o.apply(this, a); journal.push(m.toUpperCase() + ' ' + (typeof a[0] === 'string' ? a[0] : '(fn)')); return o.apply(this, a); };
}
process.on('exit', () => require('fs').writeFileSync(process.env.SORTIE_JOURNAL, journal.join('\n')));
setTimeout(() => process.exit(0), 2500);
const Module = require('module'); const charge = Module._load;
Module._load = function (req, ...r) {
  if (req === 'firebase-admin/app') return { initializeApp() {}, cert: () => ({}) };
  if (req === 'firebase-admin/auth') return { getAuth: () => ({ verifyIdToken: async () => ({}), getUser: async () => ({}) }) };
  if (req === 'firebase-admin') { const f = { initializeApp() {}, credential: { cert: () => ({}) }, auth: () => ({ verifyIdToken: async () => ({}) }), apps: [] }; return f; }
  return charge.call(this, req, ...r);
};
