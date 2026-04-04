#!/usr/bin/env node
'use strict';

/**
 * Example: run quality-aware adaptive pipeline (adaptive pipeline + quality gate).
 * Run from repo root: node neuropilot_trading_v2/engine/exampleQualityAdaptivePipeline.js
 */
const qualityAdaptivePipeline = require('./qualityAdaptivePipeline');
const backtestRunner = require('./backtestRunner');
const performanceAnalyzer = require('./performanceAnalyzer');
const strategyRanking = require('./strategyRanking');

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

const context = {
  symbol: 'XAUUSD',
  nowMs: candles[candles.length - 1].time,
  recentSignals: [], // Optional: add recent same-symbol signals to trigger cooldown blocks
};

const result = qualityAdaptivePipeline.run(
  candles,
  account,
  ranking,
  context,
  {
    adaptivePipeline: {},
    qualityGate: {
      minFinalConfidence: 0.55,
      minRegimeConfidence: 0.4,
      minStrategyConfidence: 0.5,
      cooldownMs: 5 * 60 * 1000,
    },
  },
  candles.length - 1
);

console.log('Quality-aware adaptive pipeline output:');
console.log('  shouldTrade:', result.shouldTrade);
console.log('  valid:', result.valid);
console.log('  finalConfidence:', result.finalConfidence);
console.log('  finalDecision:', result.finalDecision);
console.log('  reason:', result.reason);
console.log('  policyDecision:', result.policyDecision);
console.log('  qualityDecision:', result.qualityDecision);
