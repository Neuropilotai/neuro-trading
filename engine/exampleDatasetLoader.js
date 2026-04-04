#!/usr/bin/env node
'use strict';

/**
 * Example: load and normalize OHLCV from JSON or CSV using Dataset Loader.
 * Run from repo root: node neuropilot_trading_v2/engine/exampleDatasetLoader.js
 */
const path = require('path');
const datasetLoader = require('./datasetLoader');

async function main() {
  console.log('Dataset Loader example\n');

  const jsonPath = path.join(__dirname, 'fixtures', 'sample_ohlcv.json');
  try {
    const out = await datasetLoader.loadFromFile(jsonPath, 'QQQ', '1m');
    console.log('JSON load:', out.symbol, out.timeframe, 'candles:', out.candles.length);
    if (out.candles.length > 0) console.log('  first candle:', out.candles[0]);
  } catch {
    console.log('No fixtures/sample_ohlcv.json; demonstrating parseJSON with inline data.');
    const inline = JSON.stringify([
      { timestamp: 1700000000, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
      { t: 1700000060, o: 100.5, h: 102, l: 100, c: 101, v: 1200 },
    ]);
    const out = datasetLoader.parseJSON(inline, 'QQQ', '1m');
    console.log('parseJSON:', out.symbol, out.timeframe, 'candles:', out.candles.length);
    console.log('  first:', out.candles[0]);
  }

  const csvPath = path.join(__dirname, 'fixtures', 'sample_ohlcv.csv');
  try {
    const out = await datasetLoader.loadFromFile(csvPath, 'QQQ', '1m');
    console.log('\nCSV load:', out.symbol, out.timeframe, 'candles:', out.candles.length);
    if (out.candles.length > 0) console.log('  first candle:', out.candles[0]);
  } catch {
    console.log('\nNo fixtures/sample_ohlcv.csv; demonstrating parseCSV with inline data.');
    const csv = `timestamp,open,high,low,close,volume
1700000000,100,101,99,100.5,1000
1700000060,100.5,102,100,101,1200`;
    const out = datasetLoader.parseCSV(csv, 'QQQ', '1m');
    console.log('parseCSV:', out.symbol, out.timeframe, 'candles:', out.candles.length);
    console.log('  first:', out.candles[0]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
