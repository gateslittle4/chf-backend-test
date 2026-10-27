// utils/autorisateursSortieCaisse.js — qui peut AUTORISER une sortie de fonds (27/10, Esdras : « Jean Jacques / Madame Dioumitrie : ce sont eux seulement » puis « une liste que je peux modifier,
// disponible à la direction »). Valable pour toute sortie d'argent saisie avec « autorisé par » : « Passer » une sortie de caisse et « Rendre le dépôt ».
// La liste est un réglage (Paramètres > Caisse, réservé à parametres_gerer : la direction) stocké dans le catalogue « parametres » sous `autorisateursSortieCaisse`. Le SERVEUR fait foi : il relit la liste
// au moment de chaque sortie et refuse tout autre nom, même si quelqu'un contourne l'écran. Réglage absent ou invalide → la liste d'origine ci-dessous (jamais une liste vide : sinon plus aucune sortie possible).
const AUTORISATEURS_PAR_DEFAUT = ['Jean Jacques', 'Madame Dioumitrie'];
const LONGUEUR_MAX_NOM = 100;
const NOMBRE_MAX = 20;

// Liste propre à partir de la valeur du réglage : tableau de noms (texte, 2 à 100 caractères, sans espaces autour, sans doublon), 20 au plus ; sinon la liste d'origine.
function autorisateursDepuisReglage(valeur) {
  if (!Array.isArray(valeur)) return [...AUTORISATEURS_PAR_DEFAUT];
  const propres = [];
  for (const v of valeur) {
    if (typeof v !== 'string') continue;
    const nom = v.trim();
    if (nom.length >= 2 && nom.length <= LONGUEUR_MAX_NOM && !propres.includes(nom)) propres.push(nom);
  }
  return propres.length > 0 ? propres.slice(0, NOMBRE_MAX) : [...AUTORISATEURS_PAR_DEFAUT];
}

async function lireAutorisateursSortieCaisse(supabase) {
  try {
    const { data } = await supabase.from('catalog').select('items').eq('type', 'parametres').maybeSingle();
    const items = data && data.items && !Array.isArray(data.items) ? data.items : {};
    return autorisateursDepuisReglage(items.autorisateursSortieCaisse);
  } catch (_) { return [...AUTORISATEURS_PAR_DEFAUT]; }
}

const estAutorisateurSortieCaisse = (nom, liste) => (liste || AUTORISATEURS_PAR_DEFAUT).includes(String(nom || '').trim());
const messageAutorisateurInvalide = (liste) => `Seuls ${(liste || AUTORISATEURS_PAR_DEFAUT).join(', ').replace(/, ([^,]*)$/, ' et $1')} peuvent autoriser une sortie de fonds : choisis l'un d'eux dans « Autorisé par ».`;

module.exports = { AUTORISATEURS_PAR_DEFAUT, autorisateursDepuisReglage, lireAutorisateursSortieCaisse, estAutorisateurSortieCaisse, messageAutorisateurInvalide };
