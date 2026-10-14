// utils/routesDoublons.js — routes des doublons d'identité et de la fusion de dossiers (14/10). Montées depuis server.js AVANT /api/dossiers/:id
// (sinon Express y verrait un dossier nommé « similaires »). Dépendances injectées pour pouvoir tester sans réseau (tests/routes_doublons.test.js).
//
//   GET  /api/dossiers/similaires?nom=&date_naissance=&telephone=&sexe=   → dossiers qui ressemblent à la personne qu'on s'apprête à créer
//   GET  /api/dossiers/doublons-possibles?niveau=possible|probable|forte  → paires de dossiers qui sont probablement la même personne
//   POST /api/dossiers/doublons-ignores   { a, b }                         → « ce ne sont pas les mêmes personnes » (plus proposées)
//   POST /api/dossiers/:id/fusionner      { cible_id }                     → réunit :id DANS cible_id (annulable)
//   POST /api/dossiers/:id/defusionner                                      → annule une fusion
const crypto = require('crypto');
const { trouverDoublons, candidatsPour, NIVEAUX } = require('./doublonsIdentite');

const COLONNES_BASE = 'id, numero_dossier, nom, nom_origine, date_naissance, telephone, sexe';
const COLONNES_ETENDUES = `${COLONNES_BASE}, anciens_noms, mere_dossier_id, fusionne_dans`;
const DUREE_CACHE_MS = 60 * 1000;
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
    const lire = (colonnes) => lireToutesLesPages(() => supabase.from('dossiers').select(colonnes).order('id'));
    let dossiers;
    try { dossiers = await lire(COLONNES_ETENDUES); }
    catch (e) {
      if (e && e.code === '42703') dossiers = await lire(COLONNES_BASE); // base pas encore migrée : sans fusion ni anciens noms
      else throw e;
    }
    const { data: ignorees, error } = await supabase.from('doublons_ignores').select('dossier_a, dossier_b');
    const ignores = new Set(error ? [] : (ignorees || []).map(l => `${l.dossier_a}|${l.dossier_b}`));
    cache = { t: maintenant(), dossiers, ignores };
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
        const { dossiers, ignores } = await chargerDossiers();
        const toutes = trouverDoublons(dossiers, { ignores, seuil: min });
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
