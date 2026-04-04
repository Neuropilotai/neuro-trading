# NeuroPilot v2 — Repo Implementation Blueprint

**Audience:** Senior engineering team.  
**Scope:** neuropilot_trading_v2 (Node.js research engine).  
**Goal:** Transform pre-autonomous research engine into closed-loop autonomous research AI via repo-grounded build order.

---

## SECTION 1 — TARGET REPO ARCHITECTURE

Base: current `engine/`, `data_workspace/` (or `$NEUROPILOT_DATA_ROOT`), `config/`. No language or framework change.

### New directories

| Path | Purpose |
|------|---------|
| `engine/contracts/` | Canonical JSON/object contracts for research results and strategy documents; validity helpers. |
| `engine/validation/` | Backtest validity (coverage, requiredCandles), walk-forward runner, promotion gates. |
| `engine/evolution/mutationIntelligence.js` | Aggregate beats_parent by mutationType/family; write mutation policy; consumed by familyExpansionEngine. |
| `engine/supervisor/` | Research supervisor: reads state, writes supervisor_config.json; controls mutation budget and circuit breakers. |
| `engine/governance/` | Experiment registry (append-only), dataset version tracker; no new DB, file-based or SQLite. |
| `engine/research/` | Optional: research session id, research metrics aggregator. |

### Module classification

| Module | Action | Role |
|--------|--------|------|
| `engine/contracts/researchResultContract.js` | **NEW** | Single schema for a strategy result row; `isValidResult(row)`, `enrichResult(row, coverage)`; producers must emit this shape. |
| `engine/contracts/strategyObjectContract.js` | **NEW** | Canonical strategy object (id, rules, lineage, validation_state, deployment_status); `toStrategyDocument(metaRow, registryEntry)`. |
| `engine/validation/backtestValidity.js` | **NEW** | `computeCoverage(loadedCandles, requiredCandles)`, `isBacktestValid(row)`, default threshold 0.8. |
| `engine/validation/walkForwardValidator.js` | **MODIFY** | Replace `engine/validation/walkForwardTest.js` (stub). Implement train/test split, run backtest on each, return pass/fail + metrics. |
| `engine/evolution/mutationIntelligence.js` | **NEW** | `aggregateMutationStats(metaRanking, registry)`, `computeMutationPolicy(stats)`, `writeMutationPolicy(path)`; familyExpansionEngine reads policy. |
| `engine/supervisor/researchSupervisor.js` | **NEW** | `run(config)`: read meta_ranking, registry, batch_results, mutation_policy, dataset_versions; write supervisor_config.json; output decisions (mutation budget, families to expand, cash hold, cycle_valid). |
| `engine/governance/experimentRegistry.js` | **NEW** | `startExperiment(configSnapshot) → experimentId`, `appendArtifact(experimentId, stage, artifact)`, `getExperiment(experimentId)`; writes to governance/experiment_registry.json. |
| `engine/governance/datasetVersionTracker.js` | **NEW** | `registerDataset(symbol, timeframe, path, candleCount, dateRange) → datasetVersionId`, `getVersionId(path)`; writes to governance/dataset_versions.json. |
| `engine/meta/adaptiveAllocator.js` | **OPTIONAL** | If built: takes registry + meta + supervisor_config and suggests allocation tweaks. Defer to Phase 3; not required for Phase 1–2. |
| `engine/research/researchMetrics.js` | **OPTIONAL** | Aggregate run metrics (e.g. valid result count, invalid count, by mutationType). Can live inside runMetaPipeline or supervisor. Defer. |
| `engine/dataRoot.js` | **MODIFY** | Add `governance` to SUBDIRS so `getPath('governance')` returns `$DATA_ROOT/governance`. |
| `engine/discovery/runTwoStageDiscovery.js` | **MODIFY** | Use contracts + validity; pass datasetVersionId and requiredCandles into runTopKBacktests; ensure every result has backtestInvalid, coverageRatio, rules. |
| `engine/batch/runTopKBacktests.js` | **MODIFY** | Implement research result contract; add requiredCandles/loadedCandles/coverageRatio/backtestInvalid; persist rules on each result row. |
| `engine/batch/runStrategyBatch.js` | **MODIFY or DEPRECATE** | Either implement real backtest using same contract + validity and write contract-shaped results, or remove from all callers and document "batch results only from two-stage." |
| `engine/meta/runMetaPipeline.js` | **MODIFY** | Filter out results where `backtestInvalid === true` in groupResultsBySetup; propagate rules from raw into buildStrategiesForMeta; accept optional experimentId. |
| `engine/evolution/familyExpansionEngine.js` | **MODIFY** | Use only stored `rules` from meta/batch; require parent to have rules (skip or log if missing); read mutation_policy.json for weights; remove or bypass inferRulesFromStrategy for expansion. |
| `engine/evolution/strategyEvolution.js` | **KEEP** | Add optional write of experiment_id or cycle_id into champion_registry.json for audit. |
| `engine/scripts/runFullPipelineExpanded.sh` | **MODIFY** | Create experiment at start (Node one-liner or small script); after discovery, run supervisor; pass supervisor_config into evolution/family expansion if needed. |
| `engine/loop/runContinuousResearch.js` | **KEEP** | No change for Phase 1–2; later can pass experiment_id or supervisor_config path. |

### Deprecate / freeze

| Item | Action |
|------|--------|
| Any flow that calls `runStrategyBatch.js` expecting real metrics | **FREEZE** until runStrategyBatch is implemented or removed. |
| `inferRulesFromStrategy` for generating children | **DEPRECATE** for expansion; use only when displaying or logging legacy rows that have no rules. |
| `engine/validation/walkForwardTest.js` | **REPLACE** by walkForwardValidator.js (new implementation); keep filename walkForwardValidator.js for clarity. |

---

## SECTION 2 — CANONICAL RESEARCH CONTRACT

### 2.1 JSON schema: strategy result row

Every backtest-producing module must output an array of rows conforming to this shape. Consumers (meta, evolution) must ignore or exclude rows where `backtestInvalid === true`.

```json
{
  "setupId": "string (required)",
  "name": "string (optional, from setup)",
  "rules": "object (required for downstream expansion; keys: session_phase, regime, body_pct_min, close_strength_min, volume_ratio)",
  "source": "string (grid | familyexp | mut | bootstrap)",
  "generation": "number (0 = grid)",
  "parentSetupId": "string | null",
  "parentFamilyId": "string | null",
  "mutationType": "string | null",
  "expectancy": "number | null",
  "trades": "number",
  "winRate": "number | null",
  "tradeReturns": "number[]",
  "drawdown": "number | null",
  "requiredCandles": "number (required)",
  "loadedCandles": "number (required)",
  "coverageRatio": "number (loadedCandles/requiredCandles, 0..1+)",
  "backtestInvalid": "boolean (true if coverageRatio < threshold or data error)",
  "invalidReason": "string | null (e.g. 'coverage_below_80')",
  "symbol": "string (from run)",
  "timeframe": "string (from run)",
  "dataGroup": "string (from run)",
  "datasetVersionId": "string | null (from governance)",
  "generatedAt": "string (ISO8601)",
  "_fromTopK": "boolean (optional)",
  "_stub": "boolean (optional, must be false for real path)"
}
```

### 2.2 Batch result file shape

Producers write to `batch_results/strategy_batch_results_<SYMBOL>_<TF>.json` (two-stage) or single `strategy_batch_results.json` (batch path). Root shape:

```json
{
  "dataGroup": "string",
  "generatedAt": "string (ISO8601)",
  "experimentId": "string | null",
  "results": [ "<result row per schema above>" ],
  "_source": "runTopKBacktests | runStrategyBatch"
}
```

### 2.3 Producers

| File | Produces contract |
|------|-------------------|
| `engine/batch/runTopKBacktests.js` | Yes; must add requiredCandles, loadedCandles, coverageRatio, backtestInvalid, invalidReason, rules (from setup), datasetVersionId if available. |
| `engine/batch/runStrategyBatch.js` | Must produce same shape if implemented; else deprecated. |

### 2.4 Consumers

| File | Consumes | Rule |
|------|----------|------|
| `engine/meta/runMetaPipeline.js` | batch_results/*.json | In groupResultsBySetup: skip rows where raw.backtestInvalid === true. Merge only valid rows into bySetup. Propagate raw.rules into buildStrategiesForMeta. |
| `engine/meta/strategyReturnCorrelation.js` | batch results | buildReturnSeriesMap: only use rows where backtestInvalid !== true. |
| `engine/evolution/strategyEvolution.js` | meta_ranking.json (from meta) | Indirect; meta already filtered. Registry can store validation_level if we add it. |
| `engine/evolution/familyExpansionEngine.js` | meta_ranking / strategy_families | Only expand strategies that have rules; no inferRulesFromStrategy for child generation. |

### 2.5 Migration

1. **Add contract module:** Create `engine/contracts/researchResultContract.js` with `REQUIRED_CANDLES_DEFAULT`, `COVERAGE_THRESHOLD = 0.8`, `shapeResultRow(row, { requiredCandles, loadedCandles, datasetVersionId })`, `isValidResult(row)`.
2. **runTopKBacktests:** In runOneBacktest, compute requiredCandles from feature matrix or options (e.g. 252 * barsPerDay for 1y); set loadedCandles = candles.length; coverageRatio = loadedCandles/requiredCandles; backtestInvalid = coverageRatio < 0.8; invalidReason = backtestInvalid ? 'coverage_below_80' : null. Attach rules from setup. Ensure every result has rules (from setup.rules). Write to outPath with _source: 'runTopKBacktests'.
3. **runMetaPipeline:** In groupResultsBySetup loop, after pushing to bySetup, do not push if (r.backtestInvalid === true). In buildStrategiesForMeta, set strategy.rules = entries[0].raw.rules || null so meta_ranking strategies carry rules.
4. **runStrategyBatch:** Either (a) implement: load OHLC once, for each setup load rules from file, call same backtest logic as runTopKBacktests (or shared runOneBacktest), emit contract-shaped rows with validity; or (b) remove from runFullPipelineExpanded.sh and any other callers and document.

---

## SECTION 3 — STRATEGY OBJECT MODEL

### 3.1 Canonical strategy object (strategy document)

Used in memory and in persisted artifacts (meta_ranking, champion_registry). Not a separate DB; it is the shape of a row in meta_ranking and the enriched view for registry/portfolio.

```javascript
{
  setupId: string,
  name: string | null,
  rules: object,                    // canonical rules
  lineage: {
    parentSetupId: string | null,
    parentFamilyId: string | null,
    parentSnapshotId: string | null,
    generation: number,
    mutationType: string | null,
  },
  mutation_metadata: {
    mutationType: string | null,
    source: string,
  },
  validation_state: {
    backtestValid: boolean,
    oosPassed: boolean | null,
    walkForwardPassed: boolean | null,
    lastValidationAt: string | null,
  },
  deployment_status: 'discovered' | 'validated' | 'challenger' | 'core' | 'retired' | 'archived',
  research_status: 'active' | 'paused' | 'archived',
  tags: string[],
  regime: string | null,
  family: string | null,
  familyKey: string | null,
  source: string,
  historical_metrics: {
    expectancy: number | null,
    trades: number,
    winRate: number | null,
    meta_score: number | null,
    cross_asset_score: number | null,
    timeframe_stability_score: number | null,
    beatsParentRate: number | null,
    avgParentVsChildScore: number | null,
    lastSeenAt: string | null,
  },
}
```

### 3.2 Where created

- **Discovery path:** In runTopKBacktests, each result row is contract-shaped; it is not yet a full strategy document. Full strategy document is built in **runMetaPipeline** in buildStrategiesForMeta (one per setupId from aggregated batch results). Enrich with rules, lineage, validation_state (backtestValid from raw.backtestInvalid === false), deployment_status default 'discovered'.
- **runMetaPipeline buildStrategiesForMeta:** For each setupId, set strategy.rules = from first valid entry raw.rules; set strategy.lineage = { parentSetupId, parentFamilyId, generation, mutationType }; set strategy.validation_state = { backtestValid: true for rows we kept (we already filtered invalid), oosPassed: null, walkForwardPassed: null }; set strategy.deployment_status = 'discovered'; set historical_metrics from aggregated expectancy, trades, meta_score, etc.
- **strategyEvolution buildRegistryEntries:** Enrich with deployment_status from status (champion → core/validated); add beatsParentRate, avgParentVsChildScore to historical_metrics in registry.

### 3.3 Where enriched

- **runMetaPipeline:** After buildStrategiesForMeta, annotateParentVsChild adds parent_vs_child fields. clusterAndFilter adds familyKey. enrichAndSortByPortfolioScore adds registry metrics (beatsParentRate, adjustedSurvivalScore). selectCoreAndChallengers + selectDiversifiedPortfolio: selected strategies are the ones that get deployment_status implied by core vs challenger (core = non-child or graduated, challenger = child in challenger slot).
- **strategyEvolution:** Registry entries are the persisted "champion" view; status (champion/validated/candidate) maps to deployment_status.

### 3.4 Where persisted

- **meta_ranking.json:** strategies array = top N ranked strategies; each element must include rules, lineage, validation_state, historical_metrics (meta_score, expectancy, trades, etc.). Add fields in buildStrategiesForMeta and writeMetaRanking.
- **champion_registry.json:** champions array = registry entries; already have setupId, status, survivalScore, beatsParentRate, etc. Add deployment_status and validation_level if we add OOS/walk-forward later.
- **strategy_portfolio.json:** Selected portfolio strategies; already a subset of meta; ensure they carry rules and lineage for audit.

### 3.5 Where repo loses information today

- **Batch results:** runTopKBacktests already has rules on the result row; runStrategyBatch stub has no rules. So batch path loses rules.
- **groupResultsBySetup:** Pushes raw into entries; if we filter by backtestInvalid we don't lose. We currently don't propagate rules to buildStrategiesForMeta strategy object; we only pass raw. So strategy.rules is missing in meta_ranking today.
- **familyExpansionEngine:** Reads meta_ranking strategies; if strategies don't have .rules it falls back to inferRulesFromStrategy. So persisting rules in meta_ranking and buildStrategiesForMeta fixes the loss.

### 3.6 File-by-file implementation

| File | Change |
|------|--------|
| `engine/contracts/strategyObjectContract.js` | NEW: `toStrategyDocument(metaRow, registryEntry?)` returns object per schema; `defaultValidationState()`, `defaultDeploymentStatus()`. |
| `engine/meta/runMetaPipeline.js` | In buildStrategiesForMeta: set strategy.rules = entries[0].raw.rules; set strategy.lineage = { parentSetupId, parentFamilyId, generation, mutationType }; set strategy.validation_state = { backtestValid: true, oosPassed: null, walkForwardPassed: null }; set strategy.deployment_status = 'discovered'; set strategy.historical_metrics from averages. |
| `engine/evolution/strategyEvolution.js` | When building registry entries, add deployment_status from status (champion → 'core', validated → 'validated', candidate → 'challenger' or 'discovered'). Optionally merge strategy document fields from meta if we load meta there. |
| `engine/evolution/familyExpansionEngine.js` | When loading base strategies, require strategy.rules; if missing, skip that strategy and log; use strategy.rules for generateFamilyExpansions; remove use of inferRulesFromStrategy for expansion (keep function only for legacy display or fallback when rules absent). |

---

## SECTION 4 — FILE-BY-FILE REPO PLAN

### 4.1 engine/discovery/runTwoStageDiscovery.js

- **Current role:** Load candles, build feature matrix, build parameter grid + load generated strategies, fast vector scan, prune top K, run runTopKBacktests with candles and featureMatrix, write batch results.
- **Wrong/incomplete:** Does not pass requiredCandles or datasetVersionId; does not ensure backtest contract on results; no experimentId.
- **Exact modifications:** (1) After loadCandlesForDataGroup, call datasetVersionTracker.registerDataset(symbol, timeframe, pathOrKey, candles.length, dateRange) and get datasetVersionId (or pass through if governance not yet run). (2) Compute requiredCandles = e.g. Math.max(252 * 78, candles.length) for 5m (78 bars/day) or from options. (3) Pass { candles, featureMatrix, requiredCandles, datasetVersionId, outPath } to runTopKBacktests. (4) Optionally start experiment via experimentRegistry.startExperiment({ stage: 'discovery', dataGroup, symbol, timeframe }) and pass experimentId to runTopKBacktests so batch file includes experimentId.
- **New inputs/outputs:** runTopKBacktests opts: requiredCandles, datasetVersionId, experimentId. No change to return value of runTwoStageDiscovery.

### 4.2 engine/discovery/loadGeneratedStrategyFiles.js

- **Current role:** Load setup_*.js from dir, filter by prefix, require and extract name + rules; dedupe; return array of { setupId, name, rules, ... }.
- **Wrong/incomplete:** None critical; ensures strategies have rules when loaded from files.
- **Exact modifications:** Ensure every returned setup has rules (from mod.rules or {}). If mod has no rules, still return but caller (runTwoStageDiscovery) may use; familyExpansionEngine will skip expansion when parent has no rules. No contract change.
- **Call new helpers:** No.

### 4.3 engine/batch/runTopKBacktests.js

- **Current role:** Run one backtest per setup (runOneBacktest) when candles and featureMatrix provided; else stub. Write strategy_batch_results_<SYMBOL>_<TF>.json with results.
- **Wrong/incomplete:** No requiredCandles, loadedCandles, coverageRatio, backtestInvalid; rules are on result but not guaranteed; stub path returns _stub: true.
- **Exact modifications:** (1) runOneBacktest: accept opts.requiredCandles, opts.loadedCandles (or derive from candles.length). Compute coverageRatio = loadedCandles/requiredCandles; backtestInvalid = coverageRatio < (opts.coverageThreshold ?? 0.8); invalidReason = backtestInvalid ? 'coverage_below_80' : null. Add to out: requiredCandles, loadedCandles, coverageRatio, backtestInvalid, invalidReason, rules: setup.rules || {}, symbol, timeframe, dataGroup from opts, datasetVersionId from opts, generatedAt. (2) runTopKBacktests: pass requiredCandles, loadedCandles (candles.length), datasetVersionId, dataGroup, symbol, timeframe into each runOneBacktest (or runInParallel callback). (3) Stub path: either remove or emit same shape with backtestInvalid: true, invalidReason: 'stub_no_data'. (4) Require engine/contracts/researchResultContract and optionally call shapeResultRow there for consistency.
- **New inputs:** opts.requiredCandles, opts.loadedCandles, opts.datasetVersionId, opts.symbol, opts.timeframe, opts.dataGroup, opts.experimentId, opts.coverageThreshold.
- **New outputs:** Each result row includes all contract fields.

### 4.4 engine/batch/runStrategyBatch.js

- **Current role:** List setup_*.js from dir, return stub results (expectancy null, trades 0, _stub: true), write strategy_batch_results.json.
- **Wrong/incomplete:** Stub; no real backtest; any consumer gets wrong metrics.
- **Exact modifications:** **Option A (implement):** Load dataset by dataGroup (reuse datasetBatchLoader or runTwoStageDiscovery.loadCandlesForDataGroup), build feature matrix once, for each setup load rules from file, run same runOneBacktest logic (from runTopKBacktests or extracted to shared module), emit contract-shaped results with validity; write to batch_results with _source: 'runStrategyBatch'. **Option B (deprecate):** Remove from runFullPipelineExpanded.sh; do not call runStrategyBatch in any script; add comment at top "DEPRECATED: batch results come only from two-stage discovery"; leave file returning stub for backward compat but document that results must not be used for ranking.
- **Recommendation:** Option B for Phase 1; Option A only if a separate batch-from-files path is required later.

### 4.5 engine/meta/runMetaPipeline.js

- **Current role:** List batch files, groupResultsBySetup, buildStrategiesForMeta, computeMetaRanking, annotateParentVsChild, clusterAndFilter, load champion registry, enrichAndSortByPortfolioScore, selectCoreAndChallengers, selectDiversifiedPortfolio, buildChampionPortfolio, applyCashDeploymentPolicy, write meta_ranking.json and strategy_portfolio.json.
- **Wrong/incomplete:** Does not filter by backtestInvalid; does not attach rules to strategy object in buildStrategiesForMeta; no experimentId in written artifacts.
- **Exact modifications:** (1) In groupResultsBySetup, when iterating json.results, skip r if r.backtestInvalid === true (do not push to bySetup for that r). (2) In buildStrategiesForMeta, for each strategy set strategy.rules = entries[0].raw.rules ?? null; set strategy.lineage = { parentSetupId, parentFamilyId, generation, mutationType }; set strategy.validation_state = { backtestValid: true, oosPassed: null, walkForwardPassed: null }; set strategy.deployment_status = 'discovered'; set strategy.historical_metrics = { expectancy, trades, winRate, meta_score (later), cross_asset_score, timeframe_stability_score, lastSeenAt: generatedAt }. (3) writeMetaRanking: add experimentId to payload if provided in opts. (4) runMetaPipeline(opts): accept opts.experimentId, opts.filterInvalid = true (default true).
- **Call new helpers:** Optional: require engine/contracts/strategyObjectContract and use toStrategyDocument in buildStrategiesForMeta for consistency.
- **New inputs:** opts.experimentId, opts.filterInvalid.
- **New outputs:** meta_ranking strategies include rules, lineage, validation_state, deployment_status, historical_metrics.

### 4.6 engine/meta/championPortfolioBuilder.js

- **Current role:** buildChampionPortfolio(strategies, opts): normalize weights by meta_score or portfolio_score or expectancy, apply caps, allow cash buffer.
- **Wrong/incomplete:** None critical; works on strategy rows that already have portfolio_score from runMetaPipeline.
- **Exact modifications:** No change for Phase 1. Later: optionally filter strategies by validation_state.oosPassed if we add it.
- **New inputs/outputs:** None.

### 4.7 engine/meta/strategyCorrelation.js

- **Current role:** Structural similarity, selectDiversifiedPortfolio with correlation penalty.
- **Wrong/incomplete:** Uses strategy.rules when present; no change needed for contract.
- **Exact modifications:** Ensure we do not select strategies that have backtestInvalid (they are already filtered in meta). No code change if meta filters.
- **New inputs/outputs:** None.

### 4.8 engine/meta/strategyReturnCorrelation.js

- **Current role:** buildReturnSeriesMap(batchFiles), computeReturnCorrelationMatrix; used by runMetaPipeline for diversification.
- **Wrong/incomplete:** If batch files contain invalid rows, we might still use them for return series; could bias correlation.
- **Exact modifications:** In buildReturnSeriesMap, when iterating batch.results, skip r if r.backtestInvalid === true. Only aggregate tradeReturns from valid rows.
- **New inputs/outputs:** None.

### 4.9 engine/evolution/familyExpansionEngine.js

- **Current role:** Load meta_ranking or strategy_families, cluster, take top families, for each base strategy generate variants (session_flip, regime_flip, etc.), filter by familyKey uniqueness, write setup_familyexp_*.js.
- **Wrong/incomplete:** Uses inferRulesFromStrategy(baseStrategy) when baseStrategy.rules missing; children then not true mutations of parent.
- **Exact modifications:** (1) In generateFamilyExpansions, use only baseStrategy.rules. If !baseStrategy.rules, return [] and log "skip expansion: no rules for setupId". (2) When loading base strategies (loadInputUniverse), filter to strategies that have rules (strategy.rules && typeof strategy.rules === 'object'). (3) Read discovery/mutation_policy.json if present; if present, use mutationTypeWeights to bias which mutation types to generate (e.g. more session_flip if session_flip has high beats_parent rate). (4) Export or keep inferRulesFromStrategy only for legacy logging/display; do not call it for generating child rules.
- **New inputs:** Path to mutation_policy.json (dataRoot.getPath('discovery') + '/mutation_policy.json'). (5) Optional: maxChildrenPerFamily from supervisor_config.
- **New outputs:** Same; generated strategy files with rules and parent refs.

### 4.10 engine/evolution/strategyEvolution.js

- **Current role:** Load meta_ranking as history, buildRegistryEntries (survival score, beatsParentRate, lineageDepth), write champion_registry.json.
- **Wrong/incomplete:** No experimentId or cycle_id in registry for audit.
- **Exact modifications:** (1) runEvolution: accept opts.experimentId; write registry.generatedAt, registry.experimentId = opts.experimentId. (2) buildRegistryEntries: add deployment_status: e.status === 'champion' ? 'core' : e.status === 'validated' ? 'validated' : 'challenger' (or 'discovered') to each entry.
- **New inputs:** opts.experimentId.
- **New outputs:** champion_registry.json includes experimentId; each champion entry includes deployment_status.

### 4.11 engine/scripts/runFullPipelineExpanded.sh

- **Current role:** 1) Run expanded data engine; 2) For each symbol/timeframe run csvToBinary and runTwoStageDiscovery; 3) runMetaPipeline; 4) family expansion; 5) strategy evolution; 6) paper reload.
- **Wrong/incomplete:** No experiment id; no supervisor; no governance.
- **Exact modifications:** (1) Before step 2, run a Node one-liner or small script that calls experimentRegistry.startExperiment(configSnapshot) and exports EXPERIMENT_ID for the rest of the run (or write to a temp file and read in Node steps). (2) After step 3 (meta), run supervisor: node engine/supervisor/researchSupervisor.js (or with path to discovery dir). Supervisor reads meta_ranking, registry, mutation_policy, writes discovery/supervisor_config.json. (3) Before step 4, if supervisor_config.cycle_valid === false, skip family expansion and optionally skip evolution (or run evolution but log warning). (4) Pass EXPERIMENT_ID to runMetaPipeline and strategyEvolution (via env or config file). (5) After step 2, register dataset versions for each symbol/timeframe that was loaded (or do this inside runTwoStageDiscovery). (6) After pipeline, append experiment artifacts via experimentRegistry.appendArtifact(experimentId, 'meta', metaPath), etc.
- **New inputs:** None from user; script uses new modules.
- **New outputs:** governance/experiment_registry.json updated; discovery/supervisor_config.json written.

### 4.12 engine/loop/runContinuousResearch.js

- **Current role:** Loop: run script (runFullPipelineExpanded.sh or runGlobalPipeline.sh), sleep, repeat; write loop_runs logs.
- **Wrong/incomplete:** None for Phase 1–2.
- **Exact modifications:** No change for Phase 1. Phase 3: optionally pass --experiment or read supervisor_config to log cycle_valid in loop_runs.
- **New inputs/outputs:** None initially.

---

## SECTION 5 — NEW MODULES TO CREATE

### 5.1 engine/contracts/researchResultContract.js

- **Why:** Single source of truth for result row shape and validity; all producers use it so consumers can rely on backtestInvalid and rules.
- **Exports:** COVERAGE_THRESHOLD (0.8), REQUIRED_CANDLES_DEFAULT, shapeResultRow(row, { requiredCandles, loadedCandles, datasetVersionId, symbol, timeframe, dataGroup }), isValidResult(row).
- **Inputs:** row (partial), options object.
- **Outputs:** Full result row object; isValidResult returns boolean.
- **Callers:** runTopKBacktests, runStrategyBatch (if implemented), runMetaPipeline (isValidResult when filtering).

### 5.2 engine/contracts/strategyObjectContract.js

- **Why:** Canonical strategy document shape; meta and registry can build the same structure for expansion and audit.
- **Exports:** toStrategyDocument(metaRow, registryEntry?), defaultValidationState(), defaultDeploymentStatus(), REQUIRED_RULES_KEYS.
- **Inputs:** metaRow (from buildStrategiesForMeta), optional registryEntry.
- **Outputs:** Strategy document object.
- **Callers:** runMetaPipeline buildStrategiesForMeta (optional), familyExpansionEngine (when checking strategy.rules), documentation.

### 5.3 engine/validation/backtestValidity.js

- **Why:** Central place for coverage and validity so runTopKBacktests and any batch path share the same rule.
- **Exports:** computeCoverage(loadedCandles, requiredCandles), isBacktestValid(row, threshold?), getInvalidReason(row, threshold?).
- **Inputs:** row or loadedCandles/requiredCandles.
- **Outputs:** number (ratio), boolean, string | null.
- **Callers:** runTopKBacktests, researchResultContract (internally or vice versa), runMetaPipeline when filtering.

### 5.4 engine/validation/walkForwardValidator.js

- **Why:** Walk-forward validation for promotion gate; currently walkForwardTest.js is stub.
- **Exports:** runWalkForward(setupId, rules, dataGroup, opts), splitTrainTest(candles, trainRatioOrDates). opts: trainYears, testYear or trainEndDate, testEndDate.
- **Inputs:** setupId, rules, dataGroup (or dataset definitions), opts.
- **Outputs:** { trainExpectancy, testExpectancy, survived: boolean, valid: boolean }.
- **Callers:** Validation layer (Phase 2 or 3); meta or evolution when deciding promotion. Not called in Phase 1.
- **Note:** Replace engine/validation/walkForwardTest.js; implement in new file walkForwardValidator.js and deprecate walkForwardTest.js.

### 5.5 engine/evolution/mutationIntelligence.js

- **Why:** Aggregate beats_parent and metrics by mutationType (and optionally family); write mutation_policy.json so familyExpansionEngine can weight mutation types.
- **Exports:** aggregateMutationStats(metaRanking, registry), computeMutationPolicy(stats, opts), writeMutationPolicy(outPath, policy). stats: { byMutationType: { [type]: { beatsParent, total, avgDeltaMeta } } }. policy: { byMutationType: { [type]: weight }, generatedAt }.
- **Inputs:** meta_ranking strategies (with beats_parent, mutationType), champion_registry entries.
- **Outputs:** policy object; write to discovery/mutation_policy.json.
- **Callers:** runMetaPipeline (after writing meta_ranking) or runFullPipelineExpanded.sh after meta step; familyExpansionEngine reads the file.

### 5.6 engine/supervisor/researchSupervisor.js

- **Why:** Single place that reads state (meta, registry, batch, mutation policy, dataset versions) and writes decisions (mutation budget, families to expand, cash hold, cycle_valid).
- **Exports:** run(config), readState(config), computeDecisions(state), writeSupervisorConfig(outPath, decisions).
- **Inputs:** config = { discoveryDir, championDir, batchDir, governanceDir }.
- **Outputs:** Writes discovery/supervisor_config.json. Returns { cycle_valid, mutationBudget, familiesToExpand, mutationTypeWeights, holdCash, degradedReason }.
- **Callers:** runFullPipelineExpanded.sh (after meta).
- **Decisions:** (1) number of mutations: from mutationBudget (default or from prior beats_parent rate). (2) which families to expand: familiesToExpand (list or "all"). (3) mutation-type weighting: mutationTypeWeights (read from mutation_policy or default). (4) challenger deployment: not in supervisor initially; portfolio already has challenger slots. (5) hold more cash: holdCash boolean if degradedReason set. (6) cycle degraded: cycle_valid = false if e.g. too many invalid batch results or data quality alert.
- **Schema supervisor_config.json:** { generatedAt, cycle_valid, degradedReason?: string, mutationBudget?: number, familiesToExpand?: string[], mutationTypeWeights?: { [type]: number }, holdCash?: boolean }.

### 5.7 engine/governance/experimentRegistry.js

- **Why:** Every run is an experiment; link config, dataset versions, and artifact paths for reproducibility and audit.
- **Exports:** startExperiment(configSnapshot) → experimentId, appendArtifact(experimentId, stage, artifactPathOrPayload), getExperiment(experimentId), listExperiments(limit).
- **Inputs:** configSnapshot object; experimentId; stage string (discovery, meta, evolution, portfolio); artifact path or payload.
- **Outputs:** experimentId (uuid or timestamp-based); append to governance/experiment_registry.json. Schema: { experiments: [ { experimentId, startedAt, configSnapshot, artifacts: [ { stage, pathOrPayload, at } ], valid?: boolean } ] }.
- **Callers:** runFullPipelineExpanded.sh (start at beginning; append after each stage).

### 5.8 engine/governance/datasetVersionTracker.js

- **Why:** Track dataset version so results can reference "which data this backtest used."
- **Exports:** registerDataset(symbol, timeframe, pathOrKey, candleCount, dateRange?) → datasetVersionId, getVersionId(pathOrKey), getVersion(versionId).
- **Inputs:** symbol, timeframe, path or key, candleCount, optional dateRange.
- **Outputs:** datasetVersionId (e.g. hash of path+mtime+candleCount or incremental id). Writes governance/dataset_versions.json. Schema: { versions: [ { datasetVersionId, symbol, timeframe, pathOrKey, candleCount, dateRange, registeredAt } ] }.
- **Callers:** runTwoStageDiscovery after loading candles; runStrategyBatch if implemented.

### 5.9 engine/meta/adaptiveAllocator.js

- **Assessment:** Optional. Would suggest allocation tweaks from supervisor and registry. Defer to Phase 3; not required for correctness. **Do not create in Phase 1–2.**

### 5.10 engine/research/researchMetrics.js

- **Assessment:** Optional. Aggregate run metrics (valid/invalid counts, by mutationType). Can be inlined in supervisor or runMetaPipeline. **Do not create in Phase 1;** add in Phase 3 if needed.

### 5.11 Renames/merges

- **walkForwardTest.js → walkForwardValidator.js:** Implement real logic in walkForwardValidator.js; keep walkForwardTest.js as deprecated stub that requires walkForwardValidator.
- **mutationIntelligence.js** in engine/evolution/ (not engine/evolution/mutation/) to avoid extra dir; single file.

---

## SECTION 6 — JSON ARTIFACTS AND STATE FILES

| File path | Producer | Consumers | Schema summary | Retention |
|-----------|----------|-----------|----------------|-----------|
| discovery/meta_ranking.json | runMetaPipeline | familyExpansionEngine, strategyEvolution, supervisor | generatedAt, count, strategies[], batchFiles, totalStrategiesRanked, topN. Each strategy: setupId, rules, lineage, validation_state, deployment_status, historical_metrics, meta_score, expectancy, trades, winRate, byAsset, byTimeframe, parentSetupId, beats_parent, etc. | Cycle state; overwritten each run. |
| discovery/strategy_portfolio.json | runMetaPipeline | Paper reload, execution gate, dashboard | portfolio with strategies[], allocation_weight, cash_weight, cash_policy, correlation_summary, portfolio_composition | Cycle state; overwritten each run. |
| discovery/strategy_families.json | runMetaPipeline (or clusterStrategyFamilies) / familyExpansionEngine read | familyExpansionEngine | strategies[] with familyKey, cluster info | Cycle state. |
| discovery/family_expansion_report.json | familyExpansionEngine | Audit, supervisor (optional) | report of expanded families, counts, written files | Cycle state. |
| champion_setups/champion_registry.json | strategyEvolution | runMetaPipeline (loadChampionRegistrySync), paper reload, supervisor | generatedAt, experimentId?, source, champions[], setupsCount, championsCount. Each entry: setupId, status, survivalScore, beatsParentRate, deployment_status?, etc. | Historical registry; appended/updated each run. |
| discovery/mutation_policy.json | mutationIntelligence (new) | familyExpansionEngine | generatedAt, byMutationType: { [type]: weight } | Cycle state; overwritten each run. |
| discovery/supervisor_config.json | researchSupervisor | runFullPipelineExpanded.sh, familyExpansionEngine (optional) | generatedAt, cycle_valid, degradedReason?, mutationBudget?, familiesToExpand?, mutationTypeWeights?, holdCash? | Cycle state; overwritten each run. |
| discovery/research_metrics.json | Optional (Phase 3) | Supervisor, dashboard | validCount, invalidCount, byMutationType, etc. | Cycle state. |
| governance/experiment_registry.json | experimentRegistry | Audit, reproduce | experiments[]: experimentId, startedAt, configSnapshot, artifacts[] | Historical registry; append-only. |
| governance/dataset_versions.json | datasetVersionTracker | runTopKBacktests (attach versionId to results) | versions[]: datasetVersionId, symbol, timeframe, pathOrKey, candleCount, dateRange, registeredAt | Historical registry; append. |
| batch_results/strategy_batch_results_<SYM>_<TF>.json | runTopKBacktests | runMetaPipeline (listBatchFiles, groupResultsBySetup), strategyReturnCorrelation | dataGroup, generatedAt, experimentId?, results[] (contract shape), _source | Cycle state; one file per symbol/timeframe. |

**Classification:**

- **Ephemeral:** None; all written to disk.
- **Cycle state:** meta_ranking, strategy_portfolio, strategy_families, family_expansion_report, mutation_policy, supervisor_config. Overwritten each pipeline run.
- **Historical registry:** champion_registry (updated), experiment_registry (append), dataset_versions (append).
- **Audit artifact:** experiment_registry, dataset_versions; champion_registry for "who was champion when."
- **Deployment input:** strategy_portfolio, champion_registry (paper reload, execution gate).

---

## SECTION 7 — WALK-FORWARD IMPLEMENTATION PLAN

### 7.1 Where split happens

- **File:** engine/validation/walkForwardValidator.js (new).
- **Split:** By date or by bar index. For 5m data, e.g. train = candles where time < testStartMs, test = candles where time >= testStartMs. Or trainRatio 0.8 → last 20% as test.
- **When:** After discovery and meta ranking. Walk-forward is a separate validation stage: for each strategy that is a candidate for promotion (e.g. in top N or in challenger pool), run runWalkForward(strategy.setupId, strategy.rules, dataGroup, { trainEndDate, testEndDate }).

### 7.2 Before or after discovery

- **After discovery.** Discovery and meta run on full in-sample data (or single train window). Walk-forward runs as a separate step on strategies that already have rules and in-sample metrics; we then run backtest on train window and test window with same rules.

### 7.3 How training vs validation metrics are stored

- **Storage:** In walkForwardValidator return value: { trainExpectancy, testExpectancy, survived, valid }. Optionally append to strategy.validation_state: walkForwardPassed, walkForwardTrainExpectancy, walkForwardTestExpectancy, walkForwardAt. Persist in meta_ranking or in a separate validation_results.json keyed by setupId and experimentId.
- **Schema addition:** strategy.validation_state.walkForwardPassed: boolean | null, walkForwardTrainExpectancy: number | null, walkForwardTestExpectancy: number | null, walkForwardAt: string | null.

### 7.4 Fields added to results

- In strategy document (meta_ranking): validation_state.oosPassed, validation_state.walkForwardPassed, validation_state.walkForwardTrainExpectancy, validation_state.walkForwardTestExpectancy.
- In champion_registry entry: validation_level: 'in_sample' | 'oos' | 'walk_forward' when we have that info.

### 7.5 How meta ranking treats non-validated strategies

- **Phase 1:** Meta ranking does not filter by OOS or walk-forward; all strategies with backtestValid true are ranked.
- **Phase 2:** Add optional filter: only strategies with validation_state.oosPassed === true can enter "deployment portfolio" (core + challengers). Meta ranking still shows all; portfolio selection filters.
- **Phase 3:** Walk-forward passed required for core; challenger can be in_sample or OOS.

### 7.6 How evolution treats them

- strategyEvolution uses meta_ranking as input; if meta_ranking includes validation_state, registry can store validation_level. Promotion to champion (core) can require oosPassed or walkForwardPassed in a later phase.

### 7.7 How portfolio construction treats them

- filterChampionSetups or selectCoreAndChallengers: only strategies with validation_state.oosPassed === true (and optionally walkForwardPassed for core) get allocation. Others are excluded from strategy_portfolio.

### 7.8 Repo integration sequence

1. Implement walkForwardValidator.js: splitTrainTest(candles, opts), runWalkForward(setupId, rules, dataGroup, opts). runWalkForward loads data (reuse datasetBatchLoader), splits, runs backtest (reuse runOneBacktest logic) on train and test, returns metrics and survived.
2. Add validation_state fields to buildStrategiesForMeta (oosPassed, walkForwardPassed null initially).
3. After runMetaPipeline, add a step: for each strategy in top N (or challenger pool), call runWalkForward; update strategy.validation_state. Write updated strategies back to meta_ranking or to a separate validation cache.
4. In selectCoreAndChallengers or in buildChampionPortfolio, filter to strategies where validation_state.walkForwardPassed === true (or oosPassed for challenger) when option enabled.
5. strategyEvolution: when building registry, set validation_level from strategy.validation_state.

---

## SECTION 8 — MUTATION INTELLIGENCE IMPLEMENTATION

### 8.1 Where mutation statistics come from

- **Source 1:** meta_ranking.json strategies: each has mutationType, beats_parent, parent_vs_child_score (from annotateParentVsChild).
- **Source 2:** champion_registry.json entries: beatsParentRate, avgParentVsChildScore, mutationType per setupId.
- **Aggregation:** mutationIntelligence.aggregateMutationStats(metaRanking, registry). Iterate meta strategies and registry entries; group by mutationType; for each type compute total comparisons, beats_parent count, avg delta meta (or avg parent_vs_child_score).

### 8.2 Aggregation by mutationType / family / regime / session

- **By mutationType:** Primary. byMutationType[type] = { total, beatsParent, avgDeltaMeta, avgExpectancyDelta }.
- **By family:** Optional Phase 3; same idea keyed by familyKey.
- **By regime/session:** Optional; can be derived from strategy.regime, strategy.session_phase (if we add to meta).

### 8.3 Where policy is written

- **File:** discovery/mutation_policy.json.
- **Producer:** mutationIntelligence.writeMutationPolicy(outPath, policy). policy = { generatedAt, byMutationType: { session_flip: 0.25, regime_flip: 0.2, ... } } with weights summing to 1 or normalized. Weights from aggregateMutationStats: higher weight for higher beats_parent rate (with smoothing).

### 8.4 How familyExpansionEngine reads policy

- **Read path:** dataRoot.getPath('discovery') + '/mutation_policy.json'. At start of expansion, safeReadJson(mutationPolicyPath). If present, use policy.byMutationType when generating variants: e.g. when choosing which mutation types to emit first or how many children per type, sample or iterate in order of weight.
- **Fallback:** If file missing, use current behavior (all mutation types equally).

### 8.5 How exploration budget changes from run to run

- **Supervisor** writes supervisor_config.json with mutationBudget (number of children to generate this run). familyExpansionEngine reads supervisor_config; if mutationBudget present, cap total generated children to that number (e.g. take top-weighted mutation types until budget exhausted).
- **Mutation type weighting:** mutation_policy.byMutationType drives which types get more children; mutationBudget drives total count.

### 8.6 Exact file paths

- **Read:** engine/evolution/mutationIntelligence.js reads nothing from disk for aggregation; it receives metaRanking and registry in memory (caller loads meta_ranking.json and champion_registry.json).
- **Write:** mutationIntelligence.writeMutationPolicy(dataRoot.getPath('discovery') + '/mutation_policy.json', policy).
- **familyExpansionEngine:** path.join(dataRoot.getPath('discovery'), 'mutation_policy.json').

### 8.7 Exact JSON output shape (mutation_policy.json)

```json
{
  "generatedAt": "ISO8601",
  "byMutationType": {
    "session_flip": 0.22,
    "regime_flip": 0.18,
    "aggressive_profile": 0.15,
    "conservative_profile": 0.12,
    "hybrid_family_shift": 0.2,
    "aggressive_family_shift": 0.13
  }
}
```

### 8.8 Call chain in pipeline order

1. runFullPipelineExpanded.sh: after two-stage discovery (batch_results written).
2. runMetaPipeline: reads batch_results, writes meta_ranking.json (with rules, lineage, backtestInvalid filtered).
3. **New step:** node -e "const m = require('./engine/evolution/mutationIntelligence'); const meta = require('./discovery/meta_ranking.json'); const reg = require('./champion_setups/champion_registry.json'); const policy = m.computeMutationPolicy(m.aggregateMutationStats(meta.strategies, reg.champions)); m.writeMutationPolicy('./discovery/mutation_policy.json', policy);" (or a small script runMutationIntelligence.js that loads paths from dataRoot and writes).
4. researchSupervisor: reads meta_ranking, registry, mutation_policy; writes supervisor_config.json (including mutationBudget).
5. familyExpansionEngine: reads meta_ranking (or strategy_families), reads mutation_policy.json, reads supervisor_config.json; generates children using rules and policy weights; writes setup_familyexp_*.js.

---

## SECTION 9 — RESEARCH SUPERVISOR IMPLEMENTATION

### 9.1 Exact file path

- engine/supervisor/researchSupervisor.js

### 9.2 When it runs in runFullPipelineExpanded.sh

- After step 3 (Meta Pipeline), before step 4 (Family Expansion). Command: `"$NODE_BIN" engine/supervisor/researchSupervisor.js` (or with DISCOVERY_DIR, CHAMPION_DIR env).

### 9.3 What files it reads

- discovery/meta_ranking.json (strategies, count, batchFiles)
- champion_setups/champion_registry.json (champions, generatedAt)
- discovery/mutation_policy.json (optional; byMutationType)
- governance/experiment_registry.json (optional; last experiment valid flag)
- Batch result files: list batch_results/*.json, count total results and count where backtestInvalid === true. If invalid ratio > threshold, set cycle_valid = false.

### 9.4 What file it writes

- discovery/supervisor_config.json

### 9.5 Which pipeline stages consume that file

- runFullPipelineExpanded.sh: if supervisor_config.cycle_valid === false, skip family expansion (and optionally log "cycle degraded, skip expansion").
- familyExpansionEngine: optional; read supervisor_config for mutationBudget and familiesToExpand.

### 9.6 Decisions it controls

- **number of mutations:** mutationBudget (e.g. 30); from prior beats_parent rate or fixed.
- **which families to expand:** familiesToExpand: list of familyKeys or "all".
- **mutation-type weighting:** Copy from mutation_policy.byMutationType into supervisor_config for familyExpansionEngine.
- **challenger deployment permission:** Not in supervisor; portfolio already has challenger slots. Optional later: supervisor could set allowChallengerPromotion: false.
- **hold more cash:** holdCash: true if degradedReason set (e.g. many invalid results).
- **cycle degraded:** cycle_valid: false if e.g. (invalidCount / totalResults) > 0.2 or no meta strategies, or dataset coverage alert.

### 9.7 Supervisor config schema

```json
{
  "generatedAt": "ISO8601",
  "cycle_valid": true,
  "degradedReason": null,
  "mutationBudget": 40,
  "familiesToExpand": "all",
  "mutationTypeWeights": { "session_flip": 0.22, "regime_flip": 0.18, ... },
  "holdCash": false,
  "invalidResultRatio": 0.02,
  "totalResultsChecked": 150
}
```

---

## SECTION 10 — EXPERIMENT GOVERNANCE

### 10.1 How experiments are identified

- **experimentId:** UUID v4 or timestamp-based id (e.g. YYYYMMDD_HHmmss) generated in experimentRegistry.startExperiment(). Stored in experiment_registry.experiments[].experimentId.

### 10.2 How run configs are versioned

- **configSnapshot:** Object passed to startExperiment(configSnapshot). Snapshot can include: dataGroup list, symbol/timeframe list, topN, portfolioMax, EXPAND_FAMILIES, FAMILY_EXPANSION_MODE, etc. Stored in experiment_registry.experiments[].configSnapshot. No separate version id; each experiment has its config at start.

### 10.3 How dataset versions are tracked

- **datasetVersionTracker.registerDataset(...)** returns datasetVersionId. Stored in governance/dataset_versions.json. When runTwoStageDiscovery loads candles, it calls registerDataset and gets versionId; that versionId is written into batch result rows and can be stored in experiment artifacts (e.g. artifact payload: { batchFile, datasetVersionIds: [...] }).

### 10.4 How strategy generations are linked to experiment IDs

- **Batch results:** strategy_batch_results_*.json includes experimentId in root. So each result row is tied to an experiment via the file.
- **Meta ranking:** runMetaPipeline writes meta_ranking.json with experimentId in payload (if provided). So strategies in that run are tied to experimentId.
- **Champion registry:** strategyEvolution writes champion_registry.json with experimentId. So registry snapshot is tied to experiment.

### 10.5 How to reproduce a portfolio from a prior cycle

- **Lookup:** getExperiment(experimentId) returns configSnapshot and artifacts (paths to meta_ranking, strategy_portfolio, batch_results, champion_registry for that run).
- **Reproduce:** Re-run pipeline with same configSnapshot (same dataGroup, same topN, etc.). Data must be same version or re-register; then run discovery and meta. Optionally re-use same dataset version ids if data unchanged.
- **Append/update rules:** experiment_registry: append-only list of experiments. Each experiment: { experimentId, startedAt, configSnapshot, artifacts: [ { stage, pathOrPayload, at } ], valid }. dataset_versions: append when new dataset registered; getVersionId(path) returns latest or matching version.

### 10.6 Exact files

- governance/experiment_registry.json
- governance/dataset_versions.json

### 10.7 Exact fields (experiment_registry.json)

```json
{
  "experiments": [
    {
      "experimentId": "uuid-or-timestamp",
      "startedAt": "ISO8601",
      "configSnapshot": { "dataGroups": [], "topN": 20, "portfolioMax": 12, ... },
      "artifacts": [
        { "stage": "discovery", "pathOrPayload": "/path/to/batch_results/...", "at": "ISO8601" },
        { "stage": "meta", "pathOrPayload": "/path/to/discovery/meta_ranking.json", "at": "ISO8601" },
        { "stage": "portfolio", "pathOrPayload": "/path/to/discovery/strategy_portfolio.json", "at": "ISO8601" },
        { "stage": "registry", "pathOrPayload": "/path/to/champion_setups/champion_registry.json", "at": "ISO8601" }
      ],
      "valid": true
    }
  ]
}
```

### 10.8 Append/update rules

- **experiment_registry:** startExperiment pushes new experiment to experiments array. appendArtifact(experimentId, stage, pathOrPayload) finds experiment by id, pushes to artifacts array. File read-modify-write (lock or single writer in same process).
- **dataset_versions:** registerDataset appends to versions array; getVersionId looks up by pathOrKey (and optionally candleCount) and returns datasetVersionId.

---

## SECTION 11 — 30-DAY BUILD ORDER

### Phase 1: Research correctness (Days 1–10)

- **Goal:** Backtest contract and validity everywhere; no stub in critical path; meta and expansion use rules only.
- **Files touched:** engine/contracts/researchResultContract.js (NEW), engine/validation/backtestValidity.js (NEW), engine/dataRoot.js (add governance), engine/batch/runTopKBacktests.js, engine/meta/runMetaPipeline.js, engine/meta/strategyReturnCorrelation.js, engine/evolution/familyExpansionEngine.js, engine/batch/runStrategyBatch.js (deprecate or implement), engine/discovery/runTwoStageDiscovery.js (pass requiredCandles, datasetVersionId optional).
- **Key functions:** shapeResultRow, isValidResult, computeCoverage, isBacktestValid; runOneBacktest add validity fields; groupResultsBySetup filter backtestInvalid; buildStrategiesForMeta add rules, lineage, validation_state; familyExpansionEngine use only strategy.rules, skip if no rules.
- **Risk if skipped:** Invalid backtests ranked; expansion uses inferred rules; parent-child comparison meaningless.
- **Success criteria:** (1) Every batch result row has requiredCandles, loadedCandles, coverageRatio, backtestInvalid, rules. (2) Meta ranking excludes invalid rows and includes rules on each strategy. (3) Family expansion generates children only from strategies with rules; no inferRulesFromStrategy for expansion. (4) runStrategyBatch either removed from pipeline or implements contract.

### Phase 2: Evolution correctness (Days 11–18)

- **Goal:** Mutation intelligence and policy; strategy document shape; optional OOS/walk-forward stub or minimal implementation.
- **Files touched:** engine/evolution/mutationIntelligence.js (NEW), engine/contracts/strategyObjectContract.js (NEW), engine/meta/runMetaPipeline.js (strategy document fields), engine/evolution/familyExpansionEngine.js (read mutation_policy), engine/evolution/strategyEvolution.js (deployment_status, experimentId), discovery/mutation_policy.json (written by mutationIntelligence).
- **Key functions:** aggregateMutationStats, computeMutationPolicy, writeMutationPolicy; toStrategyDocument; buildStrategiesForMeta full strategy document; familyExpansionEngine read mutation_policy and weight mutation types.
- **Risk if skipped:** Evolution does not learn from mutation success; expansion remains blind.
- **Success criteria:** (1) mutation_policy.json written after meta; familyExpansionEngine uses it. (2) Meta strategies have full strategy document shape (rules, lineage, validation_state, deployment_status, historical_metrics). (3) Registry has deployment_status and experimentId.

### Phase 3: Supervisor and autonomous control (Days 19–24)

- **Goal:** Supervisor runs after meta; writes supervisor_config; pipeline respects cycle_valid and mutationBudget.
- **Files touched:** engine/supervisor/researchSupervisor.js (NEW), engine/scripts/runFullPipelineExpanded.sh, engine/evolution/familyExpansionEngine.js (read supervisor_config).
- **Key functions:** run(), readState(), computeDecisions(), writeSupervisorConfig(); script: start experiment, run supervisor, skip expansion if !cycle_valid, pass mutationBudget.
- **Risk if skipped:** No single brain; no circuit breaker on bad data or degraded cycle.
- **Success criteria:** (1) supervisor_config.json written each run. (2) If cycle_valid false, expansion skipped. (3) familyExpansionEngine respects mutationBudget from supervisor_config.

### Phase 4: Governance and hardening (Days 25–30)

- **Goal:** Experiment registry and dataset versioning; pipeline writes experimentId and artifacts; audit trail.
- **Files touched:** engine/governance/experimentRegistry.js (NEW), engine/governance/datasetVersionTracker.js (NEW), engine/scripts/runFullPipelineExpanded.sh, engine/discovery/runTwoStageDiscovery.js, engine/meta/runMetaPipeline.js, engine/evolution/strategyEvolution.js, engine/dataRoot.js (SUBDIRS governance).
- **Key functions:** startExperiment, appendArtifact, getExperiment; registerDataset, getVersionId; script: start experiment at beginning, append artifacts after each stage; runTwoStageDiscovery register dataset and pass datasetVersionId to runTopKBacktests; runMetaPipeline and strategyEvolution accept and write experimentId.
- **Risk if skipped:** Cannot reproduce or audit past runs; no dataset lineage.
- **Success criteria:** (1) Every run has experimentId; experiment_registry.json and dataset_versions.json updated. (2) Batch and meta and registry reference experimentId. (3) getExperiment(experimentId) returns config and artifact paths.

---

## SECTION 12 — WHAT TO DELETE, FREEZE, OR DEPRECATE

### Delete

- **Nothing** in Phase 1. Do not delete runStrategyBatch.js; deprecate or implement.

### Freeze

- **Flows that call runStrategyBatch.js and expect real metrics.** Ensure no script in runFullPipelineExpanded.sh or runGlobalPipeline.sh calls runStrategyBatch for ranking. If any script does, remove that call (freeze the path) until runStrategyBatch is implemented.

### Deprecate

- **inferRulesFromStrategy** for use in generating expansion children. Keep the function for legacy logging or for strategies that have no rules (return null or skip expansion).
- **engine/validation/walkForwardTest.js:** Replace with walkForwardValidator.js; add deprecation comment in walkForwardTest.js that points to walkForwardValidator.js.
- **runStrategyBatch.js** (if Option B): Add at top "DEPRECATED: batch results for ranking come only from two-stage discovery (runTwoStageDiscovery → runTopKBacktests). This file is stub; do not use for meta or evolution." Do not remove file so that any external caller does not break; but do not call from pipeline.

### Wrapped but left in place

- **runMetaPipeline groupResultsBySetup:** Add filter (backtestInvalid) inside the loop; keep rest of logic.
- **strategyReturnCorrelation buildReturnSeriesMap:** Add filter (skip invalid rows); keep rest.
- **familyExpansionEngine generateFamilyExpansions:** Use baseStrategy.rules only; if missing return []; keep inferRulesFromStrategy in file for non-expansion use only.

### Too dangerous to keep as-is

- **runStrategyBatch.js** returning stub and being used anywhere for ranking or evolution. **Must** either implement real backtest with contract and validity or be removed from all callers and marked deprecated. Current state: dangerous if any path uses its output for meta.

---

## SECTION 13 — FINAL CTO VERDICT

### 13.1 Most important architectural change to make first

**Introduce and enforce the single research result contract (requiredCandles, loadedCandles, coverageRatio, backtestInvalid, rules) in runTopKBacktests and runMetaPipeline, and filter out invalid results in meta and correlation.** Without this, every downstream decision (ranking, evolution, portfolio) can rest on invalid or incomplete data. Do this in Phase 1 before any new features.

### 13.2 Most dangerous illusion in the current system

**The illusion that "child beats parent" is a meaningful signal.** Today, children are often generated from inferRulesFromStrategy (heuristic reconstruction from setupId and coarse stats), not from the actual parent rules. So the comparison is not parent-vs-mutation-of-parent; it is parent-vs-something-else. The fix is to persist rules in batch and meta and use only stored rules for expansion. Until then, evolutionary metrics are not trustworthy.

### 13.3 Smallest set of changes that would most improve autonomy

1. **Validity contract and filter:** runTopKBacktests emits and runMetaPipeline filters on backtestInvalid; persist rules on every result row.
2. **Expansion from rules only:** familyExpansionEngine uses only strategy.rules; skip strategies without rules.
3. **Mutation policy and feedback:** mutationIntelligence aggregates by mutationType and writes mutation_policy.json; familyExpansionEngine reads it and weights mutation types. One closed loop.

### 13.4 What this repo would look like after the redesign

- **engine/contracts/** with researchResultContract and strategyObjectContract; **engine/validation/** with backtestValidity and walkForwardValidator; **engine/evolution/mutationIntelligence.js**; **engine/supervisor/researchSupervisor.js**; **engine/governance/experimentRegistry.js** and datasetVersionTracker.js.
- **data root:** governance/ (experiment_registry.json, dataset_versions.json); discovery/ (meta_ranking, strategy_portfolio, strategy_families, mutation_policy, supervisor_config); batch_results/ (contract-shaped results per symbol/timeframe); champion_setups/champion_registry with experimentId and deployment_status.
- **Pipeline:** Experiment start → discovery (with dataset version and validity) → meta (filter invalid, attach rules and strategy document) → mutation intelligence (write mutation_policy) → supervisor (write supervisor_config, cycle_valid) → family expansion (rules-only, policy-weighted) → evolution (registry with experimentId) → paper reload. Every run is an experiment; every result is valid or explicitly invalid; every strategy has rules and lineage; expansion and portfolio are defensible.

---

*End of implementation blueprint.*
