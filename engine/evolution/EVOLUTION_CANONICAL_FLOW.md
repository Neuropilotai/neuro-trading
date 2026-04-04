# NeuroPilot evolution — canonical flow (auditable)

## Root causes addressed (historical)

| Issue | Cause | Fix |
|-------|--------|-----|
| Champion ≠ best momentum | `promoteMutationsOverParents` + survival order + diversity order | Single stage `normalizeChampionPerGroup` ranks by momentum → avgMeta → nightsSurvived → mutation tie-break |
| No champion despite strong child | Promotion gated on `hadChampion` + separate caps | Winner promoted if `momentum ≥ GROUP_PROMOTE_VALIDATED_MIN_MOMENTUM` (0.48) or line 0.47 or prior champion |
| `mutationType` on base | Last-row carry | `cleanLineageEntry`: strip `mutationType` if not mutation |
| `parentSetupId === setupId` | Data corruption | Forced to `null` in `cleanLineageEntry` |
| Status drift | Stagnation/extinction interleaved with promotion | **Order**: survival-only build → normalize → stagnation → extinction → diversity cap |
| Diversity before winner | Old order | Diversity **after** group winner + extinction |

## Pipeline order (`runEvolution`)

1. Load + normalize history (`loadPreferredEvolutionInput`, lineage merge)
2. `buildRegistryEntries`: metrics + **initial** structural status (`scoreSetupSurvival` only), `liveStatus: active`
3. `normalizeChampionPerGroup`: **max 1 champion / competition group**, winner = best rank
4. `applyPostNormalizeStagnation`: non-champions only → weak long-run → `candidate`
5. `applyExtinctionStructural`: champion decay, validated decay, candidate `liveStatus: extinct` (grace nights)
6. `capChampionDiversity`: cross-family quotas (may demote champions)
7. `validateRegistryConsistency` (throw if `EVOLUTION_REGISTRY_STRICT=1`)
8. `buildEvolutionMetadata` → `registry.metadata`
9. Merge `liveStatus: killed` from performance file; write JSON

## Structural vs live status

| Field | Values | Set in |
|-------|--------|--------|
| `status` | candidate, validated, champion | Survival → normalize → stagnation → extinction → diversity |
| `liveStatus` | active, extinct, killed | Extinct in extinction; killed only at write from `champion_performance.json` |

## Competition group key

`parentSetupId` if distinct from `setupId`, else `setupId` (parent + all children share parent’s id).

## Env (selection)

- `GROUP_CHAMPION_MIN_MOMENTUM` (default 0.47)
- `GROUP_PROMOTE_VALIDATED_MIN_MOMENTUM` (default 0.48)
- `EVOLUTION_REGISTRY_STRICT=1` — fail write if invariants broken
