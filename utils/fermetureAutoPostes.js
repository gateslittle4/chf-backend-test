// utils/fermetureAutoPostes.js — fermeture AUTOMATIQUE des postes de caisse (15/10, Esdras : « que le poste ne reste pas ouvert : de 8h à 16h, de 16h à 8h,
// demander de le garder actif 15, 10, 5 min avant, si la personne dit de le garder, redemander toutes les 10 minutes, sans réponse le poste se ferme tout seul »).
//
// Règle (la MÊME est dans chf-app2/utils/sessionsCaisse.js, côté écran) :
//   - heure habituelle de fin, en heure d'HAÏTI : poste jour 16h, poste nuit 8h (la première après l'ouverture) ;
//   - « Garder actif » écrit session.prolongeJusqua = limite + 10 min ; la limite effective est la plus tardive des deux ;
//   - passé la limite effective, le serveur ferme le poste : fermetureISO = la limite (l'heure à laquelle il aurait dû se fermer, pas l'heure du réveil du serveur,
//     qui peut être bien plus tard), argent NON compté (comptantRemis/fondConserve null, fermetureAuto: true) — aucun chiffre n'est inventé.
const FUSEAU_HAITI = 'America/Port-au-Prince';
const HEURE_FIN = { jour: 16, nuit: 8 };
const PROLONGATION_MS = 10 * 60 * 1000;

// Parties de date/heure d'un instant, en heure d'Haïti.
function partiesHaiti(ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: FUSEAU_HAITI, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { an: +p.year, mois: +p.month, jour: +p.day, heure: +p.hour, minute: +p.minute, seconde: +p.second };
}

// L'instant (ms) où il est `heure`:00 à Haïti ce jour-là (an, mois, jour) — sans décalage fixe : Haïti change d'heure (UTC-5 / UTC-4).
function instantHaiti(an, mois, jour, heure) {
  let ms = Date.UTC(an, mois - 1, jour, heure, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = partiesHaiti(ms);
    const ecartMin = (Date.UTC(an, mois - 1, jour, heure, 0, 0) - Date.UTC(p.an, p.mois - 1, p.jour, p.heure, p.minute, p.seconde)) / 60000;
    if (ecartMin === 0) break;
    ms += ecartMin * 60000;
  }
  return ms;
}

// Heure habituelle de fin (ms) : la première heure de fin (16h pour jour, 8h pour nuit, heure d'Haïti) STRICTEMENT après l'ouverture.
function limiteHabituelle(session) {
  const ouverture = new Date(session && session.ouvertureISO).getTime();
  const heureFin = HEURE_FIN[session && session.poste] ?? HEURE_FIN.jour;
  if (!Number.isFinite(ouverture)) return null;
  const p = partiesHaiti(ouverture);
  let fin = instantHaiti(p.an, p.mois, p.jour, heureFin);
  if (fin <= ouverture) { const demain = partiesHaiti(fin + 36 * 3600 * 1000); fin = instantHaiti(demain.an, demain.mois, demain.jour, heureFin); }
  return fin;
}

// Limite effective : la plus tardive entre l'heure habituelle et la prolongation demandée.
function limiteEffective(session) {
  const base = limiteHabituelle(session);
  if (base === null) return null;
  const prolonge = new Date(session.prolongeJusqua).getTime();
  return Number.isFinite(prolonge) ? Math.max(base, prolonge) : base;
}

function sessionsAFermer(sessions, maintenantMs) {
  return (sessions || []).filter(s => s && s.statut === 'ouverte').map(s => ({ session: s, limite: limiteEffective(s) }))
    .filter(x => x.limite !== null && maintenantMs >= x.limite);
}

// Ferme tous les postes expirés. Relit la liste juste avant d'écrire. Ne lève jamais : renvoie le nombre de postes fermés.
async function fermerPostesExpires({ supabase, maintenant = () => Date.now(), journal = console }) {
  try {
    const { data: ligne, error } = await supabase.from('catalog').select('items').eq('type', 'sessions_caisse').maybeSingle();
    if (error) { if (error.code !== '42P01') journal.warn('Fermeture auto des postes : lecture impossible — ' + error.message); return 0; }
    const aFermer = sessionsAFermer((ligne && ligne.items) || [], maintenant());
    if (aFermer.length === 0) return 0;
    const maj = aFermer.map(({ session, limite }) => ({ id: session.id, champs: {
      fermetureISO: new Date(limite).toISOString(), comptantRemis: null, fondConserve: null, statut: 'fermee', fermetureAuto: true,
      justification: "Fermeture automatique : aucune réponse à « garder le poste actif ? » — argent non compté.",
    } }));
    const { error: erreurEcriture } = await supabase.rpc('definir_champs_catalogue_lot', { p_type: 'sessions_caisse', p_maj: maj });
    if (erreurEcriture) { journal.warn('Fermeture auto des postes : écriture impossible — ' + erreurEcriture.message); return 0; }
    for (const { session, limite } of aFermer) {
      try {
        await supabase.from('audit_log').insert({
          id: require('node:crypto').randomUUID(), action: 'fermeture_auto_session_caisse', effectue_par: 'système', effectue_par_uid: null,
          details: { poste: session.poste, caissier: session.nom, uid: session.uid, ouverture: session.ouvertureISO, fermeture: new Date(limite).toISOString() },
          date: new Date(maintenant()).toISOString(),
        });
      } catch (e) { journal.warn('Audit de fermeture auto non enregistré : ' + e.message); }
    }
    journal.log(`🔒 ${aFermer.length} poste(s) de caisse fermé(s) automatiquement.`);
    return aFermer.length;
  } catch (e) {
    journal.warn('Fermeture auto des postes : ' + e.message);
    return 0;
  }
}

module.exports = { FUSEAU_HAITI, PROLONGATION_MS, partiesHaiti, instantHaiti, limiteHabituelle, limiteEffective, sessionsAFermer, fermerPostesExpires };
