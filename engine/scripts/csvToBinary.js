#!/usr/bin/env node
'use strict';

/**
 * Convert a CSV OHLC dataset to the binary store (.bin) for 5×–20× faster loads.
 * Output is written next to the CSV (same dir, same base name, .bin extension).
 *
 * Usage:
 *   node engine/scripts/csvToBinary.js <path-to.csv> [symbol] [timeframe]
 *   node engine/scripts/csvToBinary.js /Volumes/TradingDrive/NeuroPilotAI/datasets/spy/spy_5m.csv SPY 5m
 *
 * If symbol/timeframe omitted, inferred from path (e.g. spy_5m.csv → SPY, 5m).
 */

const path = require('path');
const datasetLoader = require('../datasetLoader');
const { writeBinaryStore } = require('../datasetBinaryStore');

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node engine/scripts/csvToBinary.js <path-to.csv> [symbol] [timeframe]');
    process.exit(1);
  }
  const base = path.basename(csvPath, '.csv');
  const parts = base.toLowerCase().split('_');
  const symbol = process.argv[3] || (parts[0] ? parts[0].toUpperCase() : 'SPY');
  const timeframe = process.argv[4] || (parts[1] || '5m');

  const data = await datasetLoader.loadFromFile(csvPath, symbol, timeframe, { preferBinary: false });
  if (!data.candles || data.candles.length === 0) {
    console.error('No candles loaded from', csvPath);
    process.exit(1);
  }

  const binPath = path.join(path.dirname(csvPath), base + '.bin');
  const { bytes, count } = await writeBinaryStore(binPath, data);
  console.log('Written', binPath, '|', count, 'candles', '|', bytes, 'bytes');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
