# P8 / P8.1 — Governance / Research dashboard

Single operational view of governance artefacts: mini report, portfolio governor, mutation policy, trend memory, P7.1 `trendMemoryApply`, and recent experiment registry entries.

**Operator reading (repeatable)** : structured qualitative checklist — `engine/governance/GOVERNANCE_OPERATOR_SUMMARY_TEMPLATE.md` (use per snapshot; see `PAPER_TRADES_METRICS_RUNBOOK.md` §9).

## Outputs

Default directory: **`neuropilot_trading_v2/ops-snapshot/`**

| File | Purpose |
|------|---------|
| `governance_dashboard.json` | … **`paperLearningInsights`** (Learning Loop V1, suggestive only) … |
| `governance_dashboard.html` | … **Learning insights (paper, suggestive only)** — `NOT APPLIED` … |

## How to generate

From repo root `neuropilot_trading_v2`:

```bash
node engine/governance/buildGovernanceDashboard.js
```

`NEUROPILOT_DATA_ROOT` is respected (same as `dataRoot` elsewhere). **Must match** the root used for paper trades / pipeline — see `engine/governance/DATA_ROOT_ALIGNMENT.md`. Optional programmatic use:

```js
const { buildGovernanceDashboard } = require('./engine/governance/buildGovernanceDashboard');
buildGovernanceDashboard({ outDir: '/path/to/ops-snapshot', dataRoot: '/path/to/data_workspace' });
```

**Ops — comparer 3 builds d’affilée** (progression / stagnation / dégradation) : `OPS_DASHBOARD_TRIPLE_READ_CHECKLIST.md`.

## Pipeline integration

`engine/evolution/scripts/exportOpsSnapshot.js` invokes `buildGovernanceDashboard({ outDir })` after writing `latest.json` / trend / alerts / milestones, so a full ops export also refreshes P8.

**Expanded full pipeline** (`engine/scripts/runFullPipelineExpanded.sh`): un export **intermédiaire** (étape 8) conserve les métriques evolution + un snapshot P8 avant le mini final ; un **second** `exportOpsSnapshot.js` (étape **8.7**) s’exécute **après** `generateGovernanceMiniReport.js` et `runTrendMemory.js` pour que `governance_dashboard.*` reflète l’état **final** du run.

## Source files read

Under `dataRoot`:

- `discovery/governance_mini_report.json`
- `discovery/portfolio_governor.json`
- `discovery/mutation_policy.json`
- `discovery/run_trend_memory.json`
- `governance/experiment_registry.json`
- Tails: `discovery/portfolio_governor_history.json`, `discovery/run_trend_memory_history.json` (array or `{ entries: [] }`)
- **P8.1** short history also reads optional per-run reports: `discovery/reports/governance_mini_report_<experimentId>.json` (for `verdict` and `trendMemoryApply` when present; does not modify those files).
- `governance/paper_trades.jsonl` (optional) → build P8 : métriques V1/V2 + **`paper_learning_insights.json`** (Learning Loop V1, lecture seule).

## Paper trades observability (V1 + V2)

**V1** — `paperTradesMetrics` : `engine/governance/computePaperTradesMetrics.js` → `paper_trades_metrics.json`. Alertes parse : `paper_trades_alerts.log`. Smoke : `smokePaperTradesMetrics.js`.

**V2** — `paperTradesMetricsV2` : `engine/governance/computePaperTradesMetricsV2.js` (même JSONL, même règles de parse) → agrégations **par jour UTC**, **par cycle** (`cycleId` ou `experimentId`), **par `strategyId`**, plus `bestStrategy` / `worstStrategy` (par `totalPnl`). Contrat : `PAPER_TRADES_METRICS_V2_SCHEMA.md`. Smoke : `npm run test:paper-trades-metrics-v2-smoke`.

**`status-system.sh`** : `PAPER: …` et **`LEARNING: suggestive (confidence=…, best=…, worst=…)`**. **Learning V1** : `PAPER_LEARNING_INSIGHTS_SCHEMA.md`, smoke `npm run test:paper-learning-v1-smoke`. **Lecture rapide** : `PAPER_TRADES_METRICS_RUNBOOK.md` (dont **§9** suivi temporel : `npm run governance:snapshot-history` ou `NEUROPILOT_GOVERNANCE_HISTORY_SNAPSHOT=1` sur le build ; `npm run governance:history-index-report` ; `npm run governance:history-index-condensed` ; `npm run governance:learning-scan` ; `npm run governance:strategy-focus-scan -- --strategy <id>` ; `npm run governance:learning-window-stats` ; `npm run governance:diff-dashboard-snapshots` entre deux `governance_*.json`).

## Status semantics (UI)

**P8.1** pairs **governanceStatus** and **verdict** on one visual row:

- **OK** + **PASS** (or OK without verdict) → green
- **DEGRADED** → amber
- **BLOCKED** or verdict **FAIL** / **BLOCKED** → red
- Unknown → neutral (muted)

## Governance health (consolidated)

`governanceHealth` est calculé par `engine/governance/computeGovernanceHealth.js` à partir des `lastAlertReason` des quatre blocs (`p5Health`, `policyHealth`, `governorHealth`, `p7Health`). Contrat : `GOVERNANCE_HEALTH_SCHEMA.md` (V2 = 4 briques).

**Policy `fallback` / `fallback_frequent`** avec **`TREND_MEMORY_APPLY` désactivé** : souvent **comportement attendu**, pas un défaut moteur par défaut — voir `POLICY_FALLBACK_WHEN_TREND_APPLY_DISABLED.md`.

## Policy interpretation (read-only)

`policyInterpretation` est calculé par `engine/governance/computePolicyInterpretation.js` à partir de `policyHealth.lastAlertReason` et du bloc brut `trendMemoryApply` de `governance_mini_report.json`. Ne modifie pas le digest ni `governanceHealth`. Contrat : `POLICY_INTERPRETATION_SCHEMA.md`. Smoke : `node engine/governance/smokePolicyInterpretation.js`. Ligne **`status-system.sh`** : `POLICY: …`.

## Alert digest (top alerts / trend)

`governanceAlertDigest` est produit par `engine/governance/computeGovernanceAlertDigest.js` : statut aligné sur `governanceHealth`, `activeAlerts` / `topAlert`, compteurs, `componentsInAlert`, `lastAnomalyAt` (max des timestamps d’anomalie connus sur les blobs santé), `recentTrend` (comparaison du **nombre** d’entrées `activeAlerts` avec le digest du fichier JSON précédent dans `outDir`). Contrat : `GOVERNANCE_ALERT_DIGEST_SCHEMA.md`. Smoke : `node engine/governance/smokeGovernanceAlertDigest.js`.

## P7 guard metrics (usage)

`p7GuardMetrics` est rafraîchi par `engine/observability/p7GuardMetrics.js` à partir de `governance/p7_guard_events.log` (lignes `[P7 guard]` persistées par `adaptMutationPolicy.js`). Affiche **guard enabled/disabled** (env au moment du build dashboard), dernière action / alerte, taux attenuate/skip sur une fenêtre d’événements. Contrat : `engine/observability/P7_GUARD_METRICS_SCHEMA.md`. Smoke : `node engine/observability/smokeP7GuardMetrics.js`.

## Evolution summary (lab)

`evolutionSummary` est calculé par `engine/governance/computeEvolutionSummary.js` à partir de `champion_setups/champion_registry.json` et optionnellement `discovery/next_generation_report.json`. Libellés opérateur uniquement (`labOnly: true`). Contrat : `EVOLUTION_SUMMARY_SCHEMA.md`. Légende lecture : `engine/evolution/CHAMPION_SNAPSHOT_LEGEND.md`. Smoke : `node engine/governance/smokeEvolutionSummary.js`.

## Version

`dashboardVersion` … (e.g. **p8.15-v1** : **paperLearningInsights** + **paperTradesMetricsV2** + …).
