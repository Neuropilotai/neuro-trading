#!/usr/bin/env node
'use strict';

/**
 * Discovery Engine — Step 1: Feature extraction.
 *
 * Builds a per-candle feature dataset for pattern discovery.
 * Each candle → vector: body_pct, range_pct, close_strength, trend_slope,
 * distance_from_ma20, volatility_state, session_phase, regime, etc.
 *
 * Usage:
 *   node engine/features/buildFeatureDataset.js <symbol> <timeframe> [dataGroup]
 *
 * Example:
 *   node engine/features/buildFeatureDataset.js SPY 5m spy_5m_2022_2025
 *
 * Output: research/features_<symbol>_<timeframe>.json
 *
 * TODO: Implement.
 * - Load candles (datasetLoader or batchLoader by group)
 * - For each bar compute: body_pct, range_pct, close_strength, trend_slope,
 *   distance_from_ma20, volatility_state, session_phase, regime (from existing engine)
 * - Write JSON array of feature vectors (one per bar, with bar index or time)
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');

async function buildFeatureDataset(symbol, timeframe, dataGroup) {
  const outDir = dataRoot.getPath('features');
  const outFile = path.join(outDir, `features_${(symbol || 'SPY').toUpperCase()}_${(timeframe || '5m').toLowerCase()}.json`);

  // TODO: load candles, compute features per bar, write JSON
  const placeholder = {
    _comment: 'TODO: replace with real feature extraction',
    symbol: (symbol || 'SPY').toUpperCase(),
    timeframe: (timeframe || '5m').toLowerCase(),
    dataGroup: dataGroup || null,
    featureVectors: [],
    schema: [
      'body_pct',
      'range_pct',
      'close_strength',
      'trend_slope',
      'distance_from_ma20',
      'volatility_state',
      'session_phase',
      'regime',
    ],
  };
  fs.writeFileSync(outFile, JSON.stringify(placeholder, null, 2), 'utf8');
  console.log('Written (stub):', outFile);
  return outFile;
}

async function main() {
  const symbol = process.argv[2] || 'SPY';
  const timeframe = process.argv[3] || '5m';
  const dataGroup = process.argv[4] || null;
  await buildFeatureDataset(symbol, timeframe, dataGroup);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { buildFeatureDataset };
