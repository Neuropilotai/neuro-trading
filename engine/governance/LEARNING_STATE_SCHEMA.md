# learning_state.json — schema (Phase 1)

**Location:** `$NEUROPILOT_DATA_ROOT/governance/learning_state.json`  
**Producer:** `npm run learning:build-state` → `engine/learning/buildLearningState.js`  
**Phase 1:** write-only artefact; engines do not consume this file yet.

## Versioning

| Field            | Type   | Description                    |
|-----------------|--------|--------------------------------|
| `schemaVersion` | string | e.g. `1.0.0`                   |
| `generatedAt`   | string | ISO-8601 timestamp             |

## Top-level

| Field             | Type   | Description |
|-------------------|--------|-------------|
| `window`          | object | Window / anchoring placeholders (Phase 1). |
| `inputs`          | object | Provenance: absolute paths + `used` + optional `warning`. |
| `globalPolicies`  | object | Consolidated global hints (mutation learning summary, reject hints). |
| `bySetup`         | object | Map `setupKey` → per-setup scores and `actions`. |
| `byFamily`        | object | Map family bucket (`mut_`, `familyexp_`, …) → aggregates. |
| `summary`         | object | Counts (boosted, downweighted, soft-blocked, …). |
| `warnings`        | array  | Internal warning strings from fail-soft reads. |

## `inputs`

Each input is always present:

```json
{
  "paperTrades": { "path": "<abs>", "used": true, "warning": null },
  "promotedChildren": { "path": "<abs>", "used": false, "warning": null },
  "paperTradesBySetupAnalysis": { "path": "<abs>", "used": false, "warning": null },
  "mutationLearning": { "path": "<abs>", "used": false, "warning": null }
}
```

- **`path`:** absolute filesystem path (traceability).
- **`used`:** file existed and was read for aggregation (may still yield empty aggregates).
- **`warning`:** e.g. `missing_file`, parse error message (never secrets).

## `globalPolicies`

| Field                         | Type   | Description |
|------------------------------|--------|-------------|
| `dominantRejectReason`       | string \| null | Heuristic label from `paper_trades_by_setup_analysis` when present. |
| `mutationLearningComputed`   | object \| null | Summary of `computePaperMutationLearning` (no full engine coupling). |
| `mutationLearningArtifactSummary` | object \| null | Short mirror of `discovery/mutation_paper_learning.json` if present. |
| `actionBias`                 | string \| null | Coarse label (e.g. mutation learning skipped vs computed). |

## `bySetup[setupKey]`

| Field              | Type   | Description |
|--------------------|--------|-------------|
| `paperScore`       | number | 0–1 heuristic from paper PnL / depth. |
| `structuralScore`  | number | 0–1; refined from optional analysis JSON when available. |
| `confidenceScore`  | number | 0–1 blend. |
| `tradeCount`       | number | Integer ≥ 0. |
| `netR`             | number | Sum of paper PnL for the setup (label kept for compatibility). |
| `winRate`          | number \| null | 0–100 when trades exist. |
| `actions`          | object | See below. |
| `reasons`          | array of string | Human-readable tags for why multipliers were chosen. |

### `actions` (per setup)

| Field                          | Type    | Description |
|--------------------------------|---------|-------------|
| `generationWeightMultiplier`   | number  | Phase 1: observational only. |
| `promotionWeightMultiplier`    | number  | Phase 1: observational only. |
| `mutationRadiusMultiplier`    | number  | Placeholder `1.0` in Phase 1 unless extended. |
| `isSoftBlocked`                | boolean | Soft block flag (no hard-delete). |

## `byFamily[familyKey]`

Aggregates over setups sharing a key prefix (`mut_`, `familyexp_`, `example_`, `other`).  
Includes `actions.generationBudgetMultiplier` (alias of generation weight for family-level budgeting narratives).

## Stability

The builder **always** emits every top-level key and full nested objects for `inputs`; empty data yields empty `bySetup` / `byFamily` objects and zeroed `summary` fields where applicable.
