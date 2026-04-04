#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  computeWalkforwardValidation,
  applyComputedWalkforwardToGuardCandidate,
} = require('./computeWalkforwardValidation');
const { evaluatePromotionCandidate } = require('../learning/promotionGuard');

function codes(reasons) {
  return (Array.isArray(reasons) ? reasons : []).map((r) => r && r.code).filter(Boolean);
}

function mkReturns(n, fn) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(fn(i));
  return out;
}

function main() {
  const w0 = computeWalkforwardValidation({ tradeReturns: [] });
  assert.strictEqual(w0.present, false);
  assert.strictEqual(w0.reason, 'insufficient_history');

  const wShort = computeWalkforwardValidation({
    tradeReturns: mkReturns(10, () => 0.01),
  });
  assert.strictEqual(wShort.present, false);

  const good = mkReturns(48, (i) => 0.002 + (i % 7) * 0.0001);
  const wOk = computeWalkforwardValidation({ tradeReturns: good });
  assert.strictEqual(wOk.present, true);
  assert.strictEqual(wOk.segmentsEvaluated >= 3, true);
  assert.strictEqual(Array.isArray(wOk.windows), true);
  assert.strictEqual(wOk.windows.length, 4);

  const bad = mkReturns(48, () => -0.02);
  const wFail = computeWalkforwardValidation({ tradeReturns: bad });
  assert.strictEqual(wFail.present, true);
  assert.strictEqual(wFail.passed, false);
  assert.ok(['failed_segments', 'failed_score', 'failed_segments_and_score'].includes(wFail.reason));

  // Two evaluable segments clearly pass, two fail — global score can still clear minRequiredScore;
  // default MIN_PASS_RATE 0.5 requires 2/4 (k=4); 0.75 would require 3/4 and reject.
  const borderlineReturns = [];
  for (let seg = 0; seg < 4; seg += 1) {
    for (let t = 0; t < 12; t += 1) borderlineReturns.push(seg < 2 ? 0.005 : -0.008);
  }
  const wBorderStrict = computeWalkforwardValidation(
    { tradeReturns: borderlineReturns },
    { minPassRate: 0.75 }
  );
  assert.strictEqual(wBorderStrict.passed, false);
  assert.strictEqual(wBorderStrict.reason, 'failed_segments');
  const wBorderDefault = computeWalkforwardValidation({ tradeReturns: borderlineReturns });
  assert.strictEqual(wBorderDefault.passed, true);
  assert.strictEqual(wBorderDefault.reason, 'ok');

  const row = { setupId: 't1', tradeReturns: good, trades: 48, expectancy: 0.01 };
  const baseCand = {
    setupId: 't1',
    strategyId: 't1',
    trades: 48,
    expectancy: 0.01,
    drawdownPct: 5,
    profitFactor: 1.2,
    topTradesPnlShare: 0.2,
    direction: 'long',
    strategyType: 'breakout',
    avgTradeDuration: 3,
  };
  const enriched = applyComputedWalkforwardToGuardCandidate(baseCand, row, {});
  assert.strictEqual(typeof enriched.walkForwardPass, 'boolean');
  assert.ok(enriched.walkforward);

  const guardCfg = {
    minTrades: 1,
    minExpectancy: -999,
    maxDrawdownPct: 100,
    minProfitFactor: 0,
    maxTopTradesPnlShare: 1,
    requireWalkForwardPass: true,
  };

  const evPass = evaluatePromotionCandidate(enriched, guardCfg, 'core_3m');
  assert.ok(!codes(evPass.reasons).includes('REJECT_WALKFORWARD_MISSING'), 'should not be missing when WF computed');

  const evMissing = evaluatePromotionCandidate(baseCand, guardCfg, 'core_3m');
  assert.ok(codes(evMissing.reasons).includes('REJECT_WALKFORWARD_MISSING'));

  const enrichedFail = applyComputedWalkforwardToGuardCandidate(baseCand, { ...row, tradeReturns: bad }, {});
  const evFail = evaluatePromotionCandidate(enrichedFail, guardCfg, 'core_3m');
  assert.ok(codes(evFail.reasons).includes('REJECT_WALKFORWARD'));
  assert.ok(!codes(evFail.reasons).includes('REJECT_WALKFORWARD_MISSING'));

  const oldSaved = process.env.NEUROPILOT_WF_COMPUTED_DISABLE;
  process.env.NEUROPILOT_WF_COMPUTED_DISABLE = '1';
  try {
    const noCompute = applyComputedWalkforwardToGuardCandidate(baseCand, row, {});
    assert.strictEqual(noCompute.walkforward, undefined);
    assert.strictEqual(noCompute.walkForwardPass, undefined);
  } finally {
    if (oldSaved === undefined) delete process.env.NEUROPILOT_WF_COMPUTED_DISABLE;
    else process.env.NEUROPILOT_WF_COMPUTED_DISABLE = oldSaved;
  }

  console.log(JSON.stringify({ tag: 'smokeWalkforwardValidation', ok: true }));
}

main();
