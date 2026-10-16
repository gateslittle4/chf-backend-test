# Test de restauration (16/10)

Prouve qu'une sauvegarde du site **se restaure vraiment** : le vrai code (`utils/sauvegardeServeur.js`) sauvegarde une base PostgreSQL jetable remplie de données réalistes,
puis restaure les fichiers compressés dans une autre base vide, et on compare les deux table par table (nombre de lignes + empreinte du contenu).
**Rien ne touche à la vraie base** : deux bases PostgreSQL 16 créées pour l'occasion, supprimées à la fin.

```
node scripts/restauration/essai-restauration.js                 # petite échelle (1 500 dossiers, ≈ 40 s)
ECHELLE=1an  node scripts/restauration/essai-restauration.js    # 8 000 dossiers
ECHELLE=5ans node scripts/restauration/essai-restauration.js    # 40 000 dossiers, 730 000 lignes d'audit
```
Prérequis : binaires PostgreSQL 16 (`PG_BIN`, par défaut `/usr/lib/postgresql/16/bin`) et exécution en root (le script démarre un serveur PostgreSQL sous l'utilisateur `postgres`).

## Ce qui est vérifié
1. la base se **reconstruit depuis le dépôt** (`schema-reference.sql` + tous les scripts de `sql/`) sans erreur, sans changer les contraintes ni les index ;
2. la sauvegarde ne perd rien (comptage du manifeste, relecture complète, mémoire du processus mesurée) ;
3. la restauration dans une base **vide** ne produit aucune ligne en échec ni avertissement ;
4. chaque table est **identique** après restauration (dates du journal d'audit comprises, liens de fusion / mère-enfant entre dossiers rétablis, compteurs) ;
5. une 2e restauration n'ajoute rien ; le premier paiement après restauration reçoit un numéro neuf ; un fichier abîmé est **refusé avant toute écriture** ; une sauvegarde interrompue n'est pas proposée.

## Ce que le test a fait corriger (voir NOTES_POUR_PROCHAIN_CLAUDE.md)
- le journal d'audit perdait toutes ses dates (déclencheur) → `sql/restauration_audit_et_sequences.sql` (`restaurer_audit_log`) ;
- les numéros de paiement repartaient de 1 → même script (`realigner_sequences`) ;
- les dossiers se référencent entre eux (fusion, mère/enfant) → restaurés en deux temps ;
- les partenaires doivent être restaurés **avant** épisodes et paiements (le déclencheur retrouve leur identifiant d'après le nom) ;
- un compteur (numéros de dossier) ne repart jamais de zéro dans une base neuve ;
- `doublons_ignores` et `migrations_appliquees` n'étaient sauvegardées nulle part.

## Conformité avec la production
Le test affiche des **empreintes** de la structure (contraintes, index, déclencheurs, règles de sécurité, RLS). Les mêmes requêtes (`SQL_CONFORMITE` dans `essai-restauration.js`) lancées sur la
production le 16/10 ont donné **exactement les mêmes empreintes** : la base du test a la même structure que la vraie.
Refaire la comparaison de temps en temps : si une empreinte diffère, un script SQL a été appliqué en production sans être ajouté au dépôt (ou l'inverse).
