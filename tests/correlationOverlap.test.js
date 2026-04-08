#!/usr/bin/env node
'use strict';

/**
 * Correlation / overlap / crowding. Run: node tests/correlationOverlap.test.js
 */

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const cos = require('../backend/services/correlationOverlapService');
const policyApplicationService = require('../backend/services/policyApplicationService');

async function withTempDataDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'co-test-'));
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
  console.log('correlationOverlap tests…');

  const pRows = cos.buildExposureRowsFromPolicy({
    entities: [
      {
        entityType: 'strategy',
        entityKey: 'S1',
        decision: 'promote',
        confidence: 0.8,
        allocationMultiplier: 1.2,
        eligible: true,
        policyRiskLevel: 'low',
      },
      {
        entityType: 'symbol',
        entityKey: 'EURUSD',
        decision: 'keep',
        confidence: 0.7,
        allocationMultiplier: 1,
        eligible: true,
      },
    ],
  });
  assert.ok(pRows.some((r) => r.entityKey === 'S1'));

  const aRows = cos.buildExposureRowsFromAllocation({
    generatedAt: new Date().toISOString(),
    portfolio: { recommendedDeployableCapital: 1000 },
    strategyAllocations: [{ strategy: 'S1', weight: 0.6, decision: 'promote', confidence: 0.8, eligible: true }],
    symbolAllocations: [{ symbol: 'EURUSD', weight: 0.4, decision: 'keep', confidence: 0.7, eligible: true }],
  });
  assert.strictEqual(aRows.length, 2);

  const trades = [
    {
      symbol: 'EURUSD',
      strategy: 'S1',
      regime: 'trend',
      realizedPnL: 1,
      holdingTimeMin: 30,
      exitTimestamp: '2026-01-01T12:00:00.000Z',
      realizedPnLPercent: 0.5,
    },
    {
      symbol: 'GBPUSD',
      strategy: 'S2',
      regime: 'trend',
      realizedPnL: 2,
      holdingTimeMin: 20,
      exitTimestamp: '2026-01-01T14:00:00.000Z',
      realizedPnLPercent: 0.4,
    },
  ];
  const tRows = cos.buildExposureRowsFromClosedTrades(trades);
  assert.ok(tRows.length >= 2);

  const merged = cos.mergeExposureRows(pRows, aRows, tRows);
  assert.ok(merged.length >= 1);

  const ov = cos.computeStrategySymbolOverlap(merged);
  assert.ok(typeof ov.sameStrategyMultiSymbolOverlap === 'number');

  const symClusters = cos.computeClusterOverlap(merged, 'symbol');
  assert.ok(Array.isArray(symClusters));

  const mat = cos.computePairwiseOverlapMatrix(merged, {}, null);
  assert.ok(Array.isArray(mat.pairs));
  if (mat.pairs.length) {
    const p = mat.pairs[0];
    assert.ok('pairKeyA' in p && 'pairKeyB' in p && 'overlapScore' in p && 'components' in p);
    assert.ok(p.overlapScore >= 0 && p.overlapScore <= 1);
  }

  const crowding = cos.computePortfolioCrowding(merged, { symbol: symClusters, strategy: [], regime: [] }, mat);
  assert.ok(crowding.totalCrowdingScore >= 0 && crowding.totalCrowdingScore <= 1);

  const corr = cos.computeRealizedCorrelationFromClosedTrades([]);
  assert.ok(corr.pairs && typeof corr.pairs === 'object');

  const many = [];
  for (let i = 0; i < 12; i++) {
    many.push({
      symbol: 'AAA',
      strategy: 'S',
      regime: 'r',
      realizedPnL: i % 2 === 0 ? 1 : -1,
      holdingTimeMin: 10,
      exitTimestamp: `2026-02-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
      realizedPnLPercent: i,
    });
    many.push({
      symbol: 'BBB',
      strategy: 'S',
      regime: 'r',
      realizedPnL: 0.5,
      holdingTimeMin: 10,
      exitTimestamp: `2026-02-${String((i % 28) + 1).padStart(2, '0')}T11:00:00.000Z`,
      realizedPnLPercent: i * 0.5,
    });
  }
  const corr2 = cos.computeRealizedCorrelationFromClosedTrades(many);
  const hasCorr = Object.values(corr2.pairs).some((x) => x.correlation != null);
  assert.ok(hasCorr || Object.keys(corr2.pairs).length === 0);

  await withTempDataDir(async () => {
    const state = await cos.buildCorrelationOverlapState({
      policyState: { generatedAt: new Date().toISOString(), entities: [] },
      allocationPlan: {
        generatedAt: new Date().toISOString(),
        portfolio: { recommendedDeployableCapital: 500 },
        strategyAllocations: [
          { strategy: 'S1', weight: 1, decision: 'promote', confidence: 0.9, eligible: true },
        ],
        symbolAllocations: [
          { symbol: 'EURUSD', weight: 1, decision: 'keep', confidence: 0.8, eligible: true },
        ],
      },
      closedTrades: trades,
    });
    assert.strictEqual(state.correlationOverlapVersion, cos.CORRELATION_OVERLAP_VERSION);
    assert.ok(state.summary);
    await cos.saveLatestCorrelationOverlapState(state);
    const loaded = await cos.loadLatestCorrelationOverlapState();
    assert.strictEqual(loaded.generatedAt, state.generatedAt);
    await cos.appendCorrelationOverlapHistory(state);
    const hist = await cos.readCorrelationOverlapHistory(5);
    assert.ok(hist.length >= 1);
  });

  const basePolicy = policyApplicationService.applyPolicies(
    {
      generatedAt: new Date().toISOString(),
      scoreCards: [
        {
          bucketKey: 'strategy|S1',
          score: 0.8,
          confidence: 0.85,
          decision: 'promote',
          components: {},
        },
      ],
      buckets: { 'strategy|S1': { tradeCount: 20 } },
    },
    { generatedAt: new Date().toISOString(), portfolio: {}, riskDiagnostics: {}, degradationFlags: [] }
  );

  const overlapState = await cos.buildCorrelationOverlapState({
    policyState: basePolicy,
    allocationPlan: {},
    closedTrades: [
      ...trades,
      { symbol: 'EURUSD', strategy: 'S1', regime: 'trend', realizedPnL: 1, holdingTimeMin: 5, exitTimestamp: '2026-01-02T12:00:00.000Z' },
      { symbol: 'EURUSD', strategy: 'S2', regime: 'trend', realizedPnL: 1, holdingTimeMin: 5, exitTimestamp: '2026-01-03T12:00:00.000Z' },
    ],
  });

  const adj = cos.applyPolicyCrowdingPenalties(basePolicy, overlapState);
  assert.ok(Array.isArray(adj.entities));
  const e0 = adj.entities.find((x) => x.entityKey === 'S1');
  assert.ok(e0);
  assert.ok('crowdingScore' in e0 && 'overlapPenaltyMultiplier' in e0);
  assert.ok(adj.globalPolicyCrowding.crowdingMode);

  const plan = {
    portfolio: { recommendedDeployableCapital: 1000 },
    strategyAllocations: [
      { strategy: 'S1', weight: 0.7, recommendedCapital: 700, decision: 'keep', confidence: 0.8, eligible: true },
    ],
    symbolAllocations: [
      { symbol: 'EURUSD', weight: 0.5, recommendedCapital: 500, decision: 'keep', confidence: 0.8, eligible: true },
    ],
    diagnostics: {},
  };
  const prevWarn = process.env.CROWDING_WARN_THRESHOLD;
  process.env.CROWDING_WARN_THRESHOLD = '0.01';
  const capped = cos.applyCrowdingCaps(plan, overlapState);
  assert.ok(capped.crowdingAdjusted === true || capped.crowdingAdjusted === false);
  assert.ok(capped.plan.strategyAllocations);
  if (prevWarn === undefined) delete process.env.CROWDING_WARN_THRESHOLD;
  else process.env.CROWDING_WARN_THRESHOLD = prevWarn;

  const stab = require('../backend/services/policyStabilityService');
  const d = stab.buildPolicyStabilityDiagnostics(
    { generatedAt: 'b', entities: [], globalPolicy: {} },
    { generatedAt: 'a', entities: [], globalPolicy: {} },
    { diagnostics: {} },
    { diagnostics: {} },
    {
      crowdingDiagnostics: { totalCrowdingScore: 0.2 },
      matrices: { pairwiseTop: [{ pairKeyA: 'a', pairKeyB: 'b', overlapScore: 0.3 }] },
      overlapDiagnostics: { duplicateExpressionCount: 0 },
    },
    {
      crowdingDiagnostics: { totalCrowdingScore: 0.45, symbolCrowdingScore: 0.2, strategyCrowdingScore: 0.2 },
      matrices: { pairwiseTop: [{ pairKeyA: 'a', pairKeyB: 'b', overlapScore: 0.55 }] },
      overlapDiagnostics: { duplicateExpressionCount: 3 },
    }
  );
  assert.ok(d.overlap);
  assert.ok(Array.isArray(d.overlap.overlapStabilityFlags));

  const shadow = require('../backend/services/shadowAllocationService');
  const dec = shadow.buildShadowAllocationDecision({
    tradeDecision: { strategy: 'S1', symbol: 'EURUSD', notional: 80 },
    allocationPlan: plan,
    policyState: {
      entities: [
        { entityType: 'strategy', entityKey: 'S1', eligible: true, overlapPenaltyMultiplier: 0.9 },
        { entityType: 'symbol', entityKey: 'EURUSD', eligible: true },
      ],
      globalPolicy: { portfolioRiskMode: 'normal' },
    },
    correlationOverlapState: overlapState,
  });
  assert.strictEqual(typeof dec.advisoryStatus, 'string');
  assert.ok(Array.isArray(dec.crowdingReasons));

  console.log('✅ correlationOverlap tests passed');
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
