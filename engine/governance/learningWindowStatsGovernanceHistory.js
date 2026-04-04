#!/usr/bin/env node
'use strict';

/**
 * Read-only frequency counts over the last `tail` index entries (governance history).
 * Same denormalized fields as learning-scan; no snapshot JSON reads; no scoring or alerts.
 *
 * CLI: node engine/governance/learningWindowStatsGovernanceHistory.js [--tail K] [--json]
 * Default K=20. Index: readHistoryIndexEntries + defaultIndexPath.
 *
 * Count maps in JSON are sorted by count descending, then key ascending (localeCompare 'en').
 * confidence object always includes keys low, medium, high, (null) (0 if absent in data).
 */

const path = require('path');
const {
  readHistoryIndexEntries,
  defaultIndexPath,
} = require('./reportGovernanceHistoryIndex');

const LEARNING_WINDOW_STATS_CONTRACT_VERSION = '1.0.0';

const CONFIDENCE_BASE_KEYS = Object.freeze(['low', 'medium', 'high', '(null)']);

/**
 * @param {Record<string, number>} counts
 * @returns {Record<string, number>}
 */
function sortCountMapDescAlpha(counts) {
  const entries = Object.entries(counts);
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return String(a[0]).localeCompare(String(b[0]), 'en');
  });
  const out = {};
  for (const [k, v] of entries) {
    out[k] = v;
  }
  return out;
}

/**
 * @param {object[]} windowRows
 * @returns {Record<string, number>}
 */
function countConfidence(windowRows) {
  /** @type {Record<string, number>} */
  const m = {};
  for (const k of CONFIDENCE_BASE_KEYS) {
    m[k] = 0;
  }
  for (const row of windowRows) {
    if (!row || typeof row !== 'object') continue;
    const key = row.confidence == null ? '(null)' : String(row.confidence);
    m[key] = (m[key] || 0) + 1;
  }
  return m;
}

/**
 * @param {object[]} windowRows
 * @param {'bestStrategyId' | 'worstStrategyId'} field
 * @returns {Record<string, number>}
 */
function countStrategyIdField(windowRows, field) {
  /** @type {Record<string, number>} */
  const m = {};
  for (const row of windowRows) {
    if (!row || typeof row !== 'object') continue;
    const raw = row[field];
    const key = raw == null ? '(null)' : String(raw);
    m[key] = (m[key] || 0) + 1;
  }
  return m;
}

/**
 * @param {object[]} windowRows
 * @returns {{ confidence: Record<string, number>, bestStrategyId: Record<string, number>, worstStrategyId: Record<string, number> }}
 */
function buildCounts(windowRows) {
  const confidenceRaw = countConfidence(windowRows);
  const bestRaw = countStrategyIdField(windowRows, 'bestStrategyId');
  const worstRaw = countStrategyIdField(windowRows, 'worstStrategyId');

  return {
    confidence: sortCountMapDescAlpha(confidenceRaw),
    bestStrategyId: sortCountMapDescAlpha(bestRaw),
    worstStrategyId: sortCountMapDescAlpha(worstRaw),
  };
}

/**
 * @param {object[]} entries
 * @param {number} k
 */
function takeWindow(entries, k) {
  const n = Math.max(0, Math.floor(Number(k)));
  const tail = Number.isFinite(n) && n > 0 ? n : 20;
  return entries.slice(-tail);
}

function formatMapLine(counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return '(none)';
  return entries.map(([key, n]) => `${key}=${n}`).join(' · ');
}

/**
 * @param {{ confidence: Record<string, number>, bestStrategyId: Record<string, number>, worstStrategyId: Record<string, number> }} counts
 * @param {{ tail: number, windowRowCount: number, badLines: number, missing: boolean }} meta
 * @returns {string[]}
 */
function buildHumanLines(counts, meta) {
  const lines = [];
  lines.push(
    `window: ${meta.tail} · rows: ${meta.windowRowCount} (badLines: ${meta.badLines})`
  );
  lines.push(`confidence: ${formatMapLine(counts.confidence)}`);
  lines.push('bestStrategyId:');
  lines.push(`  ${formatMapLine(counts.bestStrategyId)}`);
  lines.push('worstStrategyId:');
  lines.push(`  ${formatMapLine(counts.worstStrategyId)}`);
  return lines;
}

function parseArgs(argv) {
  const out = { json: false, tail: 20 };
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
  const windowRows = missing ? [] : takeWindow(entries, args.tail);
  const windowRowCount = windowRows.length;
  const counts = buildCounts(windowRows);

  const meta = {
    sourceJsonPathUsed,
    tail: args.tail,
    windowRowCount,
    rowCount: windowRowCount,
    badLines,
    missing,
  };

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          learningWindowStatsContractVersion: LEARNING_WINDOW_STATS_CONTRACT_VERSION,
          meta,
          counts,
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  console.log('[governance_history_learning_window_stats] read-only · index window frequency counts');
  console.log('  sourceJsonPathUsed:', sourceJsonPathUsed);
  if (missing) {
    console.log('  status: missing (no index file)');
  }
  for (const line of buildHumanLines(counts, meta)) {
    console.log(line);
  }
  process.exit(0);
}

module.exports = {
  LEARNING_WINDOW_STATS_CONTRACT_VERSION,
  CONFIDENCE_BASE_KEYS,
  sortCountMapDescAlpha,
  countConfidence,
  countStrategyIdField,
  buildCounts,
  takeWindow,
  buildHumanLines,
  main,
};

if (require.main === module) {
  main();
}
