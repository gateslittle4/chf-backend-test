// tests/retrait_fiche_solde.test.js — retirer / corriger une fiche NE DOIT PAS laisser sa dette dans le solde du patient (22/10).
// Le solde d'un épisode est un total courant : chaque paiement porte (solde d'avant + ce qu'il ajoute), la dette due = celle du DERNIER paiement valide.
// La vraie fonction SQL (sql/retrait_fiche_solde.sql) tourne ici sur un vrai Postgres embarqué (pglite), avec la vraie règle de lecture du solde.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let PGlite = null;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { /* dépendance de test absente : tests ignorés */ }
const sauf = PGlite ? {} : { skip: 'Postgres embarqué (@electric-sql/pglite) non installé' };
const sqlRetrait = fs.readFileSync(path.join(__dirname, '..', 'sql', 'retrait_fiche_solde.sql'), 'utf8');

async function base() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE fiches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), episode_id uuid, supprime_le timestamptz);
    CREATE TABLE paiements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), episode_id uuid, fiche_id uuid, mode text, montant numeric DEFAULT 0,
      solde_restant numeric DEFAULT 0, date_paiement timestamptz NOT NULL DEFAULT now(), numero_paiement bigserial, annule boolean DEFAULT false, supprime_le timestamptz);`);
  await db.exec(sqlRetrait);
  let minute = 0;
  const fiche = async (episode) => (await db.query('insert into fiches (episode_id) values ($1) returning id', [episode])).rows[0].id;
  // Un paiement « comme le serveur l'écrit » : solde = solde du dernier paiement valide de l'épisode + ce que CE paiement ajoute (utils/paiementPartiel.js).
  const payer = async ({ episode, fiche: f = null, mode = 'cash', montant = 0, ajoute = 0, solde = null, annule = false }) => {
    const precedent = (await db.query(`select coalesce(solde_restant, 0) s from paiements where episode_id = $1 and (annule = false or annule is null) and supprime_le is null order by date_paiement desc, numero_paiement desc limit 1`, [episode])).rows[0];
    const s = solde !== null ? solde : (precedent ? Number(precedent.s) : 0) + ajoute;
    minute += 1;
    return (await db.query(`insert into paiements (episode_id, fiche_id, mode, montant, solde_restant, annule, date_paiement) values ($1,$2,$3,$4,$5,$6, timestamptz '2026-10-22 08:00:00+00' + ($7 || ' minutes')::interval) returning id`,
      [episode, f, mode, montant, s, annule, String(minute)])).rows[0].id;
  };
  const dette = async (episode) => Number(((await db.query(`select coalesce(solde_restant, 0) s from paiements where episode_id = $1 and (annule = false or annule is null) and supprime_le is null order by date_paiement desc, numero_paiement desc limit 1`, [episode])).rows[0] || { s: 0 }).s);
  const soldes = async (episode) => (await db.query(`select solde_restant s from paiements where episode_id = $1 and supprime_le is null order by date_paiement, numero_paiement`, [episode])).rows.map(r => Number(r.s));
  const retirer = async (f, ids) => (await db.query('select retirer_fiche_ajuster_solde($1::uuid, $2::uuid[]) r', [f, ids])).rows[0].r;
  const corbeille = async (table, id) => (await db.query(`select supprime_le from ${table} where id = $1`, [id])).rows[0].supprime_le !== null;
  return { db, fiche, payer, dette, soldes, retirer, corbeille };
}
const EP = '11111111-1111-1111-1111-111111111111';
const EP2 = '22222222-2222-2222-2222-222222222222';

test('fiche à crédit retirée, un paiement cash est venu après : la dette disparaît (avant : elle restait recopiée dans le paiement d\'après)', sauf, async () => {
  const b = await base();
  try {
    const f1 = await b.fiche(EP); const f2 = await b.fiche(EP);
    const credit = await b.payer({ episode: EP, fiche: f1, mode: 'credit', ajoute: 3000 });
    await b.payer({ episode: EP, fiche: f2, mode: 'cash', montant: 1500 });
    assert.strictEqual(await b.dette(EP), 3000, 'avant le retrait : le patient doit 3000');
    const r = await b.retirer(f1, [credit]);
    assert.strictEqual(r.dette_retiree, 3000);
    assert.strictEqual(r.paiements_ajustes, 1);
    assert.strictEqual(await b.dette(EP), 0, 'la fiche à crédit n\'existe plus : plus de dette');
    assert.ok(await b.corbeille('fiches', f1) && await b.corbeille('paiements', credit));
  } finally { await b.db.close(); }
});

test('deux dettes : retirer la première laisse la seconde, y compris dans les paiements d\'après', sauf, async () => {
  const b = await base();
  try {
    const f1 = await b.fiche(EP); const f2 = await b.fiche(EP); const f3 = await b.fiche(EP);
    const c1 = await b.payer({ episode: EP, fiche: f1, mode: 'credit', ajoute: 3000 });
    await b.payer({ episode: EP, fiche: f2, mode: 'credit', ajoute: 2000 });
    await b.payer({ episode: EP, fiche: f3, mode: 'cash', montant: 800 });
    assert.deepStrictEqual(await b.soldes(EP), [3000, 5000, 5000]);
    await b.retirer(f1, [c1]);
    assert.deepStrictEqual(await b.soldes(EP), [2000, 2000], 'reste la dette de la 2e fiche, partout');
    assert.strictEqual(await b.dette(EP), 2000);
  } finally { await b.db.close(); }
});

test('retirer la SECONDE dette laisse la première intacte, et rien ne change avant le paiement retiré', sauf, async () => {
  const b = await base();
  try {
    const f1 = await b.fiche(EP); const f2 = await b.fiche(EP);
    await b.payer({ episode: EP, fiche: f1, mode: 'credit', ajoute: 3000 });
    const c2 = await b.payer({ episode: EP, fiche: f2, mode: 'credit', ajoute: 2000 });
    const r = await b.retirer(f2, [c2]);
    assert.strictEqual(r.dette_retiree, 2000);
    assert.strictEqual(r.paiements_ajustes, 0);
    assert.deepStrictEqual(await b.soldes(EP), [3000]);
  } finally { await b.db.close(); }
});

test('paiement partiel : seul le RESTE à payer (pas le versé) est retiré de la dette', sauf, async () => {
  const b = await base();
  try {
    const f1 = await b.fiche(EP); const f2 = await b.fiche(EP);
    const partiel = await b.payer({ episode: EP, fiche: f1, mode: 'cash', montant: 1000, ajoute: 2000 }); // 1000 versés, 2000 restent dus
    await b.payer({ episode: EP, fiche: f2, mode: 'moncash', montant: 500 });
    const r = await b.retirer(f1, [partiel]);
    assert.strictEqual(r.dette_retiree, 2000);
    assert.strictEqual(await b.dette(EP), 0);
  } finally { await b.db.close(); }
});

test('fiche payée comptant, exonérée ou facturée au partenaire : la dette d\'autrui ne bouge pas', sauf, async () => {
  const b = await base();
  try {
    const f0 = await b.fiche(EP); const f1 = await b.fiche(EP); const f2 = await b.fiche(EP); const f3 = await b.fiche(EP);
    await b.payer({ episode: EP, fiche: f0, mode: 'credit', ajoute: 4000 });
    const cash = await b.payer({ episode: EP, fiche: f1, mode: 'cash', montant: 900 });
    const exo = await b.payer({ episode: EP, fiche: f2, mode: 'exoneration', montant: 0 });
    const ong = await b.payer({ episode: EP, fiche: f3, mode: 'ong', montant: 700 });
    for (const [f, p] of [[f1, cash], [f2, exo], [f3, ong]]) {
      const r = await b.retirer(f, [p]);
      assert.strictEqual(r.dette_retiree, 0);
      assert.strictEqual(r.paiements_ajustes, 0);
      assert.strictEqual(await b.dette(EP), 4000);
    }
  } finally { await b.db.close(); }
});

test('« Corriger » une fiche à crédit en fiche comptant : retirer puis refaire — la dette n\'est comptée ni deux fois ni du tout', sauf, async () => {
  const b = await base();
  try {
    const f1 = await b.fiche(EP);
    const credit = await b.payer({ episode: EP, fiche: f1, mode: 'credit', ajoute: 3000 });
    await b.retirer(f1, [credit]);
    const f1bis = await b.fiche(EP);
    await b.payer({ episode: EP, fiche: f1bis, mode: 'cash', montant: 3000 }); // le client paie finalement comptant
    assert.strictEqual(await b.dette(EP), 0);
    // et l'inverse : corriger une fiche comptant en crédit
    const f2 = await b.fiche(EP);
    const cash = await b.payer({ episode: EP, fiche: f2, mode: 'cash', montant: 2500 });
    await b.retirer(f2, [cash]);
    await b.payer({ episode: EP, fiche: await b.fiche(EP), mode: 'credit', ajoute: 2500 });
    assert.strictEqual(await b.dette(EP), 2500, 'dette comptée UNE fois');
  } finally { await b.db.close(); }
});

test('un remboursement de crédit est déjà passé après la dette : refus CHF11, rien n\'est écrit', sauf, async () => {
  const b = await base();
  try {
    const f1 = await b.fiche(EP);
    const credit = await b.payer({ episode: EP, fiche: f1, mode: 'credit', ajoute: 3000 });
    await b.payer({ episode: EP, mode: 'remboursement_credit', montant: 1000, solde: 2000 });
    await assert.rejects(b.retirer(f1, [credit]), (e) => /CHF11|remboursement/i.test(String(e.code || e.message)));
    assert.deepStrictEqual(await b.soldes(EP), [3000, 2000], 'aucun solde modifié');
    assert.strictEqual(await b.corbeille('fiches', f1), false);
    assert.strictEqual(await b.corbeille('paiements', credit), false);
  } finally { await b.db.close(); }
});

test('un remboursement AVANT la dette, ou sur une dette qui n\'est pas celle de la fiche retirée, ne bloque pas', sauf, async () => {
  const b = await base();
  try {
    const f0 = await b.fiche(EP); const f1 = await b.fiche(EP);
    await b.payer({ episode: EP, fiche: f0, mode: 'credit', ajoute: 1000 });
    await b.payer({ episode: EP, mode: 'remboursement_credit', montant: 400, solde: 600 });
    const cash = await b.payer({ episode: EP, fiche: f1, mode: 'cash', montant: 700 });
    const r = await b.retirer(f1, [cash]); // fiche comptant : contribution 0
    assert.strictEqual(r.dette_retiree, 0);
    assert.strictEqual(await b.dette(EP), 600);
  } finally { await b.db.close(); }
});

test('un paiement retiré qui est lui-même un remboursement de crédit : refus CHF12', sauf, async () => {
  const b = await base();
  try {
    const f1 = await b.fiche(EP);
    await b.payer({ episode: EP, mode: 'credit', ajoute: 1000 });
    const remb = await b.payer({ episode: EP, fiche: f1, mode: 'remboursement_credit', montant: 400, solde: 600 });
    await assert.rejects(b.retirer(f1, [remb]), (e) => /CHF12|remboursement/i.test(String(e.code || e.message)));
    assert.strictEqual(await b.dette(EP), 600);
  } finally { await b.db.close(); }
});

test('anciennes données incohérentes (crédit puis paiement à solde 0, avant le correctif du 01/09) : jamais de solde négatif', sauf, async () => {
  const b = await base();
  try {
    const f1 = await b.fiche(EP);
    const credit = await b.payer({ episode: EP, fiche: f1, mode: 'credit', ajoute: 800 });
    await b.payer({ episode: EP, mode: 'cash', montant: 100, solde: 0 }); // la dette avait « disparu » à l'époque
    await b.retirer(f1, [credit]);
    assert.deepStrictEqual(await b.soldes(EP), [0]);
  } finally { await b.db.close(); }
});

test('paiements annulés ou déjà à la corbeille : ignorés du calcul ; un autre épisode n\'est jamais touché', sauf, async () => {
  const b = await base();
  try {
    const f1 = await b.fiche(EP); const f2 = await b.fiche(EP2);
    await b.payer({ episode: EP2, fiche: f2, mode: 'credit', ajoute: 9000 });
    const credit = await b.payer({ episode: EP, fiche: f1, mode: 'credit', ajoute: 3000 });
    await b.payer({ episode: EP, mode: 'cash', montant: 10, solde: 123456, annule: true }); // annulé : n'est pas la référence
    await b.payer({ episode: EP, mode: 'cash', montant: 200 });
    await b.retirer(f1, [credit]);
    assert.strictEqual(await b.dette(EP), 0);
    assert.strictEqual(await b.dette(EP2), 9000);
    assert.strictEqual(Number((await b.db.query(`select solde_restant s from paiements where annule`)).rows[0].s), 123456, 'le paiement annulé n\'est pas réécrit');
  } finally { await b.db.close(); }
});

test('rejeu / double appel : la 2e fois ne retire plus rien (fiche déjà à la corbeille)', sauf, async () => {
  const b = await base();
  try {
    const f1 = await b.fiche(EP);
    const credit = await b.payer({ episode: EP, fiche: f1, mode: 'credit', ajoute: 3000 });
    await b.payer({ episode: EP, mode: 'cash', montant: 100 });
    await b.retirer(f1, [credit]);
    const encore = await b.retirer(f1, [credit]);
    assert.strictEqual(encore.deja_retiree, true);
    assert.strictEqual(await b.dette(EP), 0, 'pas de double soustraction');
  } finally { await b.db.close(); }
});

test('Achat Express : paiement relié à l\'épisode sans fiche_id — retiré avec la fiche ; un paiement qui n\'est ni de la fiche ni de l\'épisode n\'est pas touché', sauf, async () => {
  const b = await base();
  try {
    const f1 = await b.fiche(EP);
    const express = await b.payer({ episode: EP, fiche: null, mode: 'cash', montant: 600 });
    const etranger = await b.payer({ episode: EP2, mode: 'cash', montant: 50 });
    await b.retirer(f1, [express, etranger]);
    assert.ok(await b.corbeille('paiements', express));
    assert.strictEqual(await b.corbeille('paiements', etranger), false);
  } finally { await b.db.close(); }
});

test('fiche sans épisode (cas limite) : retirée sans erreur', sauf, async () => {
  const b = await base();
  try {
    const f = (await b.db.query('insert into fiches (episode_id) values (null) returning id')).rows[0].id;
    const r = await b.retirer(f, []);
    assert.strictEqual(r.deja_retiree, false);
    assert.ok(await b.corbeille('fiches', f));
  } finally { await b.db.close(); }
});
