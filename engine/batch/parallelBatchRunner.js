'use strict';

/**
 * Run many setup backtests in parallel (worker count = CPU cores).
 * OHLC cache: load dataset once, pass same candles to each runOne(setup, candles).
 *
 * Usage (when backtest is implemented):
 *   const candles = await loadCandlesOnce(dataGroup);
 *   const results = await runInParallel(setups, getWorkerCount(), (setup) => runOneBacktest(setup, candles));
 */

const { getWorkerCount } = require('./batchConfig');

/**
 * Run async tasks in parallel with a concurrency limit (no worker_threads, just Promise.all in chunks).
 *
 * @param {Array<T>} items - Items to process
 * @param {number} concurrency - Max concurrent runs (e.g. os.cpus().length)
 * @param {function(T): Promise<R>} fn - Async function per item
 * @returns {Promise<R[]>}
 * @template T, R
 */
async function runInParallel(items, concurrency, fn) {
  const n = Math.max(1, Number(concurrency) || getWorkerCount());
  const results = [];
  for (let i = 0; i < items.length; i += n) {
    const chunk = items.slice(i, i + n);
    const chunkResults = await Promise.all(chunk.map((item) => fn(item)));
    results.push(...chunkResults);
  }
  return results;
}

/**
 * Placeholder: load OHLC once for a dataGroup and return candles shared by all workers.
 * Replace with datasetLoader.loadFromFile (or streaming loader) so the same in-memory
 * cache is passed to each runOneBacktest(setup, candles).
 *
 * @param {string} dataGroup - e.g. spy_5m_2022_2025
 * @param {object} [dataRoot] - dataRoot.getPath('datasets') etc.
 * @returns {Promise<{ candles: Array, symbol: string, timeframe: string }>}
 */
async function loadOHLCCache(dataGroup, dataRoot) {
  if (typeof dataRoot === 'undefined') {
    dataRoot = require('../dataRoot');
  }
  // TODO: resolve dataGroup → file path, then datasetLoader.loadFromFile or streaming
  // For now return empty; runStrategyBatch stub does not use candles yet.
  return { candles: [], symbol: '', timeframe: '' };
}

module.exports = { runInParallel, loadOHLCCache, getWorkerCount };
