#!/usr/bin/env node
'use strict';

/**
 * Example: run Backtest Runner then Performance Analyzer on synthetic data.
 * Run from repo root: node neuropilot_trading_v2/engine/examplePerformance.js
 */
const backtestRunner = require('./backtestRunner');
const performanceAnalyzer = require('./performanceAnalyzer');

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
const result = backtestRunner.run(candles, account, 'XAUUSD', '2m', {
  barTimestamp: { baseMs: Date.UTC(2026, 0, 1), intervalMs: 120000 },
});

const analysis = performanceAnalyzer.analyze(result.records);

console.log('Performance analysis:');
console.log('  totals:', analysis.totals);
console.log('  ratios:', {
  validRate: Math.round(analysis.ratios.validRate * 100) / 100,
  tradeableRate: Math.round(analysis.ratios.tradeableRate * 100) / 100,
});
console.log('  byRegime:', analysis.byRegime);
console.log('  byStrategy:', analysis.byStrategy);
console.log('  byDirection:', analysis.byDirection);
console.log('  noTradeReasons:', analysis.noTradeReasons);
console.log('  topRegime:', analysis.topRegime);
console.log('  topStrategy:', analysis.topStrategy);
