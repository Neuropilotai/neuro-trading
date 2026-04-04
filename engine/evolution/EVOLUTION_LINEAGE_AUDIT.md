# Evolution System — Lineage Accumulation Audit

## 1. ROOT CAUSE (exact)

**lineageKey differed per setupId** because `extractRootFamily(setupId)` returns the full suffix after `familyexp_`. So:

- Night 1: `pattern_001_open_abc` → lineageKey `pattern_001_open_abc`
- Night 2: `pattern_001_open_def` → lineageKey `pattern_001_open_def`
- Night 3: `familyexp_pattern_001_open_ghi` → lineageKey `pattern_001_open_ghi`

Each setupId got a **different** lineageKey, so `buildByLineageKey` produced one row per bucket. `applyLineageHistoryToBySetupId` then replaced each setup’s history with that single-row bucket → **no multi-night accumulation**, and `nightsSurvived` stayed 1 (and only one night could pass `isPositiveNight` per lineage).

So the failure point is: **lineageKey assignment when `parentFamilyId`/`familyKey` are absent** — using only `extractRootFamily(setupId)` does not normalize different hashes/suffixes of the same family.

---

## 2. EVIDENCE

- **strategyEvolution.js**  
  - `buildByLineageKey`: `key = String(row.lineageKey || row.setupId || '')` — grouping is by lineageKey.  
  - If every row has a different lineageKey (e.g. `pattern_001_open_abc` vs `pattern_001_open_def`), each key gets one row.  
  - `applyLineageHistoryToBySetupId`: `bySetupId[setupId] = lineageHistory` — so each setup gets at most 1 row when each lineage bucket has 1 row.

- **extractRootFamily** only strips `familyexp_`:
  - `familyexp_pattern_001_open_abc` → `pattern_001_open_abc`
  - `pattern_001_open_def` → `pattern_001_open_def`
  So different trailing segments → different keys → no grouping across nights.

- **Registry**  
  - `nightsSurvived` in `buildRegistryEntries` is `(history || []).filter((h) => isPositiveNight(h)).length`.  
  - If `history.length === 1` for every setup (because lineage buckets had 1 row), then `nightsSurvived` is at most 1 → `maxNightsSurvived === 1`.

---

## 3. FIX (applied)

Introduce **extractStableLineageRoot(setupId)** and use it when `parentFamilyId`/`familyKey` are absent:

- After `extractRootFamily(setupId)`, strip a **trailing hash/suffix**: `root.replace(/_[a-z0-9]{2,12}$/i, '')`.
- So `pattern_001_open_abc` and `pattern_001_open_def` both become `pattern_001_open` → **same lineageKey** → one bucket with multiple nights → multi-night history and `maxNightsSurvived` can grow.

**Where applied:**

- **strategyEvolution.js**
  - `loadCurrentMetaRankingAsHistory`:  
    `lineageKey = s.parentFamilyId || s.familyKey || extractStableLineageRoot(setupId) || extractRootFamily(setupId) || setupId`
  - `normalizeEvolutionInputShape`:  
    same priority, with `extractStableLineageRoot(safeSetupId)` before `extractRootFamily(safeSetupId)`.
- **backfillLineageHistory.js**
  - `enrichRow`: lineageKey fallback uses `extractStableLineageRoot(setupId)` before `extractRootFamily(setupId)` so backfilled files match evolution.

---

## 4. DATA FLOW (verified)

1. **loadNightlyHistory()** — brain_snapshots + discovery; builds `bySetupId` keyed by setupId; records have `dateKey`, optional `lineageKey`/`parentFamilyId`/`familyKey`.
2. **loadCurrentMetaRankingAsHistory()** — one row per strategy; each row gets `lineageKey` (now with `extractStableLineageRoot` when no parent/family).
3. **normalizeEvolutionInputShape** — adds/overwrites `lineageKey` on every row (same stable root when absent).
4. **mergeEvolutionInputs** — merges by setupId, dedup by `setupId::dateKey::ts`; rows keep their `lineageKey`.
5. **buildByLineageKey** — groups by `row.lineageKey`; with stable root, multiple nights map to same key.
6. **dedupeByDateKey** — one row per dateKey per lineage; multiple dateKeys → multiple rows per lineage.
7. **applyLineageHistoryToBySetupId** — each setupId gets `byLineageKey[lineageKey]` → multi-night history.
8. **buildRegistryEntries** / **scoreSetupSurvival** — `nightsSurvived` = count of `isPositiveNight(h)` in that history.

---

## 5. FILE LOADING

- **resolveNightlyFiles(dir)** only includes files matching `discovered_setups_YYYYMMDD_HHMMSS.json` (or `_enriched`).  
- **discovered_setups.json** (no timestamp) is **not** loaded. So discovery/ only contributes if it contains timestamped files. Optional improvement: support `discovered_setups.json` / `discovered_setups_enriched.json` as one night (e.g. current date).

---

## 6. SECONDARY RISKS

- **isPositiveNight** is strict (expectancy > 0, trades >= 20, bootstrap_risk ≤ 0.2). Nightly rows with missing or defaulted fields may not count as positive → `nightsSurvived` can stay low even when history has many rows. Consider treating null bootstrap_risk as pass and/or logging when rows are dropped.
- **Nightly rows lack `ts`** — merge key uses `ts`; nightly uses `''`. Dedup is still by setupId+dateKey; sort puts all `ts`-empty rows together. No bug found, but adding `ts` from filename or `generatedAt` would make ordering explicit.
- **Regex `_[a-z0-9]{2,12}$`** — strips 2–12 char suffix. Unusual IDs (e.g. 1-char or >12 char suffix) may not normalize; monitor if new ID patterns appear.

---

## 7. SUCCESS CONDITION

After the fix:

- Same family across nights (e.g. `pattern_001_open_abc`, `pattern_001_open_def`) shares one lineageKey (`pattern_001_open`).
- `buildByLineageKey` produces buckets with multiple rows (one per night).
- `applyLineageHistoryToBySetupId` assigns that multi-night history to each setup in the lineage.
- **maxNightsSurvived** can be &gt; 1 and **with2PlusNights** &gt; 0 when enough nights pass `isPositiveNight`.
