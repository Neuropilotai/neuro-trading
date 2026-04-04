#!/usr/bin/env node
'use strict';

/**
 * Read-only: among the last `tail` index rows, keep entries where `bestStrategyId` or
 * `worstStrategyId` strictly equals `--strategy` (same denormalized fields as learning-scan).
 * No snapshot JSON reads; no scoring, trends, or alerts.
 *
 * CLI: node engine/governance/strategyFocusScanGovernanceHistory.js --strategy <id> [--tail K] [--json] [--no-header]
 * Default K=20. `--no-header` : TSV data rows only; ignored with `--json`.
 */

const path = require('path');
const {
  readHistoryIndexEntries,
  defaultIndexPath,
} = require('./reportGovernanceHistoryIndex');
const {
  LEARNING_SCAN_FIELD_ORDER,
  learningScanRow,
  buildLearningScanTsvLines,
} = require('./learningScanGovernanceHistory');

/** Bump only on breaking change to row shape, column order, or filter semantics. */
const STRATEGY_FOCUS_SCAN_CONTRACT_VERSION = '1.0.0';

/**
 * Same projection as learning-scan (single operator-facing row shape).
 * Re-export order for JSON `columns` (contract surface).
 */
const STRATEGY_FOCUS_ROW_FIELD_ORDER = LEARNING_SCAN_FIELD_ORDER;

/**
 * @param {object|null|undefined} entry
 * @param {string} strategyId
 */
function entryMatchesStrategy(entry, strategyId) {
  if (!entry || typeof entry !== 'object' || strategyId == null || strategyId === '') {
    return false;
  }
  const best = entry.bestStrategyId;
  const worst = entry.worstStrategyId;
  return best === strategyId || worst === strategyId;
}

/**
 * @param {object[]} entries
 * @param {string} strategyId
 * @param {number} k
 * @returns {{ windowRows: object[], rows: Record<string,*>[] }}
 */
function takeStrategyFocusRows(entries, strategyId, k) {
  const n = Math.max(0, Math.floor(Number(k)));
  const tail = Number.isFinite(n) && n > 0 ? n : 20;
  const windowRows = entries.slice(-tail);
  const filtered = windowRows.filter((e) => entryMatchesStrategy(e, strategyId));
  const rows = filtered.map((e) => learningScanRow(e));
  return { windowRows, rows };
}

function parseArgs(argv) {
  const out = { json: false, tail: 20, noHeader: false, strategy: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--json') out.json = true;
    if (argv[i] === '--no-header') out.noHeader = true;
    if (argv[i] === '--tail' && argv[i + 1]) {
      out.tail = parseInt(argv[i + 1], 10);
      i += 1;
    }
    if (argv[i] === '--strategy' && argv[i + 1]) {
      out.strategy = String(argv[i + 1]).trim();
      i += 1;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.strategy == null || args.strategy === '') {
    console.error(
      '[governance_history_strategy_focus] missing required --strategy <id> (read-only index filter)'
    );
    process.exit(1);
  }

  const indexPath = defaultIndexPath();
  const sourceJsonPathUsed = path.resolve(indexPath);
  const { entries, badLines, missing } = readHistoryIndexEntries(indexPath);
  const { windowRows, rows } = missing
    ? { windowRows: [], rows: [] }
    : takeStrategyFocusRows(entries, args.strategy, args.tail);

  const meta = {
    sourceJsonPathUsed,
    strategyId: args.strategy,
    tail: args.tail,
    windowRowCount: windowRows.length,
    rowCount: rows.length,
    badLines,
    missing,
  };

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          strategyFocusScanContractVersion: STRATEGY_FOCUS_SCAN_CONTRACT_VERSION,
          columns: [...STRATEGY_FOCUS_ROW_FIELD_ORDER],
          meta,
          rows,
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  console.log(
    '[governance_history_strategy_focus] read-only · last tail window, rows where best or worst strategy matches (TSV)'
  );
  console.log('  sourceJsonPathUsed:', sourceJsonPathUsed);
  console.log('  strategyId:', args.strategy);
  if (missing) {
    console.log('  status: missing (no index file)');
    process.exit(0);
  }
  if (badLines > 0) {
    console.log('  badJsonLines (skipped while reading index):', badLines);
  }
  console.log('  tail:', args.tail, '· window rows:', windowRows.length, '· matches:', rows.length);
  if (args.noHeader) {
    console.log('  tsv: no-header (data rows only)');
  }
  for (const line of buildLearningScanTsvLines(rows, args.noHeader)) {
    console.log(line);
  }
  process.exit(0);
}

module.exports = {
  STRATEGY_FOCUS_SCAN_CONTRACT_VERSION,
  STRATEGY_FOCUS_ROW_FIELD_ORDER,
  entryMatchesStrategy,
  takeStrategyFocusRows,
  main,
};

if (require.main === module) {
  main();
}
