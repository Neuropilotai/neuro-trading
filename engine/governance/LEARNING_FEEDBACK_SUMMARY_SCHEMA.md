# learning_feedback_summary.json — schema (Phase 1)

**Location:** `$NEUROPILOT_DATA_ROOT/governance/learning_feedback_summary.json`  
**Producer:** `npm run learning:build-state` → `engine/learning/buildLearningState.js`  
**Purpose:** “What changed vs the previous `learning_state.json` on disk?” (delta narrative).

## Versioning

| Field            | Type   | Description        |
|-----------------|--------|--------------------|
| `schemaVersion` | string | e.g. `1.0.0`       |
| `generatedAt`   | string | ISO-8601 timestamp |

## `changes`

| Field                 | Type   | Description |
|----------------------|--------|-------------|
| `boostedSetups`      | number | Count of setups whose `generationWeightMultiplier` increased vs previous run. |
| `downweightedSetups` | number | Count of setups whose `generationWeightMultiplier` decreased vs previous run. |

## `topActions`

Array of objects (max 10), each:

| Field       | Type   | Description |
|------------|--------|-------------|
| `setupKey` | string | Setup identifier. |
| `kind`     | string | `boost` or `downweight`. |
| `delta`    | number | Absolute change in generation weight multiplier. |

## `dominantRejectReason`

`string | null` — copied from the same heuristic as `learning_state.globalPolicies.dominantRejectReason` when analysis JSON is available.

## `explanations`

Array of strings — short bullet explanations for operators (Phase 1 placeholders allowed).

## Stability

All keys are always present; `topActions` and `explanations` may be empty arrays.
