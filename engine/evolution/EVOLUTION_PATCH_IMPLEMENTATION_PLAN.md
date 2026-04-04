# Evolution Pipeline — Implementation Plan (Post-Audit)

Based on `EVOLUTION_ARCHITECTURAL_AUDIT.md`. Implementation planner mode: ranked patches, exact touch points, order, validation, and rollback.

---

## 1. RANKED PATCH PLAN

| Rank | Patch | Rationale | Champion-selection impact |
|------|--------|-----------|----------------------------|
| 1 | **Add `championsDemotedByDiversity` to metadata** | Highest leverage: explains "no champion" without changing selection. | None (observability only). |
| 2 | **Atomic registry write** | Prevents corrupt registry on crash; no logic change. | None. |
| 3 | **Gate MUTATION_STATUS_DEBUG behind env** | Reduces log noise; no logic change. | None. |
| 4 | **Per-run audit script** | Fails run if invariants broken; catches regressions. | None (detection only). |
| 5 | **Champion floor warning** | Log/alert when championsCount &lt; N; optional soft-fail. | None by default; optional fail can block write. |
| 6 | **Stagnation vs extinction documentation** | Clarifies semantics; no code change to selection. | None. |

Patches 1–4 are **implementation**. Patches 5–6 are **optional** (warning + docs). No patch in this plan modifies `normalizeChampionPerGroup`, `compareGroupMembers`, `capChampionDiversity` logic, or extinction/stagnation thresholds — so champion selection is unchanged except if you enable the optional champion floor *and* set it to hard-fail.

---

## 2. EXACT FILES TO MODIFY

| Patch | File(s) | Notes |
|-------|---------|--------|
| 1 – Metadata | `neuropilot_trading_v2/engine/evolution/strategyEvolution.js` | Add one count, one field in return. |
| 2 – Atomic write | `neuropilot_trading_v2/engine/evolution/strategyEvolution.js` | Replace write in one function. |
| 3 – Debug log | `neuropilot_trading_v2/engine/evolution/scoreSetupSurvival.js` | Wrap one block in env check. |
| 4 – Audit script | **New file** `neuropilot_trading_v2/engine/evolution/auditRegistryConsistency.js` | Standalone script. |
| 5 – Champion floor | `neuropilot_trading_v2/engine/evolution/strategyEvolution.js` | Optional: one check after metadata, log or throw. |
| 6 – Docs | `neuropilot_trading_v2/engine/evolution/EVOLUTION_CANONICAL_FLOW.md` | Add subsection. |

---

## 3. EXACT FUNCTIONS TO TOUCH

### Patch 1 — `championsDemotedByDiversity`

- **File:** `neuropilot_trading_v2/engine/evolution/strategyEvolution.js`
- **Function:** `buildEvolutionMetadata(entries, consistency)` (starts ~line 326).
- **Change:** Before the `return { ... }`:
  - Add:  
    `championsDemotedByDiversity: list.filter((e) => e.statusReason === 'champion_diversity_capped').length`
  - Insert in the returned object (e.g. after `championsDemoted`).

### Patch 2 — Atomic registry write

- **File:** `neuropilot_trading_v2/engine/evolution/strategyEvolution.js`
- **Function:** `writeChampionRegistry(registry)` (lines 1077–1084).
- **Change:**
  - Compute `outPath` as now (e.g. `path.join(championDir, 'champion_registry.json')`).
  - Define `tmpPath = path.join(championDir, 'champion_registry.json.tmp')`.
  - `fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf8')`.
  - `fs.renameSync(tmpPath, outPath)`.
  - Return `outPath` (unchanged).

### Patch 3 — Gate MUTATION_STATUS_DEBUG

- **File:** `neuropilot_trading_v2/engine/evolution/scoreSetupSurvival.js`
- **Function:** Contains the block at ~lines 336–348 (`if (isMutationSetup) { console.log('MUTATION_STATUS_DEBUG', { ... }); }`).
- **Change:** Wrap the `console.log` in:  
  `if (process.env.EVOLUTION_DEBUG_MUTATION === '1') { ... }`.

### Patch 4 — Per-run audit script

- **New file:** `neuropilot_trading_v2/engine/evolution/auditRegistryConsistency.js`
- **Behavior:** Load `champion_registry.json` from data root (reuse `dataRoot.getPath('champion_setups')` + `champion_registry.json`), run the same checks as `validateRegistryConsistency` (and optionally: no self-parent, no base mutationType). Exit 0 if all pass, non-zero and print errors if any fail. No functions in `strategyEvolution.js` need to be modified; the script can require `validateRegistryConsistency`, `competitionGroupKey`, and the same `compareGroupMembers` (or reimplement minimal checks). Prefer requiring from `strategyEvolution.js` to avoid drift.

### Patch 5 — Champion floor (optional)

- **File:** `neuropilot_trading_v2/engine/evolution/strategyEvolution.js`
- **Function:** `runEvolution()` (after `const metadata = buildEvolutionMetadata(...)` and before building `registry`).
- **Change:**  
  - Read floor from `process.env.EVOLUTION_CHAMPION_FLOOR` (e.g. default 0 = disabled).  
  - If floor &gt; 0 and `championsRaw.length < floor`:  
    - Log warning with championsCount and floor.  
    - If `process.env.EVOLUTION_CHAMPION_FLOOR_FAIL === '1'`, throw (or set a flag and skip write).  
  - Do not change `entries` or any selection.

### Patch 6 — Documentation

- **File:** `neuropilot_trading_v2/engine/evolution/EVOLUTION_CANONICAL_FLOW.md`
- **Change:** Add a short subsection "Stagnation vs extinction" explaining: stagnation = structural demotion to candidate (weak momentum after 4+ nights); extinction = structural + live (validated→candidate, champion→validated, candidate→extinct) with grace and thresholds. No code.

---

## 4. ORDER OF IMPLEMENTATION

1. **Patch 1** — Metadata `championsDemotedByDiversity` (observability only; safe).
2. **Patch 2** — Atomic write (single function; easy to revert).
3. **Patch 3** — Gate debug log (single block; no selection impact).
4. **Patch 4** — Audit script (new file; no change to pipeline).
5. **Patch 5** — Champion floor (optional; add behind env, default off).
6. **Patch 6** — Docs (no code path change).

Implement in this order so that: (1) you get the new metric immediately; (2) registry writes become safe; (3) logs are clean; (4) you can run the auditor after every run; (5) optional guard is available; (6) semantics are documented.

---

## 5. VALIDATION COMMANDS AFTER EACH PATCH

Assume project root for commands: `neuropilot_trading_v2` (e.g. `cd neuropilot_trading_v2`).

### After Patch 1 (metadata)

```bash
node engine/evolution/strategyEvolution.js
# Then inspect metadata (path from dataRoot: data_workspace/champion_setups or NEUROPILOT_DATA_ROOT/champion_setups):
node -e "
const path = require('path');
const dataRoot = require('./engine/dataRoot');
const regPath = path.join(dataRoot.getPath('champion_setups'), 'champion_registry.json');
const r = require(regPath);
console.log('championsDemotedByDiversity' in (r.metadata || {}));
console.log('championsDemotedByDiversity:', r.metadata?.championsDemotedByDiversity);
"
```

- **Success:** Registry written; `r.metadata.championsDemotedByDiversity` is a number (0 or positive).

### After Patch 2 (atomic write)

```bash
# Ensure registry exists
node engine/evolution/strategyEvolution.js
# Simulate crash: write a script that opens registry and kills during write, or manually truncate .tmp if present
ls -la "$NEUROPILOT_DATA_ROOT/champion_setups/"  # or data root from dataRoot
# Run again and verify registry is valid JSON (use dataRoot so it works with or without NEUROPILOT_DATA_ROOT)
node -e "
const dataRoot = require('./engine/dataRoot');
const path = require('path');
const fs = require('fs');
const regPath = path.join(dataRoot.getPath('champion_setups'), 'champion_registry.json');
JSON.parse(fs.readFileSync(regPath, 'utf8'));
console.log('OK');
"
```

- **Success:** No `.tmp` left behind; `champion_registry.json` is valid JSON after a normal run.

### After Patch 3 (debug gate)

```bash
# Without env: no MUTATION_STATUS_DEBUG lines
node engine/evolution/strategyEvolution.js 2>&1 | grep -c MUTATION_STATUS_DEBUG || true
# Expect 0

# With env: lines present (if there are mutations)
EVOLUTION_DEBUG_MUTATION=1 node engine/evolution/strategyEvolution.js 2>&1 | grep -c MUTATION_STATUS_DEBUG || true
```

- **Success:** Default run has no MUTATION_STATUS_DEBUG; with `EVOLUTION_DEBUG_MUTATION=1` you may see lines.

### After Patch 4 (audit script)

```bash
# Run evolution then audit
node engine/evolution/strategyEvolution.js
node engine/evolution/auditRegistryConsistency.js
echo "Exit: $?"
```

- **Success:** Exit 0 when registry is consistent; exit non-zero and printed errors when not (e.g. run with a broken registry to test).

### After Patch 5 (champion floor, optional)

```bash
# Default: no effect
node engine/evolution/strategyEvolution.js

# With floor and fail (only if you have few champions):
EVOLUTION_CHAMPION_FLOOR=50 EVOLUTION_CHAMPION_FLOOR_FAIL=1 node engine/evolution/strategyEvolution.js
# Expect warning and exit failure when championsCount < 50
```

- **Success:** With floor and FAIL=1, run fails when below floor; without FAIL, only warning.

### After Patch 6 (docs)

- **Success:** Read `EVOLUTION_CANONICAL_FLOW.md` and confirm "Stagnation vs extinction" subsection exists and is accurate.

### Cross-check (strict validation)

After all patches, run with strict validation once:

```bash
EVOLUTION_REGISTRY_STRICT=1 node engine/evolution/strategyEvolution.js
# Expect no consistency errors in output; metadata.consistencyOk true
node engine/evolution/auditRegistryConsistency.js
# Expect exit 0
```

---

## 6. ROLLBACK STRATEGY IF A PATCH DESTABILIZES CHAMPION SELECTION

None of patches 1–4 or 6 change who becomes champion. Only patch 5 (champion floor) can change *behavior* if `EVOLUTION_CHAMPION_FLOOR_FAIL=1` is set (it can prevent writing the registry when below floor).

### Per-patch rollback

| Patch | Rollback |
|-------|----------|
| 1 | Remove `championsDemotedByDiversity` from `buildEvolutionMetadata` return. Re-run evolution; champion set unchanged. |
| 2 | Restore `writeChampionRegistry` to single `fs.writeFileSync(outPath, ...)`. Re-run evolution; same champions, write non-atomic again. |
| 3 | Remove the `EVOLUTION_DEBUG_MUTATION` guard so `console.log` runs always. No selection impact. |
| 4 | Delete or bypass `auditRegistryConsistency.js`; no impact on selection. |
| 5 | Unset `EVOLUTION_CHAMPION_FLOOR` and `EVOLUTION_CHAMPION_FLOOR_FAIL`, or remove the check from `runEvolution`. |
| 6 | Revert doc edit; no code impact. |

### If champion selection *appears* to change after a patch

1. **Confirm inputs are identical** — Same lineage history, same `bySetupId`, same env (no accidental EVOLUTION_* changes). Re-run without the patch and compare `champions` list (e.g. `registry.champions.map(e => e.setupId).sort()`).
2. **Patch 1, 2, 3, 4, 6** — They do not touch `buildRegistryEntries`, `normalizeChampionPerGroup`, `applyPostNormalizeStagnation`, `applyExtinctionStructural`, `capChampionDiversity`, or `compareGroupMembers`. If champions differ, the cause is elsewhere (data, env, or order of execution). Revert the patch and re-run to confirm champions match pre-patch state.
3. **Patch 5** — If `EVOLUTION_CHAMPION_FLOOR_FAIL=1` and floor is above current championsCount, the registry write can be skipped; "champions" would be the same in memory but not persisted. Rollback: disable floor fail or lower floor; re-run and persist.

### Safe deployment order

- Deploy 1 → validate metadata and run evolution again; compare champion count and optionally champion ids to previous run (should be identical for same input).
- Deploy 2 → run evolution twice; diff `champion_registry.json` (excluding `generatedAt`); should be identical.
- Deploy 3 and 4 → no selection change; validate with strict run and audit script.
- Deploy 5 only if you want the guard; keep `EVOLUTION_CHAMPION_FLOOR_FAIL` unset initially (warning only).
- Deploy 6 anytime.

### Restoring a known-good registry

If the written registry is corrupted or wrong:

- Restore `champion_registry.json` from backup or from the last known-good run (e.g. from version control or a copy taken after a successful strict run).
- Do **not** re-run evolution with different code or data and assume the same champions; re-run only with the same code and same inputs to reproduce.

---

*End of implementation plan.*
