// utils/fermetureConsultations.js — une consultation se ferme toute seule 1 mois après son ouverture (19/10, Esdras : « après 1 mois, toutes les données changent »).
// Seulement les consultations OUVERTES (jamais une hospitalisation : elle se ferme avec ses dates d'entrée et de sortie ; jamais une vente comptoir ; jamais un épisode suspendu ou reporté, état voulu
// par une personne). La fermeture n'efface aucune dette ni aucun dépôt : ils vivent dans les paiements, pas dans l'état de l'épisode. Inscrite au journal d'audit.
const JOURS_PAR_DEFAUT = 30;
const LOT_MAX = 500;

async function fermerConsultationsAnciennes({ supabase, maintenant = () => new Date(), journal = console, jours = JOURS_PAR_DEFAUT } = {}) {
  const instant = maintenant();
  const limite = new Date(instant.getTime() - jours * 86400000).toISOString();
  const { data: anciennes, error } = await supabase.from('episodes').select('id, dossier_id, date_ouverture, service, type_consultation')
    .eq('statut', 'ouvert').eq('est_hospitalisation', false).neq('voie_entree', 'vente_comptoir').is('supprime_le', null).is('date_suspension', null).is('mois_report', null)
    .lt('date_ouverture', limite).limit(LOT_MAX);
  if (error) { journal.warn(`Fermeture automatique des consultations : lecture impossible (${error.message})`); return { ok: false, erreur: error.message, fermees: 0 }; }
  if (!anciennes || anciennes.length === 0) return { ok: true, fermees: 0 };
  const ids = anciennes.map(e => e.id);
  const { data: fermees, error: erreurMaj } = await supabase.from('episodes')
    .update({ statut: 'ferme', date_fermeture: instant.toISOString(), motif_fermeture: 'fermeture_automatique' }).in('id', ids).eq('statut', 'ouvert').select('id');
  if (erreurMaj) { journal.warn(`Fermeture automatique des consultations refusée par la base : ${erreurMaj.message} (le script sql/hospitaliser_depuis_consultation.sql est-il collé ?)`); return { ok: false, erreur: erreurMaj.message, fermees: 0 }; }
  const nombre = (fermees || []).length;
  if (nombre > 0) {
    const { error: erreurAudit } = await supabase.from('audit_log').insert({
      id: require('node:crypto').randomUUID(), action: 'fermeture_auto_consultations', effectue_par: 'système (fermeture automatique)', effectue_par_uid: null, date: instant.toISOString(),
      details: { nombre, jours, episodes: (fermees || []).slice(0, 50).map(e => e.id) },
    });
    if (erreurAudit) journal.warn(`Fermeture automatique : journal non écrit (${erreurAudit.message})`);
    journal.log(`🗂️ ${nombre} consultation(s) de plus de ${jours} jours fermée(s) automatiquement.`);
  }
  return { ok: true, fermees: nombre };
}

module.exports = { fermerConsultationsAnciennes, JOURS_PAR_DEFAUT };
