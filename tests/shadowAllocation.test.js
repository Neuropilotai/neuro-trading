#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const shadowAllocationService = require('../backend/services/shadowAllocationService');

async function withTempDataDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sha-test-'));
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
  console.log('shadowAllocation tests…');

  assert.strictEqual(shadowAllocationService.estimateActualNotional({ notional: 100 }, null), 100);
  assert.strictEqual(
    shadowAllocationService.estimateActualNotional({ quantity: 2, price: 50 }, null),
    100
  );

  const plan = {
    portfolio: { recommendedDeployableCapital: 200 },
    strategyAllocations: [
      { strategy: 'S1', weight: 0.5, recommendedCapital: 100 },
    ],
    symbolAllocations: [{ symbol: 'XAUUSD', weight: 0.4, recommendedCapital: 80 }],
  };
  const policyState = {
    entities: [
      {
        entityType: 'strategy',
        entityKey: 'S1',
        eligible: false,
        decision: 'suspend',
        policyRiskLevel: 'high',
      },
      {
        entityType: 'symbol',
        entityKey: 'XAUUSD',
        eligible: true,
        decision: 'keep',
      },
    ],
    globalPolicy: { portfolioRiskMode: 'normal' },
  };

  const inel = shadowAllocationService.buildShadowAllocationDecision({
    tradeDecision: {
      strategy: 'S1',
      symbol: 'XAUUSD',
      notional: 50,
    },
    allocationPlan: plan,
    policyState,
  });
  assert.strictEqual(inel.advisoryStatus, 'ineligible_policy');

  process.env.SHADOW_ALLOC_SLIGHT_OVERWEIGHT_PCT = '0.1';
  process.env.SHADOW_ALLOC_MATERIAL_OVERWEIGHT_PCT = '0.3';
  process.env.SHADOW_ALLOC_UNDERWEIGHT_PCT = '-0.15';
  const polOk = {
    entities: [
      {
        entityType: 'strategy',
        entityKey: 'S1',
        eligible: true,
        decision: 'keep',
      },
      {
        entityType: 'symbol',
        entityKey: 'XAUUSD',
        eligible: true,
        decision: 'keep',
      },
    ],
    globalPolicy: { portfolioRiskMode: 'normal' },
  };
  const aligned = shadowAllocationService.buildShadowAllocationDecision({
    tradeDecision: { strategy: 'S1', symbol: 'XAUUSD', notional: 80 },
    allocationPlan: plan,
    policyState: polOk,
  });
  assert.strictEqual(aligned.advisoryStatus, 'aligned');

  // 85/80 => ratio 1.0625, above default alignedHi 1.05, overPct within slight cap 0.1
  const over = shadowAllocationService.buildShadowAllocationDecision({
    tradeDecision: { strategy: 'S1', symbol: 'XAUUSD', notional: 85 },
    allocationPlan: plan,
    policyState: polOk,
  });
  assert.strictEqual(over.advisoryStatus, 'slight_overweight');

  const nomatch = shadowAllocationService.buildShadowAllocationDecision({
    tradeDecision: { strategy: 'UNKNOWN', symbol: 'XAUUSD', notional: 10 },
    allocationPlan: plan,
    policyState: polOk,
  });
  assert.strictEqual(nomatch.advisoryStatus, 'no_allocation_match');

  const rec = shadowAllocationService.buildShadowAllocationRecord({
    tradeDecision: { strategy: 'S1', symbol: 'EURUSD', notional: 1 },
    allocationPlan: { portfolio: {}, strategyAllocations: [], symbolAllocations: [] },
    policyState: polOk,
    tradeRef: 'T1',
  });
  assert.strictEqual(rec.tradeRef, 'T1');
  assert.ok(rec.shadowAllocationVersion >= 1);

  await withTempDataDir(async () => {
    await shadowAllocationService.saveLatestShadowAllocationRecord(rec);
    const latest = await shadowAllocationService.loadLatestShadowAllocationRecord();
    assert.strictEqual(latest.tradeRef, 'T1');
    await shadowAllocationService.appendShadowAllocationHistory(rec);
    const hist = await shadowAllocationService.readShadowAllocationHistory(10);
    assert.strictEqual(hist.length, 1);
    const sum = shadowAllocationService.buildShadowAllocationSummary(hist);
    assert.strictEqual(sum.totalComparisons, 1);
  });

  delete process.env.SHADOW_ALLOC_SLIGHT_OVERWEIGHT_PCT;
  delete process.env.SHADOW_ALLOC_MATERIAL_OVERWEIGHT_PCT;
  delete process.env.SHADOW_ALLOC_UNDERWEIGHT_PCT;

  console.log('✅ shadowAllocation tests passed');
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
