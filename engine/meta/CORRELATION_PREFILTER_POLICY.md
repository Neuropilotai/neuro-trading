# Correlation pre-filter (Phase 4)

**Purpose:** Reduce the number of distinct `setupId` values passed to `computeReturnCorrelationMatrixWithTimeout` (cost scales as O(n²) in setup count).

**Policy file:** `$NEUROPILOT_DATA_ROOT/governance/correlation_prefilter_policy.json`  
**Example (repo):** `config/correlation_prefilter_policy.example.json`

## Ranking (deterministic)

Per setup, the best batch row is chosen (see `comparePreCorrRows` in `runMetaPipeline.js`), then rows are sorted globally by: `metaScore`/`meta_score`, `expectancy`, `profitFactor`/`profit_factor`, `trades`, `setupId`.

## Diversity-aware selection (`topk_global` or `topk_diverse`)

When `maxPerSymbolTimeframe` and/or `maxPerFamily` and/or `maxSetups` apply, a **single greedy pass** walks that global order:

1. Skip if the `symbol|timeframe` bucket is full (`maxPerSymbolTimeframe`, key from row `symbol` + `timeframe`).
2. Skip if the family bucket is full (`maxPerFamily`, key from `preCorrFamilyKey`).
3. Accept and increment counts; **stop** when `maxSetups` entries are collected (if `maxSetups` > 0).

If only `maxSetups` is set (no per-bucket caps), behaviour is top‑K in global order (same as before).

## Env overrides

| Env | Effect |
|-----|--------|
| `NEUROPILOT_META_PRE_CORR_MIN_TRADES` | Min trades on row |
| `NEUROPILOT_META_PRE_CORR_MAX_PER_FAMILY` | Max setups per family key |
| `NEUROPILOT_META_PRE_CORR_MAX_PER_SYMBOL_TF` | Max setups per `symbol|timeframe` |
| `NEUROPILOT_META_PRE_CORR_MAX_TOTAL` | Max setups after caps (alias: top‑K stop) |

Positive env values **override** the policy file for that dimension.

**Not changed:** Promotion guard, paper tier, meta ranking scoring logic—only which setups feed the correlation matrix.

**Reserved:** `dedupeStructural` — forward-compatible, not implemented.

**Note:** `childrenGenerated` / next-gen are downstream; tune those separately if exploration is low.
