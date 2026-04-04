#!/usr/bin/env node
'use strict';

/**
 * Proof: P5 cycle chain assert (Option A).
 *
 * Usage (from neuropilot_trading_v2):
 *   node engine/governance/testCycleP5Chain.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEUROPILOT_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'np_cycle_chain_'));

const {
  writeLastCompletedCycle,
  assertP5MiniMatchesLastCompleted,
} = require('./cycleContext');

function assert(cond, msg) {
  if (!cond) {
    console.error('[testCycleP5Chain] FAIL:', msg);
    process.exit(1);
  }
}

function main() {
  writeLastCompletedCycle('cycle_A');

  assertP5MiniMatchesLastCompleted({ cycleId: 'cycle_A', experimentId: 'cycle_A' });

  let threw = false;
  try {
    assertP5MiniMatchesLastCompleted({ cycleId: 'cycle_B', experimentId: 'cycle_B' });
  } catch (e) {
    threw = true;
    assert(String(e.message).includes('cycle contract'), 'expected cycle contract error');
  }
  assert(threw, 'mismatch should throw');

  process.env.NEUROPILOT_SKIP_CYCLE_P5_ASSERT = 'true';
  assertP5MiniMatchesLastCompleted({ cycleId: 'cycle_B', experimentId: 'cycle_B' });
  delete process.env.NEUROPILOT_SKIP_CYCLE_P5_ASSERT;

  assertP5MiniMatchesLastCompleted(null);
  assertP5MiniMatchesLastCompleted({ experimentId: 'x' }); // no cycleId → skip

  console.log('[testCycleP5Chain] OK');
}

main();
