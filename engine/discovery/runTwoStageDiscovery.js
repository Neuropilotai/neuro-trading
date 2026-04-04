#!/usr/bin/env node
'use strict';

/**
 * Two-Stage Discovery Orchestrator — Replace "setup files → batch stub" with the real flow:
 *
 *   load candles → feature matrix → parameter grid (in memory) → fast vector scan → top K → full backtest → write results
 *
 * Grid stays in memory (no thousands of setup_*.js). Full backtest runs only on survivors.
 *
 * Usage:
 *   node engine/discovery/runTwoStageDiscovery.js <symbol> <timeframe> [dataGroup]
 *   node engine/discovery/runTwoStageDiscovery.js SPY 5m spy_5m_2022_2025
 *
 * Params (env or defaults): patternCount=10, minSignals=20, topK=5000.
 */

const path = require('path');
const dataRoot = require('../dataRoot');
const { manifestKey } = require('../data/datasetManifest');
const { getDatasetGroup, GROUPS_REQUIRING_MERGE, definitionsForSymbol } = require('../researchConfig');
const datasetBatchLoader = require('../datasetBatchLoader');
const { buildFeatureMatrix } = require('../features/buildFeatureMatrix');
const { buildParameterGrid } = require('./parameterGridDiscovery');
const { loadGeneratedStrategyFiles, dedupeSetups } = require('./loadGeneratedStrategyFiles');
const { fastVectorScan } = require('./fastVectorScan');
const { pruneTopK } = require('./pruneTopK');
const { runTopKBacktests } = require('../batch/runTopKBacktests');
const { getWorkerCount } = require('../batch/batchConfig');
const { registerDataset } = require('../governance/datasetVersionTracker');

const DEFAULT_PATTERN_COUNT = 10;
const DEFAULT_MIN_SIGNALS = 20;
const DEFAULT_TOP_K = 5000;

/**
 * Resolve dataGroup to dataset definitions. Fallback for crypto (e.g. btcusdt_5m) when not in researchConfig.
 */
function getDefinitions(dataGroup, symbol, timeframe) {
  const key = (dataGroup || '').toString().trim().toLowerCase();
  let defs = getDatasetGroup(key);
  if (defs.length > 0) return { definitions: defs, merge: GROUPS_REQUIRING_MERGE.includes(key) };
  const sym = (symbol || key.split('_')[0] || 'SPY').toUpperCase();
  const tf = (timeframe || key.split('_')[1] || '5m').toLowerCase();
  const dataDir = path.join(dataRoot.getPath('datasets'), sym.toLowerCase());
  defs = definitionsForSymbol(sym, [tf], { dataDir });
  return { definitions: defs, merge: false };
}

/**
 * Load candles for a dataGroup (or symbol+timeframe). Returns first dataset's candles + symbol + timeframe.
 * When every definition was skipped only because of data guard (degraded critical), returns
 * { skippedDataGuard: true, manifestKey } instead of throwing — caller treats as non-fatal skip.
 */
async function loadCandlesForDataGroup(dataGroup, symbol, timeframe) {
  const { definitions, merge } = getDefinitions(dataGroup, symbol, timeframe);
  if (definitions.length === 0) throw new Error(`No dataset definitions for dataGroup=${dataGroup} symbol=${symbol} timeframe=${timeframe}`);
  const { datasets, loaded, errors } = await datasetBatchLoader.loadBatch(definitions, {
    mergeSameSymbolTimeframe: merge,
    minCandles: 100,
  });
  if (datasets.length === 0) {
    const onlyDataGuardSkips =
      errors.length > 0 &&
      errors.every((e) => e && String(e.message || '').trim() === 'skipped_data_guard_degraded');
    if (onlyDataGuardSkips) {
      const mk = manifestKey(symbol, timeframe);
      return { skippedDataGuard: true, manifestKey: mk, errors };
    }
    const msg = errors.length ? errors.map((e) => e.message).join('; ') : 'No datasets loaded';
    throw new Error(`Failed to load candles: ${msg}`);
  }
  const first = datasets[0];
  return { candles: first.candles, symbol: first.symbol, timeframe: first.timeframe };
}

/**
 * Run full two-stage pipeline: load → matrix → grid (memory) → fast scan → prune → backtest → write.
 *
 * @param {string} symbol - e.g. SPY
 * @param {string} timeframe - e.g. 5m
 * @param {string} [dataGroup] - e.g. spy_5m_2022_2025 (default: symbol_timeframe)
 * @param {{ patternCount?: number, minSignals?: number, topK?: number }} [opts]
 */
async function runTwoStageDiscovery(symbol, timeframe, dataGroup, opts = {}) {
  const sym = (symbol || 'SPY').toUpperCase();
  const tf = (timeframe || '5m').toLowerCase();
  const group = dataGroup || `${sym.toLowerCase()}_${tf}`;
  const patternCount = Math.max(1, Math.min(50, opts.patternCount ?? DEFAULT_PATTERN_COUNT));
  const minSignals = Math.max(1, opts.minSignals ?? DEFAULT_MIN_SIGNALS);
  const topK = Math.max(100, Math.min(50000, opts.topK ?? DEFAULT_TOP_K));

  console.log('Two-Stage Discovery:', sym, tf, 'dataGroup=', group);
  console.log('  patternCount=', patternCount, 'minSignals=', minSignals, 'topK=', topK);

  const loaded = await loadCandlesForDataGroup(group, sym, tf);
  if (loaded.skippedDataGuard) {
    const mk = loaded.manifestKey;
    console.error(
      JSON.stringify({
        event: 'non_fatal_skip_discovery',
        manifestKey: mk,
        reason: 'skipped_data_guard_degraded',
        dataGroup: group,
      })
    );
    console.error(
      `[NON_FATAL_SKIP] ${mk} degraded by data guard — two-stage discovery skipped (pipeline continues for other datasets)`
    );
    return { skippedDataGuard: true, manifestKey: mk, dataGroup: group };
  }
  const { candles, symbol: resSymbol, timeframe: resTf } = loaded;
  console.log('  1. Loaded candles:', candles.length);
  const firstTimestamp = candles.length
    ? Number(candles[0].ts || candles[0].timestamp || candles[0].time || 0)
    : null;
  const lastCandle = candles.length ? candles[candles.length - 1] : null;
  const lastTimestamp = lastCandle
    ? Number(lastCandle.ts || lastCandle.timestamp || lastCandle.time || 0)
    : null;
  const datasetVersionId = registerDataset(
    resSymbol,
    resTf,
    `${group}:${resSymbol}:${resTf}`,
    candles.length,
    {
      firstTimestamp: Number.isFinite(firstTimestamp) ? firstTimestamp : null,
      lastTimestamp: Number.isFinite(lastTimestamp) ? lastTimestamp : null,
    }
  );

  const featureMatrix = buildFeatureMatrix(candles, { symbol: resSymbol, timeframe: resTf });
  console.log('  2. Feature matrix:', featureMatrix.rows.length, 'rows');

  const patternNames = Array.from({ length: patternCount }, (_, i) => `pattern_${String(i + 1).padStart(3, '0')}`);
  const inMemorySetups = buildParameterGrid({ patternNames }).map((s) => ({
    ...s,
    source: 'grid',
    generation: 0,
  }));
  const generatedSetups = loadGeneratedStrategyFiles({
    dir: dataRoot.getPath('generated_strategies'),
    includePrefixes: ['setup_familyexp_', 'setup_mut_'],
  });
  const setups = dedupeSetups([...inMemorySetups, ...generatedSetups]);
  console.log('  3. Parameter grid (in memory):', inMemorySetups.length, '| generated:', generatedSetups.length, '| total (deduped):', setups.length, 'setups');

  const scored = fastVectorScan(featureMatrix, setups, { minSignals, winProxy: true });
  console.log('  4. Fast vector scan done:', scored.length, 'scored');

  const top = pruneTopK(scored, topK);
  console.log('  5. Prune top K:', top.length, 'survivors');

  const batchSlug = `${String(resSymbol).toUpperCase()}_${String(resTf).toLowerCase()}`;
  const requiredCandles = Math.max(1, candles.length || featureMatrix.rows?.length || 1);
  const loadedCandles = candles.length || featureMatrix.rows?.length || 0;
  const { results } = await runTopKBacktests(top, {
    dataGroup: group,
    symbol: resSymbol,
    timeframe: resTf,
    candles,
    featureMatrix: featureMatrix.rows || featureMatrix,
    requiredCandles,
    loadedCandles,
    datasetVersionId,
    experimentId: opts.experimentId || process.env.EXPERIMENT_ID || null,
    workers: getWorkerCount(),
    outPath: path.join(dataRoot.getPath('batch_results'), `strategy_batch_results_${batchSlug}.json`),
    walkforwardEnabled:
      opts.walkforwardEnabled != null
        ? !!opts.walkforwardEnabled
        : String(process.env.WALKFORWARD_ENABLED || '1') === '1',
  });
  console.log('  6. Full backtest on survivors:', results.length, 'results written');
  return { featureMatrix, setups: scored.length, survivors: top.length, results };
}

async function main() {
  const symbol = process.argv[2] || 'SPY';
  const timeframe = process.argv[3] || '5m';
  const dataGroup = process.argv[4] || null;
  const patternCount = parseInt(process.env.TWO_STAGE_PATTERN_COUNT, 10) || DEFAULT_PATTERN_COUNT;
  const minSignals = parseInt(process.env.TWO_STAGE_MIN_SIGNALS, 10) || DEFAULT_MIN_SIGNALS;
  const topK = parseInt(process.env.TWO_STAGE_TOP_K, 10) || DEFAULT_TOP_K;

  const result = await runTwoStageDiscovery(symbol, timeframe, dataGroup, {
    patternCount,
    minSignals,
    topK,
    experimentId: process.env.EXPERIMENT_ID || null,
    walkforwardEnabled: String(process.env.WALKFORWARD_ENABLED || '1') === '1',
  });
  if (result && result.skippedDataGuard) {
    process.exit(0);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runTwoStageDiscovery, loadCandlesForDataGroup, getDefinitions };
