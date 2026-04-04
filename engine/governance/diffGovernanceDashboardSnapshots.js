#!/usr/bin/env node
'use strict';

/**
 * Read-only diff of two governance_dashboard snapshot JSON files (focus: paper + metrics slice).
 *
 * Usage: node engine/governance/diffGovernanceDashboardSnapshots.js <snapshotA.json> <snapshotB.json>
 * Optional: --json  (structured A/B slice, no mutation)
 * Optional: --no-summary  (text mode only: skip quick human header A vs B)
 *
 * Quick summary appends snapshotSizeBytes (file size on disk) when stat succeeds for both paths — aligns with index.jsonl audit, not a dashboard JSON field.
 *
 * **Quick summary line order (stable, do not reorder without bumping contract / smoke):**
 * 1. dashboardVersion → 2. confidence → 3. validTradeCount → 4. bestStrategyId → 5. worstStrategyId → 6. snapshotSizeBytes (optional, always last when present)
 *
 * **Evolving this contract:** new **payload-derived** fields → **append** to `QUICK_SUMMARY_FIELD_ORDER` only (never insert in the middle without operator-visible changelog). New **file-derived** lines → stay **after** payload keys; if more than one, keep **after** `snapshotSizeBytes` or document a new terminal order + smoke. Bump **`QUICK_SUMMARY_CONTRACT_VERSION`** on any breaking change to line order or semantics (exposed in `--json`).
 */

const fs = require('fs');
const path = require('path');

/** @readonly Ordered field keys for human quick summary (payload-derived). */
const QUICK_SUMMARY_FIELD_ORDER = Object.freeze([
  'dashboardVersion',
  'confidence',
  'validTradeCount',
  'bestStrategyId',
  'worstStrategyId',
]);

/**
 * Bump when quick-summary line order or semantics change in a **breaking** way for operators/scripts.
 * Exposed in `--json` as `quickSummaryContractVersion`.
 */
const QUICK_SUMMARY_CONTRACT_VERSION = '1.0.0';

function pickMetricsV2(v2) {
  if (!v2 || typeof v2 !== 'object') return null;
  return {
    validTradeCount: v2.validTradeCount,
    bestStrategy: v2.bestStrategy,
    worstStrategy: v2.worstStrategy,
    parseErrors: v2.parseErrors,
    lineCount: v2.lineCount,
  };
}

function extractSlice(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    dashboardVersion: payload.dashboardVersion,
    generatedAt: payload.generatedAt,
    dataRoot: payload.dataRoot,
    paperLearningInsights: payload.paperLearningInsights,
    paperTradesMetricsV2: pickMetricsV2(payload.paperTradesMetricsV2),
    paperTradesMetrics:
      payload.paperTradesMetrics && typeof payload.paperTradesMetrics === 'object'
        ? {
            validTradeCount: payload.paperTradesMetrics.validTradeCount,
            parseErrors: payload.paperTradesMetrics.parseErrors,
            lineCount: payload.paperTradesMetrics.lineCount,
          }
        : null,
  };
}

function loadJson(p) {
  const abs = path.resolve(p);
  const raw = fs.readFileSync(abs, 'utf8');
  return { abs, payload: JSON.parse(raw) };
}

/** @returns {number|null} byte size or null if stat fails */
function safeFileSizeBytes(absPath) {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return null;
    const n = Number(st.size);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function pickStrategyIdFromMetric(v) {
  if (v == null) return '(null)';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.strategyId != null) return String(v.strategyId);
  return '(n/a)';
}

/**
 * Comparable scalars for human one-liners (observation only).
 * @param {object|null} slice - from extractSlice
 */
function comparablePaperFields(slice) {
  if (!slice || typeof slice !== 'object') {
    return {
      dashboardVersion: '(n/a)',
      confidence: '(n/a)',
      validTradeCount: '(n/a)',
      bestStrategyId: '(n/a)',
      worstStrategyId: '(n/a)',
    };
  }
  const ins = slice.paperLearningInsights;
  let confidence = '(n/a)';
  if (ins === null) {
    confidence = '(null)';
  } else if (ins && typeof ins === 'object' && Object.prototype.hasOwnProperty.call(ins, 'confidence')) {
    confidence = ins.confidence == null ? '(null)' : String(ins.confidence);
  }
  const v2 = slice.paperTradesMetricsV2;
  const v1 = slice.paperTradesMetrics;
  let validTradeCount = '(n/a)';
  if (v2 && v2.validTradeCount != null) validTradeCount = String(v2.validTradeCount);
  else if (v1 && v1.validTradeCount != null) validTradeCount = String(v1.validTradeCount);

  const bestFromInsights =
    ins && ins.summaryBestStrategyId != null ? String(ins.summaryBestStrategyId) : null;
  const bestFromV2 = v2 ? pickStrategyIdFromMetric(v2.bestStrategy) : '(null)';
  const bestStrategyId =
    bestFromInsights || (bestFromV2 !== '(null)' && bestFromV2 !== '(n/a)' ? bestFromV2 : '(null)');

  const worstFromInsights =
    ins && ins.summaryWorstStrategyId != null ? String(ins.summaryWorstStrategyId) : null;
  const worstFromV2 = v2 ? pickStrategyIdFromMetric(v2.worstStrategy) : '(null)';
  const worstStrategyId =
    worstFromInsights || (worstFromV2 !== '(null)' && worstFromV2 !== '(n/a)' ? worstFromV2 : '(null)');

  const dashboardVersion =
    slice.dashboardVersion == null || slice.dashboardVersion === ''
      ? '(null)'
      : String(slice.dashboardVersion);

  return {
    dashboardVersion,
    confidence,
    validTradeCount,
    bestStrategyId,
    worstStrategyId,
  };
}

/**
 * @param {object|null} sliceA
 * @param {object|null} sliceB
 * @param {object} [opts]
 * @param {number|null} [opts.fileSizeBytesA]
 * @param {number|null} [opts.fileSizeBytesB]
 * @returns {string[]} lines without trailing newlines
 */
function formatHumanPaperDiffSummary(sliceA, sliceB, opts = {}) {
  const a = comparablePaperFields(sliceA);
  const b = comparablePaperFields(sliceB);
  const out = [];
  for (const key of QUICK_SUMMARY_FIELD_ORDER) {
    const va = a[key];
    const vb = b[key];
    if (va === vb) {
      out.push(`  ${key}: ${va} (unchanged)`);
    } else {
      out.push(`  ${key}: ${va} -> ${vb}`);
    }
  }

  const szA = opts.fileSizeBytesA;
  const szB = opts.fileSizeBytesB;
  if (szA != null && szB != null && Number.isFinite(szA) && Number.isFinite(szB)) {
    const sa = String(szA);
    const sb = String(szB);
    if (sa === sb) {
      out.push(`  snapshotSizeBytes: ${sa} (unchanged)`);
    } else {
      out.push(`  snapshotSizeBytes: ${sa} -> ${sb}`);
    }
  }

  return out;
}

function parseArgs(argv) {
  const paths = [];
  let jsonOut = false;
  let noSummary = false;
  for (const a of argv) {
    if (a === '--json') jsonOut = true;
    else if (a === '--no-summary') noSummary = true;
    else paths.push(a);
  }
  return { paths, jsonOut, noSummary };
}

function main() {
  const { paths, jsonOut, noSummary } = parseArgs(process.argv.slice(2));
  const a = paths[0];
  const b = paths[1];
  if (!a || !b) {
    console.error(
      'usage: node engine/governance/diffGovernanceDashboardSnapshots.js <snapshotA.json> <snapshotB.json> [--json] [--no-summary]'
    );
    process.exit(1);
  }

  let la;
  let lb;
  try {
    la = loadJson(a);
    lb = loadJson(b);
  } catch (e) {
    console.error('[governance_diff] read/parse failed:', e && e.message ? e.message : e);
    process.exit(1);
  }

  const sa = extractSlice(la.payload);
  const sb = extractSlice(lb.payload);
  const ja = JSON.stringify(sa, null, 2);
  const jb = JSON.stringify(sb, null, 2);

  const fileSizeBytesA = safeFileSizeBytes(la.abs);
  const fileSizeBytesB = safeFileSizeBytes(lb.abs);
  const quickLines = formatHumanPaperDiffSummary(sa, sb, {
    fileSizeBytesA,
    fileSizeBytesB,
  });

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          quickSummaryContractVersion: QUICK_SUMMARY_CONTRACT_VERSION,
          sourceJsonPathUsedA: la.abs,
          sourceJsonPathUsedB: lb.abs,
          fileSizeBytesA,
          fileSizeBytesB,
          identicalPaperSlice: ja === jb,
          quickSummaryLines: quickLines,
          sliceA: sa,
          sliceB: sb,
        },
        null,
        2
      )
    );
    process.exit(ja === jb ? 0 : 2);
  }

  console.log('[governance_diff] read-only (paper + metrics slice)');
  console.log('  A:', la.abs);
  console.log('  B:', lb.abs);
  if (!noSummary) {
    console.log('\n=== quick summary (A vs B) ===');
    console.log(quickLines.join('\n'));
  }
  if (ja === jb) {
    console.log('\n  result: identical slice (full JSON)');
    process.exit(0);
  }
  console.log('\n=== slice A ===\n');
  console.log(ja);
  console.log('\n=== slice B ===\n');
  console.log(jb);
  process.exit(2);
}

module.exports = {
  QUICK_SUMMARY_CONTRACT_VERSION,
  QUICK_SUMMARY_FIELD_ORDER,
  extractSlice,
  formatHumanPaperDiffSummary,
  comparablePaperFields,
  safeFileSizeBytes,
  main,
};

if (require.main === module) {
  main();
}
