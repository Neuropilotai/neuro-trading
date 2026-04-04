#!/usr/bin/env node
'use strict';

/**
 * Example: calibrate Signal Quality Gate thresholds across configurations.
 * Run from repo root: node neuropilot_trading_v2/engine/exampleQualityGateCalibration.js
 */

const qualityGateCalibration = require('./qualityGateCalibration');

function makeCandles(n, base = 400) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = base + i * 0.05 + (Math.random() - 0.5) * 0.8;
    const c = o + (Math.random() - 0.5) * 1.2;
    out.push({
      open: o,
      high: Math.max(o, c) + Math.random() * 0.4,
      low: Math.min(o, c) - Math.random() * 0.4,
      close: c,
      volume: 1000 + Math.floor(Math.random() * 200),
      time: Date.UTC(2026, 0, 1) + i * 60000,
    });
  }
  return out;
}

const datasets = [
  { symbol: 'QQQ', timeframe: '1m', candles: makeCandles(180, 400) },
  { symbol: 'SPY', timeframe: '1m', candles: makeCandles(180, 500) },
];
const account = { equity: 500, dailyPnL: 0, openPositions: 0 };

const configs = qualityGateCalibration.buildConfigGrid({
  minFinalConfidence: [0.6, 0.65, 0.7],
  minRegimeConfidence: [0.35, 0.45, 0.55],
  minStrategyConfidence: [0.5, 0.6, 0.7],
  cooldownMs: [75000],
  minStopDistancePct: [0.0003],
  maxStopDistancePct: [0.02, 0.03],
});

const results = qualityGateCalibration.runCalibration(datasets, account, configs, {
  backtest: {
    barTimestamp: { baseMs: Date.UTC(2026, 0, 1), intervalMs: 60000 },
  },
  sortByAllowedRateDesc: true,
});

console.log('Calibration results (top 15 by allowedRate):');
console.log(results.slice(0, 15));
