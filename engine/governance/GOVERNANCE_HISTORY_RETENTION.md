# Historique des snapshots dashboard — rétention (gouvernance)

**Artefacts** : `$NEUROPILOT_DATA_ROOT/governance/history/governance_<epoch>.json` + **`index.jsonl`** (une ligne JSON par snapshot).

## Politique recommandée (manuelle pour l’instant)

- **Faible volume** de snapshots : conserver **tout** — coût disque négligeable, valeur audit maximale.
- **Quand l’historique grossit** (à réévaluer avec le temps) :
  - conserver systématiquement les **N derniers** (ex. 90 jours ou 500 fichiers, **seuils TBD** sans les optimiser sur une petite série) ;
  - option : **1 snapshot / jour** pour les plus anciens (compression sémantique), en gardant les runs « significatifs » étiquetés manuellement si besoin.

**Pas d’automatisation obligatoire** dans le repo : toute purge doit rester une **décision opérateur** (aligné `PAPER_TRADES_METRICS_RUNBOOK.md` §5).

## Index

`index.jsonl` permet de lister **timestamp, chemin relatif, `dashboardVersion`, `snapshotSizeBytes` (taille fichier snapshot, audit / anomalie), validTradeCount, confidence, best/worst strategyId, hash** sans ouvrir chaque JSON complet.

**Résumé CLI (lecture seule)** : `npm run governance:history-index-report` (options `--json`, `--tail N` ; fréquences `bestStrategyId`, **`confidence`**, `dashboardVersion` ; en `--json`, `meta.quickSummaryContractVersion` reprend le semver du quick summary diff). Variable `NEUROPILOT_GOVERNANCE_HISTORY_INDEX` pour pointer un autre fichier.

**Vue condensée** : `npm run governance:history-index-condensed` (`--tail K`, `--json`, `--no-header` pour TSV sans en-tête) — derniers enregistrements, colonnes fixes TSV / `rows[]` + `columns[]` en JSON, contrat `condensedIndexContractVersion` (indépendant du diff).

**Vue learning (scan)** : `npm run governance:learning-scan` — mêmes options ; sous-ensemble de colonnes orienté *paperLearningInsights* (index uniquement), contrat `learningScanContractVersion`.

**Vue focus stratégie** : `npm run governance:strategy-focus-scan -- --strategy <id>` — fenêtre `--tail` puis filtre `best`/`worst` (égalité stricte), contrat `strategyFocusScanContractVersion`.

**Vue learning (window stats)** : `npm run governance:learning-window-stats` — compteurs sur la fenêtre `--tail`, contrat `learningWindowStatsContractVersion`.

```bash
tail -n 5 "$NEUROPILOT_DATA_ROOT/governance/history/index.jsonl" | jq .
```

**Référence** : `snapshotGovernanceDashboardHistory.js`.
