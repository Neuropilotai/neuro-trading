# paper_learning_insights.json — Learning Loop V1 (suggestive only)

**Path**: `<dataRoot>/governance/paper_learning_insights.json`  
**Producer**: `engine/governance/computePaperLearningInsights.js` (invoked from `buildGovernanceDashboard.js`)  
**Inputs**: `paper_trades_metrics.json` (global) + `paperTradesMetricsV2` (in-memory full object from same JSONL)

## Safety

- **`safety.mode`**: always `suggestive_only`
- **`safety.applied`**: always `false`
- **No writes** to `mutation_policy.json`, governor, policy engine, trend memory, or execution.

## Version 1.0.0

| Field | Description |
|-------|-------------|
| `learningInsightsVersion` | e.g. `1.0.0` |
| `generatedAt` | ISO8601 |
| `source` | `paper_trades_metrics_v2` |
| `global` | `trades`, `winRate`, `totalPnl`, `avgPnl` from V1 global metrics |
| `strategyRanking` | Eligible strategies (`trades >= 5`), sorted by `score` desc |
| `score` | `0.7 * norm(totalPnl) + 0.3 * norm(winRate)` with min–max norm within eligible cohort; 0.5 if degenerate |
| `suggestions.strategiesToBoost` | Top ~20% by score (needs ≥3 eligible strategies) |
| `suggestions.strategiesToReduce` | Bottom ~20% by score |
| `suggestions.notes` | Warnings (parse errors, variance, insufficient data) |
| `confidence` | `low` \| `medium` \| `high` (trade volume, eligible count, parse errors) |
| `summaryBestStrategyId` / `summaryWorstStrategyId` | From ranking ends (status line / UI) |

## Smoke

`npm run test:paper-learning-v1-smoke`
