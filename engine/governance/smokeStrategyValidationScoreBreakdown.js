#!/usr/bin/env node
'use strict';

/**
 * Smoke: scoreStrategy scoreBreakdown (observability, no scoring rule change).
 * Run: node engine/governance/smokeStrategyValidationScoreBreakdown.js
 */

const assert = require('assert');
const {
  computeScoreStrategyBreakdown,
  scoreStrategy,
  DEFAULT_MODE_RULES,
} = require('./computeStrategyValidationFramework');

const promo = DEFAULT_MODE_RULES.promotion;

{
  const m = {
    strategyId: 'EMA_pullback_v2',
    trades: 1397,
    expectancy: 0.00572698,
    profitFactor: 1.6016,
    maxBarsShare: 0.0007,
  };
  const flags = { warns: [], hardFails: [] };
  const b = computeScoreStrategyBreakdown(m, flags, promo);
  assert.strictEqual(b.base, 50);
  assert.strictEqual(b.samplePts, 12);
  assert.strictEqual(b.penalties, 0);
  assert.strictEqual(b.scoreBaseClamped, 85);
  assert.ok(Math.abs(b.expectancyPts - 11.3038) < 0.001);
  const { score, scoreBreakdown } = scoreStrategy(m, flags, promo);
  assert.strictEqual(score, 85);
  assert.strictEqual(scoreBreakdown.scoreBaseClamped, 85);
}

{
  const m = { strategyId: 'x', trades: 17, expectancy: 0.5, profitFactor: 2, maxBarsShare: 0 };
  const flags = { warns: [], hardFails: ['too_few_trades_hard'] };
  const b = computeScoreStrategyBreakdown(m, flags, promo);
  assert.strictEqual(b.samplePts, -20);
}

console.log('[smokeStrategyValidationScoreBreakdown] ok');
