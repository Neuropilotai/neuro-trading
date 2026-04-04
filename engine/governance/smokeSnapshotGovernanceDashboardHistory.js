#!/usr/bin/env node
'use strict';

/**
 * Smoke: snapshotGovernanceDashboardHistory — copy fidèle, index.jsonl, pas de mutation de la source.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const {
  snapshotGovernanceDashboardHistory,
  summarizeDashboardPayload,
} = require('./snapshotGovernanceDashboardHistory');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const dir = path.join(__dirname, '..', '..', `.tmp-smoke-gov-hist-${Date.now()}`);
const src = path.join(dir, 'governance_dashboard.json');
const decoyOps = path.join(dir, 'fake_ops_snapshot', 'governance_dashboard.json');

fs.mkdirSync(path.dirname(decoyOps), { recursive: true });
fs.mkdirSync(dir, { recursive: true });

const decoyContent = JSON.stringify({ decoy: true, mustNotChange: 42 });
fs.writeFileSync(decoyOps, decoyContent, 'utf8');
const decoyHashBefore = sha256(fs.readFileSync(decoyOps));

const payloadA = {
  dashboardVersion: 'p8.15-v1',
  paperTradesMetrics: { validTradeCount: 7 },
  paperTradesMetricsV2: {
    validTradeCount: 7,
    bestStrategy: { strategyId: 's_best' },
    worstStrategy: { strategyId: 's_worst' },
  },
  paperLearningInsights: { confidence: 'medium', summaryBestStrategyId: 's_best', summaryWorstStrategyId: 's_worst' },
};
fs.writeFileSync(src, JSON.stringify(payloadA), 'utf8');
const srcHashBefore = sha256(fs.readFileSync(src));

const prev = process.env.NEUROPILOT_DATA_ROOT;
process.env.NEUROPILOT_DATA_ROOT = dir;
dataRoot.resetDataRoot();
try {
  const r = snapshotGovernanceDashboardHistory({ sourcePath: src });
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(r.dest), 'snapshot file exists');
  assert.strictEqual(sha256(fs.readFileSync(r.dest)), srcHashBefore, 'snapshot bytes === source bytes');
  assert.strictEqual(sha256(fs.readFileSync(src)), srcHashBefore, 'source file not mutated');

  const parsed = JSON.parse(fs.readFileSync(r.dest, 'utf8'));
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'paperLearningInsights'));
  assert.strictEqual(parsed.paperLearningInsights.confidence, 'medium');

  assert.strictEqual(sha256(fs.readFileSync(decoyOps)), decoyHashBefore, 'decoy ops-snapshot path untouched');

  const indexPath = path.join(dir, 'governance', 'history', 'index.jsonl');
  assert.ok(fs.existsSync(indexPath), 'index.jsonl exists');
  const lines = fs.readFileSync(indexPath, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 1);
  const entry = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(entry.parseError, false);
  assert.strictEqual(entry.validTradeCount, 7);
  assert.strictEqual(entry.confidence, 'medium');
  assert.strictEqual(entry.bestStrategyId, 's_best');
  assert.strictEqual(entry.worstStrategyId, 's_worst');
  assert.strictEqual(typeof entry.dashboardHash, 'string');
  assert.strictEqual(entry.dashboardHash.length, 64);
  assert.strictEqual(entry.dashboardHash, sha256(fs.readFileSync(r.dest)), 'index hash matches snapshot bytes');
  assert.strictEqual(entry.snapshotSizeBytes, fs.statSync(r.dest).size);
  assert.strictEqual(entry.paperLearningInsightsPresent, true);
  assert.strictEqual(entry.relativePath.startsWith('governance/history/'), true);
  assert.strictEqual(entry.dashboardVersion, 'p8.15-v1');

  const sum = summarizeDashboardPayload(payloadA);
  assert.strictEqual(sum.validTradeCount, 7);
  assert.strictEqual(sum.bestStrategyId, 's_best');
  assert.strictEqual(sum.dashboardVersion, 'p8.15-v1');
} finally {
  if (prev === undefined) delete process.env.NEUROPILOT_DATA_ROOT;
  else process.env.NEUROPILOT_DATA_ROOT = prev;
  dataRoot.resetDataRoot();
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Explicit null paperLearningInsights ---
{
  const dir2 = path.join(__dirname, '..', '..', `.tmp-smoke-gov-hist-null-${Date.now()}`);
  const src2 = path.join(dir2, 'governance_dashboard.json');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(
    src2,
    JSON.stringify({
      paperLearningInsights: null,
      paperTradesMetricsV2: { validTradeCount: 2, bestStrategy: null, worstStrategy: null },
    }),
    'utf8'
  );
  process.env.NEUROPILOT_DATA_ROOT = dir2;
  dataRoot.resetDataRoot();
  try {
    const r2 = snapshotGovernanceDashboardHistory({ sourcePath: src2 });
    assert.strictEqual(r2.ok, true);
    const entry2 = r2.indexEntry;
    assert.strictEqual(entry2.parseError, false);
    assert.strictEqual(entry2.paperLearningInsightsPresent, true);
    assert.strictEqual(entry2.confidence, null);
  } finally {
    if (prev === undefined) delete process.env.NEUROPILOT_DATA_ROOT;
    else process.env.NEUROPILOT_DATA_ROOT = prev;
    dataRoot.resetDataRoot();
    fs.rmSync(dir2, { recursive: true, force: true });
  }
}

// --- Missing paperLearningInsights key ---
{
  const dir3 = path.join(__dirname, '..', '..', `.tmp-smoke-gov-hist-nokey-${Date.now()}`);
  const src3 = path.join(dir3, 'governance_dashboard.json');
  fs.mkdirSync(dir3, { recursive: true });
  fs.writeFileSync(src3, JSON.stringify({ paperTradesMetricsV2: { validTradeCount: 1 } }), 'utf8');
  process.env.NEUROPILOT_DATA_ROOT = dir3;
  dataRoot.resetDataRoot();
  try {
    const r3 = snapshotGovernanceDashboardHistory({ sourcePath: src3 });
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(r3.indexEntry.paperLearningInsightsPresent, false);
    assert.strictEqual(r3.indexEntry.confidence, null);
  } finally {
    if (prev === undefined) delete process.env.NEUROPILOT_DATA_ROOT;
    else process.env.NEUROPILOT_DATA_ROOT = prev;
    dataRoot.resetDataRoot();
    fs.rmSync(dir3, { recursive: true, force: true });
  }
}

console.log('smokeSnapshotGovernanceDashboardHistory: ok');
