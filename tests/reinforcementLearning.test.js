#!/usr/bin/env node
'use strict';

/**
 * RL policy layer (tabular). Run: node tests/reinforcementLearning.test.js
 */

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const closedTradeAnalyticsService = require('../backend/services/closedTradeAnalyticsService');
const reinforcementLearningService = require('../backend/services/reinforcementLearningService');

function trade(pnl, strategy, symbol, hour, regime, extra = {}) {
  const exitTimestamp = `2026-04-07T${String(hour).padStart(2, '0')}:00:00.000Z`;
  return closedTradeAnalyticsService.buildClosedTradeRecord({
    symbol,
    entryPriceAvg: 100,
    exitPriceAvg: 100 + pnl,
    closedQuantity: 1,
    realizedPnL: pnl,
    entryTimestamp: '2026-04-07T08:00:00.000Z',
    exitTimestamp,
    closeReason: 'SELL',
    strategy,
    regime,
    mfe: extra.mfe != null ? extra.mfe : Math.abs(pnl) + 1,
    mae: extra.mae != null ? extra.mae : 0.5,
    efficiencyRatio: extra.efficiencyRatio != null ? extra.efficiencyRatio : 0.6,
  });
}

async function withTempDataDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-test-'));
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
  console.log('reinforcementLearning tests…');

  // 1) Profitable bucket → non-negative / not demote-only
  const good = [];
  for (let i = 0; i < 12; i++) {
    good.push(trade(2, 'alpha', 'XAUUSD', 14, 'trend'));
  }
  const rGood = reinforcementLearningService.computePolicyScores(good, []);
  const cardA = rGood.scoreCards.find((c) => c.bucketKey === 'strategy|alpha');
  assert.ok(cardA);
  assert.ok(cardA.score >= 0);
  assert.ok(['promote', 'keep', 'throttle'].includes(cardA.decision));

  // 2) Weak bucket → throttle or demote or suspend
  const bad = [];
  for (let i = 0; i < 14; i++) {
    bad.push(
      trade(-3, 'beta', 'EURUSD', 9, 'chop', {
        efficiencyRatio: 0.05,
        mae: 5,
        mfe: 0.5,
      })
    );
  }
  const rBad = reinforcementLearningService.computePolicyScores(bad, []);
  const cardB = rBad.scoreCards.find((c) => c.bucketKey === 'strategy|beta');
  assert.ok(cardB);
  assert.ok(['throttle', 'demote', 'suspend'].includes(cardB.decision));

  // 3) Low sample → lower confidence than large sample (same sign pnl)
  const small = [trade(1, 'gamma', 'XAUUSD', 10, 'x')];
  const big = [];
  for (let i = 0; i < 25; i++) big.push(trade(1, 'delta', 'XAUUSD', 10, 'x'));
  const bSmall = reinforcementLearningService.buildStateBuckets(small);
  const bBig = reinforcementLearningService.buildStateBuckets(big);
  const fsSmall = bSmall['strategy|gamma'];
  const fsBig = bBig['strategy|delta'];
  assert.ok(fsSmall.confidence < fsBig.confidence);

  // 4) Persist + reload
  await withTempDataDir(async () => {
    const ok = await reinforcementLearningService.saveLearningState({
      generatedAt: '2026-04-07T00:00:00.000Z',
      buckets: { 'strategy|x': { bucketKey: 'strategy|x', tradeCount: 1 } },
      scoreCards: [{ bucketKey: 'strategy|x', score: 0.5, decision: 'keep' }],
    });
    assert.strictEqual(ok, true);
    const loaded = await reinforcementLearningService.loadLearningState();
    assert.strictEqual(loaded.buckets['strategy|x'].tradeCount, 1);
    assert.strictEqual(loaded.scoreCards[0].score, 0.5);
  });

  // 5) Empty history — no throw
  const rEmpty = reinforcementLearningService.computePolicyScores([], []);
  assert.strictEqual(rEmpty.diagnostics.tradeRowsUsed, 0);
  assert.strictEqual(Object.keys(rEmpty.buckets).length, 0);

  // derivePolicyDecision mapping
  assert.strictEqual(
    reinforcementLearningService.derivePolicyDecision(0.8, 0.7),
    'promote'
  );
  assert.strictEqual(reinforcementLearningService.derivePolicyDecision(0.5, 0.9), 'keep');
  assert.strictEqual(reinforcementLearningService.derivePolicyDecision(0.25, 0.9), 'throttle');
  assert.strictEqual(reinforcementLearningService.derivePolicyDecision(0.1, 0.9), 'demote');

  console.log('✅ reinforcementLearning tests passed');
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
