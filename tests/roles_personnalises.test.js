// tests/roles_personnalises.test.js — rôles personnalisés (09/10, demande d'Esdras : « créer un rôle depuis
// l'app »). Ces tests EXÉCUTENT utils/roles.js : c'est la seule barrière côté serveur, l'écran n'étant qu'un
// confort et PUT /api/catalog/permissions étant atteignable directement.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const roles = require('../utils/roles');

const {
  verifierTablePermissions, appliquerMiseAJourPermissions, rolesInvitablesAvecPersonnalises, libelleRolePersonnalise,
  refusDeRoleParLaBase, formeComparable, normaliserLibelle, LIBELLES_INTEGRES, MAX_ROLES_PERSONNALISES,
  verifierRoleInvitation, etatBasePourRolesPersonnalises,
} = roles;

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function defautsDuServeur() {
  const debut = serverSrc.indexOf('const PERMISSIONS_PAR_DEFAUT = [');
  const fin = serverSrc.indexOf('\n];', debut) + 3;
  return new Function(serverSrc.slice(debut, fin).replace('const PERMISSIONS_PAR_DEFAUT =', 'return'))();
}
const DEFAUTS = defautsDuServeur();
const CLES_INTEGREES = new Set(['administrateur', ...DEFAUTS.map(r => r.role)]);
const ctx = (anciens = null) => ({ anciens, clesIntegrees: CLES_INTEGREES, defauts: DEFAUTS });

// Table « normale » : les rôles du code avec leurs droits par défaut.
const tableDuCode = () => DEFAUTS.map(r => ({ role: r.role, permissions: [...r.permissions] }));
const perso = (role, libelle, permissions = ['caisse_travailler']) => ({ role, libelle, personnalise: true, permissions });
const verifier = (items, anciens = null) => verifierTablePermissions(items, ctx(anciens));

// ---------------------------------------------------------------------------------------------------------
// Cas normaux
// ---------------------------------------------------------------------------------------------------------
test("Une table de rôles du code seuls est acceptée telle quelle (c'est ce que l'ancien écran envoyait)", () => {
  const r = verifier(tableDuCode());
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.crees, []);
  assert.deepStrictEqual(r.supprimes, []);
  assert.strictEqual(r.items.length, DEFAUTS.length);
});

test("Créer un rôle personnalisé : accepté, nom nettoyé, identifié comme créé, droits dédoublonnés", () => {
  const r = verifier([...tableDuCode(), perso('caissier_nuit', '  Caissier   de nuit ', ['caisse_travailler', 'caisse_travailler', 'episode_creer'])]);
  assert.strictEqual(r.ok, true);
  const e = r.items.find(x => x.role === 'caissier_nuit');
  assert.deepStrictEqual(e, { role: 'caissier_nuit', permissions: ['caisse_travailler', 'episode_creer'], libelle: 'Caissier de nuit', personnalise: true });
  assert.deepStrictEqual(r.crees, ['caissier_nuit']);
});

test("Un nom avec accents, apostrophe, parenthèses, tiret et emoji est accepté", () => {
  for (const nom of ['Pharmacien en chef (nuit)', "Infirmière d'urgence", '💊 Chef de pharmacie', 'Aide-soignant 2', 'Radiologie/Écho']) {
    assert.strictEqual(verifier([...tableDuCode(), perso('role_test', nom)]).ok, true, nom);
  }
});

test("Renommer et modifier les droits d'un rôle personnalisé existant : accepté et consigné", () => {
  const avant = [...tableDuCode(), perso('caissier_nuit', 'Caissier de nuit', ['caisse_travailler'])];
  const apres = [...tableDuCode(), perso('caissier_nuit', 'Caissier du soir', ['caisse_travailler', 'stock_voir'])];
  const r = verifier(apres, avant);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.renommes, [{ role: 'caissier_nuit', ancien: 'Caissier de nuit', nouveau: 'Caissier du soir' }]);
  assert.deepStrictEqual(r.modifies, [{ role: 'caissier_nuit', ajoutees: ['stock_voir'], retirees: [] }]);
  assert.deepStrictEqual(r.crees, []);
});

test("Un rôle peut garder son propre nom en le renvoyant tel quel (pas de faux conflit avec lui-même)", () => {
  const t = [...tableDuCode(), perso('caissier_nuit', 'Caissier de nuit')];
  assert.strictEqual(verifier(t, t).ok, true);
});

test("Journal des droits : la 1re sauvegarde compare aux droits PAR DÉFAUT (pas de bruit), l'administrateur n'est pas journalisé", () => {
  const r = verifier([...tableDuCode(), { role: 'administrateur', permissions: ['a_b', 'c_d'] }], null);
  assert.deepStrictEqual(r.modifies, [], "table identique aux défauts, administrateur ignoré : rien à journaliser");
  const t = tableDuCode(); t.find(x => x.role === 'pharmacien').permissions.push('stock_gerer');
  assert.deepStrictEqual(verifier(t, null).modifies, [{ role: 'pharmacien', ajoutees: ['stock_gerer'], retirees: [] }]);
});

// ---------------------------------------------------------------------------------------------------------
// Usurpation et entrées sauvages
// ---------------------------------------------------------------------------------------------------------
test("Impossible de créer un rôle personnalisé qui porte la clé d'un rôle du code — administrateur compris", () => {
  for (const cle of ['administrateur', 'direction', 'medecin', 'pharmacien_chef', 'visiteur']) {
    const r = verifier([...tableDuCode().filter(e => e.role !== cle), perso(cle, 'Un autre nom')]);
    assert.strictEqual(r.ok, false, cle);
    assert.strictEqual(r.status, 400, cle);
  }
});

test("Une NOUVELLE clé doit être déclarée personnalisée : pas d'entrée « sauvage » glissée sans les contrôles", () => {
  const r = verifier([...tableDuCode(), { role: 'chef_secret', permissions: ['utilisateurs_gerer'] }]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /n'existe pas/);
});

test("Une entrée héritée (enregistrée avant ce module, rôle disparu du code) est conservée telle quelle, sans libellé", () => {
  const anciens = [...tableDuCode(), { role: 'caissier', permissions: ['caisse_travailler'] }];
  const r = verifier([...tableDuCode(), { role: 'caissier', permissions: ['caisse_travailler'], libelle: 'Ignoré', autre: 1 }], anciens);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.items.find(e => e.role === 'caissier'), { role: 'caissier', permissions: ['caisse_travailler'] });
  // Et son retrait n'est pas une « suppression de rôle personnalisé » : rien à garder.
  const sans = verifier(tableDuCode(), anciens);
  assert.strictEqual(sans.ok, true);
  assert.deepStrictEqual(sans.supprimes, []);
});

test("Un rôle du code ne peut pas non plus se déclarer personnalisé ni porter un nom d'affichage", () => {
  const t = tableDuCode().map(e => e.role === 'infirmier' ? { ...e, personnalise: true, libelle: 'Infirmier' } : e);
  assert.strictEqual(verifier(t).ok, false);
  const t2 = tableDuCode().map(e => e.role === 'infirmier' ? { ...e, libelle: 'Truc' } : e);
  assert.deepStrictEqual(verifier(t2).items.find(e => e.role === 'infirmier'), { role: 'infirmier', permissions: DEFAUTS.find(d => d.role === 'infirmier').permissions });
});

test("Un rôle personnalisé ne peut pas perdre son statut (ni être « converti » en entrée ordinaire)", () => {
  const avant = [...tableDuCode(), perso('caissier_nuit', 'Caissier de nuit')];
  const r = verifier([...tableDuCode(), { role: 'caissier_nuit', permissions: ['caisse_travailler'] }], avant);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /rôle personnalisé/);
});

test("Aucun champ libre n'est enregistré : seuls role, permissions, libelle et personnalise survivent", () => {
  const r = verifier([...tableDuCode(), { ...perso('caissier_nuit', 'Caissier de nuit'), estAdmin: true, couleur: '#f00', __proto__: { x: 1 } }]);
  assert.deepStrictEqual(Object.keys(r.items.find(e => e.role === 'caissier_nuit')).sort(), ['libelle', 'permissions', 'personnalise', 'role']);
});

test("Clés techniques invalides refusées (majuscules, chiffre au début, tirets bas mal placés, espaces, trop court/long, caractères spéciaux)", () => {
  const invalides = ['Caissier', '1caissier', 'caissier_', '_caissier', 'cais__sier', 'caissier nuit', 'ca', 'a'.repeat(31), 'caissier-nuit', 'caïssier', 'caissier;drop', '../caissier', ''];
  for (const cle of invalides) {
    assert.strictEqual(verifier([...tableDuCode(), perso(cle, 'Un nom correct')]).ok, false, JSON.stringify(cle));
  }
  // Limites acceptées : 3 et 30 caractères.
  assert.strictEqual(verifier([...tableDuCode(), perso('abc', 'Un nom correct')]).ok, true);
  assert.strictEqual(verifier([...tableDuCode(), perso('a' + 'b'.repeat(29), 'Un nom correct')]).ok, true);
});

test("Mots réservés (constructor, null, undefined...) refusés comme identifiant ; les autres clés « ressemblantes » n'abîment rien", () => {
  for (const cle of roles.CLES_RESERVEES) {
    const r = verifier([...tableDuCode(), perso(cle, 'Un nom correct')]);
    assert.strictEqual(r.ok, false, cle);
    assert.match(r.error, /réservé|invalide/, cle);
  }
  for (const cle of ['tostring', 'valueof', 'hasownproperty']) {
    assert.strictEqual(verifier([...tableDuCode(), perso(cle, 'Un nom correct')]).ok, true, cle);
  }
  assert.strictEqual({}.polluee, undefined);
});

// ---------------------------------------------------------------------------------------------------------
// Noms d'affichage
// ---------------------------------------------------------------------------------------------------------
test("Noms refusés : HTML, guillemets, retours à la ligne, caractères invisibles ou de direction, trop courts/longs", () => {
  const mauvais = [
    '<b>Chef</b>', 'Chef "des" ventes', 'Chef\u200Bcaisse', 'Chef\u202Ecaisse', 'Chef\u0000caisse', 'Chef`caisse', 'A&B caisse',
    'ab', 'x'.repeat(41), '   ', '--', '💊💊', 'Chef <script>alert(1)</script>',
  ];
  for (const nom of mauvais) {
    assert.strictEqual(verifier([...tableDuCode(), perso('role_test', nom)]).ok, false, JSON.stringify(nom));
  }
});

test("Un nom ne peut pas ressembler à celui d'un autre rôle : mêmes lettres sans accent, sans majuscule, sans emoji", () => {
  for (const nom of ['MÉDECIN', 'medecin', '🩺 Médecin', 'pharmacien en chef', 'Pharmacien  en   chef', 'ADMINISTRATEUR', 'Infirmier en chef.']) {
    const r = verifier([...tableDuCode(), perso('role_test', nom)]);
    assert.strictEqual(r.ok, false, nom);
    assert.strictEqual(r.status, 409, nom);
  }
  const t = [...tableDuCode(), perso('role_un', 'Caissier de nuit')];
  const r = verifier([...t, perso('role_deux', 'caissier DE nuit')]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 409);
});

test("formeComparable / normaliserLibelle : accents, casse, ponctuation, espaces", () => {
  assert.strictEqual(formeComparable('  💊 Pharmacien-en  CHEF! '), 'pharmacien en chef');
  assert.strictEqual(normaliserLibelle('  a \u00A0 b\n c '), 'a b c');
  assert.strictEqual(normaliserLibelle(null), '');
});

test("Les noms du serveur pour les rôles du code couvrent exactement les rôles du code (sinon un homonyme passerait)", () => {
  assert.deepStrictEqual(Object.keys(LIBELLES_INTEGRES).sort(), [...CLES_INTEGREES].sort());
});

// ---------------------------------------------------------------------------------------------------------
// Droits, bornes, doublons
// ---------------------------------------------------------------------------------------------------------
test("Droits invalides refusés : pas un tableau, noms non conformes, trop nombreux", () => {
  assert.strictEqual(verifier([...tableDuCode(), { ...perso('role_test', 'Un nom correct'), permissions: 'tout' }]).ok, false);
  for (const mauvais of ['Caisse', 'caisse travailler', 'caisse;drop', 1, null, '']) {
    assert.strictEqual(verifier([...tableDuCode(), { ...perso('role_test', 'Un nom correct'), permissions: [mauvais] }]).ok, false, JSON.stringify(mauvais));
  }
  const beaucoup = Array.from({ length: 201 }, (_, i) => `droit_${i}`);
  assert.strictEqual(verifier([...tableDuCode(), { ...perso('role_test', 'Un nom correct'), permissions: beaucoup }]).ok, false);
});

test("Un rôle en double dans la table est refusé ; les entrées illisibles aussi", () => {
  assert.strictEqual(verifier([...tableDuCode(), perso('role_test', 'Un nom'), perso('role_test', 'Un autre')]).ok, false);
  for (const bizarre of [null, 3, 'texte', [], {}, { role: 5, permissions: [] }, { role: '', permissions: [] }, { role: 'a\nb', permissions: [] }]) {
    assert.strictEqual(verifier([...tableDuCode(), bizarre]).ok, false, JSON.stringify(bizarre));
  }
  assert.strictEqual(verifier('pas un tableau').ok, false);
  assert.strictEqual(verifier(undefined).ok, false);
});

test(`Au plus ${MAX_ROLES_PERSONNALISES} rôles personnalisés`, () => {
  const rolesN = (n) => Array.from({ length: n }, (_, i) => perso(`role_numero_${i}`, `Rôle numéro ${i}`));
  assert.strictEqual(verifier([...tableDuCode(), ...rolesN(MAX_ROLES_PERSONNALISES)]).ok, true);
  assert.strictEqual(verifier([...tableDuCode(), ...rolesN(MAX_ROLES_PERSONNALISES + 1)]).ok, false);
});

// ---------------------------------------------------------------------------------------------------------
// Invitations et affichage
// ---------------------------------------------------------------------------------------------------------
test("Rôles invitables : ceux du code + les rôles personnalisés valides ; jamais administrateur, jamais de doublon", () => {
  const invitables = ['direction', 'medecin'];
  const table = [
    ...tableDuCode(), perso('caissier_nuit', 'Caissier de nuit'), { role: 'caissier', permissions: [] },
    { role: 'administrateur', personnalise: true, libelle: 'Admin bis', permissions: [] }, perso('medecin', 'Doublon'),
    perso('Mauvaise Cle', 'Clé invalide'),
  ];
  assert.deepStrictEqual(rolesInvitablesAvecPersonnalises(invitables, table), ['direction', 'medecin', 'caissier_nuit']);
  assert.deepStrictEqual(rolesInvitablesAvecPersonnalises(invitables, null), invitables);
});

test("libelleRolePersonnalise : le nom d'un rôle personnalisé, null pour un rôle du code ou inconnu", () => {
  const table = [...tableDuCode(), perso('caissier_nuit', 'Caissier de nuit')];
  assert.strictEqual(libelleRolePersonnalise('caissier_nuit', table), 'Caissier de nuit');
  assert.strictEqual(libelleRolePersonnalise('medecin', table), null);
  assert.strictEqual(libelleRolePersonnalise('inconnu', table), null);
  assert.strictEqual(libelleRolePersonnalise('caissier_nuit', null), null);
});

test("refusDeRoleParLaBase reconnaît le refus de users_role_check (et rien d'autre)", () => {
  assert.strictEqual(refusDeRoleParLaBase({ code: '23514', message: 'new row for relation "users" violates check constraint "users_role_check"' }), true);
  assert.strictEqual(refusDeRoleParLaBase({ code: '23514', message: 'violates check constraint "paiements_mode_check"' }), false);
  assert.strictEqual(refusDeRoleParLaBase({ code: '23505', message: 'users_role_check' }), false);
  assert.strictEqual(refusDeRoleParLaBase(null), false);
});

// ---------------------------------------------------------------------------------------------------------
// Enregistrement complet (avec une fausse base)
// ---------------------------------------------------------------------------------------------------------
// rpc : ce que répond le garde-fou roles_personnalises_actifs() (par défaut « oui », comme une base où le script SQL est collé).
const BASE_PRETE = { data: true, error: null };
function fauxSupabase({ catalogue = null, comptes = [], erreurLecture = null, erreurEcriture = null, erreurAudit = null, ecritureVide = false, rpc = BASE_PRETE } = {}) {
  const appels = { upserts: [], audits: [], requetesComptes: [], rpc: [] };
  return {
    appels,
    rpc: async (nom) => { appels.rpc.push(nom); return rpc; },
    from(table) {
      if (table === 'catalog') return {
        select: () => ({ eq: () => ({ maybeSingle: async () => (erreurLecture ? { data: null, error: { message: erreurLecture } } : { data: catalogue ? { items: catalogue } : null, error: null }) }) }),
        upsert: (ligne) => ({ select: async () => { appels.upserts.push(ligne); return erreurEcriture ? { data: null, error: { message: erreurEcriture } } : { data: ecritureVide ? [] : [ligne], error: null }; } }),
      };
      if (table === 'users') return { select: () => ({ in: async (_col, valeurs) => { appels.requetesComptes.push(valeurs); return { data: comptes.filter(c => valeurs.includes(c.role)), error: null }; } }) };
      if (table === 'audit_log') return { insert: async (lignes) => { appels.audits.push(...lignes); return { error: erreurAudit ? { message: erreurAudit } : null }; } };
      throw new Error('table inattendue : ' + table);
    },
  };
}
let compteurId = 0;
const appliquer = (items, supabase) => appliquerMiseAJourPermissions({
  items, supabase, utilisateur: { id: 'uid-admin', email: 'admin@chf.com' }, clesIntegrees: CLES_INTEGREES, defauts: DEFAUTS, genererId: () => `id-${++compteurId}`,
});

test("Enregistrer la création d'un rôle : écrit la table normalisée et consigne « creation_role » avec qui, quoi et ses droits", async () => {
  const base = fauxSupabase({ catalogue: tableDuCode() });
  const r = await appliquer([...tableDuCode(), perso('caissier_nuit', ' Caissier de nuit ', ['caisse_travailler'])], base);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { success: true });
  assert.strictEqual(base.appels.upserts.length, 1);
  assert.strictEqual(base.appels.upserts[0].type, 'permissions');
  assert.strictEqual(base.appels.upserts[0].items.find(e => e.role === 'caissier_nuit').libelle, 'Caissier de nuit');
  assert.strictEqual(base.appels.audits.length, 1);
  assert.deepStrictEqual(
    { action: base.appels.audits[0].action, par: base.appels.audits[0].effectue_par, uid: base.appels.audits[0].effectue_par_uid, details: base.appels.audits[0].details },
    { action: 'creation_role', par: 'admin@chf.com', uid: 'uid-admin', details: { role: 'caissier_nuit', libelle: 'Caissier de nuit', permissions: ['caisse_travailler'] } });
});

test("Supprimer un rôle ENCORE ATTRIBUÉ est refusé (409), rien n'est écrit, et le message dit qui l'a", async () => {
  const avant = [...tableDuCode(), perso('caissier_nuit', 'Caissier de nuit')];
  const base = fauxSupabase({ catalogue: avant, comptes: [{ id: 'u1', display_name: 'Marie', role: 'caissier_nuit' }, { id: 'u2', email: 'paul@chf.com', role: 'caissier_nuit' }] });
  const r = await appliquer(tableDuCode(), base);
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /caissier_nuit/);
  assert.match(r.body.error, /2 compte\(s\)/);
  assert.match(r.body.error, /Marie, paul@chf\.com/);
  assert.strictEqual(base.appels.upserts.length, 0, "aucune écriture : les comptes garderaient un rôle sans droits");
  assert.strictEqual(base.appels.audits.length, 0);
});

test("Supprimer un rôle que personne n'a : accepté et consigné « suppression_role »", async () => {
  const avant = [...tableDuCode(), perso('caissier_nuit', 'Caissier de nuit')];
  const base = fauxSupabase({ catalogue: avant, comptes: [] });
  const r = await appliquer(tableDuCode(), base);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(base.appels.requetesComptes, [['caissier_nuit']]);
  assert.deepStrictEqual(base.appels.audits.map(a => a.action), ['suppression_role']);
  assert.strictEqual(base.appels.upserts[0].items.some(e => e.role === 'caissier_nuit'), false);
});

test("Un enregistrement sans rôle supprimé ne regarde même pas les comptes", async () => {
  const base = fauxSupabase({ catalogue: tableDuCode() });
  await appliquer(tableDuCode(), base);
  assert.deepStrictEqual(base.appels.requetesComptes, []);
});

test("Table refusée : rien n'est écrit ni consigné (400/409) ; erreurs de la base : 500", async () => {
  const base = fauxSupabase({ catalogue: tableDuCode() });
  const r = await appliquer([...tableDuCode(), perso('administrateur', 'Pirate')], base);
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual([base.appels.upserts.length, base.appels.audits.length], [0, 0]);
  assert.strictEqual((await appliquer(tableDuCode(), fauxSupabase({ erreurLecture: 'panne' }))).status, 500);
  const base2 = fauxSupabase({ catalogue: tableDuCode(), erreurEcriture: 'refus' });
  assert.strictEqual((await appliquer(tableDuCode(), base2)).status, 500);
  assert.strictEqual(base2.appels.audits.length, 0, "pas de journal pour un changement qui n'a pas eu lieu");
  assert.strictEqual((await appliquer(tableDuCode(), fauxSupabase({ catalogue: tableDuCode(), ecritureVide: true }))).status, 500, "0 ligne écrite = échec, pas un succès silencieux");
});

test("Un journal d'audit qui refuse la ligne n'annule pas un changement déjà écrit", async () => {
  const base = fauxSupabase({ catalogue: tableDuCode(), erreurAudit: 'journal plein' });
  const r = await appliquer([...tableDuCode(), perso('caissier_nuit', 'Caissier de nuit')], base);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(base.appels.upserts.length, 1);
});

test("Première sauvegarde (rien d'enregistré avant) : acceptée, sans suppression ni bruit d'audit", async () => {
  const base = fauxSupabase({ catalogue: null });
  const r = await appliquer(tableDuCode(), base);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(base.appels.audits.length, 0);
});

// ---------------------------------------------------------------------------------------------------------
// Garde-fou : la base doit accepter les rôles créés depuis l'écran AVANT qu'on en crée un
// (sinon un compte de connexion pouvait être créé sans profil, puis recevoir le rôle « auditeur » à sa 1re connexion)
// ---------------------------------------------------------------------------------------------------------
const AVEC_NOUVEAU_ROLE = () => [...tableDuCode(), perso('caissier_nuit', 'Caissier de nuit')];
const PAS_PRETE = { data: false, error: null };
const fonctionAbsente = (code, message) => ({ data: null, error: { code, message } });

test("Créer un rôle alors que le script SQL n'est pas collé : refusé (409) AVANT toute écriture, avec le message qui dit quoi faire", async () => {
  const base = fauxSupabase({ catalogue: tableDuCode(), rpc: PAS_PRETE });
  const r = await appliquer(AVEC_NOUVEAU_ROLE(), base);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, roles.MESSAGE_SQL_AVANT_CREATION);
  assert.match(r.body.error, /roles_personnalises\.sql/);
  assert.deepStrictEqual(base.appels.rpc, ['roles_personnalises_actifs']);
  assert.deepStrictEqual([base.appels.upserts.length, base.appels.audits.length], [0, 0], 'rien écrit, rien consigné');
});

test("Fonction du garde-fou absente (script jamais collé) : même verdict que « pas prête » — codes 42883 et PGRST202, ou message de la base", async () => {
  const absences = [
    fonctionAbsente('42883', 'function public.roles_personnalises_actifs() does not exist'),
    fonctionAbsente('PGRST202', 'Could not find the function public.roles_personnalises_actifs without parameters in the schema cache'),
    fonctionAbsente(undefined, 'Could not find the function public.roles_personnalises_actifs'),
    fonctionAbsente(undefined, 'function roles_personnalises_actifs() DOES NOT EXIST'),
  ];
  for (const rpc of absences) {
    const base = fauxSupabase({ catalogue: tableDuCode(), rpc });
    const r = await appliquer(AVEC_NOUVEAU_ROLE(), base);
    assert.strictEqual(r.status, 409, JSON.stringify(rpc));
    assert.strictEqual(base.appels.upserts.length, 0, JSON.stringify(rpc));
  }
});

test("Seule la réponse « true » ouvre la création : null, texte, nombre, tableau ou réponse vide comptent comme « pas prête »", async () => {
  for (const data of [null, undefined, 'true', 't', 1, [], {}, [true]]) {
    const base = fauxSupabase({ catalogue: tableDuCode(), rpc: { data, error: null } });
    const r = await appliquer(AVEC_NOUVEAU_ROLE(), base);
    assert.strictEqual(r.status, 409, JSON.stringify(data));
    assert.strictEqual(base.appels.upserts.length, 0, JSON.stringify(data));
  }
  const base = fauxSupabase({ catalogue: tableDuCode(), rpc: BASE_PRETE });
  assert.strictEqual((await appliquer(AVEC_NOUVEAU_ROLE(), base)).status, 200);
});

test("Garde-fou illisible pour une autre raison (base injoignable, droit refusé, délai dépassé) : erreur 500 claire, rien n'écrit — jamais un faux « prête »", async () => {
  const pannes = [
    { message: 'fetch failed' },
    { code: '08006', message: 'connection failure' },
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { code: '42501', message: 'permission denied for function roles_personnalises_actifs' },
    { code: '42P01', message: 'relation "public.users" does not exist' },
  ];
  for (const erreur of pannes) {
    const base = fauxSupabase({ catalogue: tableDuCode(), rpc: { data: null, error: erreur } });
    const r = await appliquer(AVEC_NOUVEAU_ROLE(), base);
    assert.strictEqual(r.status, 500, JSON.stringify(erreur));
    assert.match(r.body.error, /Vérification de la base impossible/);
    assert.strictEqual(base.appels.upserts.length, 0, JSON.stringify(erreur));
  }
});

test("etatBasePourRolesPersonnalises : prête / pas prête / erreur — y compris quand l'appel lui-même plante", async () => {
  const etat = (reponse) => etatBasePourRolesPersonnalises({ rpc: async (nom) => { assert.strictEqual(nom, 'roles_personnalises_actifs'); return reponse; } });
  assert.deepStrictEqual(await etat({ data: true, error: null }), { pret: true });
  assert.deepStrictEqual(await etat({ data: false, error: null }), { pret: false });
  assert.deepStrictEqual(await etat(fonctionAbsente('42883', 'x')), { pret: false });
  assert.deepStrictEqual(await etat(fonctionAbsente('PGRST202', 'x')), { pret: false });
  const panne = { message: 'fetch failed' };
  assert.deepStrictEqual(await etat({ data: null, error: panne }), { erreur: panne });
  // Une autre « inexistence » (table, rôle de la base...) n'est PAS prise pour une fonction absente.
  const autre = { code: '42P01', message: 'relation "public.users" does not exist' };
  assert.deepStrictEqual(await etat({ data: null, error: autre }), { erreur: autre });
  assert.deepStrictEqual(await etat(undefined), { pret: false }, 'réponse vide : jamais « prête »');
  const plante = await etatBasePourRolesPersonnalises({ rpc: async () => { throw new Error('socket hang up'); } });
  assert.deepStrictEqual(plante, { erreur: { message: 'socket hang up' } });
});

test("Le garde-fou ne bloque QUE la création : droits, renommage et suppression s'enregistrent même si le script n'est pas collé (la base n'est pas interrogée)", async () => {
  const avant = [...tableDuCode(), perso('caissier_nuit', 'Caissier de nuit'), perso('chef_nuit', 'Chef de nuit')];
  const droits = avant.map(e => (e.role === 'caissier_nuit' ? { ...e, permissions: ['caisse_travailler', 'stock_voir'] } : e));
  const renomme = avant.map(e => (e.role === 'caissier_nuit' ? { ...e, libelle: 'Caissier du soir' } : e));
  const supprime = avant.filter(e => e.role !== 'chef_nuit');
  for (const [nom, apres] of [['droits', droits], ['renommage', renomme], ['suppression', supprime]]) {
    const base = fauxSupabase({ catalogue: avant, rpc: PAS_PRETE });
    const r = await appliquer(apres, base);
    assert.strictEqual(r.status, 200, nom);
    assert.deepStrictEqual(base.appels.rpc, [], `${nom} : pas de question à la base`);
    assert.strictEqual(base.appels.upserts.length, 1, nom);
  }
});

test("Ordre des contrôles : table refusée (400) ou suppression bloquée (409) répondent SANS interroger le garde-fou", async () => {
  const b1 = fauxSupabase({ catalogue: tableDuCode(), rpc: PAS_PRETE });
  assert.strictEqual((await appliquer([...tableDuCode(), perso('administrateur', 'Pirate')], b1)).status, 400);
  assert.deepStrictEqual(b1.appels.rpc, []);
  // Suppression bloquée ET création dans la même sauvegarde : la suppression bloquée répond d'abord.
  const avant = [...tableDuCode(), perso('chef_nuit', 'Chef de nuit')];
  const b2 = fauxSupabase({ catalogue: avant, comptes: [{ id: 'u1', role: 'chef_nuit' }], rpc: PAS_PRETE });
  const r = await appliquer(AVEC_NOUVEAU_ROLE(), b2);
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /Impossible de supprimer/);
  assert.deepStrictEqual(b2.appels.rpc, []);
});

test("Plusieurs rôles créés d'un coup : une seule question à la base, une seule écriture, un journal par rôle", async () => {
  const base = fauxSupabase({ catalogue: tableDuCode() });
  const r = await appliquer([...tableDuCode(), perso('role_un', 'Rôle un'), perso('role_deux', 'Rôle deux')], base);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(base.appels.rpc, ['roles_personnalises_actifs']);
  assert.strictEqual(base.appels.upserts.length, 1);
  assert.deepStrictEqual(base.appels.audits.map(a => a.action), ['creation_role', 'creation_role']);
});

test("verifierRoleInvitation : rôle du code accepté sans interroger la base ; rôle créé accepté seulement si la base est prête ; administrateur et inconnus refusés", async () => {
  const invitables = ['direction', 'medecin', 'pharmacien'];
  const table = [...tableDuCode(), perso('caissier_nuit', 'Caissier de nuit')];
  const decision = async (role, rpc, t = table) => {
    const base = fauxSupabase({ rpc });
    return { r: await verifierRoleInvitation({ role, invitablesIntegres: invitables, table: t, supabase: base }), base };
  };
  let d = await decision('medecin', PAS_PRETE);
  assert.strictEqual(d.r, null);
  assert.deepStrictEqual(d.base.appels.rpc, [], 'un rôle du code ne dépend pas du script SQL');
  d = await decision('caissier_nuit', BASE_PRETE);
  assert.strictEqual(d.r, null);
  assert.deepStrictEqual(d.base.appels.rpc, ['roles_personnalises_actifs']);
  d = await decision('caissier_nuit', PAS_PRETE);
  assert.deepStrictEqual(d.r, { status: 409, error: roles.MESSAGE_SQL_ROLES_PERSONNALISES });
  d = await decision('caissier_nuit', fonctionAbsente('42883', 'x'));
  assert.strictEqual(d.r.status, 409);
  d = await decision('caissier_nuit', { data: null, error: { message: 'fetch failed' } });
  assert.strictEqual(d.r.status, 500);
  assert.match(d.r.error, /fetch failed/);
  for (const role of ['administrateur', 'inconnu', undefined, null, '', 'caissier_nuit ', 'CAISSIER_NUIT', 42, {}, ['caissier_nuit']]) {
    d = await decision(role, BASE_PRETE);
    assert.strictEqual(d.r && d.r.status, 400, JSON.stringify(role));
    assert.deepStrictEqual(d.base.appels.rpc, [], 'refusé sans interroger la base');
  }
  // Même si la table contient une entrée « personnalisée » nommée administrateur : jamais invitable.
  d = await decision('administrateur', BASE_PRETE, [...table, { role: 'administrateur', personnalise: true, libelle: 'Admin bis', permissions: [] }]);
  assert.strictEqual(d.r.status, 400);
  // Table absente : seuls les rôles du code restent invitables.
  d = await decision('caissier_nuit', BASE_PRETE, null);
  assert.strictEqual(d.r.status, 400);
  d = await decision('direction', BASE_PRETE, null);
  assert.strictEqual(d.r, null);
});

// ---------------------------------------------------------------------------------------------------------
// Câblage dans server.js
// ---------------------------------------------------------------------------------------------------------
test("server.js : la table des permissions ne s'écrit que par utils/roles.js, AVANT l'écriture générique du catalogue", () => {
  const route = serverSrc.slice(serverSrc.indexOf("app.put('/api/catalog/:type'"), serverSrc.indexOf("app.post('/api/catalog/:type/item'"));
  // Le bloc d'enregistrement (et non le 1er « type === 'permissions' » de la route, qui sert au contrôle du droit).
  const debutBloc = route.search(/if \(type === 'permissions'\) \{\s*const resultat = await appliquerMiseAJourPermissions\(\{/);
  const posUpsertGenerique = route.indexOf(".upsert({ type, items,");
  assert.ok(debutBloc > 0 && posUpsertGenerique > debutBloc, "le cas 'permissions' doit répondre AVANT l'upsert générique");
  assert.match(route.slice(debutBloc, posUpsertGenerique), /clesIntegrees: new Set\(\['administrateur', \.\.\.PERMISSIONS_PAR_DEFAUT\.map\(r => r\.role\)\]\)[\s\S]*return res\.status\(resultat\.status\)\.json\(resultat\.body\);\s*\}/);
  // La permission requise pour cet écran n'a pas changé.
  assert.match(route, /type === 'permissions'\) \{\s*permissionOk = await aPermission\(req\.user\.id, 'permissions_gerer'\);/);
});

test("server.js : l'invitation passe par verifierRoleInvitation (rôles du code + rôles créés, administrateur exclu) et répond AVANT de fabriquer le lien ; la page d'invitation reçoit le nom du rôle", () => {
  const creation = serverSrc.slice(serverSrc.indexOf("app.post('/api/admin/invitations'"), serverSrc.indexOf("app.get('/api/admin/roles-personnalises/pret'"));
  const posRole = creation.indexOf('verifierRoleInvitation({ role, invitablesIntegres: ROLES_INVITABLES, table: lectureRoles.table, supabase })');
  const posRefus = creation.indexOf('if (refusRole) return res.status(refusRole.status).json({ error: refusRole.error });');
  const posInsertion = creation.indexOf(".from('invitations').insert(");
  assert.ok(posRole > 0 && posRefus > posRole && posInsertion > posRefus, 'le rôle est vérifié, et refusé, AVANT de fabriquer le lien');
  assert.doesNotMatch(creation, /ROLES_INVITABLES\.includes\(role\)/, "l'ancienne liste fixe ne doit plus décider seule");
  const page = serverSrc.slice(serverSrc.indexOf("app.get('/invitation/:token'"), serverSrc.indexOf("app.post('/invitation/:token/creer-compte'"));
  assert.match(page, /role_libelle: roleLibelle/);
  assert.match(page, /libelleRolePersonnalise\(invitation\.role, lectureRoles\.table\)/);
});

test("server.js : GET /api/admin/roles-personnalises/pret exige utilisateurs_gerer AVANT d'interroger la base, puis répond { pret }", () => {
  const debut = serverSrc.indexOf("app.get('/api/admin/roles-personnalises/pret'");
  assert.ok(debut > 0, 'la route doit exister');
  const route = serverSrc.slice(debut, serverSrc.indexOf("app.get('/api/admin/invitations'", debut));
  const posDroit = route.indexOf("aPermission(req.user.id, 'utilisateurs_gerer')");
  const posBase = route.indexOf('etatBasePourRolesPersonnalises(supabase)');
  assert.ok(posDroit > 0 && posBase > posDroit, "le droit est vérifié avant toute question à la base");
  assert.match(route.slice(posDroit, posBase), /status\(403\)/);
  assert.match(route, /if \(etat\.erreur\) return res\.status\(500\)/);
  assert.match(route, /res\.json\(\{ pret: etat\.pret \}\)/);
  // Sous /api : donc derrière verifyToken.
  assert.ok(debut > serverSrc.indexOf("app.use('/api', verifyToken)"), 'route montée APRÈS verifyToken');
});

test("server.js : un rôle personnalisé refusé par la base (SQL pas collé) donne un message clair, libère le lien et supprime le compte orphelin", () => {
  const acceptation = serverSrc.slice(serverSrc.indexOf("app.post('/invitation/:token/creer-compte'"), serverSrc.indexOf("Complète la ligne déjà réservée"));
  const bloc = acceptation.slice(acceptation.indexOf('if (erreurProfil) {'));
  assert.ok(bloc.indexOf('deleteUser(nouvelUtilisateur.uid)') < bloc.indexOf('refusDeRoleParLaBase(erreurProfil)'), "le compte orphelin est retiré avant de répondre");
  assert.ok(bloc.indexOf('await relacher()') < bloc.indexOf('refusDeRoleParLaBase(erreurProfil)'), "le lien est relâché avant de répondre");
  assert.match(bloc, /refusDeRoleParLaBase\(erreurProfil\)\) \{[\s\S]*MESSAGE_ROLE_NON_ACTIVE_INVITE/);
});

// ---------------------------------------------------------------------------------------------------------
// Script SQL : le contrôle de format de la base = celui du serveur
// ---------------------------------------------------------------------------------------------------------
// (Le fichier réel a aussi été exécuté sur un Postgres 16 jetable le 09/10, avec 2 000 exemples aléatoires : aucun
// écart entre la base et le serveur. Ce test garde cet accord sans avoir besoin de Postgres.)
test("sql/roles_personnalises.sql : garde-fou d'abord (réservé au serveur), puis UNE instruction ALTER atomique dont le contrôle de format est exactement CLE_ROLE", () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'roles_personnalises.sql'), 'utf8');
  const texte = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  // --- Le garde-fou (fonction lue par le serveur).
  const posFonction = texte.search(/CREATE OR REPLACE FUNCTION public\.roles_personnalises_actifs\(\)/);
  const posAlter = texte.indexOf('ALTER TABLE users');
  assert.ok(posFonction >= 0 && posAlter > posFonction, "la fonction existe AVANT le changement de contrainte (jamais « prête » sans garde-fou)");
  assert.strictEqual((texte.match(/ALTER TABLE/g) || []).length, 1, 'un seul ALTER TABLE : DROP + ADD dans la même instruction (atomique)');
  const debutCorps = texte.indexOf('AS $$', posFonction);
  const fonction = texte.slice(posFonction, texte.indexOf('$$;', debutCorps + 5) + 3);
  assert.match(fonction, /RETURNS boolean\s+LANGUAGE sql\s+STABLE\s+SET search_path = public, pg_catalog\s+AS \$\$/);
  assert.doesNotMatch(fonction, /SECURITY DEFINER/i, 'pas de droits élevés : elle ne fait que lire pg_constraint');
  assert.match(fonction, /c\.conrelid = 'public\.users'::regclass/);
  assert.match(fonction, /c\.conname = 'users_role_check'/);
  const marque = fonction.match(/pg_get_constraintdef\(c\.oid\) LIKE '%([a-z_]+)%'/);
  assert.ok(marque, 'la fonction reconnaît la nouvelle contrainte à une marque de sa définition');
  // Réservée au serveur : ni PUBLIC, ni visiteurs (anon), ni personnes connectées (authenticated).
  assert.ok(texte.indexOf('REVOKE ALL ON FUNCTION public.roles_personnalises_actifs() FROM PUBLIC, anon, authenticated;') > posFonction);
  assert.ok(texte.indexOf('GRANT EXECUTE ON FUNCTION public.roles_personnalises_actifs() TO service_role;') > posFonction);
  assert.strictEqual((texte.match(/\bGRANT\b/g) || []).length, 1, 'un seul GRANT, au serveur');
  // --- Le contrôle de format.
  const alter = texte.slice(posAlter).split(';')[0];
  assert.match(alter, /^ALTER TABLE users\s+DROP CONSTRAINT IF EXISTS users_role_check,\s+ADD CONSTRAINT users_role_check\s+CHECK \(/);
  assert.ok(alter.includes(marque[1]), `la marque « ${marque[1]} » cherchée par la fonction doit figurer dans la nouvelle contrainte`);
  const bornes = alter.match(/char_length\(role\) BETWEEN (\d+) AND (\d+)/);
  assert.ok(bornes, 'les bornes de longueur doivent figurer dans la contrainte');
  assert.deepStrictEqual([Number(bornes[1]), Number(bornes[2])], [roles.LONGUEUR_CLE.min, roles.LONGUEUR_CLE.max]);
  const motif = alter.match(/role ~ '([^']+)'/);
  assert.ok(motif, 'le contrôle de format doit figurer dans la contrainte');
  assert.doesNotMatch(motif[1], /a-z|0-9|\[\[:/, "pas de plage ni de classe : elles peuvent dépendre de la langue du serveur");
  const enBase = new RegExp(motif[1]);
  const accepteParLeServeur = (s) => roles.CLE_ROLE.test(s) && s.length >= roles.LONGUEUR_CLE.min && s.length <= roles.LONGUEUR_CLE.max;
  const accepteParLaBase = (s) => s.length >= Number(bornes[1]) && s.length <= Number(bornes[2]) && enBase.test(s);
  // Exemples fixes (y compris les pièges) + exemples pseudo-aléatoires reproductibles.
  const bruit = ['A', 'Z', '_', '-', ' ', String.fromCharCode(233), String.fromCharCode(231), '\n', '.', "'", ';', String.fromCharCode(0x200b), String.fromCharCode(0xa0)];
  const lettres = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let graine = 20261009;
  const alea = (n) => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine % n; };
  const exemples = ['abc', 'ab', 'a_b', 'a_bc', 'ab_', '_ab', 'a__bc', 'caissier_nuit', 'Caissier', '1abc', 'abc\n', 'a'.repeat(30), 'a'.repeat(31), '', ' '];
  for (let i = 0; i < 800; i++) {
    let s = '';
    const n = alea(36);
    for (let j = 0; j < n; j++) s += (alea(10) < 7 ? lettres[alea(lettres.length)] : (alea(2) ? '_' : bruit[alea(bruit.length)]));
    exemples.push(s);
  }
  const ecarts = exemples.filter(s => accepteParLeServeur(s) !== accepteParLaBase(s));
  assert.deepStrictEqual(ecarts, [], 'la base et le serveur doivent accepter exactement les mêmes identifiants');
  assert.ok(exemples.some(accepteParLeServeur) && exemples.some(s => !accepteParLeServeur(s)), "l'échantillon doit contenir des identifiants valides ET invalides");
  // Tous les rôles du code respectent le format (sinon le script échouerait sur les comptes existants).
  for (const r of CLES_INTEGREES) assert.ok(accepteParLaBase(r), `${r} doit respecter le format`);
});

test("Les anciens scripts sql/ajoute_role_*.sql portent l'avertissement « obsolète » : les recoller remettrait la liste fixe de rôles", () => {
  const dossier = path.join(__dirname, '..', 'sql');
  const anciens = fs.readdirSync(dossier).filter(f => /^ajoute_role_.*\.sql$/.test(f));
  assert.ok(anciens.length >= 5, 'les 5 scripts historiques sont toujours là');
  for (const f of anciens) {
    const debut = fs.readFileSync(path.join(dossier, f), 'utf8').split('\n').slice(0, 5).join('\n');
    assert.match(debut, /OBSOLÈTE depuis le 09\/10 : NE PLUS COLLER ce script/, f);
    assert.match(debut, /roles_personnalises\.sql/, f);
  }
});
