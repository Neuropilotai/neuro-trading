#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  readHistoryIndexEntries,
  summarizeHistoryIndex,
} = require('./reportGovernanceHistoryIndex');

const dir = path.join(__dirname, '..', '..', `.tmp-smoke-gov-idx-${Date.now()}`);
const hist = path.join(dir, 'governance', 'history');
fs.mkdirSync(hist, { recursive: true });
const indexPath = path.join(hist, 'index.jsonl');

const lines = [
  {
    governanceHistoryIndexVersion: '1.2.0',
    snapshotAtIso: '2026-01-01T00:00:00.000Z',
    unixEpoch: 100,
    relativePath: 'governance/history/governance_100.json',
    snapshotSizeBytes: 1200,
    dashboardHash: 'a'.repeat(64),
    validTradeCount: 10,
    confidence: 'low',
    bestStrategyId: 's_a',
    worstStrategyId: 's_b',
    dashboardVersion: 'p8.14-v1',
    parseError: false,
    paperLearningInsightsPresent: true,
  },
  {
    governanceHistoryIndexVersion: '1.2.0',
    snapshotAtIso: '2026-01-02T00:00:00.000Z',
    unixEpoch: 200,
    relativePath: 'governance/history/governance_200.json',
    snapshotSizeBytes: 1300,
    dashboardHash: 'b'.repeat(64),
    validTradeCount: 50,
    confidence: 'medium',
    bestStrategyId: 's_a',
    worstStrategyId: 's_c',
    dashboardVersion: 'p8.15-v1',
    parseError: false,
    paperLearningInsightsPresent: true,
  },
  {
    governanceHistoryIndexVersion: '1.2.0',
    snapshotAtIso: '2026-01-03T00:00:00.000Z',
    unixEpoch: 300,
    relativePath: 'governance/history/governance_300.json',
    snapshotSizeBytes: 1400,
    dashboardHash: 'c'.repeat(64),
    validTradeCount: 51,
    confidence: 'medium',
    bestStrategyId: 's_x',
    worstStrategyId: 's_b',
    dashboardVersion: 'p8.15-v1',
    parseError: false,
    paperLearningInsightsPresent: true,
  },
];
fs.writeFileSync(indexPath, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');

process.env.NEUROPILOT_GOVERNANCE_HISTORY_INDEX = indexPath;
const { entries, badLines, missing } = readHistoryIndexEntries(indexPath);
assert.strictEqual(missing, false);
assert.strictEqual(badLines, 0);
assert.strictEqual(entries.length, 3);

const sum = summarizeHistoryIndex(entries, { progressTail: 10 });
assert.strictEqual(sum.snapshotCount, 3);
assert.strictEqual(sum.lastConfidence, 'medium');
assert.strictEqual(sum.lastValidTradeCount, 51);
assert.strictEqual(sum.lastDashboardVersion, 'p8.15-v1');
assert.strictEqual(sum.lastSnapshotSizeBytes, 1400);
assert.strictEqual(sum.bestStrategyIdFrequency[0].strategyId, 's_a');
assert.strictEqual(sum.bestStrategyIdFrequency[0].count, 2);
const lowC = sum.confidenceFrequency.find((r) => r.confidence === 'low');
const medC = sum.confidenceFrequency.find((r) => r.confidence === 'medium');
assert.ok(lowC && lowC.count === 1);
assert.ok(medC && medC.count === 2);
assert.strictEqual(sum.dashboardVersionFrequency[0].dashboardVersion, 'p8.15-v1');
assert.strictEqual(sum.dashboardVersionFrequency[0].count, 2);
assert.strictEqual(sum.validTradeCountProgressionTail.length, 3);
assert.strictEqual(sum.validTradeCountProgressionTail[2].validTradeCount, 51);

const reportMod = require('./reportGovernanceHistoryIndex');
const diffMod = require('./diffGovernanceDashboardSnapshots');
assert.strictEqual(reportMod.QUICK_SUMMARY_CONTRACT_VERSION, diffMod.QUICK_SUMMARY_CONTRACT_VERSION);
assert.strictEqual(reportMod.QUICK_SUMMARY_CONTRACT_VERSION, '1.0.0');

// --- Edge: missing index, empty file, exotic confidence, CLI --json + path override ---
const ghostMissing = path.join(os.tmpdir(), `neuropilot-missing-idx-${Date.now()}.jsonl`);
const miss = readHistoryIndexEntries(ghostMissing);
assert.strictEqual(miss.missing, true);
assert.strictEqual(miss.badLines, 0);
assert.strictEqual(miss.entries.length, 0);

const sumNoEntries = summarizeHistoryIndex([]);
assert.strictEqual(sumNoEntries.snapshotCount, 0);
assert.strictEqual(sumNoEntries.lastConfidence, null);

const emptyIdx = path.join(hist, 'empty.jsonl');
fs.writeFileSync(emptyIdx, '', 'utf8');
const emptyRead = readHistoryIndexEntries(emptyIdx);
assert.strictEqual(emptyRead.missing, false);
assert.strictEqual(emptyRead.badLines, 0);
assert.strictEqual(emptyRead.entries.length, 0);

const sumExotic = summarizeHistoryIndex([
  {
    confidence: 'exotic_custom',
    bestStrategyId: 'a',
    worstStrategyId: 'b',
    validTradeCount: 0,
    snapshotAtIso: '2026-01-01T00:00:00.000Z',
    unixEpoch: 1,
    parseError: false,
  },
]);
const exoticRow = sumExotic.confidenceFrequency.find((r) => r.confidence === 'exotic_custom');
assert.ok(exoticRow && exoticRow.count === 1, 'non-canonical confidence string must be counted as-is');

const reportScript = path.join(__dirname, 'reportGovernanceHistoryIndex.js');
const envFor = (p) => ({ ...process.env, NEUROPILOT_GOVERNANCE_HISTORY_INDEX: p });

const rMiss = spawnSync(process.execPath, [reportScript, '--json'], {
  encoding: 'utf8',
  env: envFor(ghostMissing),
});
assert.strictEqual(rMiss.status, 0, rMiss.stderr || '');
const jMiss = JSON.parse(rMiss.stdout.trim());
assert.strictEqual(jMiss.meta.missing, true);
assert.strictEqual(jMiss.meta.badLines, 0);
assert.strictEqual(jMiss.snapshotCount, 0);
assert.strictEqual(jMiss.meta.sourceJsonPathUsed, path.resolve(ghostMissing));

const rEmp = spawnSync(process.execPath, [reportScript, '--json'], {
  encoding: 'utf8',
  env: envFor(emptyIdx),
});
assert.strictEqual(rEmp.status, 0, rEmp.stderr || '');
const jEmp = JSON.parse(rEmp.stdout.trim());
assert.strictEqual(jEmp.meta.missing, false);
assert.strictEqual(jEmp.meta.badLines, 0);
assert.strictEqual(jEmp.snapshotCount, 0);

const rOk = spawnSync(process.execPath, [reportScript, '--json'], {
  encoding: 'utf8',
  env: envFor(indexPath),
});
assert.strictEqual(rOk.status, 0, rOk.stderr || '');
const jOk = JSON.parse(rOk.stdout.trim());
assert.strictEqual(jOk.meta.sourceJsonPathUsed, path.resolve(indexPath));
assert.strictEqual(jOk.snapshotCount, 3);

delete process.env.NEUROPILOT_GOVERNANCE_HISTORY_INDEX;
fs.rmSync(dir, { recursive: true, force: true });

console.log('smokeGovernanceHistoryIndexReport: ok');
