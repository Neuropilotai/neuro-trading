#!/usr/bin/env node
'use strict';

/**
 * Capital allocation engine. Run: node tests/capitalAllocation.test.js
 */

const assert = require('assert');
const capitalAllocationService = require('../backend/services/capitalAllocationService');

async function run() {
  console.log('capitalAllocation tests…');

  const n = capitalAllocationService.normalizeWeights({ a: 2, b: 2 });
  assert.ok(Math.abs(n.a - 0.5) < 1e-3);
  assert.ok(Math.abs(n.b - 0.5) < 1e-3);

  const w = capitalAllocationService.computeEntityBaseWeights([
    {
      entityKey: 's1',
      eligible: true,
      score: 0.5,
      confidence: 0.8,
      allocationMultiplier: 1.2,
    },
    {
      entityKey: 's2',
      eligible: true,
      score: 0,
      confidence: 0.5,
      allocationMultiplier: 1,
    },
    {
      entityKey: 'bad',
      eligible: false,
      score: 1,
      confidence: 1,
      allocationMultiplier: 2,
    },
  ]);
  assert.strictEqual(w.bad, undefined);
  assert.ok(w.s1 > w.s2);

  const capped = capitalAllocationService.applyRiskCaps(
    {
      strategies: { a: 0.5, b: 0.35, c: 0.15 },
      symbols: { X: 0.45, Y: 0.35, Z: 0.2 },
    },
    { maxStrategy: 0.35, maxSymbol: 0.4 }
  );
  for (const k of Object.keys(capped.strategies)) {
    assert.ok(capped.strategies[k] <= 0.351, `strategy ${k} over cap`);
  }
  for (const k of Object.keys(capped.symbols)) {
    assert.ok(capped.symbols[k] <= 0.401, `symbol ${k} over cap`);
  }
  const sumS = Object.values(capped.strategies).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sumS - 1) < 0.02);

  const policyState = {
    globalPolicy: {
      portfolioRiskMode: 'normal',
      maxGrossExposureMultiplier: 1,
      newEntryThrottle: 1,
      degradationFlags: [],
    },
    entities: [
      {
        entityType: 'strategy',
        entityKey: 'A',
        eligible: true,
        score: 0.4,
        confidence: 0.9,
        allocationMultiplier: 1.1,
        decision: 'keep',
        maxExposureMultiplier: 1,
      },
      {
        entityType: 'symbol',
        entityKey: 'XAUUSD',
        eligible: true,
        score: 0.3,
        confidence: 0.85,
        allocationMultiplier: 1,
        decision: 'keep',
        maxExposureMultiplier: 1.05,
      },
    ],
  };
  const overview = {
    portfolio: { equity: 1000, bookEquity: 1000, grossExposure: 0 },
    executionQuality: { averageEfficiencyRatio: 0.5 },
  };
  const prev = process.env.POLICY_MIN_CASH_RESERVE_PCT;
  process.env.POLICY_MIN_CASH_RESERVE_PCT = '0.3';
  try {
    const plan = await capitalAllocationService.buildCapitalAllocationPlan({
      policyState,
      analyticsOverview: overview,
    });
    assert.ok(plan.strategyAllocations.length >= 1);
    assert.ok(plan.symbolAllocations.length >= 1);
    assert.ok(plan.portfolio.cashReserve >= 250);
    assert.ok(plan.portfolio.recommendedDeployableCapital > 0);
    assert.ok(typeof plan.allocationConcentrationScore === 'number');
    assert.ok(Array.isArray(plan.topOverweightRisks));
    assert.ok(typeof plan.capitalEfficiencyScore === 'number');
    for (const r of plan.strategyAllocations) {
      assert.ok('weight' in r && 'recommendedCapital' in r && 'decision' in r);
    }
    for (const r of plan.symbolAllocations) {
      assert.ok('weight' in r && 'maxExposure' in r && 'symbol' in r);
    }
  } finally {
    if (prev === undefined) delete process.env.POLICY_MIN_CASH_RESERVE_PCT;
    else process.env.POLICY_MIN_CASH_RESERVE_PCT = prev;
  }

  const degradedPolicy = {
    ...policyState,
    globalPolicy: {
      portfolioRiskMode: 'degraded',
      maxGrossExposureMultiplier: 0.35,
      newEntryThrottle: 0.35,
      degradationFlags: [],
    },
  };
  const planDef = await capitalAllocationService.buildCapitalAllocationPlan({
    policyState: degradedPolicy,
    analyticsOverview: overview,
  });
  const planNorm = await capitalAllocationService.buildCapitalAllocationPlan({
    policyState,
    analyticsOverview: overview,
  });
  assert.ok(planDef.portfolio.recommendedDeployableCapital < planNorm.portfolio.recommendedDeployableCapital);

  console.log('✅ capitalAllocation tests passed');
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
