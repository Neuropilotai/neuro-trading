#!/usr/bin/env node
'use strict';

/**
 * Read-only learning-layer scan from governance/history/index.jsonl (last K rows).
 * Uses the same denormalized index fields captured at snapshot time as paperLearningInsights summary
 * (no per-snapshot JSON reads; no scoring, trends, or alerts).
 *
 * CLI: node engine/governance/learningScanGovernanceHistory.js [--json] [--tail K] [--no-header]
 * Default K=20. `--no-header` : TSV data rows only (pipes); ignored with `--json`.
 * Index path: same as reportGovernanceHistoryIndex / condenseGovernanceHistoryIndex.
 */

const path = require('path');
const {
  readHistoryIndexEntries,
  defaultIndexPath,
} = require('./reportGovernanceHistoryIndex');

/** Bump only on breaking change to row shape or column order (JSON consumers). */
const LEARNING_SCAN_CONTRACT_VERSION = '1.0.0';

/**
 * Stable column order (TSV header + JSON row keys).
 * Append only; reorder = bump contract + smoke.
 */
const LEARNING_SCAN_FIELD_ORDER = Object.freeze([
  'snapshotAtIso',
  'confidence',
  'bestStrategyId',
  'worstStrategyId',
  'validTradeCount',
]);

/**
 * @param {object|null|undefined} entry
 * @returns {Record<string, *>}
 */
function learningScanRow(entry) {
  const o = {};
  for (const k of LEARNING_SCAN_FIELD_ORDER) {
    if (!entry || typeof entry !== 'object' || !(k in entry) || entry[k] === undefined) {
      o[k] = null;
    } else {
      o[k] = entry[k];
    }
  }
  return o;
}

/**
 * @param {object[]} entries
 * @param {number} k
 */
function takeLastLearningScanRows(entries, k) {
  const n = Math.max(0, Math.floor(Number(k)));
  const tail = Number.isFinite(n) && n > 0 ? n : 20;
  return entries.slice(-tail).map(learningScanRow);
}

function tsvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function rowToTsv(row) {
  return LEARNING_SCAN_FIELD_ORDER.map((k) => tsvCell(row[k])).join('\t');
}

/**
 * @param {object[]} rows
 * @param {boolean} [noHeader]
 * @returns {string[]}
 */
function buildLearningScanTsvLines(rows, noHeader = false) {
  const lines = [];
  if (!noHeader) {
    lines.push(LEARNING_SCAN_FIELD_ORDER.join('\t'));
  }
  for (const row of rows) {
    lines.push(rowToTsv(row));
  }
  return lines;
}

function parseArgs(argv) {
  const out = { json: false, tail: 20, noHeader: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--json') out.json = true;
    if (argv[i] === '--no-header') out.noHeader = true;
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
  const rows = missing ? [] : takeLastLearningScanRows(entries, args.tail);

  const meta = {
    sourceJsonPathUsed,
    tail: args.tail,
    rowCount: rows.length,
    badLines,
    missing,
  };

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          learningScanContractVersion: LEARNING_SCAN_CONTRACT_VERSION,
          columns: [...LEARNING_SCAN_FIELD_ORDER],
          meta,
          rows,
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  console.log('[governance_history_learning_scan] read-only · last rows from index (learning fields, TSV)');
  console.log('  sourceJsonPathUsed:', sourceJsonPathUsed);
  if (missing) {
    console.log('  status: missing (no index file)');
    process.exit(0);
  }
  if (badLines > 0) {
    console.log('  badJsonLines (skipped while reading index):', badLines);
  }
  console.log('  tail:', args.tail, '· rows:', rows.length);
  if (args.noHeader) {
    console.log('  tsv: no-header (data rows only)');
  }
  for (const line of buildLearningScanTsvLines(rows, args.noHeader)) {
    console.log(line);
  }
  process.exit(0);
}

module.exports = {
  LEARNING_SCAN_CONTRACT_VERSION,
  LEARNING_SCAN_FIELD_ORDER,
  learningScanRow,
  takeLastLearningScanRows,
  buildLearningScanTsvLines,
  main,
};

if (require.main === module) {
  main();
}
