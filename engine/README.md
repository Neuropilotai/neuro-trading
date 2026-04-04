# NeuroPilot Quant Engine v1

Modular trading engine for multiple strategies driven by market regime.

## Structure

```
engine/
  features/          Feature Engine (OHLCV → feature object)
  regime/             Regime detection (features → regime + confidence)
  strategies/         Strategy selection (regime + features → strategy decision)
  execution/          Trade Decision Engine (strategy → trade decision)
  risk/               Risk Sizing Engine (trade + account → position size)
  journal/            Signal Journal (signal → flattened record)
  signalPipeline.js   Signal Pipeline Runner (orchestrator)
  backtestRunner.js    Backtest Harness / Replay Runner (bar-by-bar replay)
  performanceAnalyzer.js  Performance Analyzer (journal records → stats)
  strategyRanking.js     Strategy Ranking Engine (analysis → ranked strategies/regimes)
  adaptiveSelector.js   Adaptive Selector / Policy Layer (signal + ranking → allow/boost/penalize/block)
  adaptivePipeline.js   Policy-Aware Pipeline Runner (signal pipeline + adaptive selector)
  signalQualityGate.js  Signal Quality Gate (adaptive signal quality filters → pass/block)
  qualityGateCalibration.js Quality Gate Calibration (compare threshold configs via quality backtests)
  qualityAdaptivePipeline.js Quality-Aware Adaptive Pipeline (adaptive pipeline + quality gate)
  qualityAdaptiveBacktestRunner.js Quality-Aware Adaptive Backtest Runner (quality replay → records, analysis, ranking, report)
  breakoutConfirmationFilter.js Breakout Entry Confirmation Filter (trend_breakout one-bar confirmation → reduce false breakouts)
  breakoutStrengthFilter.js Breakout Strength Filter (trend_breakout candle body/close-in-extreme → reduce weak breakouts)
  researchReport.js     Research Report Generator (analysis + ranking + metadata → report)
  adaptiveBacktestRunner.js Policy-Aware Backtest Runner (adaptive pipeline replay → records, analysis, ranking, report)
  multiAssetRunner.js    Multi-Asset Research Runner (adaptive backtests across symbol/timeframe → summary)
  signalAdapter.js      Signal Adapter / Execution Bridge (adaptive signal → normalized payload)
  webhookBridge.js      Webhook Bridge (execution payload → webhook request object)
  datasetLoader.js     Dataset Loader / Research Input (JSON/CSV → normalized OHLCV)
  datasetBatchLoader.js Dataset Batch Loader (multiple files → array for multiAssetRunner)
  researchConfig.js    Research Config (default account, dataset groups, helpers)
  baselineStrategyConfig.js Baseline Strategy Profile (SPY 5m + trend_breakout, no filters; documented best baseline)
  runResearch.js       Research Run Script (definitions + account → load batch → multi-asset → summary)
  runResearchFromConfig.js Research Run From Config (group name → config datasets → runResearch)
  tradeSimulation.js     Trade Simulation / Outcome Engine (candles + allowed signals → trade outcomes + summary)
  localExecutionHarness.js Local Execution Harness (pipeline → webhook POST to local server)
  examplePipeline.js    Example: run full pipeline on synthetic data
  exampleBacktest.js     Example: run backtest replay on synthetic data
  examplePerformance.js  Example: backtest + performance analysis
  exampleRanking.js     Example: backtest + analysis + ranking
  exampleAdaptiveSelector.js Example: pipeline + ranking + adaptive policy
  exampleAdaptivePipeline.js Example: full adaptive pipeline (candles + ranking → one signal)
  exampleSignalQualityGate.js Example: adaptive signal quality gate checks
  exampleQualityGateCalibration.js Example: compare quality gate threshold configs
  exampleQualityAdaptivePipeline.js Example: quality-aware adaptive signal (adaptive + quality gate)
  exampleQualityAdaptiveBacktest.js Example: quality-aware adaptive backtest (quality replay → report)
  exampleResearchReport.js   Example: generate research report from analysis + ranking
  exampleAdaptiveBacktest.js Example: full adaptive backtest (candles → records, analysis, ranking, report)
  exampleMultiAssetRunner.js Example: multi-asset research (datasets → runs + summary)
  exampleSignalAdapter.js   Example: adaptive signal → execution payload
  exampleWebhookBridge.js   Example: payload → webhook request
  exampleDatasetLoader.js   Example: load JSON/CSV → normalized candles
  exampleDatasetBatchLoader.js Example: batch load datasets → multiAssetRunner input
  exampleRunResearch.js Example: run research (definitions → load → multi-asset → print summary)
  exampleRunResearchFromConfig.js Example: run research from group config + real ./data files
  exampleTradeSimulation.js Example: trade simulation from candles + allowed signals
  exampleTradeSimulationFromResearch.js Example: trade simulation from real research (symbol + timeframe + optional strategy)
  exampleTradeSimulationSweepR.js Example: R-multiple sweep (same signals, rMultiple = 1, 1.25, 1.5, 2)
  exampleResearchConfig.js Example: research config groups and helpers
  exampleLocalExecutionHarness.js Example: full pipeline + POST to local webhook
  validateLocalExecutionHarness.js End-to-end validation script (pipeline → POST → verify orderIntent/rejection)
```

## Feature Engine

**Input:** OHLCV candles (array of `{ open, high, low, close, volume }`), oldest first.

**Output:** Structured feature object, e.g.:

```js
{
  price: 2650,
  ema20: 2648,
  ema50: 2639,
  ema20Slope: 0.5,
  atr: 12,
  vwap: 2645.5,
  vwapDistance: 4.5,
  volumeSpike: true,
  rangeState: "normal",
  volatility: "high",
  regimeCandidate: "trend"
}
```

### Usage

```js
const { compute } = require('./engine/features');
const candles = [ /* OHLCV bars */ ];
const features = compute(candles);
// Optional: compute at specific bar index
const featuresAt = compute(candles, candles.length - 2);
// Optional: override periods/thresholds
const featuresCustom = compute(candles, candles.length - 1, { ema20Period: 21, atrPeriod: 14 });
```

### Indicators (modular)

Each indicator can be used standalone via `engine/features/indicators`:

- **ema** — Exponential moving average (value + slope)
- **atr** — Average True Range
- **vwap** — Volume-weighted average price and distance from VWAP
- **volumeSpike** — Current volume vs average (spike detection)
- **rangeState** — Compression / expansion vs recent range
- **volatilityRegime** — ATR% bands (low / medium / high)
- **regimeCandidate** — Trend vs range from price vs EMAs

### Extending

- Add new indicators under `features/indicators/` and register in `indicators/index.js`.
- Add new fields in `FeatureEngine.compute()` and pass through from your new indicator.
- Override `DEFAULT_OPTIONS` when calling `compute(candles, index, options)`.

---

## Signal Pipeline Runner

Single entry point that runs the full decision pipeline: **features → regime → strategy → trade decision → risk sizing**. Pure orchestration; no side effects; all stage outputs preserved.

**Inputs:** `candles` (OHLCV array), `account` (`{ equity, dailyPnL, openPositions }`), optional `options` per module, optional `index` (bar index for features, default last bar).

**Output:** One signal object:

```js
{
  shouldTrade: true,
  valid: true,
  features: { ... },
  regime: { regime: "TREND_UP", confidence: 0.8 },
  strategyDecision: { strategy: "trend_breakout", direction: "long", ... },
  tradeDecision: { shouldTrade: true, entryType: "market", stopModel: "atr", ... },
  sizingDecision: { shouldSize: true, riskAmount: 5, positionSize: 1.11, ... },
  reason: "Valid trend breakout long with risk-sized position"
}
```

If any stage fails (no trade or no sizing), `shouldTrade` and `valid` are false and `reason` explains why; all stage outputs are still present.

### Usage

```js
const { run } = require('./engine/signalPipeline');

const candles = [ /* OHLCV bars, oldest first */ ];
const account = { equity: 500, dailyPnL: 0, openPositions: 0 };
const signal = run(candles, account);

if (signal.valid) {
  // Use signal.tradeDecision, signal.sizingDecision for order construction
} else {
  // signal.reason explains failure; inspect signal.tradeDecision / signal.sizingDecision
}
```

### Per-module options

```js
run(candles, account, {
  features:   { ema20Period: 21, atrPeriod: 14 },
  regime:     { minConfidenceToAssign: 0.25 },
  strategies: { trend_breakout: { minRegimeConfidence: 0.4 } },
  execution:  { minConfidence: 0.5 },
  risk:       { riskPercent: 0.015, maxOpenPositions: 3 }
});
```

### Example script

```bash
node neuropilot_trading_v2/engine/examplePipeline.js
```

---

## Backtest Harness / Replay Runner

Replays historical OHLCV bar-by-bar: runs the full signal pipeline at each bar, converts each signal to a journal record, and returns a structured research result. **No trades placed; account is not mutated.** Signal research only.

**Inputs:** `candles`, `account`, `symbol`, `timeframe`, optional `options` (pipeline options, `startIndex`, `minBars`, `barTimestamp`).

**Output:**

```js
{
  totalBars: 500,
  totalSignals: 420,
  validSignals: 88,
  tradeableSignals: 72,
  noTradeSignals: 348,
  records: [ /* journal records, one per bar from startIndex to end */ ],
  summary: {
    byRegime:   { TREND_UP: 120, RANGE: 80, ... },
    byStrategy: { trend_breakout: 90, mean_reversion: 40, null: 290 },
    byDirection: { long: 45, short: 27, null: 348 }
  }
}
```

### Usage

```js
const { run } = require('./engine/backtestRunner');

const result = run(candles, account, 'XAUUSD', '2m');

console.log(result.totalSignals, result.tradeableSignals);
console.log(result.summary.byRegime);
```

### Options

```js
run(candles, account, symbol, timeframe, {
  pipeline:    { features: { ema20Period: 21 }, risk: { riskPercent: 0.01 } },
  startIndex:  60,           // first bar index to run (default: minBars)
  minBars:     51,           // minimum bars for feature warmup (default: 51)
  barTimestamp: { baseMs: Date.UTC(2026,0,1), intervalMs: 120000 }  // for records when candles have no .time
});
```

### Helper APIs

- `summarizeByRegime(records)` — counts per regime
- `summarizeByStrategy(records)` — counts per strategy
- `summarizeByDirection(records)` — counts per long/short/null

### Example script

```bash
node neuropilot_trading_v2/engine/exampleBacktest.js
```

---

## Performance Analyzer

Analyzes backtest journal records and produces summary statistics for quant research. Pure function; no database writes.

**Input:** `records` (array of journal records from backtestRunner).

**Output:**

```js
{
  totals: {
    totalRecords: 420,
    validSignals: 88,
    tradeableSignals: 72,
    noTradeSignals: 348
  },
  ratios: { validRate: 0.21, tradeableRate: 0.17 },
  byRegime:   { TREND_UP: 120, RANGE: 80, HIGH_VOLATILITY: 50, ... },
  byStrategy: { trend_breakout: 90, mean_reversion: 40, null: 290 },
  byDirection: { long: 45, short: 27, null: 348 },
  noTradeReasons: { "No valid strategy for current regime": 200, "Daily loss limit reached": 10, ... },
  topRegime: "TREND_UP",
  topStrategy: "trend_breakout"
}
```

### Usage

```js
const { run } = require('./engine/backtestRunner');
const { analyze } = require('./engine/performanceAnalyzer');

const result = run(candles, account, 'XAUUSD', '2m');
const analysis = analyze(result.records);

console.log(analysis.totals, analysis.ratios, analysis.topRegime);
```

### Helper APIs

- `countByField(records, field)` — count by any field (e.g. `"regime"`, `"strategy"`)
- `countNoTradeReasons(records)` — count no-trade reason strings
- `calculateRatios(totals)` — `{ validRate, tradeableRate }` from totals
- `pickTopKey(countObj)` — key with highest count

Empty or non-array input is handled safely (zero totals, empty breakdowns, null top keys).

### Example script

```bash
node neuropilot_trading_v2/engine/examplePerformance.js
```

---

## Strategy Ranking Engine

Ranks strategies and regimes using the output of the Performance Analyzer. Score is initially count / totalRecords; design allows later extension with PnL, expectancy, or Sharpe. Pure function; no database writes.

**Input:** `analysis` (object from `performanceAnalyzer.analyze(records)`).

**Output:**

```js
{
  topStrategies: [
    { strategy: "trend_breakout", score: 0.78, count: 52 },
    { strategy: "mean_reversion", score: 0.44, count: 20 }
  ],
  topRegimes: [
    { regime: "TREND_UP", score: 0.71, count: 60 },
    { regime: "RANGE", score: 0.39, count: 18 }
  ],
  recommendations: [
    "Favor trend_breakout in TREND_UP",
    "Reduce mean_reversion usage until more data"
  ]
}
```

- Strategies are ranked by frequency (count / totalRecords or count / tradeableSignals); sorted by count descending.
- Regimes are ranked by frequency among valid signals (or totalRecords); sorted by count descending.
- Recommendations: favor top strategy in top regime; caution for low-count strategies; "insufficient data" when totalRecords is low.
- Keys `"null"` (no strategy / no regime) are excluded from ranking.

### Usage

```js
const { analyze } = require('./engine/performanceAnalyzer');
const { rank } = require('./engine/strategyRanking');

const analysis = analyze(records);
const ranking = rank(analysis);

console.log(ranking.topStrategies, ranking.topRegimes, ranking.recommendations);
```

### Options

```js
rank(analysis, {
  strategyTotal: 'tradeableSignals',  // score = count / tradeableSignals (default: totalRecords)
  regimeTotal: 'validSignals',       // score = count / validSignals (default: totalRecords)
  minCountForFavor: 10,
  minCountWarning: 5
});
```

### Helper APIs

- `rankCounts(countObj, total, options)` — rank a count map → `[{ strategy|regime|key, count, score }]` sorted by count desc
- `normalizeScore(count, total)` — safe count/total in [0, 1]
- `buildRecommendations(params, options)` — build recommendation strings from ranked lists and totals

Empty or invalid analysis returns empty arrays and a single "Insufficient analysis data" recommendation.

### Example script

```bash
node neuropilot_trading_v2/engine/exampleRanking.js
```

---

## Adaptive Selector / Policy Layer

Uses strategy ranking and regime ranking to influence whether a signal should be allowed, boosted, penalized, or blocked. Pure function; no database writes.

**Inputs:** `signal` (from signalPipeline.run), `ranking` (from strategyRanking.rank).

**Output:**

```js
{
  shouldAllow: true,
  adjustedConfidence: 0.82,
  selectedStrategy: "trend_breakout",
  policyAction: "favor",
  reason: "trend_breakout is top-ranked and TREND_UP is dominant"
}
```

**Rules (v1, deterministic):**

1. If `signal.valid` is false → `shouldAllow: false`, `policyAction: "block"`.
2. If signal’s strategy is top-ranked → boost confidence (default +0.05).
3. If signal’s regime is top-ranked → boost confidence (default +0.05, stackable).
4. If strategy appears in a “Reduce … until more data” recommendation → penalize confidence (default −0.10).
5. If adjusted confidence &lt; minConfidenceThreshold (default 0.35) → block signal.

**Policy actions:** `"favor"` (boosted), `"penalize"` (reduced), `"allow"` (neutral), `"block"` (invalid or below threshold).

### Usage

```js
const { run } = require('./engine/signalPipeline');
const { rank } = require('./engine/strategyRanking');
const { select } = require('./engine/adaptiveSelector');

const signal = run(candles, account);
const ranking = rank(performanceAnalysis);
const policy = select(signal, ranking);

if (policy.shouldAllow) {
  // Use policy.adjustedConfidence for sizing or filters
} else {
  // policy.reason explains block
}
```

### Options

```js
select(signal, ranking, {
  boostAmount: 0.05,
  regimeBoostAmount: 0.05,
  penaltyAmount: 0.1,
  minConfidenceThreshold: 0.35
});
```

### Helper APIs

- `applyBoost(confidence, amount)` — add amount to confidence, cap at 1
- `applyPenalty(confidence, amount)` — subtract amount, floor at 0
- `extractPolicyFlags(signal, ranking)` — { isTopStrategy, isTopRegime, isReduceRecommendation, strategy, regime }
- `shouldBlockSignal(adjustedConfidence, minThreshold)` — true if confidence &lt; threshold

### Example script

```bash
node neuropilot_trading_v2/engine/exampleAdaptiveSelector.js
```

---

## Policy-Aware Pipeline Runner

Combines the signal pipeline with the adaptive selector so the final output is one adaptive, policy-aware signal object. Pure function; no database writes.

**Inputs:** `candles`, `account`, `ranking` (from strategyRanking.rank), optional `options` (`pipeline`, `adaptive`), optional `index` (bar index).

**Pipeline:** 1) Run signalPipeline. 2) Run adaptiveSelector(signal, ranking). 3) Merge and apply policy overrides.

**Output:**

```js
{
  shouldTrade: true,
  valid: true,
  features: { ... },
  regime: { ... },
  strategyDecision: { ... },
  tradeDecision: { ... },
  sizingDecision: { ... },
  policyDecision: {
    shouldAllow: true,
    adjustedConfidence: 0.82,
    selectedStrategy: "trend_breakout",
    policyAction: "favor",
    reason: "trend_breakout is top-ranked and TREND_UP is dominant"
  },
  finalConfidence: 0.82,
  finalDecision: "favor",
  reason: "Valid trend breakout long, favored by adaptive policy"
}
```

**Rules:**

1. If signalPipeline returns invalid signal → `finalDecision = "block"` (shouldTrade/valid remain from pipeline).
2. If adaptiveSelector blocks the signal → `shouldTrade = false`, `valid = false`, `finalDecision = "block"`.
3. If adaptiveSelector allows → `finalConfidence = policyDecision.adjustedConfidence`, `finalDecision = policyDecision.policyAction`.
4. All prior stage outputs (features, regime, strategyDecision, tradeDecision, sizingDecision, policyDecision) are preserved.

### Usage

```js
const { run } = require('./engine/adaptivePipeline');
const { rank } = require('./engine/strategyRanking');
const performanceAnalyzer = require('./engine/performanceAnalyzer');

const ranking = rank(performanceAnalyzer.analyze(backtestRecords));
const adaptive = run(candles, account, ranking);

if (adaptive.valid) {
  // Use adaptive.finalConfidence, adaptive.tradeDecision, adaptive.sizingDecision
} else {
  // adaptive.reason, adaptive.policyDecision.reason
}
```

### Options

```js
run(candles, account, ranking, {
  pipeline: { features: {}, risk: {} },
  adaptive: { minConfidenceThreshold: 0.4 }
}, candles.length - 1);
```

### Example script

```bash
node neuropilot_trading_v2/engine/exampleAdaptivePipeline.js
```

---

## Signal Quality Gate

Applies additional quality filters to adaptive signals before treating them as tradable. Pure function; no database writes. Designed as a post-adaptive gate for stricter execution hygiene.

**Inputs:** `adaptiveSignal` (from adaptivePipeline), optional `context`, optional `options`.

**Output:**

```js
{
  shouldPass: true,
  qualityAction: "pass",
  reason: "Signal passed all quality checks"
}
```

**Rules (v1, deterministic):**

1. Block if `finalConfidence` is below threshold.
2. Block if regime confidence (`signal.regime.confidence`) is below threshold.
3. Block if strategy confidence (`tradeDecision.confidence` fallback `strategyDecision.confidence`) is below threshold.
4. Block if stop distance ratio is out of bounds:
   - `stopDistance / price < minStopDistancePct`
   - `stopDistance / price > maxStopDistancePct`
5. Block if a recent **accepted/passed** same-symbol signal exists within `cooldownMs`.

**Default options:**

```js
{
  minFinalConfidence: 0.55,
  minRegimeConfidence: 0.4,
  minStrategyConfidence: 0.5,
  minStopDistancePct: 0.0005,
  maxStopDistancePct: 0.03,
  cooldownMs: 300000
}
```

**Context shape (optional):**

```js
{
  symbol: "QQQ",
  nowMs: 1700000000000,
  recentSignals: [
    { symbol: "QQQ", timeMs: 1699999995000 },
    { symbol: "SPY", timestamp: 1699999998000 }
  ]
}
```

### Usage

```js
const signalQualityGate = require('./engine/signalQualityGate');

const gate = signalQualityGate.evaluate(adaptiveSignal, {
  symbol: 'QQQ',
  nowMs: Date.now(),
  recentSignals: priorSignals
}, {
  minFinalConfidence: 0.6,
  cooldownMs: 10 * 60 * 1000
});

if (!gate.shouldPass) {
  console.log('Blocked:', gate.reason);
}
```

### API

- `evaluate(adaptiveSignal, context?, options?)` — main gate function; returns `{ shouldPass, qualityAction, reason }`
- `DEFAULT_OPTIONS` — default thresholds and cooldown
- `evaluateCooldown(signal, context, options)` — helper for cooldown-only check

In quality-aware backtests, `recentSignals` is built from prior accepted/passed signals only (not all emitted bars), so cooldown throttles actionable flow instead of suppressing every bar-level emission.

### Example script

```bash
node neuropilot_trading_v2/engine/exampleSignalQualityGate.js
```

---

## Quality Gate Calibration

Runs repeated quality-aware research with different Signal Quality Gate thresholds and returns comparable metrics. Pure orchestration; no database writes.

Uses the existing quality-aware path internally: `qualityAdaptiveBacktestRunner`.

**Inputs:** `datasets`, `account`, `configs`, optional `options`.

- **datasets** — array of `{ symbol, timeframe, candles }`
- **account** — `{ equity, dailyPnL, openPositions }`
- **configs** — array of quality gate threshold objects
- **options.backtest** — base options passed to quality backtest runner (`pipeline`, `adaptive`, `qualityContext`, `startIndex`, `barTimestamp`, etc.)
- **options.sortByAllowedRateDesc** — default `true`
- **options.includeRuns** — include per-dataset run details in each result (default `false`)

**Calibrated keys:**

- `minFinalConfidence`
- `minRegimeConfidence`
- `minStrategyConfidence`
- `cooldownMs`
- `minStopDistancePct`
- `maxStopDistancePct`

**Output:**

```js
[
  {
    config: { ... },
    totalAdaptiveSignals: 7140,
    validAdaptiveSignals: 420,
    allowedSignals: 120,
    blockedSignals: 7020,
    allowedRate: 0.0168
  }
]
```

### Usage

```js
const qualityGateCalibration = require('./engine/qualityGateCalibration');

const configs = qualityGateCalibration.buildConfigGrid({
  minFinalConfidence: [0.5, 0.6],
  minRegimeConfidence: [0.35, 0.45],
  minStrategyConfidence: [0.45, 0.55],
  cooldownMs: [0, 300000],
  minStopDistancePct: [0.0003],
  maxStopDistancePct: [0.03],
});

const results = qualityGateCalibration.runCalibration(datasets, account, configs, {
  backtest: { barTimestamp: { baseMs: Date.UTC(2026, 0, 1), intervalMs: 60000 } },
});
```

### API

- `runCalibration(datasets, account, configs, options?)` — run all configs and return comparable results
- `buildConfigGrid(space)` — build Cartesian config combinations from value arrays
- `normalizeCalibrationConfig(config)` — keep only known numeric calibration keys
- `aggregateRuns(runs)` — aggregate core metrics from per-dataset runs
- `CALIBRATION_KEYS` — supported threshold keys

### Example script

```bash
node neuropilot_trading_v2/engine/exampleQualityGateCalibration.js
```

---

## Quality-Aware Adaptive Pipeline

Runs the adaptive pipeline first, then applies the signal quality gate, and returns one final quality-aware adaptive signal. Pure function; no database writes.

**Inputs:** `candles`, `account`, `ranking`, optional `context`, optional `options`, optional `index`.

**Pipeline:**

1. Run `adaptivePipeline.run(...)`.
2. Run `signalQualityGate.evaluate(...)` on adaptive output.
3. Return merged signal with `qualityDecision` and final quality-aware decision.

**Output:**

```js
{
  shouldTrade: true,
  valid: true,
  features: { ... },
  regime: { ... },
  strategyDecision: { ... },
  tradeDecision: { ... },
  sizingDecision: { ... },
  policyDecision: { ... },
  qualityDecision: {
    shouldPass: true,
    qualityAction: "pass",
    reason: "Signal passed all quality checks"
  },
  finalConfidence: 0.82,
  finalDecision: "pass",
  reason: "Adaptive signal passed quality gate"
}
```

**Rules:**

1. If adaptive pipeline returns invalid signal → `finalDecision = "block"`.
2. If quality gate blocks → `shouldTrade = false`, `valid = false`, `finalDecision = "block"`.
3. Preserve all prior stage outputs from adaptive pipeline.
4. Add `qualityDecision` to output.

### Usage

```js
const qualityAdaptivePipeline = require('./engine/qualityAdaptivePipeline');

const out = qualityAdaptivePipeline.run(
  candles,
  account,
  ranking,
  { symbol: 'QQQ', nowMs: Date.now(), recentSignals: priorSignals },
  {
    adaptivePipeline: { pipeline: {}, adaptive: {} },
    qualityGate: { minFinalConfidence: 0.6, cooldownMs: 600000 },
  },
  candles.length - 1
);

if (!out.valid) {
  console.log(out.reason, out.qualityDecision);
}
```

### API

- `run(candles, account, ranking, context?, options?, index?)` — main orchestrator; returns quality-aware adaptive signal
- `buildFinalReason(adaptiveSignal, qualityDecision)` — helper for final reason string

### Example script

```bash
node neuropilot_trading_v2/engine/exampleQualityAdaptivePipeline.js
```

---

## Research Report Generator

Generates a structured research report from performance analysis, strategy ranking, and optional metadata. Pure function; no database or file writes.

**Inputs:** `analysis` (from performanceAnalyzer.analyze), `ranking` (from strategyRanking.rank), optional `metadata` (e.g. generatedAt, symbol, timeframe, note).

**Output:**

```js
{
  generatedAt: "2026-03-06T12:30:00.000Z",
  summary: {
    totalRecords: 420,
    validSignals: 88,
    tradeableSignals: 72,
    topRegime: "TREND_UP",
    topStrategy: "trend_breakout"
  },
  ranking: {
    topStrategies: [ { strategy, score, count }, ... ],
    topRegimes: [ { regime, score, count }, ... ]
  },
  recommendations: [ "Favor trend_breakout in TREND_UP", ... ],
  notes: [ "Total records: 420", "Tradeable signals: 72 (17.1%)", ... ]
}
```

Empty or missing analysis/ranking yields safe defaults (zero totals, empty arrays). Notes can include sample-size warnings and metadata (symbol, timeframe, custom note).

### Usage

```js
const { analyze } = require('./engine/performanceAnalyzer');
const { rank } = require('./engine/strategyRanking');
const { generate } = require('./engine/researchReport');

const analysis = analyze(records);
const ranking = rank(analysis);
const report = generate(analysis, ranking, { symbol: 'XAUUSD', timeframe: '2m' });

console.log(report.generatedAt, report.summary, report.recommendations);
```

### Helper APIs

- `buildSummary(analysis)` — { totalRecords, validSignals, tradeableSignals, topRegime, topStrategy }
- `buildNotes(analysis, ranking, metadata)` — array of note strings (extensible)
- `buildReportMetadata(metadata)` — { generatedAt: ISO string, ...rest }

### Example script

```bash
node neuropilot_trading_v2/engine/exampleResearchReport.js
```

---

## Policy-Aware Backtest Runner

Replays historical OHLCV bar-by-bar using the **adaptive pipeline** (signal + policy), then generates journal records, performance analysis, ranking, and research report. Two-pass: first pass builds ranking from signal-only backtest; second pass runs adaptive pipeline at each bar with that ranking. Pure function; no database writes, no broker interaction.

**Inputs:** `candles`, `account`, `symbol`, `timeframe`, optional `options` (pipeline, adaptive, startIndex, minBars, barTimestamp, reportMetadata).

**Output:**

```js
{
  totalBars: 500,
  totalAdaptiveSignals: 420,
  validAdaptiveSignals: 80,
  allowedSignals: 65,
  blockedSignals: 355,
  records: [ /* journal records with finalDecision */ ],
  analysis: { ... },
  ranking: { ... },
  report: { generatedAt, summary, ranking, recommendations, notes }
}
```

Each record includes `finalDecision` (e.g. `"allow"`, `"favor"`, `"block"`) for counting allowed vs blocked.

### Usage

```js
const { run, countAllowedSignals, countBlockedSignals } = require('./engine/adaptiveBacktestRunner');

const result = run(candles, account, 'XAUUSD', '2m');

console.log(result.allowedSignals, result.blockedSignals);
console.log(result.report.summary, result.report.recommendations);
```

### Helper APIs

- `countAllowedSignals(records)` — count records where `finalDecision !== 'block'`
- `countBlockedSignals(records)` — count records where `finalDecision === 'block'`

### Example script

```bash
node neuropilot_trading_v2/engine/exampleAdaptiveBacktest.js
```

---

## Quality-Aware Adaptive Backtest Runner

Replays historical OHLCV bar-by-bar using the **quality-aware adaptive pipeline** (adaptive pipeline + signal quality gate), then generates journal records, performance analysis, ranking, and research report. Pure function; no database writes, no broker interaction.

**Inputs:** `candles`, `account`, `symbol`, `timeframe`, optional `options`:

- `pipeline` / `adaptive` (passed into adaptive pipeline stage)
- `qualityGate` (passed into signal quality gate stage)
- `qualityContext` (static context for gate)
- `qualityContextProvider` (dynamic context builder per bar)
- `startIndex`, `minBars`, `barTimestamp`, `reportMetadata`
- `debugExportAllowedSignals`: `true` | string — write allowed-signal debug rows (default path: `research/allowed_signals_debug.json`). Single-run: runner writes; multi-asset: multiAssetRunner aggregates and overwrites the file once per run.
- `includeStrategies`: string[] — if set, only signals whose `strategy` is in this array count as allowed (e.g. `['trend_breakout']`); others are forced to block. Use to run research with one strategy (e.g. trend_breakout only).
- `includeRegimes`: string[] — if set, only signals whose `regime` is in this array count as allowed (e.g. `['BREAKOUT']`).
- `excludeSessionOpenMinutes`: number — if > 0, block signals in the first N minutes of US session (14:30 UTC). e.g. 30 = no trades 09:30–10:00 ET.
- `allowSessionBuckets`: string[] — if set (e.g. `['late']`), only allow signals whose bar time falls in one of these buckets (open/mid/late). US session 14:30–21:00 UTC; late = last 60 min. Use `['late']` for "late only" when late holds better than mid on a selective setup.

**Output:**

```js
{
  totalBars: 500,
  totalAdaptiveSignals: 420,
  validAdaptiveSignals: 72,
  allowedSignals: 54,
  blockedSignals: 366,
  records: [ /* journal records with finalDecision + qualityDecision */ ],
  analysis: { ... },
  ranking: { ... },
  report: { generatedAt, summary, ranking, recommendations, notes }
}
```

**Behavior:**

1. First pass uses signal-only backtest (`backtestRunner`) to bootstrap ranking.
2. Second pass runs `qualityAdaptivePipeline` per bar.
3. Each quality-aware signal is converted to a journal record and enriched with:
   - `finalDecision`
   - `qualityDecision`
4. `blockedSignals` reflects all `finalDecision === 'block'`, including quality-gate blocks.
5. Cooldown history uses prior accepted/passed signals only (`finalDecision !== 'block'` or `qualityDecision.shouldPass === true`), not all prior emitted signals.
6. Empty candle inputs return safe zero-count output with empty records.

### Usage

```js
const qualityAdaptiveBacktestRunner = require('./engine/qualityAdaptiveBacktestRunner');

const result = qualityAdaptiveBacktestRunner.run(candles, account, 'QQQ', '1m', {
  qualityGate: { minFinalConfidence: 0.6, cooldownMs: 300000 },
  barTimestamp: { baseMs: Date.UTC(2026, 0, 1), intervalMs: 60000 },
});

console.log(result.allowedSignals, result.blockedSignals, result.report.summary);
```

### Helper APIs

- `countAllowedSignals(records)` — count records where `finalDecision !== 'block'`
- `countBlockedSignals(records)` — count records where `finalDecision === 'block'`

### Example script

```bash
node neuropilot_trading_v2/engine/exampleQualityAdaptiveBacktest.js
```

---

## Breakout Entry Confirmation Filter

Optional filter to reduce immediate false breakouts for the **trend_breakout** strategy. Used by `qualityAdaptiveBacktestRunner` when `breakoutConfirmation: true` is passed in options.

**v1 behaviour:** **One-bar confirmation** — a trend_breakout signal is only allowed if the **previous bar** was already in a trend/breakout regime (TREND_UP, TREND_DOWN, or BREAKOUT). Entry is then on the bar after the breakout bar, not on the breakout bar itself.

**API:** `evaluate(candles, index, strategyName, options)` → `{ confirmed: boolean, reason: string }`. Only applies when `strategyName === 'trend_breakout'` and `options.requireOneBarConfirmation === true`; otherwise returns `{ confirmed: true }`. Uses the feature and regime engines to compute the previous bar’s regime.

**Compare baseline vs confirmed:** Run research with trend_breakout only, then with trend_breakout + confirmed (e.g. `exampleRunResearchFromConfig.js us_indices_core trend_breakout` vs `... trend_breakout confirmed`), then run trade simulation on the exported signals to compare expectancy.

---

## Breakout Strength Filter

Optional filter for **trend_breakout** to allow only breakouts when the breakout candle shows strong momentum. Reduces immediate false breakouts (e.g. bars=1 losses). Used by `qualityAdaptiveBacktestRunner` when `breakoutStrengthFilter: true` is passed in options.

**Criteria (pipeline: body ≥ 60% + close in extreme):**

- **body** = |close − open|, **range** = high − low, **bodyPercent** = body / range → **bodyPercent ≥ 0.6** (`minBodyRatio` default 0.6).
- **Long:** closeStrength = (close − low) / range ≥ **0.7** → close near high (`closeStrengthMin` default 0.7).
- **Short:** closeStrength = (high − close) / range ≥ **0.7** → close near low.
- **Optional range expansion** — when `requireRangeExpansion: true`, current bar range must be > previous bar range (default off).

**API:** `evaluate(candles, index, direction, options)` → `{ passed: boolean, reason: string }`. Call with the breakout bar index and signal direction; uses that bar’s OHLC only (and previous bar for range expansion if enabled).

**Enable:** Pass `research.multiAsset.breakoutStrengthFilter: true` or use the example fifth arg: `node engine/exampleRunResearchFromConfig.js us_indices_core trend_breakout strength`.

---

## Exclude Session Open

Optional filter to avoid trading in the chaotic first minutes of the US session. When `excludeSessionOpenMinutes` is set (e.g. 30), signals whose bar time falls in the first N minutes of the US session (9:30 ET = 14:30 UTC) are blocked. Example: 30 = no trades 09:30–10:00 ET.

**Enable:** Pass `research.multiAsset.excludeSessionOpenMinutes: 30` or use the example 7th arg: `node engine/exampleRunResearchFromConfig.js us_indices_core trend_breakout strength noopen`.

---

## Session bucket filter (late only)

When the setup is selective (e.g. strength + BREAKOUT), the **late** bucket (last 60 min of US session) often holds up better than **mid**. To restrict signals to late only, pass `research.multiAsset.allowSessionBuckets: ['late']` or use the token **late** in arg3/arg4/arg5: e.g. `node engine/exampleRunResearchFromConfig.js baseline strength late` or `baseline confirmed strength late`.

---

## Trade Simulation / Outcome Engine

Simulates trade outcomes from allowed signals on historical candles. Pure function; no database writes, no broker interaction.

**Inputs:** `candles` (OHLCV array, same symbol/timeframe as signals), `allowedSignals` (array of allowed-signal records), optional `options`.

**Allowed signal record shape:** `entryPrice`, `stopDistance`, optional `direction` (`'long'` | `'short'`), optional `barIndex` or `timestamp` (to resolve entry bar), optional `symbol` / `timeframe` (for output).

**Options:**

- `rMultiple` (default `2`) — Take-profit distance = stopDistance × rMultiple.
- `maxBarsHeld` (default `null`) — If set, exit at bar close after this many bars (time-based timeout).
- `defaultDirection` (default `'long'`) — Used when a signal has no `direction`.
- `includeStrategies` (default none) — If set to an array (e.g. `['trend_breakout']` or `['mean_reversion']`), only signals whose `strategy` is in this list are simulated; use to test one strategy in isolation.

**Per-trade logic:** Enter at `entryPrice`; stop loss at `entryPrice ± stopDistance` (long: below, short: above); target at `entryPrice ± (stopDistance × rMultiple)`. Walk forward bar-by-bar; if both stop and target are breached in the same bar, stop is considered hit first. If `maxBarsHeld` is set and no stop/target before then, outcome is `timeout` and exit at that bar’s close.

**Output per trade:** (includes `strategy`, `regime` when provided on the signal; `entryBarTimeMs` when candles have `.time` for session breakdown)

```js
{
  symbol,
  timeframe,
  entryPrice,
  stopPrice,
  targetPrice,
  outcome: "win" | "loss" | "timeout" | "skip",
  rMultiple,   // actual R achieved (e.g. -1 for loss, +2 for target hit)
  barsHeld,
  exitPrice,
  direction,
  strategy,    // passthrough from signal
  regime,      // passthrough from signal
  entryBarTimeMs  // UTC ms of entry bar (for session/time-of-day breakdown)
}
```

**Summary output:**

```js
{
  totalTrades,
  wins,
  losses,
  timeouts,
  winRate,
  avgR,
  expectancyR
}
```

**Performance breakdown by strategy / regime / direction:**

- `strategyPerformanceBreakdown(trades)` — Returns `{ byStrategy, byRegime, byDirection }`. Each key (e.g. `trend_breakout`, `mean_reversion`, `TREND_UP`, `RANGE`, `long`, `short`) maps to the same summary shape: `totalTrades`, `wins`, `losses`, `timeouts`, `winRate`, `avgR`, `expectancyR`. Use to see which strategy or regime is driving drag.

**Helper APIs:**

- `simulateOne(candles, signal, opts)` — Simulate a single trade.
- `buildSummary(trades)` — Compute summary from an array of trade results.
- `strategyPerformanceBreakdown(trades)` — Group performance by strategy, regime, and direction.
- `sessionPerformanceBreakdown(trades, options)` — Time-of-day breakdown by session bucket. Returns `{ bySession: { open, mid, late }, unknown }`. Each value is the same summary shape. **Buckets:** open = first 60 min of session, mid = middle, late = last 60 min. Default session = US 9:30–16:00 ET (14:30–21:00 UTC). Trades need `entryBarTimeMs` (set when candles have `.time`). Use to see which part of the session performs best for the baseline.
- `getSessionBucket(entryBarTimeMs, options)` — Return `'open'` | `'mid'` | `'late'` | null for a single timestamp.
- `regimePerformanceBreakdown(trades)` — Regime-level performance breakdown for the baseline. Returns `{ byRegime: { BREAKOUT, TREND_UP, TREND_DOWN }, other }`. Each value is the same summary shape (`totalTrades`, `wins`, `losses`, `timeouts`, `winRate`, `avgR`, `expectancyR`). Use to compare whether trend_breakout performs better or worse in BREAKOUT vs TREND_UP vs TREND_DOWN. **Baseline comparison reference:** expectancyR = -0.12 (SPY 5m, trend_breakout, 2R).
- `REGIME_BUCKETS` — `['BREAKOUT', 'TREND_UP', 'TREND_DOWN']` (order for reporting).
- `performanceBreakdownByPeriod(trades, options)` — Group by month (or week) to check stability. Returns `{ byPeriod: { 'YYYY-MM': summary }, periodOrder }`. Options: `periodFormat: 'month' | 'week'`.
- `formatTradesForAudit(trades)` — Flat list with entryDate, direction, regime, outcome, barsHeld, entryPrice, rMultiple, strategy for manual or scripted audit.
- `runSweepRMultiple(candles, allowedSignals, options)` — Run simulation with multiple target R multiples (same signals). Options include `rMultiples: number[]` (default `[1, 1.25, 1.5, 2]`). Returns `{ results: Array<{ rMultiple, summary, trades }> }`. Use to compare whether a smaller or larger target improves expectancy.
- `resolveBarIndex(candles, signal)` — Resolve entry bar from `signal.barIndex` or `signal.timestamp`.

### Usage

```js
const tradeSimulation = require('./engine/tradeSimulation');

const candles = [ /* OHLCV bars, oldest first */ ];
const allowedSignals = [
  { entryPrice: 100, stopDistance: 1.5, direction: 'long', barIndex: 50, symbol: 'QQQ', timeframe: '5m' },
];
const { trades, summary } = tradeSimulation.run(candles, allowedSignals, {
  rMultiple: 2,
  maxBarsHeld: 20,
});
console.log(summary.winRate, summary.expectancyR);
```

### Example script

```bash
node neuropilot_trading_v2/engine/exampleTradeSimulation.js
node neuropilot_trading_v2/engine/exampleTradeSimulationFromResearch.js SPY 5m   # session + regime + by-period breakdown (trend_breakout, 2R)
node neuropilot_trading_v2/engine/exampleTradeSimulationFromResearch.js SPY 5m audit   # + export research/trade_audit_SPY_5m.json for audit
node neuropilot_trading_v2/engine/exampleTradeSimulationSweepR.js SPY 5m trend_breakout   # R-multiple sweep for baseline
```

---

## Multi-Asset Research Runner

Runs backtests across multiple assets and timeframes, then summarizes which symbols and timeframes perform best by signal quality (allowed signals, valid signals). Pure function; no database writes, no broker interaction.

**Inputs:** `datasets` (array of `{ symbol, timeframe, candles }`), `account`, optional `options`.

- `useQualityBacktest` (default: `false`)
  - `false` → uses `adaptiveBacktestRunner`
  - `true` → uses `qualityAdaptiveBacktestRunner`
- `includeStrategies` (optional) — array of strategy names; only those strategies count as allowed (passed through to qualityAdaptiveBacktestRunner when useQualityBacktest is true).
- `includeRegimes`: string[] — if set, only signals whose `regime` is in this array count as allowed (e.g. `['BREAKOUT']`).
- `breakoutConfirmation` (optional) — when `true`, trend_breakout signals require one-bar confirmation (previous bar in trend/breakout regime); passed through to qualityAdaptiveBacktestRunner.
- `breakoutStrengthFilter` (optional) — when `true`, trend_breakout signals require strong breakout candle (body ≥ 60%, closeStrength ≥ 0.7); passed through to qualityAdaptiveBacktestRunner.
- `excludeSessionOpenMinutes` (optional) — when > 0 (e.g. 30), block signals in the first N minutes of US session (9:30 ET = 14:30 UTC). Use 30 for “no trades 09:30–10:00”. Passed through to qualityAdaptiveBacktestRunner.
- `allowSessionBuckets` (optional) — when set (e.g. `['late']`), only allow signals in those session buckets (open/mid/late). Passed through to qualityAdaptiveBacktestRunner.
- Remaining options are passed through to the selected runner.

**Output:**

```js
{
  backtestEngine: "adaptiveBacktestRunner",
  runs: [
    { symbol: "XAUUSD", timeframe: "2m", backtestEngine: "adaptiveBacktestRunner", result: { totalAdaptiveSignals, validAdaptiveSignals, allowedSignals, ... } },
    { symbol: "NAS100", timeframe: "5m", result: { ... } }
  ],
  summary: {
    bySymbol: {
      XAUUSD: { totalAdaptiveSignals: 100, validAdaptiveSignals: 22, allowedSignals: 18, blockedSignals: 82, totalBars: 200 },
      NAS100: { ... }
    },
    byTimeframe: {
      "2m": { totalAdaptiveSignals: 95, ... },
      "5m": { ... }
    },
    topSymbols: [ { symbol: "XAUUSD", totalAdaptiveSignals: 100, validAdaptiveSignals: 22, allowedSignals: 18 }, ... ],
    topTimeframes: [ { timeframe: "2m", ... }, ... ]
  }
}
```

- **bySymbol:** Aggregated stats per symbol (across all timeframes).
- **byTimeframe:** Aggregated stats per timeframe (across all symbols).
- **topSymbols / topTimeframes:** Ranked by allowedSignals (desc), then validAdaptiveSignals. Easy to extend later with PnL, expectancy, or Sharpe.

### Usage

```js
const { run, summarizeBySymbol, rankSymbols } = require('./engine/multiAssetRunner');

const datasets = [
  { symbol: 'XAUUSD', timeframe: '2m', candles: candlesXau2m },
  { symbol: 'NAS100', timeframe: '5m', candles: candlesNas5m },
];
const result = run(datasets, account, { useQualityBacktest: true });

console.log(result.backtestEngine, result.summary.topSymbols, result.summary.topTimeframes);
```

### Helper APIs

- `summarizeBySymbol(runs)` — aggregate stats by symbol
- `summarizeByTimeframe(runs)` — aggregate stats by timeframe
- `rankSymbols(bySymbol)` — sorted array of { symbol, ...stats } by allowedSignals desc
- `rankTimeframes(byTimeframe)` — sorted array of { timeframe, ...stats } by allowedSignals desc

Empty or missing datasets yield empty runs and empty summary objects.

### Example script

```bash
node neuropilot_trading_v2/engine/exampleMultiAssetRunner.js
```

---

## Signal Adapter / Execution Bridge

Converts a final adaptive signal into a normalized execution payload compatible with the neuropilot_trading_v2 paper-trading / webhook pipeline. Pure function; no HTTP or broker calls.

**Inputs:** `adaptiveSignal` (from adaptivePipeline.run or equivalent), `symbol`, optional `options` (`mode`, `source`).

**Output (valid signal):**

```js
{
  valid: true,
  symbol: "XAUUSD",
  action: "BUY",
  price: 2677,
  quantity: 1.11,
  strategy: "trend_breakout",
  confidence: 0.82,
  regime: "TREND_UP",
  riskAmount: 5,
  stopDistance: 4.5,
  riskReward: 2.0,
  mode: "paper",
  source: "neuropilot_quant_v1"
}
```

**Output (invalid / no trade):** `{ valid: false, symbol, action: null, price: null, ... }` — all execution fields null, `valid: false`.

**Rules:**

1. If adaptive signal is invalid or `shouldTrade` is false → return payload with `valid: false`.
2. Direction: `long` → `BUY`, `short` → `SELL`.
3. Field mapping: `features.price` → price, `sizingDecision.positionSize` → quantity, `finalConfidence` → confidence, `tradeDecision.riskReward` → riskReward, `regime.regime` → regime; riskAmount and stopDistance from sizingDecision, strategy from tradeDecision.
4. `mode` and `source` default to `"paper"` and `"neuropilot_quant_v1"` (overridable via options).

### Usage

```js
const { toPayload, toPayloadOrNull } = require('./engine/signalAdapter');

const payload = toPayload(adaptiveSignal, 'XAUUSD', { mode: 'paper' });

if (payload.valid) {
  // Send to paper-trading / webhook: payload.action, payload.quantity, payload.price, etc.
} else {
  // No trade
}

// Or use toPayloadOrNull for null when invalid:
const p = toPayloadOrNull(adaptiveSignal, 'XAUUSD');
if (p) { /* use p */ }
```

### API

- `toPayload(adaptiveSignal, symbol, options?)` — always returns object; `valid: true` with execution fields or `valid: false` with nulls
- `toPayloadOrNull(adaptiveSignal, symbol, options?)` — returns payload object when valid, `null` when invalid
- `directionToAction(direction)` — `"long"` → `"BUY"`, `"short"` → `"SELL"`
- `DEFAULT_OPTIONS` — `{ mode: "paper", source: "neuropilot_quant_v1" }`

### Example script

```bash
node neuropilot_trading_v2/engine/exampleSignalAdapter.js
```

---

## Dataset Loader / Research Input Layer

Loads OHLCV datasets from JSON or CSV files and normalizes them into the format expected by the quant engine. Pure normalizer functions plus a file loader (read-only). No database writes.

**Input:** File path, symbol, timeframe, optional format hints (format, encoding, delimiter, hasHeader for CSV).

**Supported input shapes:**

- **JSON:** Array of candles, or object with `candles` array. Fields can be `open`/`o`, `high`/`h`, `low`/`l`, `close`/`c`, `volume`/`v`, `time`/`timestamp`/`t`/`date`.
- **CSV:** Header row with columns such as `timestamp`, `open`, `high`, `low`, `close`, `volume` (or `o`, `h`, `l`, `c`, `v`). First line is auto-detected as header if it looks like column names.

**Output:**

```js
{
  symbol: "QQQ",
  timeframe: "1m",
  candles: [
    { time: 1700000000000, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 }
  ]
}
```

- **time** is normalized to milliseconds (numeric strings in seconds are multiplied by 1000).
- Rows that fail to parse (missing time or close) are dropped.

### Usage

```js
const datasetLoader = require('./engine/datasetLoader');

const data = await datasetLoader.loadFromFile('./data/qqq_1m.csv', 'QQQ', '1m');
console.log(data.candles.length);

const fromString = datasetLoader.parseJSON(jsonString, 'QQQ', '1m');
const fromCSV = datasetLoader.parseCSV(csvString, 'QQQ', '1m', { delimiter: ',' });
```

### API

- `loadFromFile(filePath, symbol?, timeframe?, options?)` — async; reads file, infers format from `.json`/`.csv` or `options.format`; throws `"Dataset file is empty"` when file content is empty/whitespace
- `parseJSON(content, symbol?, timeframe?)` — pure; parses JSON string, returns `{ symbol, timeframe, candles }`
- `parseCSV(content, symbol?, timeframe?, options?)` — pure; parses CSV (`options.delimiter`, `options.hasHeader`)
- `normalizeCandle(c)` — pure; maps o/h/l/c/v and time/timestamp/date to `{ time, open, high, low, close, volume }`
- `CANDLE_KEYS` — `['time', 'open', 'high', 'low', 'close', 'volume']`

### Example script

```bash
node neuropilot_trading_v2/engine/exampleDatasetLoader.js
```

---

## Dataset Batch Loader

Loads multiple dataset files via `datasetLoader.loadFromFile` and returns an array ready for **multiAssetRunner**, with loaded/failed counts and per-file errors. Async; no database writes.

**Input:** Array of dataset definitions:

```js
[
  { filePath: "./data/qqq_1m.csv", symbol: "QQQ", timeframe: "1m", options: {} },
  { filePath: "./data/spy_5m.json", symbol: "SPY", timeframe: "5m" }
]
```

**Output:**

```js
{
  datasets: [
    { symbol: "QQQ", timeframe: "1m", candles: [...] },
    { symbol: "SPY", timeframe: "5m", candles: [...] }
  ],
  loaded: 2,
  failed: 0,
  errors: []
}
```

- **datasets** — Same shape as multiAssetRunner input; order preserved from input definitions.
- **loaded** — Count of successfully loaded datasets.
- **failed** — Count of failed loads (missing path, read error, parse error, empty file, zero candles, below minimum candles).
- **errors** — Array of `{ filePath, message }` for each failed item.

**Options:**

- **failFast** (default: `false`) — If `true`, stop on first load error (throw). If `false`, continue loading and collect all errors.
- **minCandles** (default: `60`) — Minimum required candles for a dataset to count as loaded.

Validation errors are explicit:

- `Dataset file is empty`
- `Dataset contains 0 candles`
- `Dataset contains only <n> candles; minimum is <minCandles>`

### Usage

```js
const { loadBatch } = require('./engine/datasetBatchLoader');
const multiAssetRunner = require('./engine/multiAssetRunner');

const definitions = [
  { filePath: './data/qqq_1m.csv', symbol: 'QQQ', timeframe: '1m' },
  { filePath: './data/spy_5m.csv', symbol: 'SPY', timeframe: '5m' },
];

const { datasets, loaded, failed, errors } = await loadBatch(definitions, { minCandles: 60 });

if (failed > 0) {
  console.warn('Failed:', errors);
}
const result = multiAssetRunner.run(datasets, account);
```

### API

- `loadBatch(definitions, options?)` — Async. Returns `{ datasets, loaded, failed, errors }`. Options: `{ failFast: boolean, minCandles: number }`.

### Example script

```bash
node neuropilot_trading_v2/engine/exampleDatasetBatchLoader.js
```

---

## Research Config

Central configuration for research runs: default account, default dataset definitions, and named dataset groups. Pure config module; no file reads, no database writes.

**Exports:**

- **DEFAULT_ACCOUNT** — `{ equity: 500, dailyPnL: 0, openPositions: 0 }` for backtests and research.
- **DATASET_GROUPS** — Object mapping group name → array of dataset definitions. Built-in groups: `qqq_only`, `spy_only`, `nas100_only`, `us_indices_core`, `spy_5m_2022_2025`.
- **DEFAULT_TIMEFRAMES** — `['1m', '5m']` used by built-in groups.
- **SPY_5M_YEARS** — `[2022, 2023, 2024, 2025]` for multi-year SPY 5m.
- **GROUPS_REQUIRING_MERGE** — Group names that use `mergeSameSymbolTimeframe` when loading (e.g. `spy_5m_2022_2025`).
- **definitionsForSymbol(symbol, timeframes, opts?)** — Build definitions for one symbol; path pattern `dataDir/symbolLower_timeframe.ext`. Options: `{ dataDir: './data', extension: 'csv' }`.
- **definitionsForSymbolTimeframeByYears(symbol, timeframe, years, opts?)** — One file per year: `dataDir/symbolLower_timeframe_year.ext` (e.g. `spy_5m_2022.csv`). Each def gets `options: { synthesizeTimestampsFromIndex: true, startMs }` for that year. Use with `mergeSameSymbolTimeframe` in batch loader.
- **getDatasetGroup(name)** — Returns a **copy** of the definitions array for that group, or `[]` for unknown name.
- **listDatasetGroups()** — Returns array of available group names.

**Built-in groups:**

| Group                | Contents                                      |
|----------------------|-----------------------------------------------|
| `qqq_only`           | QQQ 1m, 5m                                    |
| `spy_only`           | SPY 1m, 5m                                    |
| `nas100_only`        | NAS100 1m, 5m                                 |
| `us_indices_core`    | QQQ + SPY (1m, 5m each)                       |
| `spy_5m_2022_2025`   | SPY 5m one file per year (2022–2025), merged  |

File paths: single series use `./data/<symbol_lower>_<timeframe>.csv`. Multi-year use `./data/<symbol_lower>_<timeframe>_<year>.csv` (e.g. `spy_5m_2022.csv`, `spy_5m_2023.csv`, …). Place one CSV per year in `data/`; the loader merges them when the group is in `GROUPS_REQUIRING_MERGE`.

### Usage

```js
const researchConfig = require('./engine/researchConfig');

const account = researchConfig.DEFAULT_ACCOUNT;
const definitions = researchConfig.getDatasetGroup('us_indices_core');

console.log(researchConfig.listDatasetGroups()); // ['qqq_only', 'spy_only', 'nas100_only', 'us_indices_core']

// Custom group
const custom = researchConfig.definitionsForSymbol('IWM', ['1m', '5m', '15m'], { dataDir: './data' });
```

### Example script

```bash
node neuropilot_trading_v2/engine/exampleResearchConfig.js
```

---

## Research Run Script

Single entry point: load datasets from definitions → run multi-asset research → return full result. Includes a helper to print a concise research summary. Async; no database writes.

**Inputs:**

- **definitions** — Array of dataset definitions (`{ filePath, symbol?, timeframe?, options? }`), same as datasetBatchLoader.
- **account** — Account state for risk sizing (`{ equity, dailyPnL, openPositions }`).
- **options** (optional) — `{ batchLoader: object, multiAsset: object }` passed to loadBatch and multiAssetRunner respectively. `batchLoader.minCandles` defaults to `60`.
  - `multiAsset.useQualityBacktest` chooses the backtest path (`false` = adaptive, `true` = quality-aware).

**Output:**

```js
{
  batch: { datasets, loaded, failed, errors },
  multi: { runs, summary: { bySymbol, byTimeframe, topSymbols, topTimeframes } } | null
}
```

- **batch** — Result from datasetBatchLoader.loadBatch. Always present.
- **multi** — Result from multiAssetRunner.run when at least one dataset was loaded; otherwise `null`. Empty definitions or all failed loads yield `multi: null`.

**Behavior:**

1. Calls datasetBatchLoader.loadBatch(definitions, options.batchLoader).
2. If `batch.loaded > 0`, calls multiAssetRunner.run(batch.datasets, account, options.multiAsset).
3. Returns `{ batch, multi }`. Handles empty definitions and missing account safely.

`batch.loaded` / `batch.failed` include strict dataset quality checks from batch loading:

- empty files fail
- zero-candle datasets fail
- datasets below `minCandles` (default `60`) fail

### Usage

```js
const runResearch = require('./engine/runResearch');

const definitions = [
  { filePath: './data/qqq_1m.csv', symbol: 'QQQ', timeframe: '1m' },
  { filePath: './data/spy_5m.csv', symbol: 'SPY', timeframe: '5m' },
];
const account = { equity: 500, dailyPnL: 0, openPositions: 0 };

const result = await runResearch.run(definitions, account, {
  batchLoader: { minCandles: 60 },
  multiAsset: { useQualityBacktest: true },
});

runResearch.printSummary(result);
// Optional: concise only — runResearch.printSummary(result, { includeBySymbol: false, includeByTimeframe: false });
```

### printSummary helper

Prints a readable research summary: loaded/failed, per-file errors, **Backtest engine marker**, top symbols, top timeframes, totals, and optionally bySymbol and byTimeframe. Safe for empty or partial results.

- **result** — Return value from runResearch.run().
- **options** — `{ includeBySymbol: true, includeByTimeframe: true }` to include full bySymbol/byTimeframe JSON (default both true).

### API

- `run(definitions, account, options?)` — Async. Returns `{ batch, multi }`.
- `printSummary(result, options?)` — Side effect: logs to console. Options: `includeBySymbol`, `includeByTimeframe`.

### Example script

```bash
node neuropilot_trading_v2/engine/exampleRunResearch.js
```

---

## Research Run From Config

Practical research entry point that uses `researchConfig` dataset groups and real `./data` files. It resolves a group name, uses `researchConfig.DEFAULT_ACCOUNT` by default, runs `runResearch`, and prints a concise summary.

### Current best baseline

The **documented baseline strategy configuration** (best-performing in backtests so far) is:

- **Symbol:** SPY  
- **Timeframe:** 5m  
- **Strategy:** trend_breakout only (`includeStrategies: ['trend_breakout']`)  
- **Filters:** breakoutConfirmation = false, breakoutStrengthFilter = false  
- **Target:** 2R (trade simulation)

To run research for this baseline and then simulate:

```bash
node engine/exampleRunResearchFromConfig.js baseline
node engine/exampleTradeSimulationFromResearch.js SPY 5m
```

The trade-simulation-from-research script prints session (time-of-day) and **regime-level** breakdowns for trend_breakout at 2R. Example regime output (baseline comparison: expectancyR = -0.12):

```
--- Regime breakdown (trend_breakout, 2R) — baseline comparison: expectancyR = -0.12 ---
  BREAKOUT: totalTrades=133 wins=42 losses=91 timeouts=0 winRate=31.58% avgR=-0.05 expectancyR=-0.05
  TREND_UP: totalTrades=121 wins=31 losses=86 timeouts=4 winRate=25.62% avgR=-0.18 expectancyR=-0.18
  TREND_DOWN: totalTrades=153 wins=44 losses=109 timeouts=0 winRate=28.76% avgR=-0.14 expectancyR=-0.14
```

To sweep R multiples on the same signals:

```bash
node engine/exampleTradeSimulationSweepR.js SPY 5m trend_breakout
```

The `baseline` group name is resolved by `baselineStrategyConfig.resolveBaselineGroup('baseline')` to the group that includes the baseline symbol/timeframe (e.g. `spy_only`), with the above multi-asset options applied. All values live in `baselineStrategyConfig.js` and can be changed there to shift the baseline without touching callers. **API:** `getBaselineResearchOptions()`, `resolveBaselineGroup(groupName)`, `BASELINE_SYMBOL`, `BASELINE_TIMEFRAME`, `BASELINE_GROUP`, `BASELINE_MULTI_ASSET`.

**Defaults:**

- **group:** `us_indices_core`
- **account:** `researchConfig.DEFAULT_ACCOUNT`
- **backtest path:** `qualityAdaptiveBacktestRunner` (via `multiAsset.useQualityBacktest = true`)

**Behavior:**

1. Resolve group with `researchConfig.getDatasetGroup(name)`.
2. If group is unknown, safely fallback to `us_indices_core`.
3. Call `runResearch.run(definitions, account, options.research)`.
4. Print concise summary (loaded/failed, top symbols, top timeframes).

By default this inherits strict dataset quality from batch loading (`minCandles: 60`), so loaded/failed counts in summaries exclude empty, zero-candle, and too-short datasets.
By default it also enables quality-aware backtesting. To run with a single strategy (e.g. trend_breakout only), pass `research.multiAsset.includeStrategies: ['trend_breakout']`. To add breakout entry confirmation, pass `research.multiAsset.breakoutConfirmation: true`. To add breakout strength filter (body ≥ 60%, closeStrength ≥ 0.7), pass `research.multiAsset.breakoutStrengthFilter: true`. To restrict to one regime (e.g. BREAKOUT only), pass 6th arg: `node engine/exampleRunResearchFromConfig.js baseline '' '' '' BREAKOUT` or `node engine/exampleRunResearchFromConfig.js spy_only trend_breakout '' '' BREAKOUT`. To exclude the session open (no trades 09:30–10:00 ET), pass 7th arg `noopen`: `node engine/exampleRunResearchFromConfig.js us_indices_core trend_breakout strength noopen` or `node engine/exampleRunResearchFromConfig.js baseline '' '' '' '' noopen`. Example script: 3rd = strategy filter, 4th = `confirmed`, 5th = `strength`, 7th = `noopen`.

**Recommended pipeline (≈50–200 trades):** REGIME = BREAKOUT + BODY ≥ 60% + CLOSE IN EXTREME (closeStrength ≥ 0.7) + NO OPEN (excludeSessionOpenMinutes = 30) + TREND CONFIRMATION (breakoutConfirmation = true). Example: `node engine/exampleRunResearchFromConfig.js baseline '' '' '' BREAKOUT noopen` with `breakoutStrengthFilter: true` and `breakoutConfirmation: true` in config.

**After you get a small sample with good structure:** see `engine/RESEARCH_NEXT_STEPS.md` — Option 1: validate on more data. Option 2: stability by period (by-month breakdown + `performanceBreakdownByPeriod`). Option 3: audit trades (`exampleTradeSimulationFromResearch.js SPY 5m audit` → `research/trade_audit_SPY_5m.json`). The edge is in a very filtered subset of trend_breakout, not trend_breakout in general.

To force legacy path, set:

```js
{
  research: {
    multiAsset: { useQualityBacktest: false }
  }
}
```

### API

- `DEFAULT_GROUP` — `'us_indices_core'`
- `resolveGroup(groupName?)` — Returns `{ requestedGroup, resolvedGroup, usedDefaultGroup, availableGroups }`
- `run(groupName?, options?)` — Async. Returns:

```js
{
  requestedGroup: "spy_only",
  resolvedGroup: "spy_only",
  usedDefaultGroup: false,
  availableGroups: ["qqq_only", "spy_only", "nas100_only", "us_indices_core"],
  definitions: [ /* dataset definitions */ ],
  account: { equity: 500, dailyPnL: 0, openPositions: 0 },
  result: { batch: { ... }, multi: { ... } | null }
}
```

- `printSummary(runOutput, options?)` — Side effect: logs concise summary. Options can enable full `bySymbol` / `byTimeframe`.

### Example script

```bash
node engine/exampleRunResearchFromConfig.js baseline                 # current best baseline (SPY, trend_breakout, no filters)
node engine/exampleRunResearchFromConfig.js                         # default group, all strategies
node engine/exampleRunResearchFromConfig.js us_indices_core         # all strategies
node engine/exampleRunResearchFromConfig.js us_indices_core trend_breakout           # trend_breakout only
node engine/exampleRunResearchFromConfig.js us_indices_core trend_breakout confirmed # + one-bar confirmation
node engine/exampleRunResearchFromConfig.js us_indices_core trend_breakout strength  # + strength filter
node engine/exampleRunResearchFromConfig.js us_indices_core mean_reversion           # mean_reversion only
```

### Exact run commands by group

```bash
# us_indices_core (default)
node neuropilot_trading_v2/engine/exampleRunResearchFromConfig.js

# qqq_only
node neuropilot_trading_v2/engine/exampleRunResearchFromConfig.js qqq_only

# spy_only
node neuropilot_trading_v2/engine/exampleRunResearchFromConfig.js spy_only

# nas100_only
node neuropilot_trading_v2/engine/exampleRunResearchFromConfig.js nas100_only
```

---

## Webhook Bridge

Converts a normalized execution payload into a webhook request object compatible with neuropilot_trading_v2 POST `/webhook/tradingview`. Pure function; **no HTTP call** (caller performs the request).

**Inputs:** `payload` (from signalAdapter.toPayload), optional `config`: `baseUrl`, `secret`, `includeTimestamp`, `includeAlertId`, `path`.

**Output (valid payload):**

```js
{
  valid: true,
  url: "http://localhost:3014/webhook/tradingview",
  headers: { "Content-Type": "application/json" },
  body: {
    symbol: "XAUUSD",
    action: "BUY",
    price: 2677,
    quantity: 1.11,
    strategy: "trend_breakout",
    confidence: 0.82,
    regime: "TREND_UP",
    riskAmount: 5,
    stopDistance: 4.5,
    riskReward: 2.0,
    mode: "paper",
    source: "neuropilot_quant_v1",
    timestamp: 1700000000,
    alert_id: "quant_XAUUSD_1700000000",
    secret: "optional-secret"
  }
}
```

**Output (invalid payload):** `{ valid: false, url, headers, body: null }`.

**Rules:**

1. If `payload.valid` is false → return `valid: false`, `body: null`.
2. Default path = `/webhook/tradingview` (overridable via `config.path`).
3. If `baseUrl` is provided (e.g. `http://localhost:3014`), `url` is full URL; otherwise relative path.
4. `includeTimestamp` (default true): add `timestamp` (Unix seconds) to body.
5. `includeAlertId` (default true): add `alert_id` (e.g. `quant_XAUUSD_<timestamp>`); override prefix with `config.alertIdPrefix`.
6. If `config.secret` is provided, append to body (for webhook auth).
7. No HTTP call inside this module.

### Usage

```js
const { toWebhookRequest } = require('./engine/webhookBridge');

const request = toWebhookRequest(payload, {
  baseUrl: 'http://localhost:3014',
  secret: process.env.WEBHOOK_SECRET,
  includeTimestamp: true,
  includeAlertId: true,
});

if (request.valid) {
  await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
}
```

### API

- `toWebhookRequest(payload, config?)` — returns `{ valid, url, headers, body }`
- `buildUrl(baseUrl, path)` — build full or relative URL
- `buildBody(payload, config)` — build body object (used internally)
- `DEFAULT_PATH`, `DEFAULT_CONFIG`

### Example script

```bash
node neuropilot_trading_v2/engine/exampleWebhookBridge.js
```

---

## Local Execution Harness

Runs the full adaptive quant pipeline locally, converts the signal to a webhook request, **sends POST** to the running neuropilot_trading_v2 server, and returns a structured result. The only side effect is one HTTP POST to the webhook URL. No database writes in this module.

**Inputs:** `candles`, `account`, `ranking` (from strategyRanking.rank), `symbol`, optional `config`: `baseUrl`, `secret`, `pipeline`, `adaptive`, `adapter`, `webhook`, `index`.

**Behavior:** 1) Run adaptivePipeline. 2) Convert with signalAdapter.toPayload. 3) Convert with webhookBridge.toWebhookRequest. 4) If all valid, POST to webhook URL (native fetch). 5) Return result.

**Output (request sent):**

```js
{
  valid: true,
  adaptiveSignal: { ... },
  executionPayload: { ... },
  webhookRequest: { url, headers, body },
  httpStatus: 200,
  responseBody: { ... }
}
```

**Output (no request sent):** `valid: false`, `executionPayload` / `webhookRequest` set when available, `httpStatus: null`, `responseBody: { error: "No request sent: ..." }`.

**Output (request failed):** `httpStatus: 0`, `responseBody: { error: "<message>" }`.

**Rules:**

- If adaptive signal is invalid → do not send; return with `responseBody.error` explaining.
- If payload is invalid → do not send.
- If webhook request is invalid → do not send.
- Uses native `fetch` (Node 18+). Request errors are caught and returned in `responseBody.error`.

### Usage

```js
const localExecutionHarness = require('./engine/localExecutionHarness');
const strategyRanking = require('./engine/strategyRanking');
const performanceAnalyzer = require('./engine/performanceAnalyzer');
const adaptiveBacktestRunner = require('./engine/adaptiveBacktestRunner');

// Get ranking from prior backtest or analysis
const backtestResult = adaptiveBacktestRunner.run(candles, account, 'XAUUSD', '2m');
const analysis = performanceAnalyzer.analyze(backtestResult.records);
const ranking = strategyRanking.rank(analysis);

const result = await localExecutionHarness.run(candles, account, ranking, 'XAUUSD', {
  baseUrl: 'http://localhost:3014',
  secret: process.env.TRADINGVIEW_WEBHOOK_SECRET,
});

console.log(result.httpStatus, result.responseBody);
```

### Config

- `baseUrl` — default `http://localhost:3014`
- `secret` — optional webhook secret (appended to body)
- `pipeline`, `adaptive`, `adapter`, `webhook` — passed to adaptive pipeline, signal adapter, webhook bridge
- `index` — bar index for pipeline (default: last bar)

### Example script

Requires webhook server running at http://localhost:3014.

```bash
node neuropilot_trading_v2/engine/exampleLocalExecutionHarness.js
```

### End-to-end validation (Local Execution Harness)

Validation script runs: adaptive pipeline → signalAdapter → webhookBridge → POST to `http://localhost:3014/webhook/tradingview`, then checks that the response includes `orderIntent` or the expected rejection (e.g. kill switch). Keeps TRADING_ENABLED=false; no live trading.

**Exact command (from repo root):**

```bash
node neuropilot_trading_v2/engine/validateLocalExecutionHarness.js
```

**Prerequisites:** Webhook server running; `TRADINGVIEW_WEBHOOK_SECRET` set in the server environment and exported (or in `.env` loaded by the shell) so the harness can pass the same secret in the request body.

**Expected response (TRADING_ENABLED=false, kill switch active):**

- **HTTP 403** with JSON body containing:
  - `error`: `"Risk check failed"`
  - `message`: string containing `"Trading is disabled (kill switch active)"` (or similar)
  - `orderIntent`: object with `symbol`, `action`, `price`, `quantity`, etc.

Validation passes if the response has `orderIntent` or a message matching the expected rejection (e.g. kill switch). Exit code 0 on success, 1 on failure.

**Webhook auth in this local config:**

- Auth is **enforced** when `ENABLE_WEBHOOK_AUTH` is not set to `false` (default: true). The server requires either:
  1. **HMAC header:** `X-TradingView-Signature` with `sha256=HMAC-SHA256(rawBody, TRADINGVIEW_WEBHOOK_SECRET)`, or  
  2. **Body secret:** JSON field `secret` in the request body equal to `TRADINGVIEW_WEBHOOK_SECRET`.
- If `TRADINGVIEW_WEBHOOK_SECRET` is not set on the server, the server responds with **500** and a message that the env var is required (no request is authenticated).
- The engine uses **body secret** (webhookBridge adds `secret` to the body when `config.secret` is provided). The harness passes `process.env.TRADINGVIEW_WEBHOOK_SECRET` so one env var aligns with the server.

**Secret handling consistency:**

- **Server** reads the secret from `process.env.TRADINGVIEW_WEBHOOK_SECRET`.
- **Engine** (localExecutionHarness, example, validateLocalExecutionHarness) now passes `process.env.TRADINGVIEW_WEBHOOK_SECRET` as `config.secret`. Previously the example used `WEBHOOK_SECRET`; that was inconsistent and could cause 401/500 when the server expected `TRADINGVIEW_WEBHOOK_SECRET`. Using `TRADINGVIEW_WEBHOOK_SECRET` everywhere keeps auth consistent: set it once in server env (or `.env`) and the harness uses the same value.
