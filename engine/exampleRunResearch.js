#!/usr/bin/env node
'use strict';

/**
 * Example: run research (load datasets from definitions → multi-asset run → print summary).
 * Run from repo root: node neuropilot_trading_v2/engine/exampleRunResearch.js
 */
const path = require('path');
const runResearch = require('./runResearch');

async function main() {
  const fixturesDir = path.join(__dirname, 'fixtures');
  const definitions = [
    { filePath: path.join(fixturesDir, 'sample_ohlcv.json'), symbol: 'QQQ', timeframe: '1m' },
    { filePath: path.join(fixturesDir, 'sample_ohlcv.csv'), symbol: 'QQQ', timeframe: '1m' },
  ];
  const account = { equity: 500, dailyPnL: 0, openPositions: 0 };

  const result = await runResearch.run(definitions, account);
  runResearch.printSummary(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
