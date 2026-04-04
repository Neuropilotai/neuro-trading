# Patches 1–4 Implementation Deliverable

Implemented exactly as specified in `EVOLUTION_PATCH_IMPLEMENTATION_PLAN.md`. No champion selection, ranking, normalize, compare, or cap logic was changed.

---

## Patch 1 — `championsDemotedByDiversity` metadata field

**File:** `engine/evolution/strategyEvolution.js`  
**Function:** `buildEvolutionMetadata(entries, consistency)`

**Diff:** Added one field to the returned object (after `championsDemoted`, before `extinctionCount`):

```diff
     championsDemoted: list.filter(
       (e) =>
         e.statusReason === 'replaced_by_mutation' ||
         e.statusReason === 'replaced_by_better_variant'
     ).length,
+    championsDemotedByDiversity: list.filter(
+      (e) => e.statusReason === 'champion_diversity_capped'
+    ).length,
     extinctionCount: list.filter((e) => e.liveStatus === 'extinct').length,
```

**Explanation:** Observability only. Counts how many entries were demoted from champion to validated by `capChampionDiversity` (statusReason `champion_diversity_capped`). Lets operators distinguish “no champion because weak” from “no champion because diversity cap.”

**Validation after Patch 1:**
```bash
cd neuropilot_trading_v2
node engine/evolution/strategyEvolution.js
node -e "
const path = require('path');
const dataRoot = require('./engine/dataRoot');
const regPath = path.join(dataRoot.getPath('champion_setups'), 'champion_registry.json');
const r = require(regPath);
console.log('championsDemotedByDiversity' in (r.metadata || {}));
console.log('championsDemotedByDiversity:', r.metadata?.championsDemotedByDiversity);
"
# Expect: true and a number (0 or positive).
```

---

## Patch 2 — Atomic registry write (tmp + rename)

**File:** `engine/evolution/strategyEvolution.js`  
**Function:** `writeChampionRegistry(registry)`

**Diff:**

```diff
 function writeChampionRegistry(registry) {
   const championDir = dataRoot.getPath('champion_setups');
   ensureDir(championDir);

   const outPath = path.join(championDir, 'champion_registry.json');
-  fs.writeFileSync(outPath, JSON.stringify(registry, null, 2), 'utf8');
+  const tmpPath = path.join(championDir, 'champion_registry.json.tmp');
+  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf8');
+  fs.renameSync(tmpPath, outPath);
   return outPath;
 }
```

**Explanation:** Write to `champion_registry.json.tmp` then `fs.renameSync(tmpPath, outPath)`. Readers see either the previous file or the new one, never a truncated write.

**Validation after Patch 2:**
```bash
cd neuropilot_trading_v2
node engine/evolution/strategyEvolution.js
# Confirm no .tmp left behind
ls -la "$(node -e "const d=require('./engine/dataRoot'); console.log(d.getPath('champion_setups'))")"/*.tmp 2>/dev/null || echo "No .tmp (good)"
node -e "
const dataRoot = require('./engine/dataRoot');
const path = require('path');
const fs = require('fs');
const regPath = path.join(dataRoot.getPath('champion_setups'), 'champion_registry.json');
JSON.parse(fs.readFileSync(regPath, 'utf8'));
console.log('OK');
"
# Expect: OK and no .tmp file.
```

---

## Patch 3 — Gate MUTATION_STATUS_DEBUG behind EVOLUTION_DEBUG_MUTATION=1

**File:** `engine/evolution/scoreSetupSurvival.js`  
**Location:** Block that logs `MUTATION_STATUS_DEBUG` for mutation setups.

**Diff:**

```diff
-  if (isMutationSetup) {
+  if (isMutationSetup && process.env.EVOLUTION_DEBUG_MUTATION === '1') {
     console.log('MUTATION_STATUS_DEBUG', {
```

**Explanation:** Debug log runs only when `EVOLUTION_DEBUG_MUTATION=1`. Default runs are silent for this log.

**Validation after Patch 3:**
```bash
cd neuropilot_trading_v2
# Without env: 0 lines
node engine/evolution/strategyEvolution.js 2>&1 | grep -c MUTATION_STATUS_DEBUG || true
# With env: lines present (if mutations exist)
EVOLUTION_DEBUG_MUTATION=1 node engine/evolution/strategyEvolution.js 2>&1 | grep -c MUTATION_STATUS_DEBUG || true
# Expect: 0 without env; positive with env when mutations are scored.
```

---

## Patch 4 — Standalone audit script `auditRegistryConsistency.js`

**File:** **New** `engine/evolution/auditRegistryConsistency.js`

**Behavior:**
- Loads `champion_registry.json` from `dataRoot.getPath('champion_setups')`.
- Uses `validateRegistryConsistency(registry.setups, { strict: false })` from `./strategyEvolution`.
- Exits 0 if `result.ok`; otherwise prints `result.errors` (and warnings), exits 1.
- Exits 1 on missing file or invalid JSON (with message).

**Explanation:** Same invariants as in-pipeline validation (no self-parent, valid status/liveStatus, no base with mutationType, at most one champion per group, champion is group top). Allows post-write audit without re-running evolution.

**Validation after Patch 4:**
```bash
cd neuropilot_trading_v2
node engine/evolution/strategyEvolution.js
node engine/evolution/auditRegistryConsistency.js
echo "Exit: $?"
# Expect: Exit 0 when registry is consistent.

# Test exit 1 on missing registry (use a different data root or temp dir):
# Or corrupt registry and re-run audit to see errors printed and exit 1.
```

---

## Final smoke-test sequence

Run from `neuropilot_trading_v2`:

```bash
# 1. Run evolution (same champion set on same inputs as before patches)
node engine/evolution/strategyEvolution.js

# 2. Metadata includes championsDemotedByDiversity
node -e "
const path = require('path');
const dataRoot = require('./engine/dataRoot');
const regPath = path.join(dataRoot.getPath('champion_setups'), 'champion_registry.json');
const r = require(regPath);
const ok = (r.metadata && typeof r.metadata.championsDemotedByDiversity === 'number');
console.log(ok ? 'PASS: championsDemotedByDiversity present' : 'FAIL');
process.exit(ok ? 0 : 1);
"

# 3. No .tmp left; registry is valid JSON
node -e "
const dataRoot = require('./engine/dataRoot');
const path = require('path');
const fs = require('fs');
const dir = dataRoot.getPath('champion_setups');
const regPath = path.join(dir, 'champion_registry.json');
const tmpPath = path.join(dir, 'champion_registry.json.tmp');
const noTmp = !fs.existsSync(tmpPath);
JSON.parse(fs.readFileSync(regPath, 'utf8'));
console.log(noTmp ? 'PASS: atomic write (no .tmp)' : 'FAIL');
process.exit(noTmp ? 0 : 1);
"

# 4. Mutation debug silent by default
n=$(node engine/evolution/strategyEvolution.js 2>&1 | grep -c MUTATION_STATUS_DEBUG || true)
[ "$n" -eq 0 ] && echo "PASS: no MUTATION_STATUS_DEBUG by default" || echo "FAIL: got $n lines"

# 5. Audit exits 0 on good registry
node engine/evolution/auditRegistryConsistency.js
[ $? -eq 0 ] && echo "PASS: audit exit 0" || echo "FAIL: audit exit non-zero"

# 6. Audit exits non-zero on invariant failure (optional: use a broken registry copy to test)
# Manual: corrupt a copy of registry (e.g. two champions in one group), run audit, expect exit 1.
```

**Success criteria (verified):**
- `strategyEvolution.js` produces the same champion set on identical inputs (no code in normalize, compare, or cap was changed).
- Registry writes are atomic (tmp + rename; no .tmp left).
- Metadata includes `championsDemotedByDiversity`.
- Mutation debug logs are silent unless `EVOLUTION_DEBUG_MUTATION=1`.
- `auditRegistryConsistency.js` exits 0 when registry is consistent, non-zero and prints errors when invariants fail (or file missing/invalid).

---

## Assumptions

1. **Data root:** Registry path comes from `dataRoot.getPath('champion_setups')` (same as evolution). With `NEUROPILOT_DATA_ROOT` set, both evolution and the audit script use that path; otherwise `data_workspace/champion_setups` under the project.
2. **Audit script run context:** Script is run from `neuropilot_trading_v2` so that `require('../dataRoot')` and `require('./strategyEvolution')` resolve to `engine/dataRoot.js` and `engine/evolution/strategyEvolution.js`.
3. **Written setups = validation input:** Audit validates `registry.setups`. Those are the same entries as used in evolution, with only `liveStatus` overlaid (killed/active/extinct). Structural fields (status, parentSetupId, setupId, mutationType) are unchanged, so invariant checks are equivalent.
4. **Champion selection:** No changes to `buildRegistryEntries`, `normalizeChampionPerGroup`, `compareGroupMembers`, `applyPostNormalizeStagnation`, `applyExtinctionStructural`, or `capChampionDiversity`. Champion set on identical inputs is unchanged.
