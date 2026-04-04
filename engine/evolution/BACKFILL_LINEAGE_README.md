# Backfill lineage history for nightly evolution

## Diagnosis: why maxNightsSurvived stays 1 with 4 nights

- **loadNightlyHistory()** reads `brain_snapshots/discovered_setups_YYYYMMDD_HHMMSS.json`.
- Each snapshot has a **results** array; each row has `setupId`, `expectancy`, `trades`, etc.
- **Old snapshots did not contain** `parentFamilyId`, `familyKey`, or `lineageKey`.
- In **strategyEvolution.js**, `lineageKey` is set in normalizeEvolutionInputShape as:
  `row.lineageKey || row.parentFamilyId || row.familyKey || row.setupId`.
- So for nightly-only rows, **lineageKey = setupId** (no lineage metadata).
- When **buildByLineageKey** runs, each setupId is its own lineage; **applyLineageHistoryToBySetupId** then replaces each setup’s history with its “lineage” history, which is only that setup’s rows.
- Descendants that appear with a **new setupId** each night never share a lineage with prior nights (different setupIds → different lineageKeys when parentFamilyId/familyKey are missing).
- So every setup ends up with **at most one night** of history (the night it appears), and **maxNightsSurvived = 1**. Champion needs multiple nights per lineage, so it stays 0.

**Conclusion:** Backfilling lineage metadata (`parentFamilyId`, `familyKey`, `lineageKey`) into historical nightly files lets the same lineage be recognized across nights and across different setupIds (parent/child), so multi-night history and champion graduation become possible.

---

## File-by-file changes

| File | Change |
|------|--------|
| **engine/evolution/backfillLineageHistory.js** | **NEW** – Backfill script: discovers nightly files, enriches rows with familyKey/parentFamilyId/lineageKey, writes `*_enriched.json`. |
| **engine/evolution/loadNightlyHistory.js** | **MODIFIED** – Prefer `*_enriched.json` when present; parse both base and enriched filenames; add `lineageKey` to each record when present. |
| **engine/evolution/BACKFILL_LINEAGE_README.md** | **NEW** – This doc (diagnosis, safety, verification). |

---

## Safety

- **Originals untouched:** Backfill writes only `discovered_setups_YYYYMMDD_HHMMSS_enriched.json`. Original `discovered_setups_YYYYMMDD_HHMMSS.json` files are never modified or deleted.
- **Additive only:** Enrichment only adds or fills missing `familyKey`, `parentFamilyId`, `lineageKey`. All existing fields are preserved.
- **Deterministic:** familyKey from `rules` (same buckets as buildPromotedChildren); parentFamilyId from `row.parentFamilyId` or `row.parentSetupId`; lineageKey = parentFamilyId || familyKey || setupId. No fabricated IDs.
- **Idempotent:** Backfill skips nights that already have an `_enriched` file, so re-runs do not overwrite unless you remove enriched files first.

---

## Verification commands

```bash
# 1) Set data root (e.g. your 5TB)
export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI

# 2) Run backfill
node neuropilot_trading_v2/engine/evolution/backfillLineageHistory.js

# Expect BACKFILL_LINEAGE output with filesSeen, filesWritten, rowsSeen, rowsEnrichedWithFamilyKey, etc.

# 3) Check that enriched files exist and contain lineage fields
ls -la "$NEUROPILOT_DATA_ROOT/brain_snapshots/"*_enriched.json 2>/dev/null | head -5
node -e "
const fs = require('fs');
const path = require('path');
const dir = process.env.NEUROPILOT_DATA_ROOT + '/brain_snapshots';
const files = fs.readdirSync(dir).filter(f => f.endsWith('_enriched.json')).slice(0, 1);
if (files.length) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  const r = (data.results || [])[0];
  console.log('Sample row keys:', r ? Object.keys(r).sort().join(', ') : 'no results');
  if (r) console.log('lineageKey:', r.lineageKey, 'familyKey:', r.familyKey, 'parentFamilyId:', r.parentFamilyId);
}
"

# 4) Run evolution and check that lineage history improves
node -e "
const { runEvolution } = require('./neuropilot_trading_v2/engine/evolution/strategyEvolution.js');
runEvolution().then(() => {}).catch(e => { console.error(e); process.exit(1); });
"

# In the evolution log you should see source: 'merged_meta_and_nightly_history', nightsAnalyzed >= 1, lineageCount.
# After backfill + merged history, expect some setups with multiple nights per lineage so maxNightsSurvived can be > 1 and championsCount can grow when thresholds are met.
```

---

## Success condition

After backfill and rerun of evolution:

- **maxNightsSurvived** can become > 1 for some setups (lineage aggregates multiple nights).
- **with2PlusNights** / **with3PlusNights** (if you add those stats) become > 0.
- **championsCount** can become > 0 when lineages have enough nights and meet champion graduation rules, without changing champion thresholds.
