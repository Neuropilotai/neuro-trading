# paper_trades_metrics.json — schema

**Producer**: `engine/governance/computePaperTradesMetrics.js` (invoked from `buildGovernanceDashboard.js`)  
**Input**: `<dataRoot>/governance/paper_trades.jsonl` (Paper Execution V1)  
**Output**: `<dataRoot>/governance/paper_trades_metrics.json`

## Version 1.0.0

| Field | Type | Description |
|-------|------|-------------|
| `paperTradesMetricsSchemaVersion` | string | e.g. `1.0.0` |
| `generatedAt` | ISO8601 | When metrics were computed |
| `sourceJsonl` | string \| null | Path to source JSONL |
| `sourceExists` | boolean | Whether the JSONL file existed |
| `lineCount` | number | Non-empty lines in file |
| `parseErrors` | number | Lines skipped (invalid JSON or invalid V1 trade shape) |
| `validTradeCount` | number | Trades counted (has `paperExecutionSchemaVersion` + finite `pnl`, not `skip`) |
| `wins` / `losses` / `breakeven` | number | From `pnl` sign |
| `winRate` | number \| null | % wins among valid trades |
| `totalPnl` / `avgPnl` | number \| null | Sum / mean PnL (notional 1 unit) |
| `byReason` | object | Counts by exit `reason` |
| `lastTradeTs` | string \| null | Latest `exitTs` or `ts` among valid trades |
| `schemaVersionsSeen` | string[] | Distinct `paperExecutionSchemaVersion` values |
| `status` | string | `empty_or_missing` \| `no_valid_trades` \| `has_parse_errors` \| `ok` |

## Alerts

If `parseErrors > 0`, a line is appended to `governance/paper_trades_alerts.log` (see `appendPaperTradesParseAlerts.js`).

Does **not** modify mutation, policy, governor, or `policyInterpretation`.
