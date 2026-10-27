// utils/servicesSansStockPropre.js — services dont les réquisitions N'ENTRENT PAS dans un stock de service (28/10, Esdras : « une réquisition de SOP n'entrera pas dans le stock de SOP : la personne ne va plus
// à la caisse pour le payer, il est inclus dans le package — on n'a pas besoin d'un stock SOP qui descende à chaque transaction, mais laisse la réquisition dans l'historique »).
// Pour ces services, une réquisition fait SORTIR le stock de la pharmacie (le matériel part), est enregistrée dans l'historique des réquisitions (annulable, modifiable) — mais ne crée aucun stock pour le service :
// les épisodes de ce service puisent donc dans la pharmacie, comme un patient sans service. Même liste dans l'application (utils/servicesSansStockPropre.js, pour la note affichée à l'écran).
const SERVICES_SANS_STOCK_PROPRE = ['SOP'];

const normaliser = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const serviceSansStockPropre = (service) => SERVICES_SANS_STOCK_PROPRE.some(s => normaliser(s) === normaliser(service));

module.exports = { SERVICES_SANS_STOCK_PROPRE, serviceSansStockPropre };
