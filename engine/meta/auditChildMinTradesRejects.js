#!/usr/bin/env node
'use strict';

/**
 * Aggregate audit: child strategies dropped by filterChildrenByMinTrades (read-only).
 * Compares buildStrategiesForMeta output before/after the same filter runMetaPipeline uses.
 *
 * Usage:
 *   export NEUROPILOT_DATA_ROOT=/path/to/data
 *   node engine/meta/auditChildMinTradesRejects.js
 *
 * Env:
 *   MIN_TRADES_CHILD=30
 *   MIN_TRADES_RATIO_CHILD=0.3
 *   ONLY_SOURCE_SUBSTRING=champion_mutation   (optional: filter report rows)
 *   GAP_NEAR_MAX=100          (gap <= this → bucket nearThreshold)
 *   GAP_MID_MAX=1000          (gap <= this and > near → intermediate; else far)
 *   AUDIT_SUMMARY_ONLY=1      (or --summary) print only governance blocks: counts,
 *                             rejectsGapByBucketAll, optional matching-source buckets,
 *                             mutationType counts (no per-setup list)
 */

const dataRoot = require('../dataRoot');
const {
  listBatchFiles,
  groupResultsBySetup,
  buildStrategiesForMeta,
  filterChildrenByMinTrades,
} = require('./runMetaPipeline');

function safeNum(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function minTradesForChild(s, bySetupId, minAbs, minRatio) {
  if (!s || !s.parentSetupId) return null;
  const parent = bySetupId.get(String(s.parentSetupId));
  const parentTrades = parent ? Math.max(0, safeNum(parent.trades, 0)) : 0;
  const minTrades =
    parentTrades > 0
      ? Math.max(minAbs, Math.floor(parentTrades * minRatio))
      : minAbs;
  return { parentTrades, minTradesRequired: minTrades, childTrades: safeNum(s.trades, 0) };
}

/** @param {{ tradesGapToPass: number }[]} arr */
function bucketByGap(arr, nearMax, midMax) {
  let near = 0;
  let intermediate = 0;
  let far = 0;
  for (const r of arr) {
    const g = r.tradesGapToPass;
    if (g <= nearMax) near += 1;
    else if (g <= midMax) intermediate += 1;
    else far += 1;
  }
  return { nearThreshold: near, intermediate, far };
}

/** @param {{ mutationType?: string | null }[]} arr */
function countByMutationType(arr) {
  const m = Object.create(null);
  for (const r of arr) {
    const k = r.mutationType == null || r.mutationType === '' ? '(none)' : String(r.mutationType);
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

/** Pick compact JSON for annex / governance (no rejectedChildren list). */
function buildGovernanceSummary(out) {
  const s = {
    generatedAt: out.generatedAt,
    counts: out.counts,
    rejectsGapByBucketAll: out.rejectsGapByBucketAll,
    mutationTypeCountsAmongRejectionsTotal: out.mutationTypeCountsAmongRejectionsTotal,
  };
  if (out.rejectsGapByBucketMatchingSourceFilter) {
    s.rejectsGapByBucketMatchingSourceFilter = out.rejectsGapByBucketMatchingSourceFilter;
  }
  if (out.mutationTypeCountsAmongRejectionsMatchingSourceFilter) {
    s.mutationTypeCountsAmongRejectionsMatchingSourceFilter =
      out.mutationTypeCountsAmongRejectionsMatchingSourceFilter;
  }
  return s;
}

function main() {
  const summaryOnly =
    process.env.AUDIT_SUMMARY_ONLY === '1' || process.argv.includes('--summary');

  const minTradesAbsolute = Math.max(
    0,
    safeNum(Number(process.env.MIN_TRADES_CHILD || 30), 30)
  );
  const minTradesRatio = Math.max(
    0,
    Math.min(1, safeNum(Number(process.env.MIN_TRADES_RATIO_CHILD || 0.3), 0.3))
  );
  const onlySub = (process.env.ONLY_SOURCE_SUBSTRING || '').trim().toLowerCase();
  const gapNearMax = Math.max(0, safeNum(Number(process.env.GAP_NEAR_MAX || 100), 100));
  const gapMidMax = Math.max(gapNearMax, safeNum(Number(process.env.GAP_MID_MAX || 1000), 1000));

  const batchDir = dataRoot.getPath('batch_results');
  const batchFiles = listBatchFiles(batchDir);
  if (!batchFiles.length) {
    console.error(JSON.stringify({ error: 'no_batch_files', batchDir }, null, 2));
    process.exit(2);
  }

  const { bySetup } = groupResultsBySetup(batchFiles);
  const strategies = buildStrategiesForMeta(bySetup, {});
  const filtered = filterChildrenByMinTrades(strategies, {
    minTradesAbsolute,
    minTradesRatio,
  });

  const keptIds = new Set(filtered.map((s) => String(s.setupId)));
  const bySetupId = new Map(strategies.map((s) => [String(s.setupId), s]));

  const children = strategies.filter((s) => s && s.parentSetupId);
  const rejected = children.filter((s) => !keptIds.has(String(s.setupId)));

  const allRows = [];
  for (const s of rejected) {
    const mt = minTradesForChild(s, bySetupId, minTradesAbsolute, minTradesRatio);
    if (!mt) continue;
    const gap = mt.minTradesRequired - mt.childTrades;
    allRows.push({
      setupId: s.setupId,
      source: s.source || null,
      mutationType: s.mutationType || null,
      parentSetupId: s.parentSetupId,
      parentTrades: mt.parentTrades,
      childTrades: mt.childTrades,
      minTradesRequired: mt.minTradesRequired,
      tradesGapToPass: gap,
    });
  }

  const rows = onlySub
    ? allRows.filter((r) =>
        String(r.source || '')
          .toLowerCase()
          .includes(onlySub)
      )
    : allRows;

  rows.sort((a, b) => a.tradesGapToPass - b.tradesGapToPass);

  const gapBucketDef = {
    nearThreshold: `tradesGapToPass <= ${gapNearMax}`,
    intermediate: `${gapNearMax} < tradesGapToPass <= ${gapMidMax}`,
    far: `tradesGapToPass > ${gapMidMax}`,
  };

  const rejectsGapByBucketAll = {
    scope: 'allRejectedByMinTrades',
    thresholds: { gapNearMaxInclusive: gapNearMax, gapMidMaxInclusive: gapMidMax },
    definition: gapBucketDef,
    buckets: bucketByGap(allRows, gapNearMax, gapMidMax),
  };

  const rejectsGapByBucketMatching = onlySub
    ? {
        scope: 'ONLY_SOURCE_SUBSTRING match',
        thresholds: { gapNearMaxInclusive: gapNearMax, gapMidMaxInclusive: gapMidMax },
        definition: gapBucketDef,
        buckets: bucketByGap(rows, gapNearMax, gapMidMax),
      }
    : null;

  const out = {
    generatedAt: new Date().toISOString(),
    counts: {
      strategiesTotal: strategies.length,
      withParentSetupId: children.length,
      childrenPassedFilter: children.filter((s) => keptIds.has(String(s.setupId))).length,
      childrenRejectedByMinTradesTotal: allRows.length,
      childrenRejectedMatchingSourceFilter: onlySub ? rows.length : allRows.length,
    },
    rejectsGapByBucketAll,
    ...(rejectsGapByBucketMatching && { rejectsGapByBucketMatchingSourceFilter: rejectsGapByBucketMatching }),
    mutationTypeCountsAmongRejectionsTotal: countByMutationType(allRows),
    ...(onlySub && {
      mutationTypeCountsAmongRejectionsMatchingSourceFilter: countByMutationType(rows),
    }),
    dataRoot: dataRoot.getDataRoot(),
    batchDir,
    batchFileCount: batchFiles.length,
    filter: {
      minTradesAbsolute,
      minTradesRatio,
      formula:
        'minTradesRequired = max(minTradesAbsolute, floor(parentTrades * minTradesRatio)) when parent known; else minTradesAbsolute',
    },
    onlySourceSubstring: onlySub || null,
    rejectedChildrenNearestFirst: rows.slice(0, 200),
    truncated:
      rows.length > 200
        ? { note: 'rejectedChildrenNearestFirst capped at 200', totalRejected: rows.length }
        : null,
  };

  if (summaryOnly) {
    console.log(JSON.stringify(buildGovernanceSummary(out), null, 2));
    return;
  }

  console.log(JSON.stringify(out, null, 2));
}

main();
