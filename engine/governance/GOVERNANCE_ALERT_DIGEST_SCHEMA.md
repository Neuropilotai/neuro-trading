# governanceAlertDigest — dashboard contract

**Location**: `governance_dashboard.json` → `governanceAlertDigest`  
**Producer**: `engine/governance/computeGovernanceAlertDigest.js`

## Versioning

- `governanceAlertDigestSchemaVersion` — semver; bump on breaking field renames.

## Fields (V1.0.0)

| Field | Description |
|-------|-------------|
| `status` | `healthy` \| `warning` \| `critical` (mirrors `governanceHealth.status`) |
| `activeAlerts` | Copy of `governanceHealth.activeAlerts` (sorted, `component:reason`) |
| `topAlert` | First entry of `activeAlerts` (highest severity, same tie-break as consolidé) or `null` |
| `criticalCount` / `warningCount` | Count of components in that state |
| `componentsInAlert` | Component keys with a non-null `lastAlertReason` |
| `lastAnomalyAt` | Max ISO among: `p5Health.lastMismatchAt`, `p5Health.lastParseErrorAt`, `policyHealth.lastParseErrorAt`, `governorHealth.lastParseErrorAt`, `p7Health.lastParseErrorAt` (V1 — champs absents ignorés). Si `activeAlerts` non vide mais aucun ts exploitable → max(`governanceHealth.generatedAt`, digest `generatedAt`) |
| `recentTrend` | `improving` \| `stable` \| `worsening` \| `unknown` — compares `activeAlerts.length` to previous dashboard JSON on disk |
| `previousActiveAlertsCount` | Echo of prior count used for trend (null if no prior) |

## Trend rule (V1)

Read existing `governance_dashboard.json` in the output dir before overwrite; if `governanceAlertDigest.activeAlerts` missing → `recentTrend=unknown`. Else compare lengths.
