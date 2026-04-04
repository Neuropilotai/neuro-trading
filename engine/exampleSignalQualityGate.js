#!/usr/bin/env node
'use strict';

/**
 * Example: evaluate adaptive signals with Signal Quality Gate.
 * Run from repo root: node neuropilot_trading_v2/engine/exampleSignalQualityGate.js
 */

const signalQualityGate = require('./signalQualityGate');

const adaptiveSignal = {
  shouldTrade: true,
  valid: true,
  symbol: 'QQQ',
  features: { price: 420.5, time: Date.UTC(2026, 0, 10, 14, 30) },
  regime: { regime: 'TREND_UP', confidence: 0.62 },
  strategyDecision: { strategy: 'trend_breakout', confidence: 0.64 },
  tradeDecision: { strategy: 'trend_breakout', confidence: 0.67 },
  sizingDecision: { stopDistance: 2.1 },
  finalConfidence: 0.7,
  finalDecision: 'favor',
};

const context = {
  symbol: 'QQQ',
  nowMs: Date.UTC(2026, 0, 10, 14, 30),
  recentSignals: [
    { symbol: 'QQQ', timeMs: Date.UTC(2026, 0, 10, 14, 26) }, // inside 5m cooldown -> block
    { symbol: 'SPY', timeMs: Date.UTC(2026, 0, 10, 14, 29) },
  ],
};

const blocked = signalQualityGate.evaluate(adaptiveSignal, context);
console.log('Blocked by cooldown:', blocked);

const passContext = {
  ...context,
  recentSignals: [{ symbol: 'QQQ', timeMs: Date.UTC(2026, 0, 10, 14, 20) }], // outside cooldown
};
const passed = signalQualityGate.evaluate(adaptiveSignal, passContext);
console.log('Passed:', passed);
