# p7_guard_metrics.json — schema contract

**File**: `<dataRoot>/governance/p7_guard_metrics.json`  
**Producer**: `engine/observability/p7GuardMetrics.js` (`refreshP7GuardMetrics`)  
**Events**: `p7_guard_events.log` under the **governance directory** of the active data root — i.e. `<dataRoot>/governance/` when `discovery/` is `<dataRoot>/discovery/` (same layout as `p7_metrics.json`). Lines: `ISO8601 [P7 guard] ...`, emitted by `adaptMutationPolicy.js` via `appendP7GuardEvent` (path aligned with `readP7LastAlertReason` for the run’s `discoveryDir`).

## Versioning

- `p7GuardMetricsSchemaVersion` — semver; bump on breaking field changes.

## Fields (V1.0.0)

| Field | Description |
|-------|-------------|
| `generatedAt` | Refresh time of aggregate |
| `enabled` | `NEUROPILOT_ENABLE_P7_HEALTH_GUARD=true` **at refresh time** (dashboard / CLI host) |
| `lastAction` | `normal` \| `attenuate` \| `skip` from **last** successfully parsed event, or `null` if none |
| `lastAlert` | P7 alert token from last event (`p7Alert` field), or `null` if `none` / no events |
| `counts` | `{ normal, attenuate, skip }` over the **last N** parsed events (`eventsWindow`) |
| `attenuateRate` / `skipRate` | `counts.* / eventsConsidered` (0 if no events), rounded 4 dp |
| `eventsConsidered` | Number of parsed events in the window |
| `eventsWindow` | Configured cap (default 200) |
| `source` | Absolute path to events log read |

Malformed lines in the log are skipped (tolerant parse).
