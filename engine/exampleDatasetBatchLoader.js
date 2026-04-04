#!/usr/bin/env node
'use strict';

/**
 * Example: batch load datasets and optionally run multi-asset research.
 * Run from repo root: node neuropilot_trading_v2/engine/exampleDatasetBatchLoader.js
 */
const path = require('path');
const { loadBatch } = require('./datasetBatchLoader');
const multiAssetRunner = require('./multiAssetRunner');

async function main() {
  console.log('Dataset Batch Loader example\n');

  const fixturesDir = path.join(__dirname, 'fixtures');
  const definitions = [
    { filePath: path.join(fixturesDir, 'sample_ohlcv.json'), symbol: 'QQQ', timeframe: '1m' },
    { filePath: path.join(fixturesDir, 'sample_ohlcv.csv'), symbol: 'QQQ', timeframe: '1m' },
    { filePath: path.join(fixturesDir, 'missing.csv'), symbol: 'SPY', timeframe: '5m' },
  ];

  const result = await loadBatch(definitions, { failFast: false });

  console.log('loaded:', result.loaded);
  console.log('failed:', result.failed);
  if (result.errors.length > 0) {
    console.log('errors:', result.errors);
  }
  console.log('datasets:', result.datasets.length);
  result.datasets.forEach((d, i) => {
    console.log('  ', i + 1, d.symbol, d.timeframe, 'candles:', d.candles.length);
  });

  if (result.datasets.length > 0) {
    const account = { equity: 500, dailyPnL: 0, openPositions: 0 };
    const multi = multiAssetRunner.run(result.datasets, account);
    console.log('\nMulti-asset run: runs=', multi.runs.length, 'topSymbols=', multi.summary.topSymbols?.length ?? 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
