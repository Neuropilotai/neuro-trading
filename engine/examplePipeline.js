#!/usr/bin/env node
'use strict';

/**
 * Example: run full Signal Pipeline on synthetic OHLCV and account.
 * Run from repo root: node neuropilot_trading_v2/engine/examplePipeline.js
 */
const { run } = require('./signalPipeline');

// Synthetic candles: enough bars for EMAs/ATR (e.g. 60), slight uptrend
const base = 2640;
const candles = [];
for (let i = 0; i < 60; i++) {
  const o = base + i * 0.5 + (Math.random() - 0.5) * 4;
  const c = o + (Math.random() - 0.3) * 6;
  const h = Math.max(o, c) + Math.random() * 3;
  const l = Math.min(o, c) - Math.random() * 3;
  const v = 1000 + Math.floor(Math.random() * 500);
  candles.push({ open: o, high: h, low: l, close: c, volume: v });
}
candles[candles.length - 1].volume = 3500;
candles[candles.length - 1].close = base + 58 * 0.5 + 6;

const account = { equity: 500, dailyPnL: 0, openPositions: 0 };

const signal = run(candles, account);

console.log('Signal Pipeline output:');
console.log('  shouldTrade:', signal.shouldTrade);
console.log('  valid:', signal.valid);
console.log('  reason:', signal.reason);
console.log('  regime:', signal.regime);
console.log('  strategyDecision:', signal.strategyDecision);
console.log('  tradeDecision:', signal.tradeDecision);
console.log('  sizingDecision:', signal.sizingDecision);
console.log('  features (keys):', Object.keys(signal.features).join(', '));
