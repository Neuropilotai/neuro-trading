#!/usr/bin/env node
'use strict';

/**
 * Smoke: parallel learningScore vs strict score (no governance contract change).
 * Run: node engine/governance/smokeLearningScore.js
 */

const assert = require('assert');
const {
  computeLearningScoreBreakdown,
  scoreStrategy,
  DEFAULT_MODE_RULES,
} = require('./computeStrategyValidationFramework');

const promo = DEFAULT_MODE_RULES.promotion;

// EMA-like: strict uses log expectancy (not linear *10); learning shares same positive-expectancy scale.
{
  const m = {
    strategyId: 'EMA_pullback_v2',
    trades: 1397,
    wins: 269,
    losses: 1128,
    expectancy: 0.00572698,
    profitFactor: 1.6016,
    maxBarsShare: 0.0007,
    maxDrawdown: 3.142993,
    totalPnl: 8.0005935,
  };
  const flags = { warns: [], hardFails: [] };
  const { score } = scoreStrategy(m, flags, promo);
  const lb = computeLearningScoreBreakdown(m, flags, promo);
  assert.strictEqual(score, 85, 'strict score EMA-like (expectancy no longer ~0 pts)');
  assert.ok(score >= 80, 'promotion-tier strict when PF/sample/expectancy align');
  assert.ok(lb.finalScore >= 78 && lb.finalScore <= 90, `learning in plausible band got ${lb.finalScore}`);
  assert.strictEqual(lb.penalties, 0);
}

// ORB-like: low sample → learning penalized vs EMA on expectancy/PF scale
{
  const ema = {
    strategyId: 'EMA_pullback_v2',
    trades: 1397,
    expectancy: 0.00572698,
    profitFactor: 1.6016,
    maxBarsShare: 0,
    maxDrawdown: 3.14,
    totalPnl: 8,
  };
  const orb = {
    strategyId: 'ORB_breakout_v1',
    trades: 17,
    expectancy: 0.58941176,
    profitFactor: 2.0437,
    maxBarsShare: 0,
    maxDrawdown: 1.2,
    totalPnl: 10.02,
  };
  const flags = { warns: [], hardFails: [] };
  const le = computeLearningScoreBreakdown(ema, flags, promo);
  const lo = computeLearningScoreBreakdown(orb, flags, promo);
  assert.ok(
    lo.finalScore < le.finalScore,
    `ORB learning (${lo.finalScore}) should be below EMA learning (${le.finalScore}) with low sample`
  );
}

console.log('[smokeLearningScore] ok');
