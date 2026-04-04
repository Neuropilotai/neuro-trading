'use strict';

/**
 * Discovery Engine — Step 2: Pattern discovery.
 *
 * Input: research/features_<symbol>_<timeframe>.json (per-bar feature vectors).
 * Goal: find patterns that precede winning trades (e.g. body > 60%, close_strength > 0.7,
 * session mid, trend_slope > 0). Methods: clustering (k-means, DBSCAN) or rule mining.
 *
 * Output: list of pattern descriptors that can be turned into candidate strategies.
 *
 * TODO: Implement.
 * - Load feature dataset
 * - Optionally load trade outcomes (win/loss per bar or per signal) to label "good" bars
 * - Cluster or mine rules (e.g. body_pct > 0.65, close_strength > 0.7, session_phase === 'mid')
 * - Return array of { name, rules: { body_pct_min?, close_strength_min?, session_phase?, regime? } }
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');

function loadFeatureDataset(symbol, timeframe) {
  const dir = dataRoot.getPath('features', false);
  const p = path.join(dir, `features_${symbol}_${timeframe}.json`);
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

/**
 * @param {object} options - { symbol, timeframe, method?: 'kmeans'|'rules'|'dbscan' }
 * @returns {Promise<Array<{ name: string, rules: object }>>}
 */
async function clusterPatterns(options = {}) {
  const symbol = (options.symbol || 'SPY').toUpperCase();
  const timeframe = (options.timeframe || '5m').toLowerCase();
  const data = loadFeatureDataset(symbol, timeframe);
  const vectors = data.featureVectors || [];
  // TODO: run clustering or rule mining on vectors; return patterns
  const placeholder = [
    { name: 'pattern_001', rules: { body_pct_min: 0.6, close_strength_min: 0.7, session_phase: 'mid' } },
    { name: 'pattern_002', rules: { body_pct_min: 0.65, close_strength_min: 0.75, regime: 'BREAKOUT' } },
  ];
  return placeholder;
}

module.exports = { clusterPatterns, loadFeatureDataset };
