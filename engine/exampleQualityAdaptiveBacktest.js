#!/usr/bin/env node
'use strict';

/**
 * Example: run quality-aware adaptive backtest (qualityAdaptivePipeline replay -> records, analysis, ranking, report).
 * Run from repo root: node neuropilot_trading_v2/engine/exampleQualityAdaptiveBacktest.js
 */
const qualityAdaptiveBacktestRunner = require('./qualityAdaptiveBacktestRunner');

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

const result = qualityAdaptiveBacktestRunner.run(candles, account, 'XAUUSD', '2m', {
  barTimestamp: { baseMs: Date.UTC(2026, 0, 1), intervalMs: 120000 },
  qualityGate: {
    minFinalConfidence: 0.6,
    minRegimeConfidence: 0.45,
    minStrategyConfidence: 0.55,
    cooldownMs: 5 * 60 * 1000,
  },
  reportMetadata: { note: 'Quality-aware adaptive backtest example' },
});

console.log('Quality-aware adaptive backtest result:');
console.log('  totalBars:', result.totalBars);
console.log('  totalAdaptiveSignals:', result.totalAdaptiveSignals);
console.log('  validAdaptiveSignals:', result.validAdaptiveSignals);
console.log('  allowedSignals:', result.allowedSignals);
console.log('  blockedSignals:', result.blockedSignals);
console.log('  report.summary:', result.report.summary);
console.log('  report.recommendations:', result.report.recommendations);

