// utils/routesEtatSysteme.js — routes de l'état du système (14/10) : santé des postes et erreurs de l'application.
//
//   POST  /api/postes/battement            n'importe quel compte connecté : un poste signale sa santé (≈ toutes les 2 minutes)
//   POST  /api/erreurs-client              n'importe quel compte connecté : une erreur vue sur un poste
//   GET   /api/etat-systeme/postes         ADMINISTRATEUR seulement : tous les postes et leur dernière vue
//   GET   /api/etat-systeme/erreurs        ADMINISTRATEUR seulement : erreurs regroupées
//   PATCH /api/etat-systeme/erreurs/:id    ADMINISTRATEUR seulement : { statut: nouveau | vu | resolu }
// Tant que sql/etat_systeme.sql n'est pas collé, les deux envois répondent 204 (sans bruit) et les deux lectures disent installe:false.
const { preparerErreur } = require('./erreursClient');

const entier = (v, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null; };
const texte = (v, n) => (v === undefined || v === null || v === '' ? null : String(v).replace(/[^\w .:/@()#+,-]/g, '').slice(0, n) || null);
const tableAbsente = (error) => !!error && (error.code === '42P01' || error.code === 'PGRST205' || error.code === '42883');
const STATUTS = ['nouveau', 'vu', 'resolu'];
const MAX_ERREURS_PAR_MINUTE = 30;

function creerRoutesEtatSysteme({ supabase, maintenant = () => Date.now() }) {
  const compteurs = new Map(); // compte → { debut, n } : plafond d'erreurs envoyées par minute
  let dernierMenage = 0;

  async function estAdministrateur(uid) {
    const { data } = await supabase.from('users').select('role, active, date_expiration').eq('id', uid).maybeSingle();
    return !!data && data.role === 'administrateur' && data.active !== false && !(data.date_expiration && new Date(data.date_expiration) < new Date(maintenant()));
  }
  async function profilDe(uid) {
    const { data } = await supabase.from('users').select('role, display_name').eq('id', uid).maybeSingle();
    return data || {};
  }
  const refuserSiPasAdmin = async (req, res) => {
    if (await estAdministrateur(req.user.id)) return false;
    res.status(403).json({ error: "Réservé à l'administrateur." });
    return true;
  };

  function monter(app) {
    app.post('/api/postes/battement', async (req, res) => {
      const c = req.body || {};
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(c.poste_id || ''))) return res.status(400).json({ error: 'Identifiant de poste invalide.' });
      const profil = await profilDe(req.user.id);
      const maintenantMs = maintenant();
      const ageSync = entier(c.derniere_sync_age_s, 0, 10 * 365 * 86400);
      const ligne = {
        poste_id: c.poste_id, uid: req.user.id, utilisateur: texte(profil.display_name || req.user.email || req.user.id, 80), role: texte(profil.role, 40),
        vu_le: new Date(maintenantMs).toISOString(),
        version_app: texte(c.version_app, 40), appareil: texte(c.appareil, 80), onglet: texte(c.onglet, 60),
        en_ligne: c.en_ligne !== false,
        en_attente: entier(c.en_attente, 0, 1e6) ?? 0, bloquees: entier(c.bloquees, 0, 1e6) ?? 0,
        anciennete_file_s: entier(c.anciennete_file_s, 0, 10 * 365 * 86400),
        derniere_sync_le: ageSync === null ? null : new Date(maintenantMs - ageSync * 1000).toISOString(),
        decalage_ms: entier(c.decalage_ms, -1e11, 1e11), latence_ms: entier(c.latence_ms, 0, 600000),
        erreurs_recentes: entier(c.erreurs_recentes, 0, 1e6) ?? 0,
      };
      const { error } = await supabase.from('postes_etat').upsert(ligne, { onConflict: 'poste_id' });
      if (error) {
        if (tableAbsente(error)) return res.status(204).end();
        return res.status(500).json({ error: error.message });
      }
      if (maintenantMs - dernierMenage > 6 * 3600 * 1000) { dernierMenage = maintenantMs; supabase.rpc('nettoyer_etat_systeme').then(() => {}, () => {}); }
      res.status(204).end();
    });

    app.post('/api/erreurs-client', async (req, res) => {
      const maintenantMs = maintenant();
      const clef = req.user.id;
      const s = compteurs.get(clef);
      if (!s || maintenantMs - s.debut > 60000) compteurs.set(clef, { debut: maintenantMs, n: 1 });
      else if (++s.n > MAX_ERREURS_PAR_MINUTE) return res.status(429).json({ error: 'Trop d\'erreurs envoyées : réessaie dans une minute.' });
      const e = preparerErreur(req.body);
      if (e.erreur) return res.status(400).json({ error: e.erreur });
      const profil = await profilDe(req.user.id);
      const { error } = await supabase.rpc('signaler_erreur_client', {
        p_empreinte: e.empreinte, p_message: e.message, p_pile: e.pile, p_source: e.source, p_onglet: e.onglet, p_version: e.version_app,
        p_poste: e.poste_id, p_utilisateur: texte(profil.display_name || req.user.email || req.user.id, 80), p_nombre: e.nombre,
      });
      if (error) {
        if (tableAbsente(error)) return res.status(204).end();
        return res.status(500).json({ error: error.message });
      }
      res.status(204).end();
    });

    app.get('/api/etat-systeme/postes', async (req, res) => {
      if (await refuserSiPasAdmin(req, res)) return;
      const { data, error } = await supabase.from('postes_etat').select('*').order('vu_le', { ascending: false }).limit(200);
      if (error) {
        if (tableAbsente(error)) return res.json({ installe: false, maintenant: new Date(maintenant()).toISOString(), postes: [] });
        return res.status(500).json({ error: error.message });
      }
      res.json({ installe: true, maintenant: new Date(maintenant()).toISOString(), postes: data || [] });
    });

    app.get('/api/etat-systeme/erreurs', async (req, res) => {
      if (await refuserSiPasAdmin(req, res)) return;
      const { data, error } = await supabase.from('erreurs_client').select('*').order('derniere_le', { ascending: false }).limit(200);
      if (error) {
        if (tableAbsente(error)) return res.json({ installe: false, erreurs: [], nouvelles: 0 });
        return res.status(500).json({ error: error.message });
      }
      const liste = data || [];
      res.json({ installe: true, erreurs: liste, nouvelles: liste.filter(x => x.statut === 'nouveau').length });
    });

    app.patch('/api/etat-systeme/erreurs/:id', async (req, res) => {
      if (await refuserSiPasAdmin(req, res)) return;
      const statut = req.body && req.body.statut;
      if (!STATUTS.includes(statut)) return res.status(400).json({ error: 'Statut invalide (nouveau, vu ou resolu).' });
      const maj = statut === 'nouveau' ? { statut, traite_par: null, traite_le: null }
        : { statut, traite_par: (req.user && (req.user.email || req.user.id)) || null, traite_le: new Date(maintenant()).toISOString() };
      const { data, error } = await supabase.from('erreurs_client').update(maj).eq('id', req.params.id).select();
      if (error) {
        if (tableAbsente(error)) return res.status(503).json({ error: "Le script sql/etat_systeme.sql n'est pas encore collé dans Supabase." });
        return res.status(500).json({ error: error.message });
      }
      if (!data || data.length === 0) return res.status(404).json({ error: 'Erreur introuvable.' });
      res.json(data[0]);
    });
  }
  return { monter };
}

module.exports = { creerRoutesEtatSysteme, STATUTS, MAX_ERREURS_PAR_MINUTE };
