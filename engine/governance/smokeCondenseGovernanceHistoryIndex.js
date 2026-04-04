#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  CONDENSED_INDEX_CONTRACT_VERSION,
  CONDENSED_ROW_FIELD_ORDER,
  condenseRow,
  takeLastCondensedRows,
  buildCondensedTsvLines,
} = require('./condenseGovernanceHistoryIndex');

assert.strictEqual(CONDENSED_INDEX_CONTRACT_VERSION, '1.0.0');

const dir = path.join(__dirname, '..', '..', `.tmp-smoke-condense-idx-${Date.now()}`);
const hist = path.join(dir, 'governance', 'history');
fs.mkdirSync(hist, { recursive: true });
const indexPath = path.join(hist, 'index.jsonl');

const lines = [
  {
    unixEpoch: 100,
    snapshotAtIso: '2026-01-01T00:00:00.000Z',
    dashboardVersion: 'p8.14-v1',
    validTradeCount: 10,
    confidence: 'low',
    bestStrategyId: 's_a',
    worstStrategyId: 's_b',
    snapshotSizeBytes: 1200,
  },
  {
    unixEpoch: 200,
    snapshotAtIso: '2026-01-02T00:00:00.000Z',
    dashboardVersion: 'p8.15-v1',
    validTradeCount: 50,
    confidence: 'medium',
    bestStrategyId: 's_a',
    worstStrategyId: 's_c',
    snapshotSizeBytes: 1300,
  },
  {
    unixEpoch: 300,
    snapshotAtIso: '2026-01-03T00:00:00.000Z',
    dashboardVersion: 'p8.15-v1',
    validTradeCount: 51,
    confidence: 'medium',
    bestStrategyId: 's_x',
    worstStrategyId: 's_b',
    snapshotSizeBytes: 1400,
  },
];
fs.writeFileSync(indexPath, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');

process.env.NEUROPILOT_GOVERNANCE_HISTORY_INDEX = indexPath;
const { readHistoryIndexEntries } = require('./reportGovernanceHistoryIndex');
const { entries } = readHistoryIndexEntries(indexPath);
assert.strictEqual(entries.length, 3);

const last2 = takeLastCondensedRows(entries, 2);
assert.strictEqual(last2.length, 2);
assert.strictEqual(last2[0].unixEpoch, 200);
assert.strictEqual(last2[1].validTradeCount, 51);

const keys = Object.keys(condenseRow({ unixEpoch: 1 }));
assert.deepStrictEqual(keys, [...CONDENSED_ROW_FIELD_ORDER]);

const allRows = takeLastCondensedRows(entries, 3);
const withHeader = buildCondensedTsvLines(allRows, false);
const noHeader = buildCondensedTsvLines(allRows, true);
assert.strictEqual(withHeader.length, noHeader.length + 1);
assert.ok(withHeader[0].startsWith('unixEpoch'));
assert.strictEqual(withHeader[1], noHeader[0]);

for (const row of last2) {
  assert.deepStrictEqual(Object.keys(row), [...CONDENSED_ROW_FIELD_ORDER]);
}

const lastHuge = takeLastCondensedRows(entries, 99999);
assert.strictEqual(lastHuge.length, 3);
assert.strictEqual(lastHuge[0].unixEpoch, 100);
assert.strictEqual(lastHuge[2].unixEpoch, 300);

const ghostMissing = path.join(os.tmpdir(), `neuropilot-condense-missing-${Date.now()}.jsonl`);
const condenseScript = path.join(__dirname, 'condenseGovernanceHistoryIndex.js');
const envFor = (p) => ({ ...process.env, NEUROPILOT_GOVERNANCE_HISTORY_INDEX: p });

const rMiss = spawnSync(process.execPath, [condenseScript, '--json', '--tail', '20'], {
  encoding: 'utf8',
  env: envFor(ghostMissing),
});
assert.strictEqual(rMiss.status, 0, rMiss.stderr || '');
const jMiss = JSON.parse(rMiss.stdout.trim());
assert.strictEqual(jMiss.meta.missing, true);
assert.strictEqual(jMiss.meta.badLines, 0);
assert.strictEqual(jMiss.meta.rowCount, 0);
assert.strictEqual(jMiss.rows.length, 0);
assert.strictEqual(jMiss.meta.sourceJsonPathUsed, path.resolve(ghostMissing));

const emptyIdx = path.join(hist, 'empty.jsonl');
fs.writeFileSync(emptyIdx, '', 'utf8');
const rEmp = spawnSync(process.execPath, [condenseScript, '--json', '--tail', '10'], {
  encoding: 'utf8',
  env: envFor(emptyIdx),
});
assert.strictEqual(rEmp.status, 0, rEmp.stderr || '');
const jEmp = JSON.parse(rEmp.stdout.trim());
assert.strictEqual(jEmp.meta.missing, false);
assert.strictEqual(jEmp.meta.rowCount, 0);
assert.strictEqual(jEmp.rows.length, 0);

const rOk = spawnSync(process.execPath, [condenseScript, '--json', '--tail', '2'], {
  encoding: 'utf8',
  env: envFor(indexPath),
});
assert.strictEqual(rOk.status, 0, rOk.stderr || '');
const jOk = JSON.parse(rOk.stdout.trim());
assert.strictEqual(jOk.meta.sourceJsonPathUsed, path.resolve(indexPath));
assert.strictEqual(jOk.rows.length, 2);

delete process.env.NEUROPILOT_GOVERNANCE_HISTORY_INDEX;
fs.rmSync(dir, { recursive: true, force: true });

console.log('smokeCondenseGovernanceHistoryIndex: ok');
