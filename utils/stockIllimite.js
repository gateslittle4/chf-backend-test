// utils/stockIllimite.js — réglage « Stock illimité » (17/11, Esdras : « met tous les stocks de façon infinie pour l'instant »).
// Paramètres > Stock > « Stock illimité » (catalogue « parametres », clé stockIllimite). Quand il est actif, tout ce qui SORT du stock réussit sans toucher aux quantités :
// vente, don, réquisition, sa modification, son annulation, le retour d'un service, la remise en stock d'une fiche retirée. Le stock réel garde le dernier chiffre connu ;
// les réceptions et les corrections manuelles de la gestion des stocks continuent de le changer. Le serveur relit le réglage à CHAQUE appel : jamais l'écran.
// Branché une seule fois, sur le client de base de données de routes/stock.js (voir la ligne « @enveloppe » en tête du module) : les routes gardent leurs appels `supabase.rpc(...)` d'origine.
const { lireReglagesDirection, stockIllimiteActif } = require('./reglagesDirection');

const FONCTIONS_QUI_BOUGENT = new Set(['decrementer_stock_medicaments', 'decrementer_stock_service', 'decrementer_stock_dons', 'restituer_stock_ventes', 'transferer_stock_service']);
// Annuler ou modifier une réquisition qui n'a pas de stock propre remet des quantités à la pharmacie avec `ajouter_stock_medicament` ; leurs identifiants d'idempotence portent ces marques.
// (Les réceptions et « ajouter du stock » gardent leurs propres identifiants et restent des vraies entrées.)
const MARQUES_REQUISITION = /-annulation-|-modif-/;

// 23/11 : un retrait de stock donné VOULU par la direction (POST /api/stock/retirer-don, identifiant « -retrait-don ») sort vraiment le stock, même en mode illimité : ce n'est pas une vente.
const MARQUE_RETRAIT_DON = /-retrait-don/;
const estUnRetraitDeDon = (nom, params) => nom === 'decrementer_stock_dons' && !!params && typeof params.p_local_id === 'string' && MARQUE_RETRAIT_DON.test(params.p_local_id);
const estUnMouvementDeStock = (nom, params) => (FONCTIONS_QUI_BOUGENT.has(nom) && !estUnRetraitDeDon(nom, params))
  || (nom === 'ajouter_stock_medicament' && !!params && typeof params.p_local_id === 'string' && MARQUES_REQUISITION.test(params.p_local_id));

function avecStockIllimite(supabase) {
  return new Proxy(supabase, {
    get(cible, prop) {
      if (prop === 'rpc') {
        return async (nom, params, ...reste) => {
          if (estUnMouvementDeStock(nom, params) && stockIllimiteActif(await lireReglagesDirection(cible))) {
            const { data: catalogue } = await cible.from('catalog').select('items').eq('type', 'medicaments').maybeSingle();
            return { data: { succes: true, stock_illimite: true, items: (catalogue && catalogue.items) || [] }, error: null };
          }
          return cible.rpc(nom, params, ...reste);
        };
      }
      const v = cible[prop];
      return typeof v === 'function' ? v.bind(cible) : v;
    },
  });
}

module.exports = { avecStockIllimite, estUnMouvementDeStock, FONCTIONS_QUI_BOUGENT };
