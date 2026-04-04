#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  LEARNING_WINDOW_STATS_CONTRACT_VERSION,
  CONFIDENCE_BASE_KEYS,
  sortCountMapDescAlpha,
  buildCounts,
  takeWindow,
} = require('./learningWindowStatsGovernanceHistory');

assert.strictEqual(LEARNING_WINDOW_STATS_CONTRACT_VERSION, '1.0.0');

// Tie-break: same count → alphabetical key order in sorted map iteration
const tie = sortCountMapDescAlpha({ b: 2, a: 2, c: 1 });
assert.deepStrictEqual(Object.keys(tie), ['a', 'b', 'c']);

const countsEmpty = buildCounts([]);
assert.strictEqual(countsEmpty.confidence.low, 0);
assert.strictEqual(countsEmpty.confidence.medium, 0);
assert.strictEqual(countsEmpty.confidence.high, 0);
assert.strictEqual(countsEmpty.confidence['(null)'], 0);
assert.deepStrictEqual(countsEmpty.bestStrategyId, {});
assert.deepStrictEqual(countsEmpty.worstStrategyId, {});

const rows = [
  { confidence: 'low', bestStrategyId: 's_a', worstStrategyId: 's_b' },
  { confidence: null, bestStrategyId: 's_a', worstStrategyId: null },
  { confidence: 'high', bestStrategyId: null, worstStrategyId: 's_b' },
];
const c = buildCounts(rows);
assert.strictEqual(c.confidence['(null)'], 1);
assert.strictEqual(c.confidence.low, 1);
assert.strictEqual(c.confidence.high, 1);
assert.strictEqual(c.bestStrategyId['(null)'], 1);
assert.strictEqual(c.bestStrategyId.s_a, 2);
assert.strictEqual(c.worstStrategyId.s_b, 2);
assert.strictEqual(c.worstStrategyId['(null)'], 1);

// Keys order: s_b=2, then (null)=1
const wKeys = Object.keys(c.worstStrategyId);
assert.deepStrictEqual(wKeys, ['s_b', '(null)']);

const dir = path.join(__dirname, '..', '..', `.tmp-smoke-learning-window-stats-${Date.now()}`);
const hist = path.join(dir, 'governance', 'history');
fs.mkdirSync(hist, { recursive: true });
const indexPath = path.join(hist, 'index.jsonl');
const raw =
  JSON.stringify({
    confidence: 'low',
    bestStrategyId: 'x',
    worstStrategyId: 'y',
  }) +
  '\n' +
  'not-json{' +
  '\n' +
  JSON.stringify({
    confidence: 'medium',
    bestStrategyId: 'x',
    worstStrategyId: 'z',
  }) +
  '\n';
fs.writeFileSync(indexPath, raw, 'utf8');

process.env.NEUROPILOT_GOVERNANCE_HISTORY_INDEX = indexPath;
const { readHistoryIndexEntries } = require('./reportGovernanceHistoryIndex');
const { entries, badLines, missing } = readHistoryIndexEntries(indexPath);
assert.strictEqual(missing, false);
assert.strictEqual(badLines, 1);
assert.strictEqual(entries.length, 2);

const w = takeWindow(entries, 10);
assert.strictEqual(w.length, 2);
const wc = buildCounts(w);
assert.strictEqual(wc.confidence.low, 1);
assert.strictEqual(wc.confidence.medium, 1);

const wHuge = takeWindow(entries, 99999);
assert.strictEqual(wHuge.length, 2);
assert.deepStrictEqual(wHuge, entries);

const exoticRows = [
  { confidence: 'exotic', bestStrategyId: 'a', worstStrategyId: 'b' },
  { confidence: 'exotic', bestStrategyId: 'c', worstStrategyId: 'd' },
  { confidence: 'low', bestStrategyId: 'a', worstStrategyId: 'b' },
  { confidence: null, bestStrategyId: 'z', worstStrategyId: 'z' },
];
const ex = buildCounts(exoticRows);
assert.strictEqual(ex.confidence.exotic, 2);
assert.strictEqual(ex.confidence.low, 1);
assert.strictEqual(ex.confidence['(null)'], 1);
// Count tie (null) vs low → localeCompare 'en' puts '(null)' before 'low'
assert.deepStrictEqual(Object.keys(ex.confidence), [
  'exotic',
  '(null)',
  'low',
  'high',
  'medium',
]);

const w2 = takeWindow(entries, 1);
assert.strictEqual(w2.length, 1);
assert.strictEqual(w2[0].confidence, 'medium');

for (const k of CONFIDENCE_BASE_KEYS) {
  assert.ok(Object.prototype.hasOwnProperty.call(buildCounts([]).confidence, k));
}

const jsonPayload = JSON.parse(
  JSON.stringify({
    learningWindowStatsContractVersion: LEARNING_WINDOW_STATS_CONTRACT_VERSION,
    meta: {
      tail: 10,
      windowRowCount: 2,
      rowCount: 2,
      badLines: 1,
      missing: false,
    },
    counts: wc,
  })
);
assert.strictEqual(jsonPayload.learningWindowStatsContractVersion, '1.0.0');
assert.ok(jsonPayload.counts.confidence);

const ghostMissing = path.join(os.tmpdir(), `neuropilot-lws-missing-${Date.now()}.jsonl`);
const lwsScript = path.join(__dirname, 'learningWindowStatsGovernanceHistory.js');
const envFor = (p) => ({ ...process.env, NEUROPILOT_GOVERNANCE_HISTORY_INDEX: p });

const rMiss = spawnSync(process.execPath, [lwsScript, '--json', '--tail', '5'], {
  encoding: 'utf8',
  env: envFor(ghostMissing),
});
assert.strictEqual(rMiss.status, 0, rMiss.stderr || '');
const jMiss = JSON.parse(rMiss.stdout.trim());
assert.strictEqual(jMiss.meta.missing, true);
assert.strictEqual(jMiss.meta.badLines, 0);
assert.strictEqual(jMiss.meta.windowRowCount, 0);
assert.strictEqual(jMiss.meta.rowCount, 0);
assert.strictEqual(jMiss.meta.sourceJsonPathUsed, path.resolve(ghostMissing));

const emptyIdx = path.join(hist, 'empty.jsonl');
fs.writeFileSync(emptyIdx, '', 'utf8');
const rEmp = spawnSync(process.execPath, [lwsScript, '--json', '--tail', '10'], {
  encoding: 'utf8',
  env: envFor(emptyIdx),
});
assert.strictEqual(rEmp.status, 0, rEmp.stderr || '');
const jEmp = JSON.parse(rEmp.stdout.trim());
assert.strictEqual(jEmp.meta.missing, false);
assert.strictEqual(jEmp.meta.windowRowCount, 0);
assert.strictEqual(jEmp.counts.confidence.low, 0);

const rOk = spawnSync(process.execPath, [lwsScript, '--json', '--tail', '999'], {
  encoding: 'utf8',
  env: envFor(indexPath),
});
assert.strictEqual(rOk.status, 0, rOk.stderr || '');
const jOk = JSON.parse(rOk.stdout.trim());
assert.strictEqual(jOk.meta.sourceJsonPathUsed, path.resolve(indexPath));
assert.strictEqual(jOk.meta.windowRowCount, 2);

delete process.env.NEUROPILOT_GOVERNANCE_HISTORY_INDEX;
fs.rmSync(dir, { recursive: true, force: true });

// Missing index: readHistoryIndexEntries returns missing true — simulate via non-existent path
const ghost = path.join(os.tmpdir(), `neuropilot-lws-post-rm-${Date.now()}.jsonl`);
const missingRead = readHistoryIndexEntries(ghost);
assert.strictEqual(missingRead.missing, true);
assert.strictEqual(missingRead.entries.length, 0);
const mc = buildCounts([]);
assert.strictEqual(mc.confidence['(null)'], 0);

console.log('smokeLearningWindowStatsGovernanceHistory: ok');
