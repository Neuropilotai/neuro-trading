# policyInterpretation — dashboard contract

**Location**: `governance_dashboard.json` → `policyInterpretation`  
**Producer**: `engine/governance/computePolicyInterpretation.js`  
**Related**: `POLICY_FALLBACK_WHEN_TREND_APPLY_DISABLED.md`

## Purpose

Read-only hint so operators do not treat **`policy:fallback_frequent`** as a default engine failure when **trend memory apply is intentionally off**.

## Fields (V1.0.0)

| Field | Description |
|-------|-------------|
| `policyInterpretationSchemaVersion` | Semver |
| `status` | `normal` \| `expected_by_config` \| `investigate` \| `unknown` |
| `reason` | Machine token or `null` |
| `envTrendMemoryApplyEnabled` | From `governance_mini_report.trendMemoryApply.envEnabled`, or `null` if mini / block missing |
| `policyLastAlertReason` | Echo of `policyHealth.lastAlertReason` |
| `userHint` | Short English sentence for UI |

## Rules (V1)

- No `fallback_frequent` → `status: normal`.
- `fallback_frequent` + mini has `trendMemoryApply` + **`envEnabled === false`** (boolean) → `expected_by_config`, `fallback_under_trend_apply_disabled`.
- `fallback_frequent` + **`envEnabled === true`** → `investigate`, `fallback_frequent_with_apply_enabled`.
- `fallback_frequent` + no `trendMemoryApply` on mini → `unknown`, `missing_trend_memory_apply_on_mini_report`.
- `fallback_frequent` + `trendMemoryApply` present but `envEnabled` missing or not boolean → `unknown`, `trend_apply_env_enabled_indeterminate`.

Does **not** change `governanceHealth` or alert severities (digest unchanged in V1).
