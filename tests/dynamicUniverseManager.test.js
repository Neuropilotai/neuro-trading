#!/usr/bin/env node
'use strict';

/**
 * Run: node tests/dynamicUniverseManager.test.js
 */

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const dynamicUniverseManager = require('../backend/services/dynamicUniverseManager');

async function withTempDataDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dyn-uni-test-'));
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
  console.log('dynamicUniverseManager tests…');

  const cfg = dynamicUniverseManager.getDynamicUniverseConfig({
    maxActiveSymbols: 3,
    maxWatchlistSymbols: 2,
    baseSymbols: ['XAUUSD', 'EURUSD', 'BTCUSD'],
    extraSymbols: ['EURUSD', 'USDJPY'],
    allowCrypto: true,
    allowFx: true,
    allowIndices: false,
    allowMetals: true,
    suspendedSymbols: [],
    writeSnapshot: false,
  });
  assert.strictEqual(cfg.maxActiveSymbols, 3);
  assert.ok(cfg.baseSymbols.includes('XAUUSD'));

  const candidates = dynamicUniverseManager.getDynamicUniverseCandidates(cfg);
  assert.deepStrictEqual(candidates, ['BTCUSD', 'EURUSD', 'USDJPY', 'XAUUSD']);

  const s = dynamicUniverseManager.scoreUniverseCandidate('XAUUSD', {
    config: cfg,
    explicitSuspended: [],
    allCandidatesSorted: candidates,
  });
  assert.strictEqual(s.symbol, 'XAUUSD');
  assert.ok(s.totalScore > 0);
  assert.ok(s.reasons.length > 0);

  const cfgNoIdx = {
    ...cfg,
    extraSymbols: ['NAS100USD'],
  };
  const candidatesIdx = dynamicUniverseManager.getDynamicUniverseCandidates(cfgNoIdx);
  const dropped = dynamicUniverseManager.scoreUniverseCandidate('NAS100USD', {
    config: cfgNoIdx,
    explicitSuspended: [],
    allCandidatesSorted: candidatesIdx,
  });
  assert.strictEqual(dropped.decision, 'dropped');

  const built = dynamicUniverseManager.buildDynamicUniverse({ config: cfg });
  assert.strictEqual(built.ok, true);
  assert.strictEqual(built.activeSymbols.length, 3);
  assert.strictEqual(built.watchlistSymbols.length, 1);
  assert.ok(built.diagnostics.candidateCount >= 4);
  assert.ok(Array.isArray(built.scores));
  assert.ok(built.constraints.maxActiveSymbols === 3);

  await withTempDataDir(async (dir) => {
    const prevWrite = process.env.DYNAMIC_UNIVERSE_WRITE_SNAPSHOT;
    const prevSnapPath = process.env.DYNAMIC_UNIVERSE_SNAPSHOT_PATH;
    process.env.DYNAMIC_UNIVERSE_WRITE_SNAPSHOT = 'true';
    process.env.DYNAMIC_UNIVERSE_SNAPSHOT_PATH = 'dynamic_universe_latest.json';
    const r = dynamicUniverseManager.buildDynamicUniverse({
      config: {
        maxActiveSymbols: 2,
        maxWatchlistSymbols: 1,
        baseSymbols: ['EURUSD', 'XAUUSD'],
        extraSymbols: [],
        allowCrypto: true,
        allowFx: true,
        allowIndices: true,
        allowMetals: true,
        writeSnapshot: true,
      },
    });
    assert.strictEqual(r.ok, true);
    const p = path.join(dir, 'dynamic_universe_latest.json');
    const raw = await fs.readFile(p, 'utf8');
    const o = JSON.parse(raw);
    assert.strictEqual(o.ok, true);
    assert.ok(o.generatedAt);
    const snap = dynamicUniverseManager.loadLatestDynamicUniverseSnapshot();
    assert.strictEqual(snap.generatedAt, o.generatedAt);
    if (prevWrite === undefined) delete process.env.DYNAMIC_UNIVERSE_WRITE_SNAPSHOT;
    else process.env.DYNAMIC_UNIVERSE_WRITE_SNAPSHOT = prevWrite;
    if (prevSnapPath === undefined) delete process.env.DYNAMIC_UNIVERSE_SNAPSHOT_PATH;
    else process.env.DYNAMIC_UNIVERSE_SNAPSHOT_PATH = prevSnapPath;
  });

  const bad = dynamicUniverseManager.buildDynamicUniverse({
    config: { maxActiveSymbols: -1, maxWatchlistSymbols: 0 },
  });
  assert.strictEqual(bad.ok, false);

  console.log('✅ dynamicUniverseManager tests passed');
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
