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
function fauxSupabase({ catalogue = null, comptes = [], erreurLecture = null, erreurEcriture = null, erreurAudit = null, ecritureVide = false } = {}) {
  const appels = { upserts: [], audits: [], requetesComptes: [] };
  return {
    appels,
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

test("server.js : les invitations acceptent les rôles personnalisés, et la page d'invitation reçoit leur nom", () => {
  const creation = serverSrc.slice(serverSrc.indexOf("app.post('/api/admin/invitations'"), serverSrc.indexOf("app.get('/api/admin/invitations'"));
  assert.match(creation, /rolesInvitablesAvecPersonnalises\(ROLES_INVITABLES, lectureRoles\.table\)/);
  assert.match(creation, /if \(!rolesPossibles\.includes\(role\)\)/);
  assert.doesNotMatch(creation, /ROLES_INVITABLES\.includes\(role\)/, "l'ancienne liste fixe ne doit plus décider seule");
  const page = serverSrc.slice(serverSrc.indexOf("app.get('/invitation/:token'"), serverSrc.indexOf("app.post('/invitation/:token/creer-compte'"));
  assert.match(page, /role_libelle: roleLibelle/);
  assert.match(page, /libelleRolePersonnalise\(invitation\.role, lectureRoles\.table\)/);
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
test("sql/roles_personnalises.sql : une seule instruction atomique, et son contrôle de format est exactement CLE_ROLE du serveur", () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'roles_personnalises.sql'), 'utf8');
  const instructions = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean);
  assert.strictEqual(instructions.length, 1, "une seule instruction : DROP + ADD dans le même ALTER TABLE (atomique)");
  assert.match(instructions[0], /^ALTER TABLE users\s+DROP CONSTRAINT IF EXISTS users_role_check,\s+ADD CONSTRAINT users_role_check\s+CHECK \(/);
  const bornes = instructions[0].match(/char_length\(role\) BETWEEN (\d+) AND (\d+)/);
  assert.ok(bornes, 'les bornes de longueur doivent figurer dans la contrainte');
  assert.deepStrictEqual([Number(bornes[1]), Number(bornes[2])], [roles.LONGUEUR_CLE.min, roles.LONGUEUR_CLE.max]);
  const motif = instructions[0].match(/role ~ '([^']+)'/);
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
