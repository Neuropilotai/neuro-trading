#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  computeReplayBoostPriority,
  orderSignalsForReplayBoostStable,
  buildSetupMapFromComputed,
  assignTierFromScore,
  parseConvergenceTail,
  globalPipelineStallMalus,
  parseReplayBoostEnv,
} = require('./replayBoostPolicy');

const baseOpts = {
  enabled: true,
  maxTierACap: null,
  maxTierBCap: null,
  minTradesForPfMalus: 8,
  requirePromoted: false,
  tierBarsA: 5,
  tierBarsB: 3,
  tierBarsC: 1,
  tierBarsD: 0,
  baseMaxBarsFromEnv: 3,
};

function tierAHot() {
  const strategyValidation = {
    rows: [
      {
        strategyId: 'mut_hot',
        trades: 12,
        score: 72,
        learningScore: 65,
        expectancy: 0.4,
        profitFactor: 1.4,
        symbolCount: 1,
        hardFails: ['too_few_trades_hard', 'single_market_required'],
      },
    ],
  };
  const strictMappingReport = {
    promoted_not_seen_in_paper_last_7d: [{ setupKey: 'mut_hot' }],
    promoted_and_paper_recent: [],
  };
  const promotedManifest = { items: [{ setupId: 'mut_hot' }] };
  const r = computeReplayBoostPriority(
    {
      strategyValidation,
      strictMappingReport,
      setupAnalysis: null,
      promotedManifest,
      convergenceTail: [],
    },
    baseOpts
  );
  const row = r.setups.find((x) => x.setupId === 'mut_hot');
  assert(row, 'row');
  assert.strictEqual(row.replayPriorityTier, 'A', 'expect tier A');
  assert(row.replayPriorityScore >= 70, `score ${row.replayPriorityScore}`);
  assert.strictEqual(row.budgetAssigned, 5, 'A bars');
}

function tierBMid() {
  const strategyValidation = {
    rows: [
      {
        strategyId: 'mut_mid',
        trades: 25,
        score: 55,
        learningScore: 50,
        expectancy: 0,
        profitFactor: 0.95,
        symbolCount: 2,
        hardFails: ['too_few_trades_hard'],
      },
    ],
  };
  const promotedManifest = { items: [{ setupId: 'mut_mid' }] };
  const r = computeReplayBoostPriority(
    {
      strategyValidation,
      strictMappingReport: { promoted_not_seen_in_paper_last_7d: [], promoted_and_paper_recent: [] },
      promotedManifest,
      convergenceTail: [],
    },
    baseOpts
  );
  const row = r.setups.find((x) => x.setupId === 'mut_mid');
  assert.strictEqual(row.replayPriorityTier, 'B');
  assert.strictEqual(row.budgetAssigned, 3);
}

function tierDWeakPf() {
  const strategyValidation = {
    rows: [
      {
        strategyId: 'mut_weak',
        trades: 35,
        score: 40,
        learningScore: 35,
        expectancy: -0.5,
        profitFactor: 0.85,
        symbolCount: 2,
        hardFails: ['too_few_trades_hard', 'negative_expectancy', 'low_profit_factor'],
      },
    ],
  };
  const promotedManifest = { items: [{ setupId: 'mut_weak' }] };
  const r = computeReplayBoostPriority(
    {
      strategyValidation,
      strictMappingReport: { promoted_not_seen_in_paper_last_7d: [], promoted_and_paper_recent: [] },
      promotedManifest,
      convergenceTail: [],
    },
    baseOpts
  );
  const row = r.setups.find((x) => x.setupId === 'mut_weak');
  assert.strictEqual(row.replayPriorityTier, 'D');
  assert.strictEqual(row.budgetAssigned, 3);
}

function saturationHighTrades() {
  const strategyValidation = {
    rows: [
      {
        strategyId: 'mut_sat',
        trades: 85,
        score: 55,
        learningScore: 50,
        expectancy: 0,
        profitFactor: 1,
        symbolCount: 3,
        hardFails: [],
      },
    ],
  };
  const promotedManifest = { items: [{ setupId: 'mut_sat' }] };
  const r = computeReplayBoostPriority(
    {
      strategyValidation,
      strictMappingReport: { promoted_not_seen_in_paper_last_7d: [], promoted_and_paper_recent: [] },
      promotedManifest,
      convergenceTail: [],
    },
    baseOpts
  );
  const row = r.setups.find((x) => x.setupId === 'mut_sat');
  assert(row.replayPriorityScore < 70, 'saturation should pull below A');
  assert(row.reasons.some((x) => x === 'high_trade_count_saturation'));
}

function tieBreakOrder() {
  const strategyValidation = {
    rows: [
      {
        strategyId: 'mut_z',
        trades: 10,
        score: 70,
        learningScore: 60,
        expectancy: 0.1,
        profitFactor: 1.2,
        symbolCount: 2,
        hardFails: [],
      },
      {
        strategyId: 'mut_a',
        trades: 10,
        score: 70,
        learningScore: 60,
        expectancy: 0.1,
        profitFactor: 1.2,
        symbolCount: 2,
        hardFails: [],
      },
    ],
  };
  const promotedManifest = { items: [{ setupId: 'mut_z' }, { setupId: 'mut_a' }] };
  const computed = computeReplayBoostPriority(
    {
      strategyValidation,
      strictMappingReport: { promoted_not_seen_in_paper_last_7d: [], promoted_and_paper_recent: [] },
      promotedManifest,
      convergenceTail: [],
    },
    baseOpts
  );
  const m = buildSetupMapFromComputed(computed);
  const out = orderSignalsForReplayBoostStable(
    [
      { signalSource: 'promoted_manifest', setupId: 'mut_z', strategyId: 'mut_z' },
      { signalSource: 'promoted_manifest', setupId: 'mut_a', strategyId: 'mut_a' },
    ],
    m
  );
  assert.strictEqual(out[0].setupId, 'mut_a');
  assert.strictEqual(out[1].setupId, 'mut_z');
}

function globalBudgetUnchangedInPolicy() {
  const stall = globalPipelineStallMalus([
    { appended_last_run: 0, duplicateSkippedPersistent_last_run: 20 },
    { appended_last_run: 0, duplicateSkippedPersistent_last_run: 20 },
    { appended_last_run: 0, duplicateSkippedPersistent_last_run: 20 },
  ]);
  assert.strictEqual(stall.malus, 12);
}

function assignTierBoundaries() {
  assert.strictEqual(assignTierFromScore(71), 'A');
  assert.strictEqual(assignTierFromScore(55), 'B');
  assert.strictEqual(assignTierFromScore(35), 'C');
  assert.strictEqual(assignTierFromScore(10), 'D');
}

function parseTail() {
  const t = parseConvergenceTail('{"a":1}\n{"b":2}\n', 5);
  assert.strictEqual(t.length, 2);
}

tierAHot();
tierBMid();
tierDWeakPf();
saturationHighTrades();
tieBreakOrder();
globalBudgetUnchangedInPolicy();
assignTierBoundaries();
parseTail();

delete process.env.NEUROPILOT_PAPER_REPLAY_BOOST_ENABLE;
assert.strictEqual(parseReplayBoostEnv().enabled, false);
process.env.NEUROPILOT_PAPER_REPLAY_BOOST_ENABLE = '1';
assert.strictEqual(parseReplayBoostEnv().enabled, true);
delete process.env.NEUROPILOT_PAPER_REPLAY_BOOST_ENABLE;

console.log('[smokeReplayBoostPolicy] ok');
