// utils/roles.js — rôles personnalisés (09/10, demande d'Esdras : « créer un rôle depuis l'app, c'est trop de
// choses à faire à chaque fois, et je vais en créer d'autres à la demande de la direction »).
//
// Avant : la liste des rôles était figée à TROIS endroits — la contrainte users_role_check de la base, les
// tableaux du code (app et serveur) et ROLES_INVITABLES. Chaque nouveau rôle demandait donc une modification du
// code, un déploiement ET un SQL. Maintenant, un rôle PERSONNALISÉ est une entrée de plus dans la table des
// permissions (catalog 'permissions'), à côté de celles des rôles du code :
//     { role: 'caissier_nuit', libelle: 'Caissier de nuit', personnalise: true, permissions: ['caisse_travailler', ...] }
// et la base n'impose plus qu'un FORMAT de nom (sql/roles_personnalises.sql). Les rôles du code (infirmier,
// pharmacien...) ne changent pas : leurs droits par défaut vivent toujours dans PERMISSIONS_PAR_DEFAUT.
//
// CE MODULE EST LA SEULE VRAIE BARRIÈRE : l'écran de l'app n'est qu'un confort, et PUT /api/catalog/permissions
// est atteignable directement. Rien de ce qui est enregistré ne doit pouvoir :
//   - usurper un rôle du code (même clé), ni 'administrateur' ;
//   - créer une entrée « sauvage » : toute NOUVELLE clé doit être déclarée personnalisée et passer les contrôles
//     complets (les entrées déjà enregistrées avant ce module sont conservées telles quelles) ;
//   - porter autre chose que { role, permissions, libelle, personnalise } (aucun champ libre) ;
//   - avoir un nom d'affichage avec du HTML, des caractères invisibles ou de contrôle, ni un nom qui ressemble à
//     celui d'un autre rôle (« Médecin » / « medecin » / « MÉDECIN ») ;
//   - faire disparaître un rôle encore attribué à des comptes : ces personnes se retrouveraient sans AUCUN droit ;
//   - dépasser des bornes (nombre de rôles, de droits) qui rendraient la table ingérable.
//
// Volontairement sans dépendance (ni supabase ni express) : les fonctions pures se testent telles quelles, et
// l'orchestration reçoit sa base en paramètre.

// Clé technique : minuscules, chiffres, tirets bas ENTRE deux mots — jamais de tiret bas au début, à la fin ou
// doublé (« administrateur_ » ne doit pas pouvoir faire illusion). Même règle que sql/roles_personnalises.sql.
const CLE_ROLE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const LONGUEUR_CLE = { min: 3, max: 30 };
// Mots qui ne doivent jamais servir d'identifiant de rôle : du code qui indexe un objet avec le rôle (ou compare à
// une valeur absente) pourrait les confondre avec autre chose. Même liste que chf-app2 (utils/rolesPersonnalises.js).
const CLES_RESERVEES = ['constructor', 'prototype', 'undefined', 'null', 'true', 'false'];
const LONGUEUR_LIBELLE = { min: 3, max: 40 };
// Lettres, chiffres, emoji (comme « 💊 Pharmacien »), espace simple, apostrophes, parenthèses, tiret, point,
// virgule, barre oblique. Ni < > " ` & ni aucun caractère invisible ou de contrôle (sauf le liant d'emoji).
const LIBELLE_AUTORISE = /^[\p{L}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D '’()\-.,/]+$/u;
const CLE_PERMISSION = /^[a-z][a-z0-9_]{0,59}$/;
const MAX_ROLES_PERSONNALISES = 30;
const MAX_ENTREES = 80;
const MAX_PERMISSIONS_PAR_ROLE = 200;
const MAX_LIGNES_AUDIT = 50;

// Noms d'affichage des rôles du code, SANS emoji — uniquement pour refuser qu'un rôle personnalisé porte le
// même nom qu'eux. À garder identique à LABELS_ROLE de l'app (chf-app2, utils/permissions.js) : un test de
// l'app compare les deux listes.
const LIBELLES_INTEGRES = {
  administrateur: 'Administrateur', direction: 'Direction', comptable: 'Comptable', auditeur: 'Auditeur',
  lecteur: 'Lecteur', archiviste: 'Archiviste', infirmier: 'Infirmier', infirmier_chef: 'Infirmier en chef',
  medecin: 'Médecin', pharmacien: 'Pharmacien', pharmacien_chef: 'Pharmacien en chef', visiteur: 'Visiteur',
};

const refus = (status, error) => ({ ok: false, status, error });
const estObjet = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// Espaces multiples/insécables/retours à la ligne → un espace simple ; bords retirés.
function normaliserLibelle(texte) {
  return String(texte === undefined || texte === null ? '' : texte).normalize('NFC').replace(/\s+/gu, ' ').trim();
}

// Forme de COMPARAISON d'un nom : sans accent, sans majuscule, sans ponctuation ni emoji. Deux noms qui ont la
// même forme sont considérés identiques (« Médecin » = « MEDECIN » = « 🩺 médecin »).
function formeComparable(texte) {
  return String(texte === undefined || texte === null ? '' : texte)
    .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function estRolePersonnalise(entree) {
  return estObjet(entree) && entree.personnalise === true && typeof entree.role === 'string';
}

function validerLibelle(libelle) {
  if (libelle.length < LONGUEUR_LIBELLE.min || libelle.length > LONGUEUR_LIBELLE.max) {
    return `Le nom d'un rôle fait entre ${LONGUEUR_LIBELLE.min} et ${LONGUEUR_LIBELLE.max} caractères.`;
  }
  if (!LIBELLE_AUTORISE.test(libelle)) {
    return "Le nom d'un rôle ne peut contenir que des lettres, des chiffres, des espaces, des emoji et ' ( ) - . , /";
  }
  if ((libelle.match(/[\p{L}\p{N}]/gu) || []).length < 2) {
    return "Le nom d'un rôle doit contenir au moins deux lettres ou chiffres.";
  }
  return null;
}

function normaliserPermissions(brutes) {
  if (!Array.isArray(brutes)) return { erreur: "Chaque rôle doit avoir une liste « permissions »." };
  if (brutes.length > MAX_PERMISSIONS_PAR_ROLE) return { erreur: `Trop de permissions pour un seul rôle (${MAX_PERMISSIONS_PAR_ROLE} au maximum).` };
  const vues = new Set();
  for (const p of brutes) {
    if (typeof p !== 'string' || !CLE_PERMISSION.test(p)) return { erreur: 'Une permission a un nom invalide.' };
    vues.add(p);
  }
  return { permissions: [...vues] };
}

// Vérifie ET normalise la table envoyée à PUT /api/catalog/permissions.
//   items          : ce que le client veut enregistrer
//   anciens        : la table actuellement enregistrée (tableau) ou null
//   clesIntegrees  : Set des clés des rôles du code, administrateur compris
//   defauts        : PERMISSIONS_PAR_DEFAUT (référence pour décrire les changements de droits)
// Renvoie { ok:true, items, crees, supprimes, renommes, modifies } ou { ok:false, status, error }.
function verifierTablePermissions(items, { anciens, clesIntegrees, defauts }) {
  if (!Array.isArray(items)) return refus(400, "items doit être un tableau d'entrées { role, permissions }.");
  if (items.length > MAX_ENTREES) return refus(400, `Trop de rôles dans la table (${MAX_ENTREES} au maximum).`);

  const entreesAnciennes = new Map();
  for (const e of (Array.isArray(anciens) ? anciens : [])) if (estObjet(e) && typeof e.role === 'string') entreesAnciennes.set(e.role, e);

  const vues = new Set();
  const formesLibelles = new Map(); // forme -> clé, pour refuser deux rôles de même nom
  for (const [cle, nom] of Object.entries(LIBELLES_INTEGRES)) formesLibelles.set(formeComparable(nom), cle);
  const normalisees = [];
  let nbPersonnalises = 0;

  for (const brute of items) {
    if (!estObjet(brute) || typeof brute.role !== 'string' || brute.role.length === 0 || brute.role.length > 60 || /[\u0000-\u001f]/.test(brute.role)) {
      return refus(400, 'Une entrée de la table des permissions est invalide (rôle manquant ou illisible).');
    }
    const role = brute.role;
    if (vues.has(role)) return refus(400, `Le rôle « ${role} » apparaît deux fois dans la table.`);
    vues.add(role);
    const perms = normaliserPermissions(brute.permissions);
    if (perms.erreur) return refus(400, `${perms.erreur} (rôle « ${role} »)`);

    const ancienne = entreesAnciennes.get(role);
    const integre = clesIntegrees.has(role);
    const personnaliseAvant = estRolePersonnalise(ancienne);

    if (integre) {
      // Rôle du code : seulement ses droits. Il ne peut ni porter de nom d'affichage ni se déclarer personnalisé.
      if (brute.personnalise === true) return refus(400, `Le rôle « ${role} » existe déjà dans l'application : on ne peut pas en créer un du même nom.`);
      normalisees.push({ role, permissions: perms.permissions });
      continue;
    }

    const veutEtrePersonnalise = brute.personnalise === true;
    if (personnaliseAvant && !veutEtrePersonnalise) {
      return refus(400, `Le rôle « ${role} » est un rôle personnalisé : il ne peut pas perdre ce statut. Pour le retirer, supprime-le (aucun compte ne doit plus l'avoir).`);
    }
    if (!veutEtrePersonnalise) {
      if (!ancienne) return refus(400, `Le rôle « ${role} » n'existe pas : un nouveau rôle doit être créé comme rôle personnalisé.`);
      // Entrée héritée (enregistrée avant ce module, pour un rôle qui n'est plus dans le code) : gardée telle quelle.
      normalisees.push({ role, permissions: perms.permissions });
      continue;
    }

    // Rôle personnalisé : contrôles complets.
    if (role.length < LONGUEUR_CLE.min || role.length > LONGUEUR_CLE.max || !CLE_ROLE.test(role)) {
      return refus(400, `Identifiant de rôle invalide (« ${role} ») : ${LONGUEUR_CLE.min} à ${LONGUEUR_CLE.max} caractères, minuscules, chiffres et tirets bas entre deux mots.`);
    }
    if (CLES_RESERVEES.includes(role)) return refus(400, `L'identifiant « ${role} » est réservé : choisis un autre nom de rôle.`);
    const libelle = normaliserLibelle(brute.libelle);
    const erreurLibelle = validerLibelle(libelle);
    if (erreurLibelle) return refus(400, `${erreurLibelle} (rôle « ${role} »)`);
    const forme = formeComparable(libelle);
    if (formesLibelles.has(forme) && formesLibelles.get(forme) !== role) {
      return refus(409, `Le nom « ${libelle} » est déjà pris par un autre rôle. Choisis un autre nom.`);
    }
    formesLibelles.set(forme, role);
    nbPersonnalises++;
    if (nbPersonnalises > MAX_ROLES_PERSONNALISES) return refus(400, `Trop de rôles personnalisés (${MAX_ROLES_PERSONNALISES} au maximum).`);
    normalisees.push({ role, permissions: perms.permissions, libelle, personnalise: true });
  }

  // Ce qui change par rapport à la table enregistrée (sert à l'audit et à la garde des suppressions).
  const anciensPersonnalises = [...entreesAnciennes.values()].filter(estRolePersonnalise);
  const supprimes = anciensPersonnalises.filter(e => !vues.has(e.role)).map(e => e.role);
  const crees = normalisees.filter(e => e.personnalise && !estRolePersonnalise(entreesAnciennes.get(e.role))).map(e => e.role);
  const renommes = normalisees
    .filter(e => e.personnalise && estRolePersonnalise(entreesAnciennes.get(e.role)) && entreesAnciennes.get(e.role).libelle !== e.libelle)
    .map(e => ({ role: e.role, ancien: entreesAnciennes.get(e.role).libelle, nouveau: e.libelle }));
  const defautDe = (role) => (Array.isArray(defauts) ? defauts : []).find(d => d && d.role === role);
  const modifies = [];
  for (const e of normalisees) {
    if (crees.includes(e.role)) continue; // la création porte déjà ses droits dans son audit
    if (e.role === 'administrateur') continue; // a toujours tout (aPermission) : l'entrée enregistrée n'a aucun effet, inutile de la journaliser
    const avant = entreesAnciennes.get(e.role) || defautDe(e.role);
    const avantDroits = new Set(avant && Array.isArray(avant.permissions) ? avant.permissions : []);
    const apresDroits = new Set(e.permissions);
    const ajoutees = [...apresDroits].filter(p => !avantDroits.has(p));
    const retirees = [...avantDroits].filter(p => !apresDroits.has(p));
    if (ajoutees.length || retirees.length) modifies.push({ role: e.role, ajoutees, retirees });
  }
  return { ok: true, items: normalisees, crees, supprimes, renommes, modifies };
}

// Lecture de la table enregistrée : tableau, ou null si jamais enregistrée / illisible.
async function lireTablePermissions(supabase) {
  const { data, error } = await supabase.from('catalog').select('items').eq('type', 'permissions').maybeSingle();
  if (error) return { erreur: error };
  return { table: data && Array.isArray(data.items) && data.items.length > 0 ? data.items : null };
}

// Rôles qu'un lien d'invitation peut accorder : ceux du code (liste fixée par server.js, administrateur exclu —
// voir le commentaire de ROLES_INVITABLES) + les rôles personnalisés. Un rôle personnalisé n'est JAMAIS
// administrateur : sa clé ne peut pas être celle d'un rôle du code (voir verifierTablePermissions).
function rolesInvitablesAvecPersonnalises(invitablesIntegres, table) {
  const perso = (Array.isArray(table) ? table : []).filter(estRolePersonnalise).map(e => e.role).filter(r => CLE_ROLE.test(r) && !invitablesIntegres.includes(r) && r !== 'administrateur');
  return [...invitablesIntegres, ...perso];
}

// Nom d'affichage d'un rôle personnalisé (null pour un rôle du code : l'app connaît déjà son libellé).
function libelleRolePersonnalise(role, table) {
  const e = (Array.isArray(table) ? table : []).find(x => estRolePersonnalise(x) && x.role === role);
  return e && typeof e.libelle === 'string' ? e.libelle : null;
}

// La base refuse une valeur de users.role : contrainte users_role_check encore sur l'ancienne liste fixe.
function refusDeRoleParLaBase(erreur) {
  return !!erreur && erreur.code === '23514' && /users_role_check/.test(String(erreur.message || ''));
}
// Message pour l'ADMINISTRATEUR (écran Utilisateurs) et pour la PERSONNE INVITÉE (qui ne peut rien y faire :
// elle doit juste prévenir l'administrateur, et son lien est relâché pour qu'elle puisse réessayer).
const MESSAGE_SQL_ROLES_PERSONNALISES =
  "La base de données n'accepte pas encore les rôles personnalisés : colle une fois le script sql/roles_personnalises.sql dans Supabase (SQL Editor), puis réessaie.";
const MESSAGE_ROLE_NON_ACTIVE_INVITE =
  "Ton rôle n'est pas encore activé dans la base de données : préviens l'administrateur (il lui reste une étape de configuration), puis réessaie avec le même lien — il n'est pas perdu.";

// La base accepte-t-elle les rôles créés depuis l'écran ? Interroge le garde-fou installé par
// sql/roles_personnalises.sql (fonction roles_personnalises_actifs, réservée au serveur). Sert à REFUSER, avant
// qu'il soit trop tard, un rôle que la base refuserait d'attribuer : sinon un compte de connexion pouvait être
// créé sans profil, et l'app lui aurait donné le rôle « auditeur » à sa première connexion.
// Renvoie { pret: true } | { pret: false } (script pas collé, ou remis à l'ancienne liste fixe) | { erreur }
// (base injoignable...). Une fonction absente (code 42883 ou PGRST202) veut dire « script pas collé ».
async function etatBasePourRolesPersonnalises(supabase) {
  let reponse;
  try { reponse = await supabase.rpc('roles_personnalises_actifs'); }
  catch (e) { return { erreur: { message: (e && e.message) || String(e) } }; }
  const { data, error } = reponse || {};
  if (error) {
    // Seule l'absence de CETTE fonction signifie « script pas collé » ; toute autre erreur (réseau, droit refusé,
    // table introuvable...) reste une erreur, pour qu'on la voie au lieu de la prendre pour une réponse.
    const absente = error.code === '42883' || error.code === 'PGRST202'
      || /could not find the function|function .*does not exist/i.test(String(error.message || ''));
    return absente ? { pret: false } : { erreur: error };
  }
  return { pret: data === true };
}
const MESSAGE_SQL_AVANT_CREATION =
  "Avant de créer un rôle, il faut coller UNE fois le script roles_personnalises.sql dans Supabase (SQL Editor) : sans lui, la base refuserait d'attribuer ce rôle à quelqu'un. Rien n'a été enregistré.";

// Un lien d'invitation peut-il accorder ce rôle ? Renvoie null (oui) ou { status, error } à renvoyer tel quel.
// - rôle absent des rôles invitables (administrateur compris) : 400 ;
// - rôle créé depuis l'écran : la base doit l'accepter (script SQL collé), sinon la personne invitée tomberait sur
//   une erreur qu'elle ne peut pas résoudre : 409 (ou 500 si la base ne répond pas). Les rôles du code n'ont besoin
//   d'aucune vérification de ce genre.
async function verifierRoleInvitation({ role, invitablesIntegres, table, supabase }) {
  const possibles = rolesInvitablesAvecPersonnalises(invitablesIntegres, table);
  if (!possibles.includes(role)) {
    return { status: 400, error: `Rôle invalide ou non autorisé par lien d'invitation. Rôles possibles : ${possibles.join(', ')}.` };
  }
  if (!invitablesIntegres.includes(role)) {
    const etat = await etatBasePourRolesPersonnalises(supabase);
    if (etat.erreur) return { status: 500, error: `Vérification de la base impossible : ${etat.erreur.message}` };
    if (!etat.pret) return { status: 409, error: MESSAGE_SQL_ROLES_PERSONNALISES };
  }
  return null;
}

// Enregistre la table des permissions : vérifie, garde les suppressions, écrit, journalise.
//   supabase    : client (service_role)
//   utilisateur : { id, email } de la personne connectée
// Renvoie { status, body } — la route n'a plus qu'à répondre.
async function appliquerMiseAJourPermissions({ items, supabase, utilisateur, clesIntegrees, defauts, genererId }) {
  const lecture = await lireTablePermissions(supabase);
  if (lecture.erreur) return { status: 500, body: { error: lecture.erreur.message } };
  const verif = verifierTablePermissions(items, { anciens: lecture.table, clesIntegrees, defauts });
  if (!verif.ok) return { status: verif.status, body: { error: verif.error } };

  if (verif.supprimes.length > 0) {
    const { data: comptes, error: erreurComptes } = await supabase.from('users').select('id, email, display_name, role').in('role', verif.supprimes);
    if (erreurComptes) return { status: 500, body: { error: erreurComptes.message } };
    if (comptes && comptes.length > 0) {
      const noms = comptes.slice(0, 5).map(c => c.display_name || c.email || c.id).join(', ');
      const roles = [...new Set(comptes.map(c => c.role))].join(', ');
      return { status: 409, body: { error: `Impossible de supprimer le rôle « ${roles} » : ${comptes.length} compte(s) l'ont encore (${noms}${comptes.length > 5 ? ', …' : ''}). Donne-leur d'abord un autre rôle.` } };
    }
  }

  // Création d'au moins un NOUVEAU rôle : la base doit déjà accepter les rôles créés depuis l'écran. (Les autres
  // enregistrements — droits, renommage, suppression — n'en dépendent pas et ne sont jamais bloqués par ceci.)
  if (verif.crees.length > 0) {
    const etat = await etatBasePourRolesPersonnalises(supabase);
    if (etat.erreur) return { status: 500, body: { error: `Vérification de la base impossible : ${etat.erreur.message}` } };
    if (!etat.pret) return { status: 409, body: { error: MESSAGE_SQL_AVANT_CREATION } };
  }

  const { data, error } = await supabase.from('catalog')
    .upsert({ type: 'permissions', items: verif.items, updated_at: new Date().toISOString() }, { onConflict: 'type' })
    .select();
  if (error) return { status: 500, body: { error: error.message } };
  if (!data || data.length === 0) return { status: 500, body: { error: 'Échec inattendu de l\'enregistrement du catalogue "permissions".' } };

  // Journal d'audit (best-effort : un journal qui refuse la ligne n'annule pas un changement déjà écrit).
  const date = new Date().toISOString();
  const par = { effectue_par: utilisateur.email || utilisateur.id, effectue_par_uid: utilisateur.id };
  const libelleDe = (role) => (verif.items.find(e => e.role === role) || {}).libelle || null;
  const lignes = [
    ...verif.crees.map(role => ({ action: 'creation_role', details: { role, libelle: libelleDe(role), permissions: verif.items.find(e => e.role === role).permissions } })),
    ...verif.supprimes.map(role => ({ action: 'suppression_role', details: { role } })),
    ...verif.renommes.map(r => ({ action: 'renommage_role', details: r })),
    ...verif.modifies.map(m => ({ action: 'modification_droits_role', details: m })),
  ];
  if (lignes.length > 0) {
    const aEcrire = lignes.slice(0, MAX_LIGNES_AUDIT).map(l => ({ id: genererId(), action: l.action, ...par, details: l.details, date }));
    const { error: erreurAudit } = await supabase.from('audit_log').insert(aEcrire);
    if (erreurAudit) console.warn('Audit des rôles non enregistré :', erreurAudit.message);
  }
  return { status: 200, body: { success: true } };
}

module.exports = {
  CLE_ROLE, LONGUEUR_CLE, CLES_RESERVEES, LONGUEUR_LIBELLE, LIBELLE_AUTORISE, MAX_ROLES_PERSONNALISES, MAX_ENTREES, LIBELLES_INTEGRES,
  MESSAGE_SQL_ROLES_PERSONNALISES, MESSAGE_ROLE_NON_ACTIVE_INVITE, MESSAGE_SQL_AVANT_CREATION, etatBasePourRolesPersonnalises, verifierRoleInvitation,
  normaliserLibelle, formeComparable, estRolePersonnalise, verifierTablePermissions, lireTablePermissions,
  rolesInvitablesAvecPersonnalises, libelleRolePersonnalise, refusDeRoleParLaBase, appliquerMiseAJourPermissions,
};
