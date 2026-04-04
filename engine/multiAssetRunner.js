'use strict';

/**
 * NeuroPilot Quant Engine v1 — Multi-Asset Research Runner
 *
 * Runs adaptive backtests across multiple assets and timeframes, then summarizes
 * which symbols and timeframes perform best by signal quality. Pure function;
 * no database writes, no broker interaction.
 *
 * Inputs:
 *   - datasets: array of { symbol, timeframe, candles }
 *   - account: { equity, dailyPnL, openPositions }
 *   - options: optional (passed to selected backtest runner per run)
 *     - useQualityBacktest: boolean (default false). true -> qualityAdaptiveBacktestRunner
 *
 * Output:
 *   - { runs, summary: { bySymbol, byTimeframe, topSymbols, topTimeframes } }
 */

const path = require('path');
const fs = require('fs');
const adaptiveBacktestRunner = require('./adaptiveBacktestRunner');
const qualityAdaptiveBacktestRunner = require('./qualityAdaptiveBacktestRunner');

const ENGINE_ADAPTIVE = 'adaptiveBacktestRunner';
const ENGINE_QUALITY = 'qualityAdaptiveBacktestRunner';

/** Default stats shape for empty aggregation. */
const EMPTY_STATS = Object.freeze({
  totalAdaptiveSignals: 0,
  validAdaptiveSignals: 0,
  allowedSignals: 0,
  blockedSignals: 0,
  totalBars: 0,
});

/**
 * Aggregate one result into a stats object (mutable). Adds counts from result to acc.
 */
function addResultToStats(acc, result) {
  if (!result || typeof result !== 'object') return;
  acc.totalBars += typeof result.totalBars === 'number' ? result.totalBars : 0;
  acc.totalAdaptiveSignals += typeof result.totalAdaptiveSignals === 'number' ? result.totalAdaptiveSignals : 0;
  acc.validAdaptiveSignals += typeof result.validAdaptiveSignals === 'number' ? result.validAdaptiveSignals : 0;
  acc.allowedSignals += typeof result.allowedSignals === 'number' ? result.allowedSignals : 0;
  acc.blockedSignals += typeof result.blockedSignals === 'number' ? result.blockedSignals : 0;
}

/**
 * Summarize runs by symbol. Each symbol key holds aggregated stats across all timeframes for that symbol.
 *
 * @param {Array<{ symbol: string, timeframe: string, result: object }>} runs - Output runs from multi-asset runner
 * @returns {object} Map of symbol -> { totalAdaptiveSignals, validAdaptiveSignals, allowedSignals, blockedSignals, totalBars }
 */
function summarizeBySymbol(runs) {
  if (!Array.isArray(runs)) return {};
  const out = {};
  for (const run of runs) {
    const key = run.symbol != null ? String(run.symbol) : 'unknown';
    if (!out[key]) out[key] = { ...EMPTY_STATS };
    addResultToStats(out[key], run.result);
  }
  return out;
}

/**
 * Summarize runs by timeframe. Each timeframe key holds aggregated stats across all symbols.
 *
 * @param {Array<{ symbol: string, timeframe: string, result: object }>} runs
 * @returns {object} Map of timeframe -> { totalAdaptiveSignals, validAdaptiveSignals, allowedSignals, blockedSignals, totalBars }
 */
function summarizeByTimeframe(runs) {
  if (!Array.isArray(runs)) return {};
  const out = {};
  for (const run of runs) {
    const key = run.timeframe != null ? String(run.timeframe) : 'unknown';
    if (!out[key]) out[key] = { ...EMPTY_STATS };
    addResultToStats(out[key], run.result);
  }
  return out;
}

/**
 * Rank symbols by allowed signal count (descending). Secondary sort by validAdaptiveSignals.
 *
 * @param {object} bySymbol - Output of summarizeBySymbol(runs)
 * @returns {Array<{ symbol: string, totalAdaptiveSignals: number, validAdaptiveSignals: number, allowedSignals: number, ... }>}
 */
function rankSymbols(bySymbol) {
  if (!bySymbol || typeof bySymbol !== 'object') return [];
  const entries = Object.entries(bySymbol).map(([symbol, stats]) => ({
    symbol,
    ...stats,
  }));
  entries.sort((a, b) => {
    if (b.allowedSignals !== a.allowedSignals) return b.allowedSignals - a.allowedSignals;
    return (b.validAdaptiveSignals || 0) - (a.validAdaptiveSignals || 0);
  });
  return entries;
}

/**
 * Rank timeframes by allowed signal count (descending). Secondary sort by validAdaptiveSignals.
 *
 * @param {object} byTimeframe - Output of summarizeByTimeframe(runs)
 * @returns {Array<{ timeframe: string, totalAdaptiveSignals: number, validAdaptiveSignals: number, allowedSignals: number, ... }>}
 */
function rankTimeframes(byTimeframe) {
  if (!byTimeframe || typeof byTimeframe !== 'object') return [];
  const entries = Object.entries(byTimeframe).map(([timeframe, stats]) => ({
    timeframe,
    ...stats,
  }));
  entries.sort((a, b) => {
    if (b.allowedSignals !== a.allowedSignals) return b.allowedSignals - a.allowedSignals;
    return (b.validAdaptiveSignals || 0) - (a.validAdaptiveSignals || 0);
  });
  return entries;
}

/**
 * Run backtests for each dataset and build cross-asset summary. Pure function.
 *
 * @param {Array<{ symbol: string, timeframe: string, candles: Array }>} datasets - One entry per symbol/timeframe
 * @param {object} account - Account state for risk sizing
 * @param {object} [options] - Passed to selected runner (pipeline/adaptive/qualityGate/barTimestamp/etc.)
 * @returns {object} { backtestEngine, runs, summary: { bySymbol, byTimeframe, topSymbols, topTimeframes } }
 */
function run(datasets, account, options = {}) {
  const list = Array.isArray(datasets) ? datasets : [];
  const opts = options && typeof options === 'object' ? options : {};
  const useQualityBacktest = opts.useQualityBacktest === true;
  const debugExportAllowedSignals = opts.debugExportAllowedSignals;
  const backtestEngine = useQualityBacktest ? ENGINE_QUALITY : ENGINE_ADAPTIVE;
  const runner = useQualityBacktest ? qualityAdaptiveBacktestRunner : adaptiveBacktestRunner;
  const runnerOptions = { ...opts };
  delete runnerOptions.useQualityBacktest;
  delete runnerOptions.debugExportAllowedSignals;
  if (useQualityBacktest && debugExportAllowedSignals) {
    runnerOptions.debugCollectOnly = true;
  }
  const runs = [];

  for (const ds of list) {
    const symbol = ds.symbol != null ? String(ds.symbol) : 'UNKNOWN';
    const timeframe = ds.timeframe != null ? String(ds.timeframe) : 'unknown';
    const candles = Array.isArray(ds.candles) ? ds.candles : [];
    const result = runner.run(candles, account, symbol, timeframe, runnerOptions);
    runs.push({ symbol, timeframe, backtestEngine, result });
  }

  if (useQualityBacktest && debugExportAllowedSignals) {
    const aggregated = [];
    for (const r of runs) {
      const arr = r.result && Array.isArray(r.result.allowedSignalsDebug) ? r.result.allowedSignalsDebug : [];
      aggregated.push(...arr);
    }
    const exportPath = debugExportAllowedSignals === true
      ? qualityAdaptiveBacktestRunner.DEFAULT_DEBUG_EXPORT_PATH
      : (typeof debugExportAllowedSignals === 'string' ? debugExportAllowedSignals : null);
    if (exportPath) {
      try {
        fs.mkdirSync(path.dirname(exportPath), { recursive: true });
        fs.writeFileSync(exportPath, JSON.stringify(aggregated, null, 2), 'utf8');
      } catch (err) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[multiAssetRunner] debugExportAllowedSignals write failed:', err && err.message);
        }
      }
    }
  }

  const bySymbol = summarizeBySymbol(runs);
  const byTimeframe = summarizeByTimeframe(runs);
  const topSymbols = rankSymbols(bySymbol);
  const topTimeframes = rankTimeframes(byTimeframe);

  return {
    backtestEngine,
    runs,
    summary: {
      bySymbol,
      byTimeframe,
      topSymbols,
      topTimeframes,
    },
  };
}

module.exports = {
  run,
  ENGINE_ADAPTIVE,
  ENGINE_QUALITY,
  summarizeBySymbol,
  summarizeByTimeframe,
  rankSymbols,
  rankTimeframes,
  EMPTY_STATS,
  addResultToStats,
};
