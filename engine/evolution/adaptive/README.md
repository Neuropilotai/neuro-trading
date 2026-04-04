# Evolution adaptive (P2)

## `stagnationSignals.js`

- `loadMetricsHistoryFromLog(logPath)` — NDJSON tail (max 500 lines)
- `readStagnationSignals(metricsHistory)` — last up to 5 rows → `isStagnating` (`avgDelta <= 0`), `zeroPromotions`

## `deriveWildcardTuning.js`

- `deriveAdaptiveWildcardOpts({ baseMinDelta, baseMaxPromotions, stagnation })`
- Active only if `EVOLUTION_ADAPTIVE_ENABLE=1`
- Stagnating: `minDelta *= 0.75`, `maxPromotions += 2`, then clamp with `EVOLUTION_ADAPTIVE_MIN_DELTA_FLOOR` / `EVOLUTION_ADAPTIVE_MAX_PROMOTIONS_CAP`

**Does not** change `compareGroupMembers` or normalize.

## Instrumentation

See `../instrumentation/computeLearningScores.js` (P0).
