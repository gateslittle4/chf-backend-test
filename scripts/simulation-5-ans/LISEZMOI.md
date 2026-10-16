# Simulation « le site dans 5 ans » (16/10/2026)

Trois mesures, à relancer chaque année avec les vrais volumes (remplacer les hypothèses par les chiffres de production) :

| Script | Ce qu'il mesure | Lancement |
|---|---|---|
| `base-a-echelle.py` | Base PostgreSQL **jetable** remplie à l'échelle (40 000 dossiers, 70 000 épisodes, 159 000 fiches, 137 000 paiements, 730 000 lignes d'audit) : lecture complète des listes page par page (500 lignes, comme `lireToutesLesPages`), journal d'audit, rapports, recherche. | `python3 scripts/simulation-5-ans/base-a-echelle.py` (root + binaires PostgreSQL 16) ; scénario lourd : `N_DOS=100000 N_AU=1800000` |
| `sauvegarde-memoire.js` | Mémoire du serveur pour la sauvegarde quotidienne (toutes les lignes → JSON → Buffer), avec les tailles de ligne mesurées en production. | `node --expose-gc --max-old-space-size=4096 scripts/simulation-5-ans/sauvegarde-memoire.js` |
| `navigateur-liste-complete.js` | Poids, temps d'écriture/relecture et mémoire de la liste complète épisodes + paiements dans le navigateur. | `node --expose-gc scripts/simulation-5-ans/navigateur-liste-complete.js` (dépôt `chf-app2` voisin, ou `CHF_APP=...`) |

## Résultats du 16/10/2026 (hypothèse : 22 dossiers/jour, 14 000 épisodes/an)

- **Base** : 374 Mo à 40 000 dossiers, 921 Mo à 100 000 (plan Pro : 8 Go). Ouvrir un dossier < 4 ms, recherche par numéro 3–5 ms, mise à jour incrémentale 107–223 ms, recherche floue par nom 145 ms (40 000) → 442 ms (100 000).
- **Liste complète** (base seule, sans le réseau) : épisodes 2,4–3,9 s à 70 000, 20–25 s à 175 000 ; paiements 10–15 s à 137 000, 62–110 s à 341 000. Le vrai coût est le nombre de requêtes : ~1 300 à 5 ans (≈ 500 à 2 ans).
- **Navigateur** : 5 Mo de `localStorage` dépassés dès ~2 300 épisodes (corrigé : `utils/copieLocaleListes.js` côté application) ; liste complète à 70 000 épisodes = 152 Mo de JSON, 204 Mo de mémoire.
- **Sauvegarde** : fichier 90 Mo / 325 Mo de mémoire à 1 an ; 179 Mo / 845 Mo à 2 ans (serveur de 512 Mo tué) ; 448 Mo / 2 Go à 5 ans.

## À faire ensuite (voir NOTES_POUR_PROCHAIN_CLAUDE.md)

Sauvegarde compressée et découpée par table (avant 6 mois), listes de l'application limitées aux épisodes ouverts et aux 12 derniers mois (avant 1 an), archivage du journal d'audit et des sessions de caisse anciennes.
