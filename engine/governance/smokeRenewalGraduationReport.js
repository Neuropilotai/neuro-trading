#!/usr/bin/env node
'use strict';

/**
 * Smoke: renewal shadow graduation report (deterministic, read-only).
 * Run: node engine/governance/smokeRenewalGraduationReport.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  computeRenewalMetrics,
  compareSegments,
  isValidTrade,
} = require('./buildRenewalGraduationReport.js');

{
  const m = computeRenewalMetrics([
    { pnl: 2, reason: 'target', barsHeld: 1 },
    { pnl: -1, reason: 'stop', barsHeld: 2 },
  ]);
  assert.strictEqual(m.tradeCount, 2);
  assert.strictEqual(m.winRate, 0.5);
  assert.strictEqual(m.expectancy, 0.5);
  assert.ok(m.profitFactor != null && m.profitFactor > 1);
}

{
  const a = computeRenewalMetrics([{ pnl: 1, reason: 'target', barsHeld: 1 }]);
  const b = computeRenewalMetrics([{ pnl: 0.5, reason: 'target', barsHeld: 1 }]);
  const c = compareSegments(a, b);
  assert.strictEqual(c.deltaExpectancy, 0.5);
}

assert.strictEqual(isValidTrade({ pnl: 1, reason: 'skip' }), false);

const tmp = path.join(__dirname, '..', '..', `.tmp-smoke-renewal-grad-${Date.now()}`);
const gov = path.join(tmp, 'governance');
fs.mkdirSync(gov, { recursive: true });

const policyPath = path.join(tmp, 'policy.smoke.json');
fs.writeFileSync(
  policyPath,
  JSON.stringify(
    {
      policyVersion: 'renewal_graduation_v1_smoke',
      schemaVersion: 1,
      description: 'smoke',
      thresholds: {
        nMinPerStrategy: 2,
        nMinGlobalSegment: 1,
        nLiveFloorForComparative: 99,
        profitFactorMin: 1.01,
        deltaExpectancyVsLive: 0,
        deltaProfitFactorVsLive: 0,
        worstSingleTradeFloor: null,
        cvarWorstCount: 5,
        maxDatasetShare: 0.95,
        maxCoefficientOfVariation: null,
        consecutiveStopsForExclusion: 99,
        setupDominanceShareBeta: 0.99,
        minTradesPerDatasetBucket: 99,
        autoPolicyIntegrationMaxLevel: 3,
      },
      labels: {
        '0': 'reject',
        '1': 'observe',
        '2': 'candidate',
        '3': 'controlled_promotion',
        '4': 'policy_integration_candidate',
      },
    },
    null,
    2
  ),
  'utf8'
);

const livePath = path.join(gov, 'paper_trades.jsonl');
const shadowPath = path.join(gov, 'paper_trades_renewal_shadow.jsonl');
const lastRunPath = path.join(gov, 'paper_exec_v1_last_run_shadow.json');
const outPath = path.join(gov, 'renewal_shadow_evaluation_report.json');

const line = (o) => `${JSON.stringify(o)}\n`;
fs.writeFileSync(
  livePath,
  line({
    strategyId: 'live_only',
    setupId: 'live_only',
    pnl: 0.1,
    reason: 'target',
    barsHeld: 1,
    datasetKey: 'DS1',
  }),
  'utf8'
);
fs.writeFileSync(
  shadowPath,
  line({
    strategyId: 'grad_smoke_inj',
    setupId: 'grad_smoke_inj',
    shadowInjection: false,
    pnl: -0.5,
    reason: 'stop',
    barsHeld: 1,
    datasetKey: 'DS1',
  }) +
    line({
      strategyId: 'grad_smoke_inj',
      setupId: 'grad_smoke_inj',
      shadowInjection: true,
      pnl: 1,
      reason: 'target',
      barsHeld: 1,
      datasetKey: 'DS1',
    }) +
    line({
      strategyId: 'grad_smoke_inj',
      setupId: 'grad_smoke_inj',
      shadowInjection: true,
      pnl: 2,
      reason: 'target',
      barsHeld: 1,
      datasetKey: 'DS1',
    }),
  'utf8'
);
fs.writeFileSync(
  lastRunPath,
  JSON.stringify(
    {
      renewalShadowTradesWritten: 3,
      renewalShadowInjectedTradesWritten: 2,
      renewalShadowBaseTradesWritten: 1,
    },
    null,
    2
  ),
  'utf8'
);

execFileSync(
  process.execPath,
  [path.join(__dirname, 'buildRenewalGraduationReport.js')],
  {
    env: {
      ...process.env,
      NEUROPILOT_DATA_ROOT: tmp,
      NP_RENEWAL_EVAL_POLICY: policyPath,
      NP_RENEWAL_EVAL_LIVE_JSONL: livePath,
      NP_RENEWAL_EVAL_SHADOW_JSONL: shadowPath,
      NP_RENEWAL_EVAL_LAST_RUN_SHADOW: lastRunPath,
      NP_RENEWAL_EVAL_OUT: outPath,
    },
    stdio: 'inherit',
  }
);

const rep = JSON.parse(fs.readFileSync(outPath, 'utf8'));
assert.strictEqual(rep.schemaVersion, 1);
assert.strictEqual(rep.policyVersion, 'renewal_graduation_v1_smoke');
assert.strictEqual(rep.segments.shadowInjected.metrics.tradeCount, 2);
assert.strictEqual(rep.segments.shadowBase.metrics.tradeCount, 1);
assert.strictEqual(rep.strategies.length, 1);
assert.strictEqual(rep.strategies[0].strategyId, 'grad_smoke_inj');
assert.ok(rep.strategies[0].graduationLevel >= 1);
assert.strictEqual(rep.globalVerdict.strategiesEvaluated, 1);
assert.ok(rep.inputs.inputHash.startsWith('sha256:'));

const candPath = path.join(gov, 'renewal_shadow_graduation_candidates.json');
assert.strictEqual(fs.existsSync(candPath), true);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('smokeRenewalGraduationReport: all passed');
