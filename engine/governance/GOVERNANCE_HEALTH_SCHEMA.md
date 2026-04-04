# governanceHealth — dashboard contract

**Location**: `governance_dashboard.json` → `governanceHealth`  
**Producer**: `engine/governance/computeGovernanceHealth.js`

## Versioning

- `governanceHealthSchemaVersion` — **2.0.0** includes **P7** as a fourth component.
- Bump **minor** for additive fields; **major** for breaking changes.

## Fields (V2.0.0)

| Field | Description |
|-------|-------------|
| `generatedAt` | ISO time of consolidation (same build as dashboard `generatedAt` when built together) |
| `dashboardVersion` | Copy of root `dashboardVersion` for self-contained snapshots |
| `status` | `healthy` \| `warning` \| `critical` |
| `lastAlertReason` | Highest-severity non-null `lastAlertReason` across components; tie-break **p5 → policy → governor → p7** |
| `activeAlerts` | Sorted list `p5:reason`, `policy:reason`, `governor:reason`, `p7:reason` |
| `healthyComponentCount` | Count of components with no `lastAlertReason` |
| `alertComponentCount` | `4 - healthyComponentCount` |
| `components` | `{ p5, policy, governor, p7 }` each `{ status, lastAlertReason }` |

## Severity (V2)

### Warning

- **P5 / Policy / Governor (unchanged)**: `drift_jump`, `fallback_frequent`, `reason_missing`, `no_p5_cycle_events`, `no_policy_metrics_events`, `no_governor_metrics_events`
- **P7**: `low_report_coverage`, `empty_window`, `no_p7_metrics_events`

### Critical

- **Shared / triptyque**: `chain_mismatch`, `parse_errors`, `invalid_weights`, `invalid_decision`, `decision_flap`, unknown reasons
- **P7**: `apply_zero_unexpected`

Global `status`: any component **critical** → `critical`; else any **warning** → `warning`; else `healthy`.
