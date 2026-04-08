#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const policyStabilityService = require('../backend/services/policyStabilityService');

async function withTempDataDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stab-test-'));
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
  console.log('policyStability tests…');

  const empty = policyStabilityService.buildPolicyStabilityDiagnostics(
    { generatedAt: 't1', entities: [], globalPolicy: {} },
    {},
    { diagnostics: { deployablePct: 0.7 } },
    {}
  );
  assert.ok(empty.summary.instabilityFlags.includes('insufficient_history'));

  const curP = {
    generatedAt: 't2',
    entities: [
      {
        entityType: 'strategy',
        entityKey: 'A',
        decision: 'throttle',
        confidence: 0.5,
        eligible: true,
      },
    ],
    globalPolicy: {
      portfolioRiskMode: 'normal',
      degradedMode: false,
      recommendedAction: 'normal',
    },
    policyHealthScore: 70,
  };
  const prevP = {
    generatedAt: 't1',
    entities: [
      {
        entityType: 'strategy',
        entityKey: 'A',
        decision: 'promote',
        confidence: 0.8,
        eligible: true,
      },
    ],
    globalPolicy: {
      portfolioRiskMode: 'normal',
      degradedMode: false,
      recommendedAction: 'normal',
    },
    policyHealthScore: 85,
  };
  const curA = {
    diagnostics: { deployablePct: 0.7, postCapConcentrationScore: 30 },
    strategyAllocations: [
      { strategy: 'A', weight: 0.6 },
      { strategy: 'B', weight: 0.4 },
    ],
    symbolAllocations: [{ symbol: 'X', weight: 1 }],
    portfolio: { baseCapital: 1000, cashReserve: 300, recommendedDeployableCapital: 500 },
  };
  const prevA = {
    diagnostics: { deployablePct: 0.7, postCapConcentrationScore: 28 },
    strategyAllocations: [
      { strategy: 'A', weight: 0.4 },
      { strategy: 'B', weight: 0.6 },
    ],
    symbolAllocations: [{ symbol: 'X', weight: 1 }],
    portfolio: { baseCapital: 1000, cashReserve: 300, recommendedDeployableCapital: 500 },
  };

  const d = policyStabilityService.buildPolicyStabilityDiagnostics(curP, prevP, curA, prevA);
  assert.strictEqual(d.lookbackAvailable, true);
  assert.strictEqual(d.policy.comparableEntityCount, 1);
  assert.strictEqual(d.policy.promoteToThrottleCount, 1);
  assert.ok(d.policy.avgConfidenceChange < 0);
  assert.ok(d.allocation.strategyWeightTurnover > 0);
  assert.ok(d.summary.policyStabilityScore <= 100);
  assert.ok(d.summary.allocationStabilityScore <= 100);

  const unstable = policyStabilityService.buildPolicyStabilityDiagnostics(
    {
      ...curP,
      globalPolicy: { portfolioRiskMode: 'degraded', degradedMode: true, recommendedAction: 'x' },
    },
    {
      ...prevP,
      globalPolicy: { portfolioRiskMode: 'normal', degradedMode: false, recommendedAction: 'y' },
    },
    { ...curA, diagnostics: { ...curA.diagnostics, postCapConcentrationScore: 55 } },
    prevA
  );
  assert.ok(unstable.summary.overallStabilityScore < d.summary.overallStabilityScore);

  await withTempDataDir(async () => {
    await policyStabilityService.saveLatestStabilityDiagnostics(d);
    const loaded = await policyStabilityService.loadLatestStabilityDiagnostics();
    assert.strictEqual(loaded.policyStabilityVersion, d.policyStabilityVersion);
    await policyStabilityService.appendStabilityHistory(d);
    const hist = await policyStabilityService.readStabilityHistory(5);
    assert.strictEqual(hist.length, 1);
  });

  console.log('✅ policyStability tests passed');
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
