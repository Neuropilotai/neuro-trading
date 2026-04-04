#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { allocateCandidatesUnderCaps } = require('./buildPromotedManifest');

function mk(setupId, symbol, datasetKey, barIndex) {
  return {
    setupId,
    strategyId: setupId,
    symbol,
    datasetKey,
    barIndex,
    timeframe: '5m',
  };
}

function run() {
  const perSetupCandidates = new Map();
  perSetupCandidates.set('promoted_A', new Map([['k1', mk('promoted_A', 'BTCUSDT', 'BTCUSDT_5m', 100)]]));
  perSetupCandidates.set('promoted_B', new Map([['k2', mk('promoted_B', 'ETHUSDT', 'ETHUSDT_5m', 200)]]));
  perSetupCandidates.set('regular_C', new Map([['k3', mk('regular_C', 'BTCUSDT', 'BTCUSDT_5m', 300)]]));

  const promotedOrder = ['promoted_A', 'promoted_B', 'regular_C'];
  const r = allocateCandidatesUnderCaps(perSetupCandidates, promotedOrder, 1, 2);

  assert.strictEqual(r.items.length, 2, 'expected maxTotal=2 applied');
  const setupIds = r.items.map((x) => x.setupId);
  assert.deepStrictEqual(
    setupIds.sort(),
    ['promoted_A', 'promoted_B'].sort(),
    'expected promoted setups retained before regular setup under cap'
  );
  assert.strictEqual(r.allocationStats.promotedIncludedCount, 2);
  assert.strictEqual(r.allocationStats.regularIncludedCount, 0);
  console.log(JSON.stringify({ ok: true, setupIds, stats: r.allocationStats }, null, 2));
}

if (require.main === module) run();
