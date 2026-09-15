-- Tarification automatique ONG sous contrat vs privé (15/09, retour d'Esdras) : les ONG sont
-- facturées par contrat — quand un tarif de service change, un ONG déjà sous contrat continue de
-- payer l'ANCIEN prix jusqu'à la fin de son contrat, alors qu'un patient privé passe tout de suite
-- au nouveau prix. Jusqu'ici ce choix (ancien/nouveau tarif) était un bouton manuel dans le
-- Calculateur — aucun lien avec le patient ou l'ONG, entièrement à la mémoire du caissier.
--
-- Aucune date connue = traité comme "encore sous contrat" (ancien prix) par prudence — jamais
-- l'inverse : appliquer le nouveau prix sans date de fin explicite reviendrait à deviner qu'un
-- contrat est terminé.
alter table ong_partenaires add column if not exists date_fin_contrat date;
