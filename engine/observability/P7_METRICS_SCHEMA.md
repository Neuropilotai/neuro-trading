# p7_metrics.json — schema contract

**File**: `<dataRoot>/governance/p7_metrics.json`  
**Producer**: `engine/observability/p7Metrics.js` (`refreshP7Metrics`)  
**Runtime line**: emitted from `engine/governance/runTrendMemory.js` after `run_trend_memory.json` is written.

## Versioning

- `p7MetricsSchemaVersion` — semver; **minor** additive, **major** breaking.

## Event line (grep-stable)

Prefix: **`[P7 metrics]`** (do not rename).

```
[P7 metrics] cycleId=<id> producingCycleId=<id> windowSize=<int> reportsConsidered=<int> reportsLoaded=<int> applyCount=<int> applyExpected=<0|1> status=<ok|degraded|empty> source=<archive|fallback|none>
```

## JSON fields (V1.0.0)

| Field | Description |
|-------|-------------|
| `generatedAt` | Refresh time of aggregate |
| `lastStatus` / `lastSource` | Last event |
| `lastWindowSize`, `lastReportsConsidered`, `lastReportsLoaded`, `lastApplyCount` | Last event counters |
| `coverageRate` | `reportsLoaded / reportsConsidered` on last event |
| `degradedRate` / `emptyRate` | Share of parsed events with that status |
| `lastAlertReason` | `null` when healthy |
| `parseErrorCount` | Malformed lines |

Alerts: `governance/p7_alerts.log` (anomaly-only).

## Alert reasons

- `parse_errors`
- `apply_zero_unexpected` (`applyExpected=1` and `applyCount=0`)
- `empty_window` (empty status or zero reports loaded)
- `low_report_coverage` (considered ≥ 3 and loaded/considered &lt; 0.8, and not empty-window)
- `no_p7_metrics_events` (optional expect flag + `run_trend_memory.json` present)
