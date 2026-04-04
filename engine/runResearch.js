'use strict';

/**
 * NeuroPilot Quant Engine v1 — Research Run Script
 *
 * Single entry point: load datasets from definitions → run multi-asset research → return full result.
 * Includes a helper to print a concise research summary. Async; no database writes.
 *
 * Input: dataset definitions array, account, optional options
 * Output: { batch: { datasets, loaded, failed, errors }, multi: { runs, summary } | null }
 */

const datasetBatchLoader = require('./datasetBatchLoader');
const multiAssetRunner = require('./multiAssetRunner');

/**
 * Run full research: load batch → multi-asset run (if any datasets loaded). Safe for empty inputs.
 *
 * @param {Array<{ filePath: string, symbol?: string, timeframe?: string, options?: object }>} definitions - Dataset definitions
 * @param {object} account - Account state for risk sizing (equity, dailyPnL, openPositions)
 * @param {object} [options] - { batchLoader: object, multiAsset: object } — passed to loadBatch and multiAssetRunner
 * @returns {Promise<{ batch: object, multi: object | null }>}
 */
async function run(definitions, account, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const list = Array.isArray(definitions) ? definitions : [];
  const batchOptions = opts.batchLoader && typeof opts.batchLoader === 'object' ? opts.batchLoader : {};
  const multiOptions = opts.multiAsset && typeof opts.multiAsset === 'object' ? opts.multiAsset : {};

  const batch = await datasetBatchLoader.loadBatch(list, batchOptions);

  let multi = null;
  if (batch.loaded > 0 && Array.isArray(batch.datasets) && batch.datasets.length > 0) {
    const acc = account && typeof account === 'object' ? account : { equity: 0, dailyPnL: 0, openPositions: 0 };
    multi = multiAssetRunner.run(batch.datasets, acc, multiOptions);
  }

  return { batch, multi };
}

/**
 * Print a readable research summary to the console. Handles empty or partial results safely.
 *
 * @param {object} result - Output from runResearch.run() — { batch, multi }
 * @param {object} [options] - { includeBySymbol: boolean, includeByTimeframe: boolean } — default both true
 */
function printSummary(result, options = {}) {
  const opts = { includeBySymbol: true, includeByTimeframe: true, includeTotals: true, ...options };
  if (!result || typeof result !== 'object') {
    console.log('Research summary: (no result)');
    return;
  }

  const batch = result.batch;
  const loaded = batch && typeof batch.loaded === 'number' ? batch.loaded : 0;
  const failed = batch && typeof batch.failed === 'number' ? batch.failed : 0;
  const errors = batch && Array.isArray(batch.errors) ? batch.errors : [];

  console.log('--- Research run ---');
  console.log('Datasets: loaded', loaded, 'failed', failed);
  if (errors.length > 0) {
    errors.forEach((e) => console.log('  error:', e.filePath, '—', e.message));
  }

  const multi = result.multi;
  const summary = multi && multi.summary && typeof multi.summary === 'object'
    ? multi.summary
    : { topSymbols: [], topTimeframes: [], bySymbol: {}, byTimeframe: {} };
  const runs = multi && Array.isArray(multi.runs) ? multi.runs : [];
  const backtestEngine = multi && typeof multi.backtestEngine === 'string' ? multi.backtestEngine : 'none';
  const topSymbols = summary.topSymbols && Array.isArray(summary.topSymbols) ? summary.topSymbols : [];
  const topTimeframes = summary.topTimeframes && Array.isArray(summary.topTimeframes) ? summary.topTimeframes : [];

  console.log('Backtest engine:', backtestEngine);
  console.log('topSymbols:', topSymbols);
  console.log('topTimeframes:', topTimeframes);

  if (opts.includeTotals) {
    const totals = runs.reduce((acc, run) => {
      const r = run && run.result && typeof run.result === 'object' ? run.result : {};
      acc.allowedSignals += Number.isFinite(r.allowedSignals) ? r.allowedSignals : 0;
      acc.blockedSignals += Number.isFinite(r.blockedSignals) ? r.blockedSignals : 0;
      acc.validAdaptiveSignals += Number.isFinite(r.validAdaptiveSignals) ? r.validAdaptiveSignals : 0;
      acc.totalAdaptiveSignals += Number.isFinite(r.totalAdaptiveSignals) ? r.totalAdaptiveSignals : 0;
      return acc;
    }, { allowedSignals: 0, blockedSignals: 0, validAdaptiveSignals: 0, totalAdaptiveSignals: 0 });

    console.log('allowedSignals:', totals.allowedSignals);
    console.log('blockedSignals:', totals.blockedSignals);
    console.log('validAdaptiveSignals:', totals.validAdaptiveSignals);
    console.log('totalAdaptiveSignals:', totals.totalAdaptiveSignals);
  }

  if (opts.includeBySymbol && summary.bySymbol && typeof summary.bySymbol === 'object') {
    console.log('bySymbol:', JSON.stringify(summary.bySymbol, null, 2));
  }
  if (opts.includeByTimeframe && summary.byTimeframe && typeof summary.byTimeframe === 'object') {
    console.log('byTimeframe:', JSON.stringify(summary.byTimeframe, null, 2));
  }

  if (!multi || !multi.summary) {
    console.log('Multi-asset: (none — no datasets loaded)');
  }
}

module.exports = {
  run,
  printSummary,
};
