'use strict';

/**
 * Top-K Pruning — Keep only the top K setups by score at each pipeline stage.
 *
 * Example: 1M setups → top 50k after fast scan → top 5k after quick backtest → top 500 full → top 100 bootstrap → top 20 evolution.
 * Never process 1M setups at "full fidelity".
 *
 * Usage:
 *   const { pruneTopK } = require('./engine/discovery/pruneTopK');
 *   const top = pruneTopK(scoredList, 5000);
 */

/**
 * Sort by score descending and return first K entries.
 *
 * @param {Array<{ score: number, [key: string]: any }>} list - Scored setups (e.g. from fastVectorScan)
 * @param {number} K - Max number to keep
 * @param {{ scoreKey?: string }} [opts] - Key for score (default 'score')
 * @returns {Array}
 */
function pruneTopK(list, K, opts = {}) {
  const scoreKey = opts.scoreKey || 'score';
  const k = Math.max(0, Math.floor(Number(K)) || 0);
  if (!Array.isArray(list) || k === 0) return [];
  const sorted = [...list].sort((a, b) => (b[scoreKey] ?? -1e9) - (a[scoreKey] ?? -1e9));
  return sorted.slice(0, k);
}

/**
 * Prune and also enforce a minimum score threshold.
 */
function pruneTopKWithMinScore(list, K, minScore, opts = {}) {
  const scoreKey = opts.scoreKey || 'score';
  const filtered = (list || []).filter((x) => (x[scoreKey] ?? 0) >= (minScore ?? 0));
  return pruneTopK(filtered, K, opts);
}

module.exports = { pruneTopK, pruneTopKWithMinScore };
