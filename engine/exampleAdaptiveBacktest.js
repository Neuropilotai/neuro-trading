#!/usr/bin/env node
'use strict';

/**
 * Example: run Policy-Aware Backtest (adaptive pipeline bar-by-bar → records, analysis, ranking, report).
 * Run from repo root: node neuropilot_trading_v2/engine/exampleAdaptiveBacktest.js
 */
const adaptiveBacktestRunner = require('./adaptiveBacktestRunner');

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

const result = adaptiveBacktestRunner.run(candles, account, 'XAUUSD', '2m', {
  barTimestamp: { baseMs: Date.UTC(2026, 0, 1), intervalMs: 120000 },
  reportMetadata: { note: 'Adaptive backtest example' },
});

console.log('Adaptive backtest result:');
console.log('  totalBars:', result.totalBars);
console.log('  totalAdaptiveSignals:', result.totalAdaptiveSignals);
console.log('  validAdaptiveSignals:', result.validAdaptiveSignals);
console.log('  allowedSignals:', result.allowedSignals);
console.log('  blockedSignals:', result.blockedSignals);
console.log('  report.summary:', result.report.summary);
console.log('  report.recommendations:', result.report.recommendations);
