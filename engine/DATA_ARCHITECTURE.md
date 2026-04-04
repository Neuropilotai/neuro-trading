# Data architecture — 3 couches

## Principe

| Couche | Où | Rôle |
|--------|-----|------|
| **1. Code local** | Mac (repo `neuropilot_trading_v2`) | Code source, Node, exécution |
| **2. Données lourdes** | **5TB externe** | Datasets, features, discovery, batch, bootstrap, brain |
| **3. Backup / archive** | **Google Drive** | Copies finales, rapports, versions, pas pour le calcul intensif |

**Pourquoi :**
- **5TB** : gros volumes, I/O local, évite de saturer le Mac.
- **Google Drive** : à éviter pour accès intensif, milliers de petits fichiers, SQLite/DB ouverts, batch qui lisent/écrivent en continu. À utiliser pour backup/sync/historique.

→ **Self-learning AI qui “pratique”** → 5TB local.  
→ **Backup / sync / historique** → Google Drive.

---

## Racine données : `NEUROPILOT_DATA_ROOT`

Pour diriger tout le lourd vers le 5TB :

```bash
export NEUROPILOT_DATA_ROOT="/Volumes/My Passport/NeuroPilotAI"
```

Le moteur utilise ce chemin pour :
- datasets, features, discovery, batch_results, bootstrap, walkforward, brain_snapshots, archives.

Si `NEUROPILOT_DATA_ROOT` n’est pas défini ou le volume n’est pas monté, le moteur utilise un répertoire local de repli (`data_workspace/` dans le projet) pour que le dev fonctionne sans 5TB. Tu peux ajouter `data_workspace/` à `.gitignore` pour ne pas versionner les sorties locales.

### Runbook — historique OANDA (forex / métaux)

Validation du flux **candles REST** (pas l’exécution broker) : [engine/data/OANDA_RUNBOOK.md](data/OANDA_RUNBOOK.md) — prérequis env, bootstrap hybride archive CSV + queue OANDA, doctrine des frontières `fromMs` vs Binance/Yahoo, logs `oanda_download_summary`, blocs `node -e`, fraîcheur `datasets_freshness.json` / ops dashboard.

---

## Layout recommandé sur le 5TB

```
/Volumes/My Passport/NeuroPilotAI/
  datasets/
    spy/
    qqq/
    iwm/
    nq/
  features/
  discovery/
  generated_strategies/
  batch_results/
  bootstrap/
  walkforward/
  brain_snapshots/
  champion_setups/
  nightly_logs/
  archives/
```

**Contenu typique :**
- **datasets/** — CSV lourds (par actif/symbole).
- **features/** — `features_<symbol>_<tf>.json` (sortie feature extraction).
- **discovery/** — `discovered_patterns.json`, runs de discovery.
- **generated_strategies/** — `setup_001.js`, … (stratégies générées).
- **batch_results/** — `strategy_batch_results.json`, résultats backtest batch.
- **bootstrap/** — exports bootstrap par setup.
- **walkforward/** — résultats walk-forward (train/test).
- **brain_snapshots/** — `brain_state.json`, états sauvegardés à chaque cycle.
- **archives/** — snapshots avant gros changements, copies pour Google Drive.

---

## Ce qu’il faut stocker sur le 5TB (et pas sur Google Drive pour le calcul)

- `features_*.json`
- `discovered_patterns.json`
- `generated_setups/*.js`
- `strategy_batch_results.json`
- `bootstrap_results.json`
- `walkforward_results.json`
- `champion_setups.json`
- `brain_state.json`

**Important :** ne pas tout régénérer à chaque run. Le système doit pouvoir relire l’historique, comparer aux runs précédents, améliorer le ranking, éviter de refaire les mêmes tests inutilement.

---

## Google Drive : à quoi ça sert

**Utiliser Google Drive pour :**
- Backup quotidien du brain
- Copie des meilleurs setups
- Rapports mensuels
- Exports CSV/JSON finaux
- Snapshots avant gros changements

**Éviter Google Drive pour :**
- Fichiers de calcul temporaires
- Bases SQLite actives
- Batch live
- Monte Carlo massif
- Discovery en boucle

---

## Self-Learning Trading AI Loop

Niveau au-dessus du Discovery Engine : une boucle complète qui apprend à chaque nouveau dataset.

**Boucle :**
1. Nouveau dataset arrive
2. Extraction des features
3. Découverte de patterns
4. Génération de nouveaux setups
5. Backtest batch
6. Bootstrap
7. Walk-forward
8. Ranking
9. Promotion automatique des meilleurs setups (champion / challengers)
10. Sauvegarde du “brain state”

→ Moteur qui apprend comme un petit labo quant.

**Ce que le système apprend automatiquement :**
- Quels setups gardent une expectancy positive
- Quels setups meurent quand on change d’actif
- Quels R multiples sont les meilleurs
- Quelles phases de session sont robustes
- Quels setups sont trop fragiles au bootstrap
- Quels setups survivent au walk-forward
- Quels setups méritent d’être promus en “production candidates”

---

## Cinq modules “hedge fund research lab”

Pour faire passer Neuro.Pilot.AI à ce niveau :

| Module | Rôle |
|--------|------|
| **1. Feature memory** | Historique de tous les patterns détectés |
| **2. Strategy memory** | Historique des setups générés, avec score et statut |
| **3. Validation memory** | Bootstrap + walk-forward + cross-asset survival |
| **4. Champion/challenger engine** | Un setup champion, plusieurs challengers |
| **5. Brain snapshots** | États sauvegardés à chaque cycle d’apprentissage |

---

## Lecture des datasets depuis le 5TB

Le **dataset loader** (`engine/datasetLoader.js`) résout les chemins ainsi :

1. Il tente d’abord le chemin fourni (souvent `./data/<symbol>_<tf>.csv` dans le repo).
2. Si le fichier n’existe pas et que `NEUROPILOT_DATA_ROOT` est défini (5TB monté), il essaie  
   `$NEUROPILOT_DATA_ROOT/datasets/<symbol_lower>/<nom_fichier>`.

Tu peux donc mettre les gros CSV sur le 5TB dans `datasets/spy/`, `datasets/qqq/`, etc. Le moteur les utilisera sans rien changer au code ni aux noms de groupes. Voir `engine/RUNBOOK_5TB.md`.

---

## Étapes recommandées

1. **Déplacer le stockage lourd sur le 5TB** — monter le volume, définir `NEUROPILOT_DATA_ROOT`, créer l’arborescence.
2. **Garder le repo et Node localement** — pas d’exécution depuis Google Drive.
3. **Faire écrire le Discovery Engine** dans `$NEUROPILOT_DATA_ROOT/features`, `discovery`, `batch_results`, etc. (via `engine/dataRoot.js`).
4. **Copie automatique vers Google Drive** des résultats finaux seulement : utiliser `scripts/backup_discovery_to_gdrive.sh` (définir `NEUROPILOT_GDRIVE_BACKUP_ROOT`).

---

## Verdict

- **Oui** : l’AI peut “pratiquer” sur le 5TB externe ; c’est la meilleure option.
- **Google Drive** : backup/archivage, pas moteur principal de recherche.
- **Prochaine amélioration** : passer du “discovery engine” au **self-learning trading AI loop** (mémoire, revalidation, ranking, promotion, brain snapshots).
