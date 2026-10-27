-- sql/sortie_caisse_autorise_par.sql — « Passer » une sortie de caisse directement (27/10, Esdras) : la direction écrit sa décision sur papier, la caisse saisit le motif, le montant
-- et « autorisé par » (le nom de la personne qui a décidé), puis clique sur Passer : l'argent sort tout de suite, sans demande ni réponse.
-- Une colonne en plus sur depenses_caisse : le nom de la personne qui a autorisé. Rien n'est supprimé ni modifié dans les lignes existantes (les anciennes demandes gardent autorise_par vide).
-- Sans DROP ni REVOKE. Relançable sans effet (if not exists).
alter table public.depenses_caisse add column if not exists autorise_par text;
