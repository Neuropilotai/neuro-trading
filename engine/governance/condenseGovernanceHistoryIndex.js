#!/usr/bin/env node
'use strict';

/**
 * Read-only condensed view of governance/history/index.jsonl (last K rows, stable columns).
 * Does not change diff / quick-summary contracts.
 *
 * CLI: node engine/governance/condenseGovernanceHistoryIndex.js [--json] [--tail K] [--no-header]
 * Default K=20. `--no-header` : TSV data rows only (pipes); ignored with `--json`. Same index path as reportGovernanceHistoryIndex.
 */

const path = require('path');
const {
  readHistoryIndexEntries,
  defaultIndexPath,
} = require('./reportGovernanceHistoryIndex');

/** Bump only on breaking change to row shape or column order (JSON consumers). */
const CONDENSED_INDEX_CONTRACT_VERSION = '1.0.0';

/** Stable column order (TSV header + JSON keys). Append only; reorder = bump contract + smoke. */
const CONDENSED_ROW_FIELD_ORDER = Object.freeze([
  'unixEpoch',
  'snapshotAtIso',
  'dashboardVersion',
  'validTradeCount',
  'confidence',
  'bestStrategyId',
  'worstStrategyId',
  'snapshotSizeBytes',
]);

/**
 * @param {object|null|undefined} entry
 * @returns {Record<string, *>}
 */
function condenseRow(entry) {
  const o = {};
  for (const k of CONDENSED_ROW_FIELD_ORDER) {
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
function takeLastCondensedRows(entries, k) {
  const n = Math.max(0, Math.floor(Number(k)));
  const tail = Number.isFinite(n) && n > 0 ? n : 20;
  return entries.slice(-tail).map(condenseRow);
}

function tsvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function rowToTsv(row) {
  return CONDENSED_ROW_FIELD_ORDER.map((k) => tsvCell(row[k])).join('\t');
}

/**
 * TSV body lines only (optional header row). `noHeader` does not change JSON contract version.
 * @param {object[]} rows - condensed rows
 * @param {boolean} [noHeader]
 * @returns {string[]}
 */
function buildCondensedTsvLines(rows, noHeader = false) {
  const lines = [];
  if (!noHeader) {
    lines.push(CONDENSED_ROW_FIELD_ORDER.join('\t'));
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
  const rows = missing ? [] : takeLastCondensedRows(entries, args.tail);

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
          condensedIndexContractVersion: CONDENSED_INDEX_CONTRACT_VERSION,
          columns: [...CONDENSED_ROW_FIELD_ORDER],
          meta,
          rows,
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  console.log('[governance_history_condensed] read-only · last rows from index (TSV)');
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
  for (const line of buildCondensedTsvLines(rows, args.noHeader)) {
    console.log(line);
  }
  process.exit(0);
}

module.exports = {
  CONDENSED_INDEX_CONTRACT_VERSION,
  CONDENSED_ROW_FIELD_ORDER,
  condenseRow,
  takeLastCondensedRows,
  buildCondensedTsvLines,
  main,
};

if (require.main === module) {
  main();
}
