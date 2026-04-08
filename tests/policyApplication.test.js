#!/usr/bin/env node
'use strict';

/**
 * Policy application layer. Run: node tests/policyApplication.test.js
 */

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const closedTradeAnalyticsService = require('../backend/services/closedTradeAnalyticsService');
const reinforcementLearningService = require('../backend/services/reinforcementLearningService');
const policyApplicationService = require('../backend/services/policyApplicationService');

function winTrade(strategy, sym, i) {
  return closedTradeAnalyticsService.buildClosedTradeRecord({
    symbol: sym,
    entryPriceAvg: 100,
    exitPriceAvg: 102,
    closedQuantity: 1,
    realizedPnL: 2,
    entryTimestamp: `2026-04-01T${String(10 + (i % 5)).padStart(2, '0')}:00:00.000Z`,
    exitTimestamp: `2026-04-01T${String(11 + (i % 5)).padStart(2, '0')}:00:00.000Z`,
    closeReason: 'SELL',
    strategy,
    regime: 'trend',
    mfe: 3,
    mae: 0.2,
    efficiencyRatio: 0.65,
  });
}

function loseTrade(strategy, sym, i) {
  return closedTradeAnalyticsService.buildClosedTradeRecord({
    symbol: sym,
    entryPriceAvg: 100,
    exitPriceAvg: 97,
    closedQuantity: 1,
    realizedPnL: -3,
    entryTimestamp: `2026-04-02T${String(10 + (i % 5)).padStart(2, '0')}:00:00.000Z`,
    exitTimestamp: `2026-04-02T${String(11 + (i % 5)).padStart(2, '0')}:00:00.000Z`,
    closeReason: 'SELL',
    strategy,
    regime: 'chop',
    mfe: 0.5,
    mae: 4,
    efficiencyRatio: 0.05,
  });
}

async function withTempDataDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pol-test-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function run() {
  console.log('policyApplication tests…');

  const good = [];
  for (let i = 0; i < 20; i++) good.push(winTrade('good-strat', 'XAUUSD', i));
  const rlGood = reinforcementLearningService.computePolicyScores(good, []);
  const overview = {
    generatedAt: new Date().toISOString(),
    portfolio: { equity: 1000, bookEquity: 1000, grossExposure: 200 },
    riskDiagnostics: { drawdownProxy: 0.05, degradationFlags: [], unstableRegimes: [] },
    strategyAttribution: [{ expectancy: 1, groupKey: 'good-strat' }],
    degradationFlags: [],
    executionQuality: { tradeCount: 20 },
  };
  const polGood = policyApplicationService.applyPolicies(
    { ...rlGood, generatedAt: new Date().toISOString() },
    overview
  );
  const entGood = polGood.entities.filter((e) => e.entityType === 'strategy' && e.entityKey === 'good-strat');
  assert.ok(entGood.length >= 1);
  assert.strictEqual(entGood[0].eligible, true);
  assert.ok(entGood[0].score > -0.2, 'profitable book should score above weak');
  assert.ok(
    entGood[0].allocationMultiplier >= entGood[0].throttleFactor,
    'multipliers should be coherent'
  );

  const bad = [];
  for (let i = 0; i < 18; i++) bad.push(loseTrade('bad-strat', 'EURUSD', i));
  const rlBad = reinforcementLearningService.computePolicyScores(bad, []);
  const polBad = policyApplicationService.applyPolicies(
    { ...rlBad, generatedAt: new Date().toISOString() },
    overview
  );
  const entBad = polBad.entities.filter((e) => e.entityType === 'strategy' && e.entityKey === 'bad-strat');
  assert.ok(entBad.length >= 1);
  assert.ok(entBad[0].score < entGood[0].score);
  assert.ok(['throttle', 'demote', 'suspend'].includes(entBad[0].decision));

  const scLow = {
    bucketKey: 'strategy|lowconf',
    score: 0.5,
    confidence: 0.15,
    decision: 'promote',
    components: { expectancy: 0.1 },
  };
  const bLow = { tradeCount: 20, expectancy: 0.5 };
  const eLow = policyApplicationService.deriveEntityPolicy({
    entityType: 'strategy',
    entityKey: 'lowconf',
    scoreCard: scLow,
    bucketStats: bLow,
    globalDegradationFlags: [],
  });
  const entHigh = policyApplicationService.deriveEntityPolicy({
    entityType: 'strategy',
    entityKey: 'hiconf',
    scoreCard: { ...scLow, confidence: 0.95 },
    bucketStats: bLow,
    globalDegradationFlags: [],
  });
  assert.ok(eLow.allocationMultiplier < entHigh.allocationMultiplier);

  const manySuspend = {
    scoreCards: Array.from({ length: 5 }, (_, i) => ({
      bucketKey: `strategy|s${i}`,
      decision: 'suspend',
      score: -0.3,
      confidence: 0.7,
      components: {},
    })),
    buckets: {},
    generatedAt: new Date().toISOString(),
  };
  const polSus = policyApplicationService.applyPolicies(manySuspend, {
    portfolio: { equity: 500, bookEquity: 500, grossExposure: 400 },
    riskDiagnostics: { drawdownProxy: 0.5, degradationFlags: ['HIGH_DRAWDOWN_PRESSURE'] },
    strategyAttribution: [{ expectancy: -1 }],
    degradationFlags: ['HIGH_DRAWDOWN_PRESSURE'],
  });
  assert.ok(
    ['cautious', 'restricted', 'degraded', 'defensive'].includes(
      polSus.globalPolicy.portfolioRiskMode
    )
  );

  await withTempDataDir(async () => {
    const state = { generatedAt: '2026-01-01T00:00:00.000Z', entities: [{ x: 1 }], globalPolicy: {} };
    await policyApplicationService.savePolicyState(state);
    const loaded = await policyApplicationService.loadPolicyState();
    assert.strictEqual(loaded.entities.length, 1);
  });

  assert.strictEqual(policyApplicationService.parseEntityFromBucketKey('strategy|a').entityKey, 'a');
  assert.strictEqual(
    policyApplicationService.parseEntityFromBucketKey('symbol+hourUTC|XAUUSD|14').entityType,
    'symbol+hourUTC'
  );

  console.log('✅ policyApplication tests passed');
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
