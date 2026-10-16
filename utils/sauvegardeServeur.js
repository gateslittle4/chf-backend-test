// utils/sauvegardeServeur.js — sauvegarde quotidienne, vérification et RESTAURATION (format v2, voir utils/sauvegarde.js).
//
// Sorti de server.js (16/10) pour pouvoir être TESTÉ pour de vrai : le test de restauration (scripts/restauration/essai-restauration.js) fait tourner ce même code contre
// deux bases PostgreSQL jetables — une qui se fait sauvegarder, une vide qui se fait restaurer — puis compare les deux table par table.
// Tout ce qui parle à l'extérieur est injecté : `supabase` (base + Storage), `ouvrirCopieHorsSite` (Backblaze B2), `journal`.
const S = require('./sauvegarde');

const TAILLE_LOT_RESTAURATION = 500;
const TAILLE_LISTE_STORAGE = 1000;

function creerServiceSauvegarde({
  supabase, bucket, tables, clesPrimaires = {}, ordreRestauration, fuseau = 'America/Port-au-Prince',
  ouvrirCopieHorsSite = async () => null, journal = console, maintenant = () => new Date(),
  tailleTrancheMax = S.TAILLE_TRANCHE_MAX, taillePage = 500, tailleLotRestauration = TAILLE_LOT_RESTAURATION,
}) {
  const stockage = () => supabase.storage.from(bucket);
  // Clé primaire d'une table : « id » par défaut ; plusieurs colonnes séparées par une virgule (doublons_ignores : dossier_a,dossier_b).
  const cleOrdre = Object.fromEntries(ordreRestauration || []);
  const colonnesCle = (table) => String(clesPrimaires[table] || cleOrdre[table] || 'id').split(',');
  const cleDe = (table, ligne) => colonnesCle(table).map(c => String(ligne[c])).join('|');
  const trierPar = (requete, table) => colonnesCle(table).reduce((q, c) => q.order(c), requete);
  const dateDuJour = () => maintenant().toLocaleDateString('en-CA', { timeZone: fuseau });

  async function telecharger(chemin) {
    const { data, error } = await stockage().download(chemin);
    if (error) throw new Error(`Téléchargement de ${chemin} : ${error.message}`);
    return Buffer.from(await data.arrayBuffer());
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------
  // SAUVEGARDE
  // ------------------------------------------------------------------------------------------------------------------------------------------------
  async function sauvegarder() {
    const dossier = S.nomDossierSauvegarde(dateDuJour());
    const genereLe = maintenant().toISOString();
    const { data: buckets, error: erreurListeBuckets } = await supabase.storage.listBuckets();
    if (erreurListeBuckets) throw new Error(`Liste des buckets : ${erreurListeBuckets.message}`);
    if (!buckets.some(b => b.name === bucket)) {
      const { error: erreurCreation } = await supabase.storage.createBucket(bucket, { public: false });
      if (erreurCreation) throw new Error(`Création du bucket : ${erreurCreation.message}`);
    }

    // Copie hors Supabase (Backblaze B2) : best-effort, un échec ne fait JAMAIS échouer la sauvegarde principale — il est seulement rapporté (copie.erreur).
    const copie = { configuree: false, envoyee: false, fichiers: 0, erreur: null };
    let session = null;
    try { session = await ouvrirCopieHorsSite(); copie.configuree = !!session; }
    catch (e) { copie.configuree = true; copie.erreur = e.message; }
    const copier = async (chemin, tampon) => {
      if (!session || copie.erreur) return;
      try { await session.envoyer(chemin, tampon); copie.fichiers++; }
      catch (e) { copie.erreur = e.message; journal.error(`❌ Copie hors Supabase : ${chemin} — ${e.message}`); }
    };

    // Une table illisible ne fait pas échouer la sauvegarde ENTIÈRE : on continue table par table et on remonte la liste des échecs — une sauvegarde partielle
    // vaut infiniment mieux que pas de sauvegarde, à condition que le trou soit annoncé (manifeste, journal, alerte WhatsApp).
    const tablesEnEchec = [];
    const infos = {};
    for (const table of tables) {
      const envoyes = [];
      try {
        const tranches = [];
        let lignes = 0;
        // Lecture PAGINÉE, à tri TOTAL (clé primaire) : un simple select('*') s'arrêterait au plafond de lignes de Supabase SANS erreur, et sans tri total deux
        // lignes de même valeur peuvent changer de page d'un appel à l'autre.
        const pages = S.parcourirPages(() => trierPar(supabase.from(table).select('*'), table), taillePage);
        for await (const tranche of S.produireTranches({ table, pages, tailleMax: tailleTrancheMax })) {
          const chemin = `${dossier}/${tranche.fichier}`;
          const { error } = await stockage().upload(chemin, tranche.tampon, { contentType: 'application/gzip', upsert: true });
          if (error) throw new Error(`Envoi vers Storage (${tranche.fichier}) : ${error.message}`);
          envoyes.push(chemin);
          await copier(chemin, tranche.tampon);
          tranches.push(S.resumeTranche(tranche)); lignes += tranche.lignes;
        }
        infos[table] = { lignes, tranches };
      } catch (error) {
        journal.error(`⚠️ Sauvegarde : table "${table}" illisible — ${error.message}`);
        tablesEnEchec.push(`${table} (${error.message})`);
        if (envoyes.length > 0) { try { await stockage().remove(envoyes); } catch (_) { /* fichiers orphelins, sans manifeste ils ne servent à rien */ } }
      }
    }
    if (Object.keys(infos).length === 0) throw new Error(`Aucune table n'a pu être lue : ${tablesEnEchec.join(' ; ')}`);

    // Le manifeste est écrit EN DERNIER : sa présence prouve que tous les fichiers sont là.
    const manifeste = S.fabriquerManifeste({ genereLe, tables: infos, tablesEnEchec });
    const texteManifeste = Buffer.from(JSON.stringify(manifeste, null, 1), 'utf8');
    const cheminManifeste = `${dossier}/${S.NOM_MANIFESTE}`;
    const { error: erreurManifeste } = await stockage().upload(cheminManifeste, texteManifeste, { contentType: 'application/json', upsert: true });
    if (erreurManifeste) throw new Error(`Envoi du manifeste vers Storage : ${erreurManifeste.message}`);
    await copier(cheminManifeste, texteManifeste);
    copie.envoyee = !!session && !copie.erreur && copie.fichiers > 0;
    if (session && copie.envoyee && typeof session.terminer === 'function') {
      try { await session.terminer({ dossier, manifeste }); } catch (e) { journal.warn(`⚠️ Copie réussie, mais la notification a échoué (sans impact sur la sauvegarde) : ${e.message}`); }
    }

    let nettoyage = { supprimees: [], erreur: null };
    try { nettoyage = await elaguer(); } catch (e) { nettoyage.erreur = e.message; journal.warn(`⚠️ Nettoyage des anciennes sauvegardes impossible : ${e.message}`); }

    // Relecture de ce qui vient d'être écrit : un fichier tronqué ou abîmé à l'envoi se découvre ce soir, pas le jour de la restauration.
    let verification = { ok: false, erreurs: ['vérification non faite'] };
    try { verification = await verifierSauvegarde(dossier, { profond: true }); }
    catch (e) { verification = { ok: false, erreurs: [e.message] }; }

    const nombreTranches = Object.values(infos).reduce((s, i) => s + i.tranches.length, 0);
    return { fichier: dossier, nombreLignes: manifeste.lignesParTable, tablesEnEchec, octets: manifeste.totalOctets, fichiers: nombreTranches + 1, copie, nettoyage, verification };
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------
  // LISTE, CONSERVATION, VÉRIFICATION
  // ------------------------------------------------------------------------------------------------------------------------------------------------
  async function listerRacine() {
    const { data, error } = await stockage().list('', { limit: TAILLE_LISTE_STORAGE });
    if (error) throw new Error(error.message);
    return data || [];
  }

  // Sauvegardes disponibles : anciens fichiers .json (format 1) et dossiers COMPLETS (avec manifeste) du format 2, les plus récentes d'abord.
  async function listerSauvegardes() {
    const racine = await listerRacine();
    const resultat = [];
    for (const entree of racine) {
      if (S.RE_ANCIEN_FICHIER.test(entree.name)) {
        resultat.push({ nom: entree.name, taille: (entree.metadata && entree.metadata.size) || null, creeLe: entree.created_at || null, format: 1 });
      } else if (S.RE_DOSSIER.test(entree.name)) {
        const { data: fichiers, error } = await stockage().list(entree.name, { limit: TAILLE_LISTE_STORAGE });
        if (error) continue;
        const manifeste = (fichiers || []).find(f => f.name === S.NOM_MANIFESTE);
        if (!manifeste) continue; // sauvegarde interrompue : jamais proposée
        resultat.push({
          nom: entree.name, format: 2, creeLe: manifeste.created_at || null,
          taille: (fichiers || []).reduce((s, f) => s + ((f.metadata && f.metadata.size) || 0), 0) || null,
        });
      }
    }
    return resultat.sort((a, b) => b.nom.localeCompare(a.nom));
  }

  async function dateDerniereSauvegarde() {
    const liste = await listerSauvegardes();
    return liste.length ? S.dateDeNom(liste[0].nom) : null;
  }

  async function sauvegardeDuJourExisteDeja() {
    const aujourdhui = dateDuJour();
    return (await listerSauvegardes()).some(s => S.dateDeNom(s.nom) === aujourdhui);
  }

  // Supprime ce que la règle de conservation ne garde pas (30 quotidiennes + 1 par mois sur 12 mois). Un nom qu'on ne reconnaît pas n'est jamais touché.
  async function elaguer() {
    const racine = await listerRacine();
    const { supprimer } = S.choisirSauvegardesAGarder(racine.map(e => e.name));
    const supprimees = [];
    for (const nom of supprimer) {
      if (S.RE_DOSSIER.test(nom)) {
        const { data: fichiers } = await stockage().list(nom, { limit: TAILLE_LISTE_STORAGE });
        const chemins = (fichiers || []).map(f => `${nom}/${f.name}`);
        if (chemins.length) { const { error } = await stockage().remove(chemins); if (error) throw new Error(error.message); }
      } else {
        const { error } = await stockage().remove([nom]);
        if (error) throw new Error(error.message);
      }
      supprimees.push(nom);
    }
    return { supprimees, erreur: null };
  }

  async function lireManifesteStocke(dossier) {
    return S.lireManifeste((await telecharger(`${dossier}/${S.NOM_MANIFESTE}`)).toString('utf8'));
  }

  // Vérifie qu'une sauvegarde du format 2 est INTACTE : chaque fichier existe, a la bonne taille et la bonne somme SHA-256 ; en mode `profond`, il est aussi
  // décompressé et ses lignes sont comptées. Ne modifie rien.
  async function verifierSauvegarde(dossier, { profond = false } = {}) {
    const manifeste = await lireManifesteStocke(dossier);
    const erreurs = [];
    const tablesVerifiees = [];
    for (const [table, info] of Object.entries(manifeste.tables)) {
      let ok = true, erreur = null;
      for (const tranche of info.tranches || []) {
        try {
          const tampon = await telecharger(`${dossier}/${tranche.fichier}`);
          if (profond) await S.lireTranche(tampon, tranche); else S.verifierTranche(tampon, tranche);
        } catch (e) { ok = false; erreur = e.message; erreurs.push(`${table} : ${e.message}`); break; }
      }
      tablesVerifiees.push({ table, lignes: info.lignes, fichiers: (info.tranches || []).length, ok, erreur });
    }
    for (const t of manifeste.tablesEnEchec || []) erreurs.push(`table non sauvegardée : ${t}`);
    return { ok: erreurs.length === 0, genereLe: manifeste.genereLe, totalLignes: manifeste.totalLignes, tables: tablesVerifiees, erreurs };
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------
  // RESTAURATION
  // Ajoute UNIQUEMENT ce qui manque : rien ne remplace une ligne déjà présente (une ligne déjà là aujourd'hui est forcément plus récente ou identique à celle de la
  // sauvegarde ; l'écraser ferait perdre une modification récente pour un gain nul). Ne déclare JAMAIS un succès sans l'avoir vérifié : chaque insertion relit le
  // nombre de lignes RÉELLEMENT écrites. Un lot refusé en bloc est retenté ligne par ligne, pour qu'une seule mauvaise ligne ne bloque pas les 499 bonnes.
  // ------------------------------------------------------------------------------------------------------------------------------------------------
  async function lireClesExistantes(table) {
    const existantes = new Set();
    const colonnes = colonnesCle(table).join(',');
    // Lues EN ENTIER, page par page, colonnes de clé seules : un `.in(...)` mettrait des centaines d'identifiants dans l'URL, au-delà de ce qu'accepte l'API.
    for await (const page of S.parcourirPages(() => trierPar(supabase.from(table).select(colonnes), table), taillePage)) page.forEach(r => existantes.add(cleDe(table, r)));
    return existantes;
  }

  const rpcAbsente = (erreur) => !!erreur && (['PGRST202', '42883'].includes(String(erreur.code)) || /could not find the function|does not exist/i.test(String(erreur.message || '')));

  async function restaurerLignes(table, source, avertissements) {
    const colonnes = colonnesCle(table).join(',');
    const existantes = await lireClesExistantes(table);
    const rapport = { table, lignesSauvegarde: 0, dejaPresentes: 0, inserees: 0, lignesEnEchec: [] };
    // Le journal d'audit passe par restaurer_audit_log (sql/restauration_audit_et_sequences.sql) : le déclencheur de la base remet sinon TOUTES les dates à l'heure
    // de la restauration. Sans cette fonction, on restaure quand même, mais on le dit.
    let auditParFonction = table === 'audit_log';
    // Les dossiers se référencent entre eux (fusion, mère/enfant) : un lien vers un dossier qui n'est pas encore inséré refuserait la ligne. On insère donc SANS ces
    // deux liens, puis on les pose une fois tous les dossiers en place.
    const liens = [];
    const insererLot = async (lot) => {
      if (auditParFonction) {
        const { data, error } = await supabase.rpc('restaurer_audit_log', { p_lignes: lot });
        if (!error) return { inserees: Number(data) || 0 };
        if (!rpcAbsente(error)) return { erreur: error };
        auditParFonction = false;
        avertissements.push("audit_log : la fonction restaurer_audit_log n'existe pas dans cette base (sql/restauration_audit_et_sequences.sql) — les dates du journal d'audit ont été remplacées par l'heure de la restauration.");
      }
      const { data, error } = await supabase.from(table).insert(lot).select(colonnes);
      return error ? { erreur: error } : { inserees: (data || []).length };
    };
    for await (const lignes of source) {
      rapport.lignesSauvegarde += lignes.length;
      let aInserer = lignes.filter(l => !existantes.has(cleDe(table, l)));
      rapport.dejaPresentes += lignes.length - aInserer.length;
      if (table === 'dossiers') {
        aInserer = aInserer.map(l => {
          if (l.fusionne_dans || l.mere_dossier_id) liens.push({ id: l.id, fusionne_dans: l.fusionne_dans || null, mere_dossier_id: l.mere_dossier_id || null });
          return { ...l, fusionne_dans: null, mere_dossier_id: null };
        });
      }
      for (let i = 0; i < aInserer.length; i += tailleLotRestauration) {
        const lot = aInserer.slice(i, i + tailleLotRestauration);
        const r = await insererLot(lot);
        if (!r.erreur) { rapport.inserees += r.inserees; continue; }
        for (const ligne of lot) {
          const r2 = await insererLot([ligne]);
          if (r2.erreur) rapport.lignesEnEchec.push({ id: cleDe(table, ligne), erreur: r2.erreur.message });
          else rapport.inserees += r2.inserees;
        }
      }
    }
    if (liens.length > 0) {
      const echoues = new Set(rapport.lignesEnEchec.map(e => e.id));
      for (const lien of liens) {
        if (echoues.has(lien.id)) continue;
        const { error } = await supabase.from('dossiers').update({ fusionne_dans: lien.fusionne_dans, mere_dossier_id: lien.mere_dossier_id }).eq('id', lien.id);
        if (error) rapport.lignesEnEchec.push({ id: lien.id, erreur: `liens de fusion / mère : ${error.message}` });
      }
    }
    return rapport;
  }

  // Dernière étape : les numéros de paiement continuent APRÈS le plus grand numéro restauré (dans une base neuve, la séquence repartirait de 1 et le premier
  // encaissement échouerait sur l'unicité).
  async function realignerSequences(avertissements) {
    const { error } = await supabase.rpc('realigner_sequences');
    if (error) avertissements.push(rpcAbsente(error)
      ? "realigner_sequences n'existe pas dans cette base (sql/restauration_audit_et_sequences.sql) : dans une base NEUVE, les prochains numéros de paiement repartiraient de 1."
      : `Séquences non réalignées : ${error.message}`);
  }

  const totaux = (rapport) => ({
    totalInsere: rapport.reduce((s, r) => s + r.inserees, 0),
    totalEnEchec: rapport.reduce((s, r) => s + r.lignesEnEchec.length, 0),
  });

  // Ancien format : tout le contenu déjà en mémoire ({ table: [lignes] }).
  async function restaurerDepuisContenu(contenu, avertissements = []) {
    const rapport = [];
    for (const [table] of ordreRestauration) {
      const lignes = contenu[table];
      if (!Array.isArray(lignes) || lignes.length === 0) { rapport.push({ table, lignesSauvegarde: 0, dejaPresentes: 0, inserees: 0, lignesEnEchec: [] }); continue; }
      try { rapport.push(await restaurerLignes(table, (async function* () { yield lignes; })(), avertissements)); }
      catch (e) { rapport.push({ table, lignesSauvegarde: lignes.length, dejaPresentes: 0, inserees: 0, lignesEnEchec: [{ id: null, erreur: e.message }] }); }
    }
    await realignerSequences(avertissements);
    return rapport;
  }

  async function restaurer(nom, { verifierSeulement = false } = {}) {
    const avertissements = [];
    if (S.RE_ANCIEN_FICHIER.test(nom)) {
      const texte = (await telecharger(nom)).toString('utf8');
      let contenu;
      try { contenu = JSON.parse(texte); } catch (e) { throw new Error("Le fichier n'est pas un JSON valide."); }
      if (!contenu || typeof contenu !== 'object' || !ordreRestauration.some(([table]) => Array.isArray(contenu[table]))) {
        throw new Error("Ce fichier ne ressemble pas à une sauvegarde automatique (aucune des tables attendues n'y figure).");
      }
      if (verifierSeulement) {
        const lignes = ordreRestauration.reduce((s, [t]) => s + (Array.isArray(contenu[t]) ? contenu[t].length : 0), 0);
        return { fichier: nom, format: 1, verification: { ok: true, totalLignes: lignes, erreurs: [] } };
      }
      const rapport = await restaurerDepuisContenu(contenu, avertissements);
      return { fichier: nom, format: 1, rapport, ...totaux(rapport), avertissements };
    }
    if (!S.RE_DOSSIER.test(nom)) throw new Error("Nom de sauvegarde non reconnu (attendu : backup-AAAA-MM-JJ).");

    const manifeste = await lireManifesteStocke(nom);
    // 1. Tout est contrôlé AVANT d'écrire quoi que ce soit : une sauvegarde abîmée ne se restaure pas à moitié.
    const verification = await verifierSauvegarde(nom, { profond: verifierSeulement });
    const fichiersAbimes = verification.tables.filter(t => !t.ok);
    if (verifierSeulement) return { fichier: nom, format: 2, verification };
    if (fichiersAbimes.length > 0) {
      throw new Error(`Sauvegarde abîmée, rien n'a été restauré — ${fichiersAbimes.map(t => `${t.table} : ${t.erreur}`).join(' ; ')}`);
    }
    // 2. Restauration table par table, dans l'ordre des dépendances, une tranche à la fois.
    const rapport = [];
    for (const [table] of ordreRestauration) {
      const info = manifeste.tables[table];
      if (!info) {
        const enEchec = (manifeste.tablesEnEchec || []).find(t => t.startsWith(`${table} (`));
        rapport.push({ table, lignesSauvegarde: 0, dejaPresentes: 0, inserees: 0, lignesEnEchec: enEchec ? [{ id: null, erreur: `table absente de la sauvegarde : ${enEchec}` }] : [] });
        continue;
      }
      try {
        const source = (async function* () { for (const tranche of info.tranches) yield await S.lireTranche(await telecharger(`${nom}/${tranche.fichier}`), tranche); })();
        rapport.push(await restaurerLignes(table, source, avertissements));
      } catch (e) {
        rapport.push({ table, lignesSauvegarde: info.lignes, dejaPresentes: 0, inserees: 0, lignesEnEchec: [{ id: null, erreur: e.message }] });
      }
    }
    await realignerSequences(avertissements);
    return { fichier: nom, format: 2, rapport, ...totaux(rapport), avertissements };
  }

  return { sauvegarder, verifierSauvegarde, listerSauvegardes, dateDerniereSauvegarde, sauvegardeDuJourExisteDeja, elaguer, restaurer, restaurerDepuisContenu };
}

module.exports = { creerServiceSauvegarde, TAILLE_LOT_RESTAURATION };
