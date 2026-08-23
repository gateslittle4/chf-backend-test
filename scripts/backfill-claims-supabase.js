// scripts/backfill-claims-supabase.js — Étape 2b du plan RLS (voir PLAN_RLS.md à la racine).
//
// Supabase Third-Party Auth exige que chaque utilisateur Firebase porte la revendication
// personnalisée `role: 'authenticated'` (nom malheureux — rien à voir avec les rôles CHF
// administrateur/direction/comptable/... stockés dans la table users ; c'est un simple
// marqueur que Supabase impose, identique pour tout le monde).
//
// Les NOUVEAUX comptes l'ont déjà automatiquement (voir server.js, POST /api/admin/users,
// qui appelle setCustomUserClaims à la création). Ce script rattrape UNE SEULE FOIS tous les
// comptes créés AVANT ce correctif.
//
// Prérequis : étape 2a (intégration Firebase ajoutée dans Supabase → Authentication →
// Third-Party Auth) déjà faite — sinon ce script tourne pour rien, la revendication ne sert
// à rien tant que Supabase ne fait pas confiance aux jetons Firebase.
//
// Utilisation : copier .env.example vers .env, remplir FIREBASE_SERVICE_ACCOUNT (même valeur
// que sur Render), puis :
//   node scripts/backfill-claims-supabase.js

require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT manquant dans .env (même format que pour server.js).');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });

async function backfillClaims() {
  let nextPageToken;
  let total = 0;
  let echecs = 0;
  do {
    const page = await getAuth().listUsers(1000, nextPageToken);
    for (const user of page.users) {
      try {
        await getAuth().setCustomUserClaims(user.uid, { role: 'authenticated' });
        console.log('OK', user.email || user.uid);
        total++;
      } catch (e) {
        console.error('ÉCHEC', user.email || user.uid, e.message);
        echecs++;
      }
    }
    nextPageToken = page.pageToken;
  } while (nextPageToken);
  console.log(`Terminé : ${total} compte(s) mis à jour${echecs ? `, ${echecs} échec(s)` : ''}.`);
}

backfillClaims().then(() => process.exit(0));
