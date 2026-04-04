#!/usr/bin/env node
'use strict';

/**
 * Enrich each child batch row with parent metrics and beats_parent.
 *
 * - Loads all strategy_batch_results_*.json
 * - Builds global index: setupId -> { expectancy, trades, winRate }
 * - For each file, for each row with parentSetupId: adds
 *   parent_expectancy, parent_trades, parent_winRate, beats_parent, parent_vs_child_score
 * - Writes back to the same files
 *
 * Downstream: buildMutationPerfFromBatchResults uses row.beats_parent and row.parent_vs_child_score.
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');

function safeNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function listBatchFiles(batchDir) {
  if (!batchDir || !fs.existsSync(batchDir)) return [];
  return fs.readdirSync(batchDir)
    .filter((f) => /^strategy_batch_results_.*\.json$/i.test(f))
    .map((f) => path.join(batchDir, f))
    .sort();
}

/**
 * Build index: setupId -> { expectancy, trades, winRate }.
 * Prefer entry with more trades when same setupId appears in multiple files.
 */
function buildParentIndex(batchFiles) {
  const bySetupId = new Map();

  for (const filePath of batchFiles) {
    const json = safeReadJson(filePath);
    if (!json || !Array.isArray(json.results)) continue;

    for (const row of json.results) {
      const setupId = row && (row.setupId && String(row.setupId).trim());
      if (!setupId) continue;

      const trades = Math.max(0, safeNum(row.trades, 0));
      const expectancy = safeNum(row.expectancy, null);
      const winRate = row.winRate != null ? safeNum(row.winRate, null) : null;

      const existing = bySetupId.get(setupId);
      if (existing && existing.trades >= trades) continue;
      bySetupId.set(setupId, {
        expectancy: Number.isFinite(expectancy) ? expectancy : null,
        trades,
        winRate: winRate != null && Number.isFinite(winRate) ? winRate : null,
      });
    }
  }

  return bySetupId;
}

/**
 * Enrich a single row if it has parentSetupId. Mutates row in place.
 * @returns {boolean} true if row was enriched
 */
function enrichRow(row, parentIndex) {
  const parentId = row && (row.parentSetupId && String(row.parentSetupId).trim());
  if (!parentId) return false;

  const parent = parentIndex.get(parentId);
  if (!parent) return false;

  const childExpectancy = safeNum(row.expectancy, null);
  const parentExpectancy = parent.expectancy;

  row.parent_expectancy = parent.expectancy;
  row.parent_trades = parent.trades;
  row.parent_winRate = parent.winRate;

  const bothFinite =
    Number.isFinite(childExpectancy) && Number.isFinite(parentExpectancy);
  row.beats_parent = bothFinite ? childExpectancy > parentExpectancy : false;
  row.parent_vs_child_score = bothFinite
    ? childExpectancy - parentExpectancy
    : null;

  return true;
}

/**
 * Enrich all batch files in batchDir: add parent_* and beats_parent to each child row, write back.
 * @param {string} batchDir - directory containing strategy_batch_results_*.json
 * @param {{ dryRun?: boolean }} opts
 * @returns {{ filesRead: number, filesWritten: number, rowsEnriched: number }}
 */
function enrichBatchResultsWithParentMetrics(batchDir, opts = {}) {
  const dryRun = !!opts.dryRun;
  const batchFiles = listBatchFiles(batchDir);

  const parentIndex = buildParentIndex(batchFiles);

  let filesRead = 0;
  let filesWritten = 0;
  let rowsEnriched = 0;

  for (const filePath of batchFiles) {
    const json = safeReadJson(filePath);
    if (!json || !Array.isArray(json.results)) continue;

    filesRead += 1;
    let changed = false;

    for (const row of json.results) {
      if (enrichRow(row, parentIndex)) {
        rowsEnriched += 1;
        changed = true;
      }
    }

    if (changed && !dryRun) {
      fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');
      filesWritten += 1;
    }
  }

  return {
    filesRead,
    filesWritten,
    rowsEnriched,
    parentIndexSize: parentIndex.size,
  };
}

function run(opts = {}) {
  const batchDir = opts.batchDir || dataRoot.getPath('batch_results', false);
  const dryRun = !!opts.dryRun;

  const result = enrichBatchResultsWithParentMetrics(batchDir, { dryRun });

  console.log('Enrich batch results (parent metrics + beats_parent):');
  console.log(`  Batch dir: ${batchDir}`);
  console.log(`  Files read: ${result.filesRead}`);
  console.log(`  Rows enriched: ${result.rowsEnriched}`);
  console.log(`  Parent index size: ${result.parentIndexSize}`);
  if (dryRun) {
    console.log('  (dry run: no files written)');
  } else {
    console.log(`  Files written: ${result.filesWritten}`);
  }

  return result;
}

if (require.main === module) {
  try {
    const dryRun = process.argv.includes('--dry-run');
    run({ dryRun });
  } catch (err) {
    console.error('Enrich failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = {
  buildParentIndex,
  enrichRow,
  enrichBatchResultsWithParentMetrics,
  listBatchFiles,
  run,
};
