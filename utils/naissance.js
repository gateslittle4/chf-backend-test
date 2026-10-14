// utils/naissance.js — règles du dossier de naissance (14/10) : lien bébé → mère et nom définitif du bébé. Fonctions pures + une vérification de la mère
// qui reçoit le client Supabase en argument (testable sans réseau).

// Le bébé reçoit d'abord un nom temporaire (« Bébé Marie Joseph »), puis son vrai nom au retour de la mère. Chaque nom quitté est gardé dans anciens_noms
// (nom_origine, lui, reste le tout premier nom de la création). Renvoie la nouvelle liste, ou null si le nom n'a pas changé.
function anciensNomsApresRenommage(actuel, nouveauNom, par, maintenantIso) {
  const ancien = String((actuel && actuel.nom) || '').trim();
  const nouveau = String(nouveauNom || '').trim();
  if (!ancien || !nouveau || ancien === nouveau) return null;
  const liste = Array.isArray(actuel.anciens_noms) ? actuel.anciens_noms : [];
  return [...liste, { nom: ancien, jusqu_au: maintenantIso, origine: 'renommage', par: par || null }];
}

// Vérifie la mère indiquée pour un dossier. enfantId : le dossier qu'on modifie (null à la création) — pour refuser « sa propre mère » et les cycles.
// Renvoie { ok: true, mere } ou { ok: false, status, erreur }.
async function verifierMere(supabase, mereId, enfantId = null) {
  if (!mereId) return { ok: false, status: 400, erreur: 'Le dossier de la mère est requis.' };
  if (enfantId && mereId === enfantId) return { ok: false, status: 400, erreur: 'Un dossier ne peut pas être sa propre mère.' };
  const { data: mere, error } = await supabase.from('dossiers').select('id, numero_dossier, nom, sexe, mere_dossier_id, fusionne_dans').eq('id', mereId).maybeSingle();
  if (error) {
    if (error.code === '42703') return { ok: false, status: 503, erreur: "Le script sql/dossiers_naissance_fusion.sql n'est pas encore collé dans Supabase : le lien bébé → mère n'est pas disponible." };
    return { ok: false, status: 500, erreur: error.message };
  }
  if (!mere) return { ok: false, status: 404, erreur: 'Dossier de la mère introuvable.' };
  if (mere.fusionne_dans) return { ok: false, status: 409, erreur: 'Ce dossier a été fusionné dans un autre : choisis le dossier final de la mère.' };
  if (mere.sexe === 'M') return { ok: false, status: 400, erreur: 'La mère doit être une femme : le dossier choisi est celui d\'un homme.' };
  if (enfantId && mere.mere_dossier_id === enfantId) return { ok: false, status: 409, erreur: 'Ce dossier est déjà un enfant du dossier à modifier (lien en boucle).' };
  return { ok: true, mere };
}

module.exports = { anciensNomsApresRenommage, verifierMere };
