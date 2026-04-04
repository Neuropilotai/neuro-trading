#!/usr/bin/env node
'use strict';

/**
 * Example: generate a research report from backtest → analysis → ranking.
 * Run from repo root: node neuropilot_trading_v2/engine/exampleResearchReport.js
 */
const backtestRunner = require('./backtestRunner');
const performanceAnalyzer = require('./performanceAnalyzer');
const strategyRanking = require('./strategyRanking');
const researchReport = require('./researchReport');

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
const ranking = strategyRanking.rank(analysis);

const report = researchReport.generate(analysis, ranking, {
  symbol: 'XAUUSD',
  timeframe: '2m',
  note: 'Example research run',
});

console.log('Research report:');
console.log('  generatedAt:', report.generatedAt);
console.log('  summary:', report.summary);
console.log('  ranking.topStrategies:', report.ranking.topStrategies.length);
console.log('  ranking.topRegimes:', report.ranking.topRegimes.length);
console.log('  recommendations:', report.recommendations);
console.log('  notes:', report.notes);
