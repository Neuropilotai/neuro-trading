# policy_metrics.json — schema contract

File: `<dataRoot>/governance/policy_metrics.json`  
Producer: `engine/observability/policyMetrics.js`

## Versioning

- `policyMetricsSchemaVersion` uses semver.
- Minor: additive backward-compatible fields.
- Major: breaking changes (rename/remove/semantic changes).

## Core fields (V1.0.0)

- `generatedAt`
- `source`
- `lastExplorationWeight`
- `lastExploitationWeight`
- `lastDiversity`
- `lastSource`
- `driftDetected`
- `lastAlertReason` (`null` when healthy)
- `parseErrorCount`
- `invalidWeightsCount`
- `fallbackRate`

Alerts remain append-only in `<dataRoot>/governance/policy_alerts.log`.

