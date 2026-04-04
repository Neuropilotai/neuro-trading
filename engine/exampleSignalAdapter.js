#!/usr/bin/env node
'use strict';

/**
 * Example: convert adaptive signal to execution payload via Signal Adapter.
 * Run from repo root: node neuropilot_trading_v2/engine/exampleSignalAdapter.js
 */
const adaptivePipeline = require('./adaptivePipeline');
const backtestRunner = require('./backtestRunner');
const performanceAnalyzer = require('./performanceAnalyzer');
const strategyRanking = require('./strategyRanking');
const signalAdapter = require('./signalAdapter');

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

const backtestResult = backtestRunner.run(candles, account, 'XAUUSD', '2m', {
  barTimestamp: { baseMs: Date.UTC(2026, 0, 1), intervalMs: 120000 },
});
const analysis = performanceAnalyzer.analyze(backtestResult.records);
const ranking = strategyRanking.rank(analysis);

const adaptive = adaptivePipeline.run(candles, account, ranking, {}, candles.length - 1);
const payload = signalAdapter.toPayload(adaptive, 'XAUUSD', { mode: 'paper' });

console.log('Execution payload:');
console.log(JSON.stringify(payload, null, 2));

if (payload.valid) {
  console.log('\nReady for paper-trading / webhook:', payload.action, payload.quantity, '@', payload.price);
} else {
  console.log('\nNo trade:', payload.valid);
}
