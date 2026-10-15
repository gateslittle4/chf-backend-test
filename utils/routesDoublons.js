// utils/routesDoublons.js — routes des doublons d'identité et de la fusion de dossiers (14/10). Montées depuis server.js AVANT /api/dossiers/:id
// (sinon Express y verrait un dossier nommé « similaires »). Dépendances injectées pour pouvoir tester sans réseau (tests/routes_doublons.test.js).
//
//   GET  /api/dossiers/similaires?nom=&date_naissance=&telephone=&sexe=   → dossiers qui ressemblent à la personne qu'on s'apprête à créer
//   GET  /api/dossiers/doublons-possibles?niveau=possible|probable|forte  → paires de dossiers qui sont probablement la même personne
//   POST /api/dossiers/doublons-ignores   { a, b }                         → « ce ne sont pas les mêmes personnes » (plus proposées)
//   POST /api/dossiers/:id/fusionner      { cible_id }                     → réunit :id DANS cible_id (annulable)
//   POST /api/dossiers/:id/defusionner                                      → annule une fusion
const crypto = require('crypto');
const { trouverDoublonsSansBloquer, candidatsPour, NIVEAUX } = require('./doublonsIdentite');

const COLONNES_BASE = 'id, numero_dossier, nom, nom_origine, date_naissance, telephone, sexe';
const COLONNES_ETENDUES = `${COLONNES_BASE}, anciens_noms, mere_dossier_id, fusionne_dans`;
const DUREE_CACHE_MS = 60 * 1000;
// 15/10 : au-delà de DUREE_CACHE_MS la liste n'est plus relue EN ENTIER (50 pages de 1 000 à 50 000 dossiers) mais seulement ce qui a changé depuis (colonne modifie_le, tenue à jour
// par la base) ; une relecture complète a lieu toutes les 30 minutes (rattrape aussi les dossiers supprimés, que la lecture par différence ne voit pas).
const RECHARGE_COMPLETE_MS = 30 * 60 * 1000;
const MARGE_MODIFIE_MS = 5000;
const DUREE_CACHE_PAIRES_MS = 5 * 60 * 1000;
const MESSAGE_SQL_MANQUANT = "Le script sql/dossiers_naissance_fusion.sql n'est pas encore collé dans Supabase : la fusion de dossiers n'est pas disponible.";

const CODES_FUSION = {
  CHF11: [404, 'Dossier introuvable.'],
  CHF12: [400, 'Un dossier ne peut pas être fusionné avec lui-même.'],
  CHF13: [409, 'Ce dossier a déjà été fusionné dans un autre.'],
  CHF14: [409, 'Le dossier cible a lui-même été fusionné dans un autre : choisis le dossier final.'],
  CHF15: [409, 'Le dossier cible est un enfant du dossier à fusionner.'],
  CHF16: [409, "Ce dossier n'a pas été fusionné : rien à annuler."],
};

const ordonner = (a, b) => (a < b ? [a, b] : [b, a]);
const publique = (d) => ({ id: d.id, numero_dossier: d.numero_dossier, nom: d.nom, nom_origine: d.nom_origine || null, date_naissance: d.date_naissance || null, telephone: d.telephone || null, sexe: d.sexe || null });

function creerRoutesDoublons({ supabase, aPermission, lireToutesLesPages, maintenant = () => Date.now() }) {
  let cache = null;

  async function chargerDossiers() {
    if (cache && maintenant() - cache.t < DUREE_CACHE_MS) return cache;
    const colonnes = (base) => `${base}, modifie_le`;
    const lire = (cols, depuis) => lireToutesLesPages(() => {
      const requete = supabase.from('dossiers').select(cols);
      return (depuis ? requete.gte('modifie_le', depuis) : requete).order('id');
    });
    // Lecture par différence : seulement si la liste précédente a été lue COMPLÈTEMENT il y a moins de 30 minutes et que chaque ligne porte sa date de modification.
    let dossiers = null, parDifference = false, nbChangements = 0;
    if (cache && cache.derniereModif && maintenant() - cache.chargeCompleteLe < RECHARGE_COMPLETE_MS) {
      try {
        const changes = await lire(colonnes(cache.colonnesBase), new Date(new Date(cache.derniereModif).getTime() - MARGE_MODIFIE_MS).toISOString());
        const parId = new Map(cache.dossiers.map(d => [d.id, d]));
        // Une ligne relue sans changement réel (marge de 5 s) ne compte pas : on compare la date de modification avec ce qu'on avait.
        nbChangements = changes.filter(d => !parId.has(d.id) || parId.get(d.id).modifie_le !== d.modifie_le).length;
        changes.forEach(d => parId.set(d.id, d));
        dossiers = [...parId.values()]; parDifference = true;
      } catch (_) { dossiers = null; } // en cas de doute : relecture complète
    }
    let colonnesBase = cache ? cache.colonnesBase : COLONNES_ETENDUES;
    if (!dossiers) {
      try { dossiers = await lire(colonnes(COLONNES_ETENDUES)); colonnesBase = COLONNES_ETENDUES; }
      catch (e) {
        if (!(e && e.code === '42703')) throw e;
        try { dossiers = await lire(COLONNES_ETENDUES); colonnesBase = COLONNES_ETENDUES; } // sans modifie_le : relectures complètes
        catch (e2) {
          if (e2 && e2.code === '42703') { dossiers = await lire(COLONNES_BASE); colonnesBase = COLONNES_BASE; } // base pas encore migrée : sans fusion ni anciens noms
          else throw e2;
        }
      }
    }
    const modifs = dossiers.map(d => d.modifie_le).filter(Boolean).sort();
    const derniereModif = modifs.length === dossiers.length && modifs.length > 0 ? modifs[modifs.length - 1] : null;
    const { data: ignorees, error } = await supabase.from('doublons_ignores').select('dossier_a, dossier_b');
    const ignores = new Set(error ? [] : (ignorees || []).map(l => `${l.dossier_a}|${l.dossier_b}`));
    // Rien n'a changé (ni dossiers ni paires ignorées) : les paires déjà calculées restent valables.
    const identique = parDifference && nbChangements === 0 && cache.ignores.size === ignores.size;
    cache = { t: maintenant(), dossiers, ignores, colonnesBase, derniereModif, chargeCompleteLe: parDifference ? cache.chargeCompleteLe : maintenant(), version: (cache ? cache.version : 0) + (identique ? 0 : 1), paires: identique ? cache.paires : new Map() };
    return cache;
  }
  const invalider = () => { cache = null; };

  async function audit(req, action, details) {
    try {
      const { error } = await supabase.from('audit_log').insert({
        id: crypto.randomUUID(), action,
        effectue_par: (req.user && (req.user.email || req.user.id)) || null, effectue_par_uid: (req.user && req.user.id) || null,
        details, date: new Date().toISOString(),
      });
      if (error) console.warn(`Audit « ${action} » non enregistré :`, error.message);
    } catch (e) { console.warn(`Audit « ${action} » non enregistré :`, e.message); }
  }

  const peutVoirSimilaires = async (uid) => (await aPermission(uid, 'dossier_creer')) || (await aPermission(uid, 'caisse_travailler')) || (await aPermission(uid, 'fiche_patient_modifier'));

  function monter(app) {
    app.get('/api/dossiers/similaires', async (req, res) => {
      if (!(await peutVoirSimilaires(req.user.id))) return res.status(403).json({ error: 'Permission requise.' });
      const nom = String(req.query.nom || '').trim();
      if (nom.length < 3) return res.json([]);
      try {
        const { dossiers, ignores } = await chargerDossiers();
        const sexe = req.query.sexe === 'M' || req.query.sexe === 'F' ? req.query.sexe : null;
        const trouves = candidatsPour({ nom, date_naissance: req.query.date_naissance || null, telephone: req.query.telephone || null, sexe }, dossiers, { ignores });
        res.json(trouves.map(t => ({ ...publique(t.dossier), score: t.score, niveau: { cle: t.niveau.cle, label: t.niveau.label }, raisons: t.raisons })));
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/dossiers/doublons-possibles', async (req, res) => {
      if (!(await aPermission(req.user.id, 'fiche_patient_modifier'))) return res.status(403).json({ error: "Permission 'fiche_patient_modifier' requise." });
      try {
        const min = (NIVEAUX.find(n => n.cle === req.query.niveau) || NIVEAUX[NIVEAUX.length - 1]).min;
        const etat = await chargerDossiers();
        // Le calcul des paires peut durer plusieurs secondes avec des dizaines de milliers de dossiers : il cède la main au reste du serveur, et son résultat est gardé 5 minutes.
        let calcul = etat.paires.get(min);
        if (!calcul || maintenant() - calcul.t > DUREE_CACHE_PAIRES_MS) {
          calcul = { t: maintenant(), promesse: trouverDoublonsSansBloquer(etat.dossiers, { ignores: etat.ignores, seuil: min }) };
          etat.paires.set(min, calcul);
        }
        const toutes = await calcul.promesse;
        const paires = toutes.slice(0, 200);
        const ids = [...new Set(paires.flatMap(p => [p.a.id, p.b.id]))];
        const nb = {};
        if (ids.length) {
          const { data: episodes } = await supabase.from('episodes').select('dossier_id').in('dossier_id', ids);
          (episodes || []).forEach(e => { nb[e.dossier_id] = (nb[e.dossier_id] || 0) + 1; });
        }
        res.json({
          total: toutes.length,
          paires: paires.map(p => ({
            a: { ...publique(p.a), nb_episodes: nb[p.a.id] || 0 }, b: { ...publique(p.b), nb_episodes: nb[p.b.id] || 0 },
            score: p.score, niveau: { cle: p.niveau.cle, label: p.niveau.label }, raisons: p.raisons,
          })),
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/dossiers/doublons-ignores', async (req, res) => {
      if (!(await aPermission(req.user.id, 'fiche_patient_modifier'))) return res.status(403).json({ error: "Permission 'fiche_patient_modifier' requise." });
      const { a, b } = req.body || {};
      if (!a || !b || a === b) return res.status(400).json({ error: 'Deux dossiers différents sont requis.' });
      const [dossier_a, dossier_b] = ordonner(String(a), String(b));
      const { error } = await supabase.from('doublons_ignores').upsert({ dossier_a, dossier_b, ignore_par: (req.user && (req.user.email || req.user.id)) || null }, { onConflict: 'dossier_a,dossier_b' });
      if (error) {
        if (error.code === '42P01') return res.status(503).json({ error: MESSAGE_SQL_MANQUANT });
        return res.status(500).json({ error: error.message });
      }
      invalider();
      await audit(req, 'doublons_ignores', { dossier_a, dossier_b });
      res.status(201).json({ ok: true });
    });

    const appelerFusion = async (req, res, rpc, args, actionAudit, details) => {
      const { data, error } = await supabase.rpc(rpc, args);
      if (error) {
        if (error.code === '42883') return res.status(503).json({ error: MESSAGE_SQL_MANQUANT });
        if (CODES_FUSION[error.code]) return res.status(CODES_FUSION[error.code][0]).json({ error: CODES_FUSION[error.code][1], code: error.code });
        return res.status(500).json({ error: error.message });
      }
      invalider();
      await audit(req, actionAudit, { ...details, resultat: data });
      res.json(data);
    };

    app.post('/api/dossiers/:id/fusionner', async (req, res) => {
      if (!(await aPermission(req.user.id, 'fiche_patient_modifier'))) return res.status(403).json({ error: "Permission 'fiche_patient_modifier' requise." });
      const cible = req.body && req.body.cible_id;
      if (!cible) return res.status(400).json({ error: 'Le dossier à conserver (cible_id) est requis.' });
      const par = (req.user && (req.user.email || req.user.id)) || 'inconnu';
      const { data: deux } = await supabase.from('dossiers').select('id, numero_dossier, nom').in('id', [req.params.id, cible]);
      const nomDe = (id) => ((deux || []).find(d => d.id === id) || {});
      await appelerFusion(req, res, 'fusionner_dossiers', { p_source: req.params.id, p_cible: cible, p_par: par }, 'fusion_dossiers',
        { source: req.params.id, source_numero: nomDe(req.params.id).numero_dossier, source_nom: nomDe(req.params.id).nom, cible, cible_numero: nomDe(cible).numero_dossier, cible_nom: nomDe(cible).nom });
    });

    app.post('/api/dossiers/:id/defusionner', async (req, res) => {
      if (!(await aPermission(req.user.id, 'fiche_patient_modifier'))) return res.status(403).json({ error: "Permission 'fiche_patient_modifier' requise." });
      const par = (req.user && (req.user.email || req.user.id)) || 'inconnu';
      await appelerFusion(req, res, 'defusionner_dossiers', { p_source: req.params.id, p_par: par }, 'fusion_dossiers_annulee', { source: req.params.id });
    });
  }

  return { monter, chargerDossiers, invalider };
}

module.exports = { creerRoutesDoublons, CODES_FUSION, COLONNES_BASE, COLONNES_ETENDUES };
