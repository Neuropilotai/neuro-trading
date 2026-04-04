#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  QUICK_SUMMARY_CONTRACT_VERSION,
  QUICK_SUMMARY_FIELD_ORDER,
  extractSlice,
  formatHumanPaperDiffSummary,
} = require('./diffGovernanceDashboardSnapshots');

assert.strictEqual(QUICK_SUMMARY_CONTRACT_VERSION, '1.0.0');

const dir = path.join(__dirname, '..', '..', `.tmp-smoke-gov-diff-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const aPath = path.join(dir, 'a.json');
const bPath = path.join(dir, 'b.json');

const base = {
  dashboardVersion: 'p8.15-v1',
  generatedAt: '2026-01-01T00:00:00.000Z',
  dataRoot: '/tmp/x',
  paperLearningInsights: { confidence: 'low', learningInsightsVersion: '1.0.0' },
  paperTradesMetricsV2: { validTradeCount: 5, bestStrategy: null, worstStrategy: null },
};
fs.writeFileSync(aPath, JSON.stringify(base), 'utf8');
fs.writeFileSync(bPath, JSON.stringify(base), 'utf8');

const sa = JSON.stringify(extractSlice(JSON.parse(fs.readFileSync(aPath, 'utf8'))));
const sb = JSON.stringify(extractSlice(JSON.parse(fs.readFileSync(bPath, 'utf8'))));
assert.strictEqual(sa, sb);

const diffBase = { ...base, paperLearningInsights: { ...base.paperLearningInsights, confidence: 'high' } };
fs.writeFileSync(bPath, JSON.stringify(diffBase), 'utf8');
const sb2 = JSON.stringify(extractSlice(JSON.parse(fs.readFileSync(bPath, 'utf8'))));
assert.notStrictEqual(sa, sb2);

// bPath holds diffBase after last write
const sliceA = extractSlice(JSON.parse(fs.readFileSync(aPath, 'utf8')));
const sliceB = extractSlice(JSON.parse(fs.readFileSync(bPath, 'utf8')));
const lines = formatHumanPaperDiffSummary(sliceA, sliceB, {
  fileSizeBytesA: fs.statSync(aPath).size,
  fileSizeBytesB: fs.statSync(bPath).size,
});
const confLine = lines.find((l) => l.includes('confidence:'));
assert.ok(confLine && confLine.includes('low') && confLine.includes('high') && confLine.includes('->'));
const sizeLine = lines.find((l) => l.includes('snapshotSizeBytes:'));
assert.ok(sizeLine && sizeLine.includes('->'), 'snapshot file sizes differ after payload change');

for (let i = 0; i < QUICK_SUMMARY_FIELD_ORDER.length; i += 1) {
  const prefix = `  ${QUICK_SUMMARY_FIELD_ORDER[i]}:`;
  assert.ok(
    lines[i].startsWith(prefix),
    `quick summary line ${i} must start with ${prefix} (stable order)`
  );
}
assert.strictEqual(lines.length, QUICK_SUMMARY_FIELD_ORDER.length + 1, 'payload fields + snapshotSizeBytes only');
assert.ok(
  lines[QUICK_SUMMARY_FIELD_ORDER.length].startsWith('  snapshotSizeBytes:'),
  'snapshotSizeBytes line must be immediately after payload fields (last line)'
);

const linesNoSize = formatHumanPaperDiffSummary(sliceA, sliceB);
assert.ok(!linesNoSize.some((l) => l.includes('snapshotSizeBytes:')), 'omit size line without opts');
assert.strictEqual(linesNoSize.length, QUICK_SUMMARY_FIELD_ORDER.length);
for (let i = 0; i < QUICK_SUMMARY_FIELD_ORDER.length; i += 1) {
  assert.ok(linesNoSize[i].startsWith(`  ${QUICK_SUMMARY_FIELD_ORDER[i]}:`), 'order stable without file sizes');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('smokeDiffGovernanceDashboardSnapshots: ok');
