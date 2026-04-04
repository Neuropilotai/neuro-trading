#!/usr/bin/env node
'use strict';

/**
 * Learning Loop V1 smoke — suggestive insights only.
 * npm run test:paper-learning-v1-smoke
 */

const assert = require('assert');
const { computePaperLearningInsights, MIN_TRADES_PER_STRATEGY } = require('./computePaperLearningInsights');

// --- Empty / missing V2 ---
{
  const r = computePaperLearningInsights({ validTradeCount: 0 }, null);
  assert.strictEqual(r.learningInsightsVersion, '1.0.0');
  assert.strictEqual(r.safety.mode, 'suggestive_only');
  assert.strictEqual(r.safety.applied, false);
  assert.strictEqual(r.confidence, 'low');
  assert.strictEqual(r.strategyRanking.length, 0);
  assert.ok(r.suggestions.notes.some((n) => n.includes('missing')));
}

// --- Malformed byStrategy ---
{
  const v2 = { byStrategy: 'not-array', parseErrors: 0 };
  const r = computePaperLearningInsights({ validTradeCount: 10 }, v2);
  assert.strictEqual(r.strategyRanking.length, 0);
}

// --- Low trades global → confidence low ---
{
  const v2 = {
    parseErrors: 0,
    byStrategy: [
      { strategyId: 'only', trades: 10, winRate: 50, totalPnl: 1 },
    ],
  };
  const r = computePaperLearningInsights({ validTradeCount: 8, winRate: 50, totalPnl: 1 }, v2);
  assert.strictEqual(r.confidence, 'low');
  assert.ok(r.strategyRanking.length >= 1);
}

// --- Parse errors → low confidence + note ---
{
  const v2 = {
    parseErrors: 2,
    byStrategy: [
      { strategyId: 'a', trades: 10, winRate: 60, totalPnl: 2 },
      { strategyId: 'b', trades: 10, winRate: 40, totalPnl: -1 },
    ],
  };
  const r = computePaperLearningInsights({ validTradeCount: 20 }, v2);
  assert.strictEqual(r.confidence, 'low');
  assert.ok(r.suggestions.notes.some((n) => n.includes('parse')));
}

// --- Multi-strategy ranking + boost/reduce (≥3 eligible, 5+ trades each) ---
{
  const v2 = {
    parseErrors: 0,
    byStrategy: [
      { strategyId: 'best', trades: 6, winRate: 80, totalPnl: 10 },
      { strategyId: 'mid', trades: 6, winRate: 50, totalPnl: 0 },
      { strategyId: 'worst', trades: 6, winRate: 20, totalPnl: -5 },
    ],
  };
  const r = computePaperLearningInsights({ validTradeCount: 60, winRate: 50, totalPnl: 5 }, v2);
  assert.strictEqual(r.strategyRanking[0].strategyId, 'best');
  assert.strictEqual(r.strategyRanking[r.strategyRanking.length - 1].strategyId, 'worst');
  assert.strictEqual(r.summaryBestStrategyId, 'best');
  assert.strictEqual(r.summaryWorstStrategyId, 'worst');
  assert.ok(r.suggestions.strategiesToBoost.includes('best'));
  assert.ok(r.suggestions.strategiesToReduce.includes('worst'));
}

// --- Below MIN_TRADES excluded from ranking ---
{
  const v2 = {
    parseErrors: 0,
    byStrategy: [
      { strategyId: 'tiny', trades: 2, winRate: 100, totalPnl: 99 },
      { strategyId: 'ok', trades: 6, winRate: 50, totalPnl: 0 },
    ],
  };
  const r = computePaperLearningInsights({ validTradeCount: 8 }, v2);
  assert.strictEqual(r.strategyRanking.length, 1);
  assert.strictEqual(r.strategyRanking[0].strategyId, 'ok');
  assert.ok(r.suggestions.notes.some((n) => n.includes('insufficient_eligible')));
}

// --- All strategies below MIN_TRADES ---
{
  const v2 = {
    parseErrors: 0,
    byStrategy: [{ strategyId: 'tiny', trades: 2, winRate: 100, totalPnl: 1 }],
  };
  const r = computePaperLearningInsights({ validTradeCount: 2 }, v2);
  assert.strictEqual(r.strategyRanking.length, 0);
  assert.ok(r.suggestions.notes.some((n) => n.includes(String(MIN_TRADES_PER_STRATEGY))));
}

console.log('smokePaperLearningV1: all passed');
