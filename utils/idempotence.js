// utils/idempotence.js — écritures idempotentes par clé (en-tête Idempotency-Key).
//
// Audit hors ligne du 28/09. L'app coupe maintenant toute écriture qui ne répond pas en 15 s et la
// met en file d'attente (connexion "qui semble active mais ne répond pas"). Mais une requête
// abandonnée par le navigateur a PEUT-ÊTRE été reçue et traitée ici : la rejouer ne doit jamais
// l'appliquer deux fois. Les routes de CRÉATION étaient déjà protégées une par une (local_id) ; les
// MODIFICATIONS (transfert de service, lit, annulation de paiement, numéro de lot...) ne l'étaient
// pas — rejouées, elles s'appliquaient deux fois ou étaient refusées à tort ("un autre poste a changé
// ce patient"), ce qui envoyait une opération pourtant réussie dans la liste des échecs.
//
// Principe : la clé est RÉSERVÉE avant d'exécuter la route (clé primaire : deux rejeux simultanés ne
// peuvent pas passer tous les deux), la réponse est enregistrée si elle réussit (2xx), et un rejeu de
// la même clé reçoit cette même réponse sans que la route soit exécutée une 2e fois.
// - Une réponse en échec (4xx/5xx) n'est PAS gardée : la clé est libérée, un rejeu réexécute la route
//   (un refus reste un refus ; une panne passagère a une nouvelle chance).
// - Rejeu pendant que la 1re exécution tourne encore : 503 OPERATION_EN_COURS — l'app le traite
//   comme une indisponibilité passagère (mise en file, nouvel essai plus tard).
// - Réservation orpheline (serveur redémarré en pleine requête) : considérée abandonnée au bout de
//   DUREE_ABANDON_MS, la route est alors réexécutée — les créations restent protégées par local_id.
// - Clé préfixée par l'uid : la clé d'une personne ne peut jamais renvoyer la réponse d'une autre.
// - Table absente (script SQL pas encore appliqué) ou base injoignable : la route s'exécute
//   normalement, comme avant cette protection (jamais de blocage de l'app pour ça).
const TABLE = 'requetes_idempotentes';
const DUREE_ABANDON_MS = 2 * 60 * 1000;
const METHODES = ['POST', 'PUT', 'PATCH', 'DELETE'];

function creerMiddlewareIdempotence(supabase, { journal = console } = {}) {
  return async function idempotence(req, res, next) {
    const brute = req.get && req.get('Idempotency-Key');
    if (!brute || !METHODES.includes(req.method) || !req.user || !req.user.id) return next();
    const cle = `${req.user.id}:${String(brute).slice(0, 200)}`;
    const chemin = req.originalUrl || req.url;

    const reserver = () => supabase.from(TABLE).insert({ cle, methode: req.method, chemin, uid: req.user.id });
    let { error } = await reserver();
    if (error && error.code === '23505') {
      const { data: existante, error: erreurLecture } = await supabase.from(TABLE).select('statut, reponse, cree_le').eq('cle', cle).maybeSingle();
      if (erreurLecture) { journal.warn('Idempotence : lecture impossible, exécution normale :', erreurLecture.message); return next(); }
      if (existante && existante.statut != null) {
        res.set('Idempotent-Replayed', 'true');
        return res.status(existante.statut).json(existante.reponse);
      }
      const age = existante && existante.cree_le ? Date.now() - new Date(existante.cree_le).getTime() : Infinity;
      if (age < DUREE_ABANDON_MS) {
        return res.status(503).json({ error: 'OPERATION_EN_COURS', message: 'Cette opération est déjà en cours de traitement — nouvel essai automatique dans un instant.' });
      }
      // Réservation orpheline : on la reprend.
      await supabase.from(TABLE).delete().eq('cle', cle);
      ({ error } = await reserver());
    }
    if (error) {
      if (error.code !== '42P01') journal.warn('Idempotence : réservation impossible, exécution normale :', error.message);
      return next();
    }

    // Capture du corps de la réponse (res.json) et enregistrement une fois la réponse partie.
    let corps;
    const jsonOriginal = res.json.bind(res);
    res.json = (valeur) => { corps = valeur; return jsonOriginal(valeur); };
    res.on('finish', () => {
      const statut = res.statusCode;
      const operation = (statut >= 200 && statut < 300 && corps !== undefined)
        ? supabase.from(TABLE).update({ statut, reponse: corps }).eq('cle', cle)
        : supabase.from(TABLE).delete().eq('cle', cle);
      Promise.resolve(operation).then(r => { if (r && r.error) journal.warn('Idempotence : enregistrement impossible :', r.error.message); })
        .catch(e => journal.warn('Idempotence : enregistrement impossible :', e.message));
    });
    next();
  };
}

// Ménage : les clés servent à absorber un REJEU (minutes, heures, au pire quelques jours de coupure).
async function purgerClesIdempotence(supabase, jours = 30) {
  const limite = new Date(Date.now() - jours * 86400000).toISOString();
  const { error } = await supabase.from(TABLE).delete().lt('cree_le', limite);
  return error ? { erreur: error.message } : { ok: true };
}

module.exports = { creerMiddlewareIdempotence, purgerClesIdempotence, TABLE, DUREE_ABANDON_MS };
