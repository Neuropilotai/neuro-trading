#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const { enrichBatchResultsWithParentMetrics } = require('./enrichBatchResultsWithParentMetrics');

function safeNum(v, fallback = 0) {
  return Number.isFinite(Number(v)) ? Number(v) : fallback;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function listBatchFiles(batchDir) {
  if (!fs.existsSync(batchDir)) return [];
  return fs.readdirSync(batchDir)
    .filter((f) => /^strategy_batch_results_.*\.json$/i.test(f))
    .map((f) => path.join(batchDir, f))
    .sort();
}

function isChild(row) {
  return !!(
    row &&
    (
      row.parentSetupId ||
      row.parentFamilyId ||
      row.mutationType ||
      String(row.setupId || '').startsWith('familyexp_')
    )
  );
}

function getMutationType(row) {
  if (row && row.mutationType) return String(row.mutationType);
  return 'unknown';
}

function isValidChildForLearning(row, opts = {}) {
  if (!isChild(row)) return false;
  if (row.backtestInvalid === true) return false;

  const minTrades = Math.max(1, safeNum(opts.minTrades, 20));
  const trades = safeNum(row.trades, 0);
  if (trades < minTrades) return false;

  return true;
}

function buildMutationPerfFromBatchResults(batchFiles, opts = {}) {
  const byMutationType = {};
  const minTrades = Math.max(1, safeNum(opts.minTrades, 20));

  let filesRead = 0;
  let rowsSeen = 0;
  let childRowsSeen = 0;
  let childRowsEligible = 0;

  for (const file of batchFiles || []) {
    const json = safeReadJson(file);
    if (!json || !Array.isArray(json.results)) continue;

    filesRead += 1;

    for (const row of json.results) {
      rowsSeen += 1;

      if (!isChild(row)) continue;
      childRowsSeen += 1;

      if (!isValidChildForLearning(row, { minTrades })) continue;
      childRowsEligible += 1;

      const mutationType = getMutationType(row);

      if (!byMutationType[mutationType]) {
        byMutationType[mutationType] = {
          total: 0,
          beats: 0,
          avgExpectancy: 0,
          avgTrades: 0,
          avgParentVsChildScore: 0,
          validRows: 0,
        };
      }

      const bucket = byMutationType[mutationType];
      bucket.total += 1;
      bucket.validRows += 1;
      bucket.beats += row.beats_parent === true ? 1 : 0;
      bucket.avgExpectancy += safeNum(row.expectancy, 0);
      bucket.avgTrades += safeNum(row.trades, 0);
      bucket.avgParentVsChildScore += safeNum(row.parent_vs_child_score, 0);
    }
  }

  for (const key of Object.keys(byMutationType)) {
    const x = byMutationType[key];
    const n = Math.max(1, x.validRows);
    x.avgExpectancy = x.avgExpectancy / n;
    x.avgTrades = x.avgTrades / n;
    x.avgParentVsChildScore = x.avgParentVsChildScore / n;
    x.beatsRate = x.total > 0 ? x.beats / x.total : 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    source: 'batch_results',
    minTrades,
    filesRead,
    rowsSeen,
    childRowsSeen,
    childRowsEligible,
    byMutationType,
  };
}

function writeMutationPerf(outPath, perf) {
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(perf, null, 2), 'utf8');
  return outPath;
}

function run(opts = {}) {
  const batchDir = opts.batchDir || dataRoot.getPath('batch_results', false);
  const discoveryDir = opts.discoveryDir || dataRoot.getPath('discovery', false);
  const outPath = opts.outPath || path.join(discoveryDir, 'mutation_perf.json');
  const minTrades = Math.max(1, safeNum(opts.minTrades, process.env.MUTATION_PERF_MIN_TRADES || 20));
  const enrichFirst = opts.enrichFirst !== false;

  if (enrichFirst) {
    const enrichResult = enrichBatchResultsWithParentMetrics(batchDir, { dryRun: false });
    if (enrichResult.rowsEnriched > 0) {
      console.log(`Enriched ${enrichResult.rowsEnriched} child rows across ${enrichResult.filesWritten} batch file(s).`);
    }
  }

  const batchFiles = listBatchFiles(batchDir);
  const perf = buildMutationPerfFromBatchResults(batchFiles, { minTrades });
  writeMutationPerf(outPath, perf);

  console.log('Mutation perf built.');
  console.log(`  Batch files: ${perf.filesRead}`);
  console.log(`  Rows seen: ${perf.rowsSeen}`);
  console.log(`  Child rows seen: ${perf.childRowsSeen}`);
  console.log(`  Child rows eligible: ${perf.childRowsEligible}`);
  console.log(`  Output: ${outPath}`);

  return perf;
}

if (require.main === module) {
  try {
    const noEnrich = process.argv.includes('--no-enrich');
    run({ enrichFirst: !noEnrich });
  } catch (err) {
    console.error('Mutation perf build failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = {
  isChild,
  isValidChildForLearning,
  buildMutationPerfFromBatchResults,
  writeMutationPerf,
  run,
};
