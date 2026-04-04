#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  LEARNING_SCAN_CONTRACT_VERSION,
  LEARNING_SCAN_FIELD_ORDER,
  learningScanRow,
  takeLastLearningScanRows,
  buildLearningScanTsvLines,
} = require('./learningScanGovernanceHistory');

assert.strictEqual(LEARNING_SCAN_CONTRACT_VERSION, '1.0.0');

const dir = path.join(__dirname, '..', '..', `.tmp-smoke-learning-scan-${Date.now()}`);
const hist = path.join(dir, 'governance', 'history');
fs.mkdirSync(hist, { recursive: true });
const indexPath = path.join(hist, 'index.jsonl');

const valid1 = {
  unixEpoch: 100,
  snapshotAtIso: '2026-01-01T00:00:00.000Z',
  confidence: 'low',
  bestStrategyId: 's_orb2',
  worstStrategyId: 's_meanrev',
  validTradeCount: 42,
};
const valid2 = {
  unixEpoch: 200,
  snapshotAtIso: '2026-01-02T00:00:00.000Z',
  confidence: 'medium',
  bestStrategyId: 's_orb2',
  worstStrategyId: 's_scalp',
  validTradeCount: 87,
};
/** Partial index row: missing keys → nulls in scan row */
const valid3Partial = {
  unixEpoch: 300,
  snapshotAtIso: '2026-01-03T00:00:00.000Z',
};

const rawIndex =
  JSON.stringify(valid1) +
  '\n' +
  '{not valid json line' +
  '\n' +
  JSON.stringify(valid2) +
  '\n' +
  JSON.stringify(valid3Partial) +
  '\n';
fs.writeFileSync(indexPath, rawIndex, 'utf8');

process.env.NEUROPILOT_GOVERNANCE_HISTORY_INDEX = indexPath;
const { readHistoryIndexEntries } = require('./reportGovernanceHistoryIndex');
const { entries, badLines } = readHistoryIndexEntries(indexPath);
assert.strictEqual(badLines, 1, 'one invalid JSONL line must be counted');
assert.strictEqual(entries.length, 3);

const last2 = takeLastLearningScanRows(entries, 2);
assert.strictEqual(last2.length, 2);
assert.strictEqual(last2[0].snapshotAtIso, '2026-01-02T00:00:00.000Z');
assert.strictEqual(last2[0].validTradeCount, 87);
assert.strictEqual(last2[1].confidence, null);
assert.strictEqual(last2[1].bestStrategyId, null);
assert.strictEqual(last2[1].worstStrategyId, null);
assert.strictEqual(last2[1].validTradeCount, null);

const keys = Object.keys(learningScanRow({ snapshotAtIso: 'x' }));
assert.deepStrictEqual(keys, [...LEARNING_SCAN_FIELD_ORDER]);

const allRows = takeLastLearningScanRows(entries, 10);
assert.strictEqual(allRows.length, 3);

const allHuge = takeLastLearningScanRows(entries, 99999);
assert.strictEqual(allHuge.length, 3);
assert.strictEqual(allHuge[0].snapshotAtIso, valid1.snapshotAtIso);
assert.strictEqual(allHuge[2].snapshotAtIso, valid3Partial.snapshotAtIso);
const withHeader = buildLearningScanTsvLines(allRows, false);
const noHeader = buildLearningScanTsvLines(allRows, true);
assert.strictEqual(withHeader.length, noHeader.length + 1);
assert.ok(withHeader[0].startsWith('snapshotAtIso'));
assert.strictEqual(withHeader[0].split('\t').length, LEARNING_SCAN_FIELD_ORDER.length);
assert.strictEqual(withHeader[1], noHeader[0]);

for (const row of allRows) {
  assert.deepStrictEqual(Object.keys(row), [...LEARNING_SCAN_FIELD_ORDER]);
}

const jsonPayload = JSON.parse(
  JSON.stringify({
    learningScanContractVersion: LEARNING_SCAN_CONTRACT_VERSION,
    columns: [...LEARNING_SCAN_FIELD_ORDER],
    meta: { sourceJsonPathUsed: indexPath, tail: 10, rowCount: 3, badLines: 1, missing: false },
    rows: allRows,
  })
);
assert.strictEqual(jsonPayload.learningScanContractVersion, '1.0.0');
assert.ok(Array.isArray(jsonPayload.columns));
assert.deepStrictEqual(jsonPayload.columns, [...LEARNING_SCAN_FIELD_ORDER]);

const ghostMissing = path.join(os.tmpdir(), `neuropilot-learn-scan-missing-${Date.now()}.jsonl`);
const learnScript = path.join(__dirname, 'learningScanGovernanceHistory.js');
const envFor = (p) => ({ ...process.env, NEUROPILOT_GOVERNANCE_HISTORY_INDEX: p });

const rMiss = spawnSync(process.execPath, [learnScript, '--json', '--tail', '5'], {
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
const rEmp = spawnSync(process.execPath, [learnScript, '--json', '--tail', '5'], {
  encoding: 'utf8',
  env: envFor(emptyIdx),
});
assert.strictEqual(rEmp.status, 0, rEmp.stderr || '');
const jEmp = JSON.parse(rEmp.stdout.trim());
assert.strictEqual(jEmp.meta.missing, false);
assert.strictEqual(jEmp.meta.rowCount, 0);

const rOk = spawnSync(process.execPath, [learnScript, '--json', '--tail', '2'], {
  encoding: 'utf8',
  env: envFor(indexPath),
});
assert.strictEqual(rOk.status, 0, rOk.stderr || '');
const jOk = JSON.parse(rOk.stdout.trim());
assert.strictEqual(jOk.meta.sourceJsonPathUsed, path.resolve(indexPath));
assert.strictEqual(jOk.rows.length, 2);

delete process.env.NEUROPILOT_GOVERNANCE_HISTORY_INDEX;
fs.rmSync(dir, { recursive: true, force: true });

console.log('smokeLearningScanGovernanceHistory: ok');
