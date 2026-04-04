#!/usr/bin/env node
'use strict';

/**
 * Example: run Multi-Asset Research (adaptive backtests across symbol/timeframe datasets).
 * Run from repo root: node neuropilot_trading_v2/engine/exampleMultiAssetRunner.js
 */
const multiAssetRunner = require('./multiAssetRunner');

function makeCandles(n, base = 2640) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = base + i * 0.3 + (Math.random() - 0.5) * 2;
    const c = o + (Math.random() - 0.2) * 4;
    out.push({
      open: o,
      high: Math.max(o, c) + Math.random() * 2,
      low: Math.min(o, c) - Math.random() * 2,
      close: c,
      volume: 1000 + Math.floor(Math.random() * 500),
      time: Date.UTC(2026, 0, 1) + i * 120000,
    });
  }
  return out;
}

const account = { equity: 500, dailyPnL: 0, openPositions: 0 };

const datasets = [
  { symbol: 'XAUUSD', timeframe: '2m', candles: makeCandles(120) },
  { symbol: 'XAUUSD', timeframe: '5m', candles: makeCandles(100) },
  { symbol: 'NAS100', timeframe: '2m', candles: makeCandles(120, 21000) },
  { symbol: 'NAS100', timeframe: '5m', candles: makeCandles(100, 21000) },
];

const result = multiAssetRunner.run(datasets, account, {
  barTimestamp: { baseMs: Date.UTC(2026, 0, 1), intervalMs: 120000 },
});

console.log('Multi-asset result:');
console.log('  runs:', result.runs.length);
console.log('  summary.bySymbol:', result.summary.bySymbol);
console.log('  summary.byTimeframe:', result.summary.byTimeframe);
console.log('  summary.topSymbols:', result.summary.topSymbols);
console.log('  summary.topTimeframes:', result.summary.topTimeframes);
