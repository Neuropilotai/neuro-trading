# Paper trades metrics V2 — derived artifacts

**Source of truth**: `governance/paper_trades.jsonl` (append-only, Paper Execution V1).  
**Producers**: `engine/governance/computePaperTradesMetricsV2.js` (invoked from `buildGovernanceDashboard.js`).  
**Read-only**: no mutation of JSONL; malformed lines counted in `parseErrors` (same rules as V1 `parsePaperTradesJsonl.js`).

## Version 1.0.0

### Files

| File | `aggregation` | `buckets[]` key |
|------|-----------------|-----------------|
| `governance/paper_trades_metrics_by_day.json` | `by_day` | `day` (UTC `YYYY-MM-DD` or `unknown`) |
| `governance/paper_trades_metrics_by_cycle.json` | `by_cycle` | `cycleKey` (`cycleId` or `experimentId` or `_unknown_cycle`) |
| `governance/paper_trades_metrics_by_strategy.json` | `by_strategy` | `strategyId` |

### Bucket fields (each element of `buckets`)

- `trades`, `wins`, `losses`, `flat`
- `winRate` (%), `totalPnl`, `avgPnl`
- `byReason` — counts by exit `reason`

### Combined payload (`governance_dashboard.json` → `paperTradesMetricsV2`)

Same as `full` return: `byDay`, `byCycle`, `byStrategy` (strategies sorted by `totalPnl` desc), `bestStrategy` / `worstStrategy` (by `totalPnl`, deterministic tie-break).

### Smoke

`npm run test:paper-trades-metrics-v2-smoke`
