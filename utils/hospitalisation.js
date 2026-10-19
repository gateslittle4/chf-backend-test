// utils/hospitalisation.js — passer un patient de la CONSULTATION à l'HOSPITALISATION (19/10, Esdras).
// Le docteur retient le patient : la consultation ouverte est FERMÉE et une hospitalisation s'ouvre, dans un NOUVEL épisode lié à la consultation (episode_origine_id) — les fiches et les
// paiements de la consultation restent sur la consultation (revenus par service, statistiques et rapport du ministère restent justes). Le dépôt restant et le crédit (dette) restant PASSENT
// à l'hospitalisation, SANS aucun argent encaissé ni rendu : deux lignes « transfert_hospitalisation » de 0 Gdes (une sur chaque épisode) déplacent seulement les soldes.
//   - dépôt : la ligne de la consultation « consomme » le dépôt restant (details.montant_depot_utilise), celle de l'hospitalisation l'ajoute (details.depot_transfere) — voir calculerSoldeDepot ;
//   - crédit : la ligne de la consultation porte solde_restant = 0, celle de l'hospitalisation solde_restant = la dette reprise (le dernier paiement de l'épisode fait foi pour le crédit).
// Le montant 0 fait que la caisse du jour, la direction et les lots ne comptent jamais deux fois cet argent.
// Fonction à base de `supabase` injecté (tests : base simulée). Sans transaction côté base : l'épisode d'origine est « réservé » en premier (fermeture conditionnelle : un double clic ou deux postes
// ne peuvent pas la faire deux fois), puis tout est défait si une étape échoue.
const MODE_TRANSFERT = 'transfert_hospitalisation';
const TYPES_LIT = ['normal', 'semi_prive', 'prive', 'isolette', 'incubateur'];

const arrondi2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const echec = (statut, message, code) => Object.assign(new Error(message), { statut, code });

function validerDemande({ service, typeLit }) {
  const s = typeof service === 'string' ? service.trim() : '';
  if (!s) return 'Le service d\'hospitalisation est requis.';
  if (s.length > 80) return 'Le nom du service est trop long.';
  if (!TYPES_LIT.includes(typeLit)) return 'Le type de lit est requis.';
  return null;
}

async function hospitaliserEpisode({ supabase, episodeId, service, typeLit, utilisateur, calculerSoldeDepot, maintenant = () => new Date() }) {
  const erreur = validerDemande({ service, typeLit });
  if (erreur) throw echec(400, erreur, 'DEMANDE_INVALIDE');
  const serviceNet = service.trim();

  const { data: origine, error: erreurLecture } = await supabase.from('episodes').select('*').eq('id', episodeId).is('supprime_le', null).maybeSingle();
  if (erreurLecture) throw echec(500, erreurLecture.message, 'LECTURE');
  if (!origine) throw echec(404, 'Épisode introuvable.', 'INTROUVABLE');
  if (origine.est_hospitalisation) throw echec(400, 'Ce patient est déjà en hospitalisation.', 'DEJA_HOSPITALISE');
  if (origine.statut !== 'ouvert') throw echec(400, 'Seule une consultation ouverte peut être transformée en hospitalisation.', 'EPISODE_FERME');
  if (origine.voie_entree === 'vente_comptoir') throw echec(400, 'Une vente au comptoir ne peut pas devenir une hospitalisation.', 'VENTE_COMPTOIR');

  // Les soldes sont lus AVANT de réserver (lecture seule), puis relus après la réservation : un paiement arrivé entre-temps serait ainsi pris en compte.
  const lireSoldes = async () => {
    const { data: paiements, error } = await supabase.from('paiements').select('*').eq('episode_id', episodeId).is('supprime_le', null).order('date_paiement', { ascending: true });
    if (error) throw echec(500, error.message, 'LECTURE_PAIEMENTS');
    const valides = (paiements || []).filter(p => !p.annule);
    const { soldeDepot } = calculerSoldeDepot(valides);
    const dernier = valides[valides.length - 1];
    const dette = dernier && Number(dernier.solde_restant) > 0 ? arrondi2(dernier.solde_restant) : 0;
    // Début de la dette en cours : le premier paiement qui l'a fait naître (pour que l'âge de la créance ne reparte pas de zéro).
    let debutDette = null;
    if (dette > 0) {
      let precedent = 0;
      for (const p of valides) { const reste = Number(p.solde_restant) || 0; if (reste > 0 && precedent <= 0) debutDette = p.date_paiement; if (reste <= 0) debutDette = null; precedent = reste; }
    }
    return { depot: arrondi2(soldeDepot), dette, debutDette };
  };

  const horodatage = maintenant().toISOString();
  // Réservation : la consultation se ferme maintenant, seulement si elle est encore ouverte.
  const { data: reservee, error: erreurReservation } = await supabase.from('episodes')
    .update({ statut: 'ferme', date_fermeture: horodatage, motif_fermeture: 'hospitalise' })
    .eq('id', episodeId).eq('statut', 'ouvert').eq('est_hospitalisation', false).is('supprime_le', null).select();
  if (erreurReservation) throw echec(500, erreurReservation.message, 'RESERVATION');
  if (!reservee || reservee.length === 0) throw echec(409, 'Cette consultation vient d\'être fermée ou hospitalisée par quelqu\'un d\'autre.', 'DEJA_TRAITE');

  const defaire = async ({ nouvelId, lignes }) => {
    for (const id of lignes) await supabase.from('paiements').delete().eq('id', id);
    if (nouvelId) await supabase.from('episodes').delete().eq('id', nouvelId);
    await supabase.from('episodes').update({ statut: 'ouvert', date_fermeture: null, motif_fermeture: null }).eq('id', episodeId);
  };

  let nouvelEpisode = null; const lignesCreees = [];
  try {
    const { data: dossier } = await supabase.from('dossiers').select('nom').eq('id', origine.dossier_id).maybeSingle();
    const { data: cree, error: erreurCreation } = await supabase.from('episodes').insert({
      dossier_id: origine.dossier_id, voie_entree: 'urgence', service: serviceNet, type_consultation: null,
      type_patient: origine.type_patient, ong_partenaire: origine.ong_partenaire || null, ong_partenaire_id: origine.ong_partenaire_id || null,
      statut: 'ouvert', est_hospitalisation: true, type_lit: typeLit, episode_origine_id: origine.id, date_ouverture: horodatage,
    }).select().single();
    if (erreurCreation) throw echec(500, erreurCreation.message, 'CREATION');
    nouvelEpisode = cree;

    const { depot, dette, debutDette } = await lireSoldes();
    const signature = { encaisse_par: utilisateur.email || utilisateur.id, traite_par_uid: utilisateur.id, patient_nom: (dossier && dossier.nom) || null, date_paiement: horodatage, mode: MODE_TRANSFERT, montant: 0, fiche_id: null, type_patient: origine.type_patient === 'partenaire' ? 'ONG' : 'PRIVE', ong_partenaire: origine.ong_partenaire || null };
    if (depot > 0 || dette > 0) {
      const entrante = { ...signature, episode_id: nouvelEpisode.id, solde_restant: dette, details: { depuis_episode: origine.id, ...(depot > 0 ? { depot_transfere: depot } : {}), ...(dette > 0 ? { dette_transferee: dette, dette_depuis: debutDette } : {}) } };
      const sortante = { ...signature, episode_id: origine.id, solde_restant: 0, details: { vers_episode: nouvelEpisode.id, ...(depot > 0 ? { montant_depot_utilise: depot } : {}), ...(dette > 0 ? { dette_transferee: dette } : {}) } };
      // D'abord la ligne de l'hospitalisation (si la 2e échoue, on défait la 1re) : jamais d'argent « perdu » ; la ligne de la consultation vient en dernier, une fois l'autre sûre.
      const { data: l1, error: e1 } = await supabase.from('paiements').insert(entrante).select().single();
      if (e1) throw echec(500, e1.message, 'TRANSFERT_ENTRANT');
      lignesCreees.push(l1.id);
      const { data: l2, error: e2 } = await supabase.from('paiements').insert(sortante).select().single();
      if (e2) throw echec(500, e2.message, 'TRANSFERT_SORTANT');
      lignesCreees.push(l2.id);
    }
    return { nouvelEpisode, consultationFermee: { ...origine, statut: 'ferme', date_fermeture: horodatage, motif_fermeture: 'hospitalise' }, transfere: { depot, dette } };
  } catch (e) {
    await defaire({ nouvelId: nouvelEpisode && nouvelEpisode.id, lignes: lignesCreees });
    throw e.statut ? e : echec(500, e.message, 'ERREUR');
  }
}

module.exports = { MODE_TRANSFERT, TYPES_LIT, validerDemande, hospitaliserEpisode };
