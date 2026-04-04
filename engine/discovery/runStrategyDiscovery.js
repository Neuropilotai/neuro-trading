#!/usr/bin/env node
'use strict';

/**
 * Discovery Engine — One command to run the full pipeline.
 *
 * Usage:
 *   node engine/discovery/runStrategyDiscovery.js <symbol> <timeframe> [dataGroup]
 *
 * Example:
 *   node engine/discovery/runStrategyDiscovery.js SPY 5m
 *   node engine/discovery/runStrategyDiscovery.js SPY 5m spy_5m_2022_2025
 *
 * Pipeline:
 *   1. Feature extraction   → research/features_<symbol>_<tf>.json
 *   2. Pattern discovery     → list of patterns (clusterPatterns)
 *   3. Generate strategies  → engine/generatedStrategies/setup_XXX.js
 *   4. Backtest batch       → research/strategy_batch_results.json
 *   5. Bootstrap batch      → bootstrap_risk per setup
 *   6. Ranking              → research/discovered_setups.json (filter: expectancy > 0, trades >= 30, bootstrap < 20%)
 *
 * See engine/DISCOVERY_ENGINE.md for full spec.
 */

const path = require('path');
const dataRoot = require('../dataRoot');
const { buildFeatureDataset } = require('../features/buildFeatureDataset');
const { clusterPatterns } = require('./clusterPatterns');
const { generateCandidateStrategies } = require('./generateCandidateStrategies');
const { runStrategyBatch } = require('../batch/runStrategyBatch');
const { bootstrapBatch } = require('../validation/bootstrapBatch');

async function runStrategyDiscovery(symbol, timeframe, dataGroup) {
  const sym = (symbol || 'SPY').toUpperCase();
  const tf = (timeframe || '5m').toLowerCase();
  const group = dataGroup || `spy_5m_2022_2025`;

  console.log('Discovery pipeline:', sym, tf, group);
  console.log('');

  console.log('1. Feature extraction…');
  await buildFeatureDataset(sym, tf, group);

  console.log('2. Pattern discovery…');
  const patterns = await clusterPatterns({ symbol: sym, timeframe: tf });
  console.log('   Patterns found:', patterns.length);

  console.log('3. Generate candidate strategies…');
  const written = generateCandidateStrategies(patterns);
  console.log('   Written:', written.length, 'files');

  console.log('4. Backtest batch…');
  await runStrategyBatch(group, dataRoot.getPath('generated_strategies'));

  console.log('5. Bootstrap batch…');
  await bootstrapBatch(null);

  const discoveryDir = dataRoot.getPath('discovery');
  console.log('6. Ranking →', path.join(discoveryDir, 'discovered_setups.json'));
  if (dataRoot.isUsingExternalDrive()) {
    console.log('   Data root:', dataRoot.getDataRoot(), '(5TB)');
  } else {
    console.log('   Data root:', dataRoot.getDataRoot(), '(local fallback)');
  }
  console.log('');
  console.log('Done. See discovery/discovered_setups.json (stub until steps 1–5 are implemented).');
}

async function main() {
  const symbol = process.argv[2] || 'SPY';
  const timeframe = process.argv[3] || '5m';
  const dataGroup = process.argv[4] || null;
  await runStrategyDiscovery(symbol, timeframe, dataGroup);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runStrategyDiscovery };
