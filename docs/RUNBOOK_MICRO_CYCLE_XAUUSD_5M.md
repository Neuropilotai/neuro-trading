# Runbook — Micro-cycle manuel traçable (XAUUSD 5m)

Production-oriented operational steps for `neuropilot_trading_v2`. This runbook **documents and orchestrates** existing commands only. It does **not** change engine behavior.

---

## 1. Overview

**Purpose**

- Run a **minimal research loop** for a **single universe** (XAUUSD 5m): next-gen → discovery (two-stage) → meta → evolution → ops snapshot.
- Obtain **traceability** in `governance/experiment_registry.json` comparable to what `engine/scripts/runFullPipelineExpanded.sh` achieves via explicit `appendArtifact` calls after each stage.

**Micro-cycle vs full pipeline**

| Aspect | Micro-cycle (this runbook) | `runFullPipelineExpanded.sh` |
|--------|----------------------------|------------------------------|
| Scope | One symbol/timeframe (`XAUUSD` / `5m` / `xauusd_5m`) | Many pairs, data engine, supervisor, governor, family expansion, mini-report, trend memory, etc. |
| `experimentId` | You call `startExperiment` once per cycle | Step 0 starts experiment and appends artifacts throughout |
| Registry artifacts | **You must run Step 6** (`appendArtifact`) | Shell runs `appendArtifact` after meta, evolution, exports, etc. |

**When to use**

- Targeted iteration on gold 5m (cost control, debugging meta/discovery).
- Validating that `meta_ranking.json`, `champion_registry.json`, and hybrid/ops snapshots update under your real `NEUROPILOT_DATA_ROOT`.

**Key limitation**

- `startExperiment` only creates an entry with `artifacts: []`. **Nothing** automatically appends artifacts for a manual shell sequence. **`appendArtifact` is mandatory** if you want registry traceability (same idea as the full pipeline shell, not embedded inside `runMetaPipeline.js`).

---

## 2. Preconditions

**Working directory**

- All `node` commands below assume **current working directory** is the repo root:

```text
neuropilot_trading_v2/
```

**Environment**

- `NEUROPILOT_DATA_ROOT` — absolute path to your data tree (must exist). Same variable the full pipeline uses.
- Node.js **≥ 20** (per `package.json` engines).
- Optional: `NEUROPILOT_HYBRID_PROMOTION_ENABLE=1` before `exportOpsSnapshot.js` if you want hybrid layers in the snapshot (observability only).

**Dataset file**

- Required CSV:

```text
$NEUROPILOT_DATA_ROOT/datasets/xauusd/xauusd_5m.csv
```

**Verification**

```bash
cd /path/to/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"   # example; use your path

node -e "console.log('dataRoot=', require('./engine/dataRoot').getDataRoot())"
ls -lh "$NEUROPILOT_DATA_ROOT/datasets/xauusd/xauusd_5m.csv"
```

If `getDataRoot()` does not print the same root you intend, fix `NEUROPILOT_DATA_ROOT` **before** running meta or evolution; otherwise writes go to the wrong tree.

---

## 3. Step 0 — Start experiment (traceability)

**Why**

- Creates a new `experimentId` and appends a record to `governance/experiment_registry.json` with `artifacts: []`.
- Downstream, Step 6 attaches paths to this id so the dashboard and audits can list what was produced in this run.

**Relationship**

- `engine/governance/experimentRegistry.js` → `registryPath()` = `dataRoot.getPath('governance')` + `/experiment_registry.json` (i.e. under the same root as `NEUROPILOT_DATA_ROOT` when set and the path exists).

**Commands**

```bash
cd /path/to/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"

export EXPERIMENT_ID="$(node -e "const g=require('./engine/governance/experimentRegistry'); console.log(g.startExperiment({ note: 'micro XAUUSD 5m' }));")"
export NEUROPILOT_CYCLE_ID="$EXPERIMENT_ID"
echo "EXPERIMENT_ID=$EXPERIMENT_ID"
```

**Verification**

```bash
jq '.experiments[-1] | { experimentId, startedAt, artifacts }' \
  "$(node -e "const d=require('./engine/dataRoot'); console.log(require('path').join(d.getPath('governance'),'experiment_registry.json'));")"
```

Expect `artifacts: []` until Step 6 completes.

---

## 4. Step 1 — Next generation

**What it does**

- Reads champions / meta context per `engine/evolution/buildNextGenerationFromChampions.js`.
- Writes mutated child strategy files under `generated_strategies/` and report `discovery/next_generation_report.json` (paths relative to `NEUROPILOT_DATA_ROOT` via `dataRoot`).

**Command**

```bash
node engine/evolution/buildNextGenerationFromChampions.js
```

---

## 5. Step 2 — CSV → binary + two-stage discovery

**What it does**

- `csvToBinary.js` updates the binary dataset used by discovery.
- `runTwoStageDiscovery.js` runs the real batch-style path (not `runStrategyBatch.js`, which remains a stub).

**dataGroup**

- **Must** be `xauusd_5m` — defined in `engine/researchConfig.js` and used by `runFullPipelineExpanded.sh` for XAUUSD 5m.

**Commands**

```bash
node engine/scripts/csvToBinary.js \
  "$NEUROPILOT_DATA_ROOT/datasets/xauusd/xauusd_5m.csv" XAUUSD 5m

node engine/discovery/runTwoStageDiscovery.js XAUUSD 5m xauusd_5m
```

**Outputs (under data root)**

- `datasets/xauusd/` — `.bin` alongside CSV usage.
- `data_workspace` / `batch_results` — per project layout; batch JSON consumed by meta lives under `batch_results/` (see `runMetaPipeline` / `dataRoot.getPath('batch_results')`).

---

## 6. Step 3 — Meta pipeline

**What it does**

- `engine/meta/runMetaPipeline.js` reads batch results, ranks strategies, builds portfolio, writes:
  - `discovery/meta_ranking.json`
  - `discovery/strategy_portfolio.json`

**Command**

```bash
node -e "console.log('dataRoot before meta:', require('./engine/dataRoot').getDataRoot())"
node engine/meta/runMetaPipeline.js 30 12
```

**Critical checks**

```bash
META="$NEUROPILOT_DATA_ROOT/discovery/meta_ranking.json"
jq '.generatedAt, .experimentId, .topN, .totalStrategiesRanked' "$META"
```

- Prefer **`generatedAt` inside JSON** over Finder/`stat` mtime on network volumes.
- On success, CLI prints `Meta Pipeline done.` and `Meta ranking:` with the absolute path; that path should match the file you inspect.

---

## 7. Step 4 — Evolution

**What it does**

- `engine/evolution/strategyEvolution.js` updates champion registry and related outputs using meta + history (see file header in repo).

**Command**

```bash
node engine/evolution/strategyEvolution.js
```

**Note**

- `engine/evolution/scripts/runEvolutionBaseline.sh` is **narrower** (wildcard + audit + metrics; does **not** run next-gen / meta). Do not substitute it for this step if you need a full meta-driven evolution pass in one micro-cycle.

---

## 8. Step 5 — Ops snapshot + hybrid (optional observability)

**What it does**

- `engine/evolution/scripts/exportOpsSnapshot.js` refreshes `ops-snapshot/*` (and calls `buildGovernanceDashboard` when configured).
- With `NEUROPILOT_HYBRID_PROMOTION_ENABLE=1`, enriches `strategy_validation.json`, `hybrid_review_queue.json`, `latest.json`, etc. (all **non-blocking** relative to strict promotion).

**Commands**

```bash
export NEUROPILOT_HYBRID_PROMOTION_ENABLE=1
node engine/evolution/scripts/exportOpsSnapshot.js
```

**Default snapshot directory**

- Repo-relative `ops-snapshot/` unless `NEUROPILOT_OPS_SNAPSHOT_DIR` is set (see `exportOpsSnapshot.js`).

---

## 9. Step 6 — Append artifacts (critical for traceability)

**Why**

- `runFullPipelineExpanded.sh` runs `appendArtifact` **after** meta, evolution, and exports.
- A manual micro-cycle **must** do the same; otherwise `experiments[-1].artifacts` stays `[]`.

**Path helper**

- Use the same resolution as the full pipeline: `NEUROPILOT_DATA_ROOT` if set, else `require('./engine/dataRoot').getDataRoot()`.

**Commands**

```bash
node -e "
const g = require('./engine/governance/experimentRegistry');
const path = require('path');
const dr = require('./engine/dataRoot');
const p = process.env.NEUROPILOT_DATA_ROOT && String(process.env.NEUROPILOT_DATA_ROOT).trim()
  ? path.resolve(process.env.NEUROPILOT_DATA_ROOT.trim())
  : dr.getDataRoot();
const id = process.env.EXPERIMENT_ID;
if (!id) { console.error('EXPERIMENT_ID missing'); process.exit(1); }
g.appendArtifact(id, 'meta', path.join(p, 'discovery', 'meta_ranking.json'));
g.appendArtifact(id, 'portfolio', path.join(p, 'discovery', 'strategy_portfolio.json'));
console.log('appendArtifact: meta, portfolio OK');
"

node -e "
const g = require('./engine/governance/experimentRegistry');
const path = require('path');
const dr = require('./engine/dataRoot');
const p = process.env.NEUROPILOT_DATA_ROOT && String(process.env.NEUROPILOT_DATA_ROOT).trim()
  ? path.resolve(process.env.NEUROPILOT_DATA_ROOT.trim())
  : dr.getDataRoot();
const id = process.env.EXPERIMENT_ID;
g.appendArtifact(id, 'registry', path.join(p, 'champion_setups', 'champion_registry.json'));
console.log('appendArtifact: registry OK');
"

node -e "
const g = require('./engine/governance/experimentRegistry');
const path = require('path');
const dr = require('./engine/dataRoot');
const p = process.env.NEUROPILOT_DATA_ROOT && String(process.env.NEUROPILOT_DATA_ROOT).trim()
  ? path.resolve(process.env.NEUROPILOT_DATA_ROOT.trim())
  : dr.getDataRoot();
const id = process.env.EXPERIMENT_ID;
g.appendArtifact(id, 'ops_snapshot', path.join(p, 'discovery', 'supervisor_config.json'));
console.log('appendArtifact: ops_snapshot OK');
"
```

**Alignment with full pipeline**

- Stage names and target paths mirror the inline `node -e` blocks in `runFullPipelineExpanded.sh` after meta, evolution, and interim ops snapshot (`supervisor_config.json` for ops snapshot artifact).

---

## 10. Final verification

```bash
REG="$(node -e "const d=require('./engine/dataRoot'); const p=require('path'); console.log(p.join(d.getPath('governance'),'experiment_registry.json'));")"
jq '.experiments[-1] | { experimentId, artifacts }' "$REG"
```

**Expected**

- `artifacts` is a **non-empty** array.
- Stages include at least: `meta`, `portfolio`, `registry`, `ops_snapshot` (order may vary).

---

## 11. Expected outputs summary

| Artifact | Typical path (under `NEUROPILOT_DATA_ROOT` unless noted) |
|----------|-------------------------------------------------------------|
| Experiment registry | `governance/experiment_registry.json` |
| Meta ranking | `discovery/meta_ranking.json` |
| Strategy portfolio | `discovery/strategy_portfolio.json` |
| Next-gen report | `discovery/next_generation_report.json` |
| Champion registry | `champion_setups/champion_registry.json` |
| Ops snapshot / dashboard | `neuropilot_trading_v2/ops-snapshot/*` (default) |
| Hybrid queue (if enabled) | `governance/hybrid_review_queue.json` + mirror under `ops-snapshot/` per export script |

---

## 12. Known pitfalls

1. **`meta_ranking` “old timestamp”** — Trust `jq '.generatedAt'` on the file whose path was printed at `Meta Pipeline done.`. Do not rely on volume `mtime` alone.
2. **Empty `artifacts`** — You skipped Step 6 or `EXPERIMENT_ID` was unset when running `appendArtifact`.
3. **Wrong data root** — Meta and registry write under `dataRoot.getPath(...)`. Always print `getDataRoot()` in the **same shell** before long runs.
4. **`runEvolutionBaseline.sh` ≠ micro-cycle** — It does not replace meta/next-gen; see `runEvolutionBaseline.sh` header comments.
5. **Duplicate `exportOpsSnapshot`** — `runEvolutionBaseline.sh` already ends with `exportOpsSnapshot.js`; if you chain baseline after this runbook, you may run export twice (usually harmless).

---

## 13. Optional — loop mode (advanced)

Use only when you understand that **each iteration** should either reuse one experiment (artifacts accumulate) or start a **new** `startExperiment` per lap for clean audit trails.

**Example skeleton** (new experiment each lap):

```bash
cd /path/to/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"

while true; do
  echo "=== MICRO RUN $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  export EXPERIMENT_ID="$(node -e "const g=require('./engine/governance/experimentRegistry'); console.log(g.startExperiment({ note: 'micro XAUUSD 5m loop' }));")"
  export NEUROPILOT_CYCLE_ID="$EXPERIMENT_ID"
  echo "EXPERIMENT_ID=$EXPERIMENT_ID"

  node engine/evolution/buildNextGenerationFromChampions.js
  node engine/scripts/csvToBinary.js "$NEUROPILOT_DATA_ROOT/datasets/xauusd/xauusd_5m.csv" XAUUSD 5m
  node engine/discovery/runTwoStageDiscovery.js XAUUSD 5m xauusd_5m
  node engine/meta/runMetaPipeline.js 30 12
  node engine/evolution/strategyEvolution.js
  NEUROPILOT_HYBRID_PROMOTION_ENABLE=1 node engine/evolution/scripts/exportOpsSnapshot.js

  node -e "
    const g=require('./engine/governance/experimentRegistry');
    const path=require('path'); const dr=require('./engine/dataRoot');
    const p=process.env.NEUROPILOT_DATA_ROOT&&String(process.env.NEUROPILOT_DATA_ROOT).trim()?path.resolve(process.env.NEUROPILOT_DATA_ROOT.trim()):dr.getDataRoot();
    const id=process.env.EXPERIMENT_ID;
    g.appendArtifact(id,'meta',path.join(p,'discovery','meta_ranking.json'));
    g.appendArtifact(id,'portfolio',path.join(p,'discovery','strategy_portfolio.json'));
    g.appendArtifact(id,'registry',path.join(p,'champion_setups','champion_registry.json'));
    g.appendArtifact(id,'ops_snapshot',path.join(p,'discovery','supervisor_config.json'));
  "

  sleep 300
done
```

Add your own failure handling (`set -e`, logging, disk checks) before production use.

---

## Reference — canonical XAUUSD 5m triplet

| Field | Value |
|--------|--------|
| Symbol | `XAUUSD` |
| Timeframe | `5m` |
| dataGroup | `xauusd_5m` |

Sources: `engine/researchConfig.js`, `engine/scripts/runFullPipelineExpanded.sh`, `engine/scripts/runDiscoverySpyQqqBtc.sh`.
