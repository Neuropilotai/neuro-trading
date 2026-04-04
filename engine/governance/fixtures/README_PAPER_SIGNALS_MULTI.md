# Signaux paper multi-stratégies (Learning / métriques V2)

## Fichier

`paper_execution_v1_signals_multi_strategy.example.json`

## Objectif

Fournir **plusieurs `strategyId`** en une exécution Paper V1 pour que :

- `paper_trades_metrics_by_strategy.json` et **Learning insights V1** aient de la matière à comparer ;
- ce soit **déterministe** (mêmes `datasetKey`, `barIndex`, paramètres → même résultat sur les mêmes `.bin`).

Les ids `lab_*` sont **synthétiques** : ils ne sont **pas** branchés sur le moteur de discovery / champions.

## Identité canonique (`setupId`) pour le mutation learning

Sur chaque entrée de `signals`, tu peux **ajouter** un champ optionnel **`setupId`** avec l’id canonique du setup (`mut_…`, `familyexp_…`, etc.) **tel qu’il apparaît dans `generated_strategies`**.

- **`strategyId`** reste le label affiché / legacy (ex. `lab_*`, dashboard).
- Si **`setupId`** est présent **et** différent de `strategyId`, la ligne écrite dans `paper_trades.jsonl` contient **les deux** ; le learning mappe sur `setupId`.
- Si tu ne mets que `strategyId`, comportement inchangé par rapport à avant.
- Ne pas inventer de `setupId` : seulement une valeur déjà connue du pipeline / du registre.

## Installation

1. Même **`NEUROPILOT_DATA_ROOT`** que pipeline + dashboard (`DATA_ROOT_ALIGNMENT.md`).
2. Copier le fichier :

```bash
cp engine/governance/fixtures/paper_execution_v1_signals_multi_strategy.example.json \
  "$NEUROPILOT_DATA_ROOT/governance/paper_execution_v1_signals.json"
```

3. Activer l’exécution paper (pipeline ou manuel) :

```bash
export NEUROPILOT_PAPER_EXEC_V1=1
```

4. Rebuild dashboard :

```bash
node engine/governance/buildGovernanceDashboard.js
```

## Vérification (obligatoire avant run)

**Paper V1** charge les bins via **`datasets_manifest.json`** (`datasets.<datasetKey>.paths.bin`), pas via `dataset_versions.json` (registre d’audit séparé).

```bash
# 1) Clés demandées par les signaux
jq -r '.signals[].datasetKey' "$NEUROPILOT_DATA_ROOT/governance/paper_execution_v1_signals.json" | sort -u

# 2) Clés réellement présentes dans le manifest (source de vérité pour skip / no-skip)
jq -r '.datasets | keys[]' "$NEUROPILOT_DATA_ROOT/datasets_manifest.json" | sort -u
```

Toute clé en (1) absente de (2) ⇒ signal **skipped** ⇒ moins de trades, learning biaisé. Optionnel : `dataset_versions.json` pour traçabilité des versions enregistrées, mais ce n’est pas ce que lit `runPaperExecutionV1.js`.

## Vérification après runs

```bash
wc -l "$NEUROPILOT_DATA_ROOT/governance/paper_trades.jsonl"
jq '.paperTradesMetricsV2.byStrategy | length' ops-snapshot/governance_dashboard.json
jq '.paperLearningInsights.strategyRanking | length' ops-snapshot/governance_dashboard.json
```

## Jeux de données

Chaque `datasetKey` doit exister dans **`datasets_manifest.json`** (souvent après `runExpandedDataEngine`). Sinon la ligne est **ignorée** (log `[paper_exec_v1] skip signal`).

Pour un run **minimal** sans crypto, retire le signal `BTCUSDT_5m` du JSON copié.

## Voir aussi

- `PAPER_EXECUTION_V1_SPEC.md`
- `paper_execution_v1_signals.example.json` (1 signal minimal)
