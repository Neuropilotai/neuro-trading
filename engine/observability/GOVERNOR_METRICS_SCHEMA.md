# governor_metrics.json — schema contract

**File**: `<dataRoot>/governance/governor_metrics.json`  
**Producer**: `engine/observability/governorMetrics.js` (`refreshGovernorMetrics`)

## Versioning

- `governorMetricsSchemaVersion` uses semver (see code constant).
- **Minor**: additive backward-compatible fields.
- **Major**: breaking renames / semantics.

## Runtime event (grep-stable)

Prefix must remain **`[Governor metrics]`** (do not rename).

```
[Governor metrics] cycleId=<id> decision=<OK|DEGRADED|BLOCKED> mode=<healthy|degraded|blocked> reason=<token|n/a> policySource=<trend|mutation|baseline> riskState=<same as mode>
```

## Core JSON fields (V1.0.0)

| Field | Description |
|-------|-------------|
| `generatedAt` | Snapshot refresh time |
| `lastDecision` / `lastMode` / `lastReason` | Last parsed event |
| `lastPolicySource` | trend \| mutation \| baseline |
| `decisionChangeDetected` | Last decision ≠ previous |
| `decisionFlapDetected` | ≥3 decision transitions in last 5 events |
| `lastAlertReason` | `null` when healthy |
| `parseErrorCount` | Malformed lines |
| `invalidDecisionRowCount` | Invalid enum / riskState mismatch |
| `reasonMissingCount` | Lines with `reason=n/a` |

Alerts: `governance/governor_alerts.log` (anomaly-only).
