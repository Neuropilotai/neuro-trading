#!/usr/bin/env node
'use strict';

/**
 * Read-only summary of governance/history/index.jsonl (no mutation).
 *
 * CLI: node engine/governance/reportGovernanceHistoryIndex.js [--json] [--tail N]
 * Default index: $NEUROPILOT_DATA_ROOT/governance/history/index.jsonl
 * Override: NEUROPILOT_GOVERNANCE_HISTORY_INDEX=/abs/path/to/index.jsonl
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const { QUICK_SUMMARY_CONTRACT_VERSION } = require('./diffGovernanceDashboardSnapshots');

function defaultIndexPath() {
  const env = process.env.NEUROPILOT_GOVERNANCE_HISTORY_INDEX;
  if (env && String(env).trim()) {
    return path.resolve(String(env).trim());
  }
  return path.join(dataRoot.getPath('governance', false), 'history', 'index.jsonl');
}

/**
 * @param {string} indexPath
 * @returns {{ entries: object[], badLines: number, missing: boolean }}
 */
function readHistoryIndexEntries(indexPath) {
  const entries = [];
  let badLines = 0;
  if (!fs.existsSync(indexPath)) {
    return { entries, badLines, missing: true };
  }
  const text = fs.readFileSync(indexPath, 'utf8');
  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  return { entries, badLines, missing: false };
}

/**
 * @param {object[]} entries
 * @param {object} [opts]
 * @param {number} [opts.progressTail] - last N validTradeCount values (default 15)
 */
function summarizeHistoryIndex(entries, opts = {}) {
  const progressTail = opts.progressTail != null ? Math.max(1, Number(opts.progressTail) || 15) : 15;
  const n = entries.length;
  const last = n > 0 ? entries[n - 1] : null;
  const first = n > 0 ? entries[0] : null;
  const lastSnapshotSizeBytes =
    last && last.snapshotSizeBytes != null && Number.isFinite(Number(last.snapshotSizeBytes))
      ? Number(last.snapshotSizeBytes)
      : null;

  const bestFreq = new Map();
  for (const e of entries) {
    const k = e.bestStrategyId == null ? '(null)' : String(e.bestStrategyId);
    bestFreq.set(k, (bestFreq.get(k) || 0) + 1);
  }
  const bestStrategyIdFrequency = [...bestFreq.entries()]
    .map(([strategyId, count]) => ({ strategyId, count }))
    .sort((a, b) => b.count - a.count);

  const versions = new Map();
  for (const e of entries) {
    const v = e.dashboardVersion == null ? '(null)' : String(e.dashboardVersion);
    versions.set(v, (versions.get(v) || 0) + 1);
  }
  const dashboardVersionFrequency = [...versions.entries()]
    .map(([dashboardVersion, count]) => ({ dashboardVersion, count }))
    .sort((a, b) => b.count - a.count);

  const confMap = new Map();
  for (const e of entries) {
    let c = '(null)';
    if (e && Object.prototype.hasOwnProperty.call(e, 'confidence')) {
      c = e.confidence == null ? '(null)' : String(e.confidence);
    }
    confMap.set(c, (confMap.get(c) || 0) + 1);
  }
  const confidenceFrequency = [...confMap.entries()]
    .map(([confidence, count]) => ({ confidence, count }))
    .sort((a, b) => b.count - a.count);

  const parseErrors = entries.filter((e) => e.parseError === true).length;
  const tradesSeries = entries
    .filter((e) => e.parseError !== true && e.validTradeCount != null)
    .map((e) => ({
      snapshotAtIso: e.snapshotAtIso,
      unixEpoch: e.unixEpoch,
      validTradeCount: e.validTradeCount,
    }));
  const progressionTail = tradesSeries.slice(-progressTail);

  return {
    snapshotCount: n,
    indexFirst: first,
    indexLast: last,
    lastConfidence: last && Object.prototype.hasOwnProperty.call(last, 'confidence') ? last.confidence : null,
    lastValidTradeCount: last && last.validTradeCount != null ? last.validTradeCount : null,
    lastDashboardVersion: last && last.dashboardVersion != null ? last.dashboardVersion : null,
    lastSnapshotSizeBytes,
    bestStrategyIdFrequency,
    dashboardVersionFrequency,
    confidenceFrequency,
    parseErrorRows: parseErrors,
    validTradeCountProgressionTail: progressionTail,
  };
}

function printText(summary, meta) {
  console.log('[governance_history_index] read-only summary');
  console.log('  indexPath:', meta.indexPath);
  if (meta.sourceJsonPathUsed) {
    console.log('  sourceJsonPathUsed:', meta.sourceJsonPathUsed);
  }
  if (meta.missing) {
    console.log('  status: missing (no index yet)');
    return;
  }
  console.log('  snapshotCount:', summary.snapshotCount);
  if (meta.badLines > 0) {
    console.log('  badJsonLines (skipped):', meta.badLines);
  }
  console.log('  parseErrorRows (in entries):', summary.parseErrorRows);
  console.log('  lastConfidence:', summary.lastConfidence);
  console.log('  lastValidTradeCount:', summary.lastValidTradeCount);
  console.log('  lastDashboardVersion:', summary.lastDashboardVersion);
  if (summary.indexLast) {
    console.log('  lastRelativePath:', summary.indexLast.relativePath);
    console.log('  lastSnapshotAtIso:', summary.indexLast.snapshotAtIso);
  }
  console.log('  bestStrategyId frequency (desc):');
  for (const row of summary.bestStrategyIdFrequency.slice(0, 12)) {
    console.log(`    ${row.count}x  ${row.strategyId}`);
  }
  if (summary.confidenceFrequency.length) {
    console.log('  confidence frequency (desc):');
    for (const row of summary.confidenceFrequency.slice(0, 12)) {
      console.log(`    ${row.count}x  ${row.confidence}`);
    }
  }
  if (summary.dashboardVersionFrequency.length) {
    console.log('  dashboardVersion frequency (desc):');
    for (const row of summary.dashboardVersionFrequency.slice(0, 8)) {
      console.log(`    ${row.count}x  ${row.dashboardVersion}`);
    }
  }
  console.log('  validTradeCount tail (oldest → newest):');
  for (const p of summary.validTradeCountProgressionTail) {
    console.log(`    ${p.validTradeCount}  @ ${p.snapshotAtIso}`);
  }
}

function parseArgs(argv) {
  const out = { json: false, tail: 15 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--json') out.json = true;
    if (argv[i] === '--tail' && argv[i + 1]) {
      out.tail = parseInt(argv[i + 1], 10);
      i += 1;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const indexPath = defaultIndexPath();
  const sourceJsonPathUsed = path.resolve(indexPath);
  const { entries, badLines, missing } = readHistoryIndexEntries(indexPath);
  const summary = summarizeHistoryIndex(entries, { progressTail: args.tail });
  const meta = {
    indexPath,
    sourceJsonPathUsed,
    badLines,
    missing,
    /** Aligns with `diffGovernanceDashboardSnapshots.js --json` for pipelines that join index + diff. */
    quickSummaryContractVersion: QUICK_SUMMARY_CONTRACT_VERSION,
  };

  if (args.json) {
    console.log(JSON.stringify({ ...summary, meta }, null, 2));
    process.exit(0);
  }
  printText(summary, meta);
  process.exit(0);
}

module.exports = {
  readHistoryIndexEntries,
  summarizeHistoryIndex,
  defaultIndexPath,
  main,
  // Re-export from diffGovernanceDashboardSnapshots (single source of truth for JSON meta + diff --json).
  QUICK_SUMMARY_CONTRACT_VERSION,
};

if (require.main === module) {
  main();
}
