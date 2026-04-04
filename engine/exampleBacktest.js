#!/usr/bin/env node
'use strict';

/**
 * Example: run Backtest Runner on synthetic OHLCV.
 * Run from repo root: node neuropilot_trading_v2/engine/exampleBacktest.js
 */
const { run, summarizeByRegime, summarizeByStrategy } = require('./backtestRunner');

const base = 2640;
const candles = [];
for (let i = 0; i < 120; i++) {
  const o = base + i * 0.3 + (Math.random() - 0.5) * 2;
  const c = o + (Math.random() - 0.2) * 4;
  candles.push({
    open: o,
    high: Math.max(o, c) + Math.random() * 2,
    low: Math.min(o, c) - Math.random() * 2,
    close: c,
    volume: 1000 + Math.floor(Math.random() * 500),
    time: Date.UTC(2026, 0, 1) + i * 120000,
  });
}

const account = { equity: 500, dailyPnL: 0, openPositions: 0 };
const result = run(candles, account, 'XAUUSD', '2m', {
  barTimestamp: { baseMs: Date.UTC(2026, 0, 1), intervalMs: 120000 },
});

console.log('Backtest result:');
console.log('  totalBars:', result.totalBars);
console.log('  totalSignals:', result.totalSignals);
console.log('  validSignals:', result.validSignals);
console.log('  tradeableSignals:', result.tradeableSignals);
console.log('  noTradeSignals:', result.noTradeSignals);
console.log('  summary.byRegime:', result.summary.byRegime);
console.log('  summary.byStrategy:', result.summary.byStrategy);
console.log('  summary.byDirection:', result.summary.byDirection);
console.log('  first record id:', result.records[0] && result.records[0].id);
console.log('  last record id:', result.records[result.records.length - 1] && result.records[result.records.length - 1].id);
