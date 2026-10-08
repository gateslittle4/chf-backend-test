# Archive des anciennes branches — chf-backend-test (serveur) (08/10/2026)

Cette branche ne sert **à rien d'autre** qu'à garder en mémoire les commits des anciennes branches listées ci-dessous, pour pouvoir les supprimer de GitHub sans rien perdre. Elle ne change rien à `main` (même contenu, plus ce fichier) et ne doit **jamais** être fusionnée.

## Pourquoi ces branches ne sont plus utiles

L'historique de `main` a été recréé le 29/08/2026 : ses commits n'ont **aucun ancêtre commun** avec ces branches (créées entre la mi-août et le 29/08), donc elles ne pouvaient plus être fusionnées telles quelles.

Vérification faite le 08/10/2026 par comparaison du code (pas par exécution) : Pour les 33 commits de code de ces branches, j'ai mesuré la part des lignes ajoutées qui existent encore dans `main` : 28 sont à 50 % ou plus. Les 5 autres sont trois anciens « Add files via upload » (15-18/08) et deux routes Firebase **temporaires** (22/08), retirées exprès.

Aucune fonction vivante manquante à `main` n'a été trouvée.

## Les branches archivées

| Branche | Dernier commit (identifiant complet) | Date | Titre |
|---|---|---|---|
| `claude/acces-temporaire-utilisateurs` | `062189226b682cec87733f4fac962eba07a63b08` | 2026-08-23 | Accès à durée limitée + correction : "Désactiver un compte" n'avait jamais d'effet réel |
| `claude/chf-pending-ops-sync-59r2yg` | `a3f6523343c05916040b3d5d292d371caff56ea6` | 2026-08-23 | Fiches : écrit total_global/breakdown/mode_paiement dès la création |
| `claude/classification-episodes-badge` | `c078283c472a2a44e0bd54cf8f29fa93acd5f031` | 2026-08-23 | Suite à PLAN_CLASSIFICATION_EPISODES.md : voie_entree lu depuis le corps (suggestion 1) |
| `claude/fix-catalogue-race-condition` | `64912e4f6903086a06b431595ff6b5482b602f88` | 2026-08-23 | Catalogue medicaments/actes : fin de la réécriture complète du tableau |
| `claude/fix-conflit-numero-dossier` | `300f4d30f78693d9f74e55aab34cbddca7d9d014` | 2026-08-23 | POST /api/dossiers renvoie 409 (pas 500) pour un vrai conflit numero_dossier |
| `claude/fix-suppression-fiche-urgent` | `734438a04e01d6d314c9243839f24cb7e5c98d7f` | 2026-08-23 | URGENT : ajoute DELETE /api/fiches/:id (bug financier) |
| `claude/lits-nommes` | `60bc416d998256b1b780820b6744f95e47db8a61` | 2026-08-23 | Lits nommés individuellement par service |
| `claude/pieces-jointes-ong` | `ad9257a0f423775720fa72545a9015d9e7010ce1` | 2026-08-23 | Pièces jointes au dossier (fiches de référence ONG en priorité) |
| `claude/recherche-floue-dossiers` | `f0c3812ec02099681c5b87edd45961b4b050a36e` | 2026-08-23 | Recherche patient : branche la tolérance aux fautes de frappe (pg_trgm) |
| `claude/requisitions-inter-services` | `d7a8de80ee0194d4d0d2fc85fcf462f6b130a0eb` | 2026-08-23 | Réquisitions de stock par service (remplace la correction manuelle médicament par médicament) |
| `claude/transfert-entre-services` | `303a3cacb20cb9e8614208c6a89852c4b19298f2` | 2026-08-23 | Transfert d'un patient hospitalisé entre services |

## Retrouver une de ces branches

```
git fetch origin archive-anciennes-branches
git branch NOM_DE_LA_BRANCHE IDENTIFIANT_COMPLET_DU_TABLEAU
git push origin NOM_DE_LA_BRANCHE
```

Branches volontairement gardées (pas archivées) et ménage des branches déjà fusionnées : voir `NOTES_POUR_PROCHAIN_CLAUDE.md` (section « Ménage des branches 08/10 »).
