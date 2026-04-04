#!/usr/bin/env node
'use strict';

/**
 * Read-only audit: among children rejected by filterChildrenByMinTrades, aggregate
 * by parentSetupId (and optional family prefix) — gap buckets + mutationType mix.
 * Same batch/meta replay as auditChildMinTradesRejects.js.
 *
 * Usage:
 *   export NEUROPILOT_DATA_ROOT=/path/to/data
 *   node engine/meta/auditChildMinTradesByParent.js
 *
 * Env (aligned with auditChildMinTradesRejects.js):
 *   MIN_TRADES_CHILD=30
 *   MIN_TRADES_RATIO_CHILD=0.3
 *   ONLY_SOURCE_SUBSTRING=champion_mutation   (optional)
 *   GAP_NEAR_MAX=100
 *   GAP_MID_MAX=1000
 *   TOP_PARENTS=50              (max rows in topParentsByPenalty)
 *   SORT_BY=far_first           | rejects_first  (default far_first)
 *   FAMILY_PREFIX_N=2           (0 = disable familyRollup; else first N underscore segments)
 *   AUDIT_SUMMARY_ONLY=1        (or --summary) compact JSON: no full parent list beyond top
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

function familyKeyFromParentId(parentId, prefixN) {
  if (!prefixN || prefixN < 1) return null;
  const segs = String(parentId).split('_');
  if (segs.length === 0) return String(parentId);
  return segs.slice(0, Math.min(prefixN, segs.length)).join('_');
}

function aggregateByParent(rows, gapNearMax, gapMidMax) {
  const map = new Map();
  for (const r of rows) {
    const pid = String(r.parentSetupId || '');
    if (!pid) continue;
    let e = map.get(pid);
    if (!e) {
      e = {
        parentSetupId: pid,
        parentTrades: r.parentTrades,
        rejectedChildren: 0,
        gapBuckets: { nearThreshold: 0, intermediate: 0, far: 0 },
        mutationTypeCounts: Object.create(null),
      };
      map.set(pid, e);
    }
    e.rejectedChildren += 1;
    const g = r.tradesGapToPass;
    if (g <= gapNearMax) e.gapBuckets.nearThreshold += 1;
    else if (g <= gapMidMax) e.gapBuckets.intermediate += 1;
    else e.gapBuckets.far += 1;

    const mt =
      r.mutationType == null || r.mutationType === ''
        ? '(none)'
        : String(r.mutationType);
    e.mutationTypeCounts[mt] = (e.mutationTypeCounts[mt] || 0) + 1;
  }
  return [...map.values()];
}

function sortParents(entries, sortBy) {
  const cmpFarFirst = (a, b) =>
    b.gapBuckets.far - a.gapBuckets.far ||
    b.rejectedChildren - a.rejectedChildren ||
    b.parentTrades - a.parentTrades;
  const cmpRejectsFirst = (a, b) =>
    b.rejectedChildren - a.rejectedChildren ||
    b.gapBuckets.far - a.gapBuckets.far ||
    b.parentTrades - a.parentTrades;
  return [...entries].sort(sortBy === 'rejects_first' ? cmpRejectsFirst : cmpFarFirst);
}

function rollupFamilyPrefix(rows, gapNearMax, gapMidMax, prefixN) {
  if (!prefixN || prefixN < 1) return null;
  const map = new Map();
  for (const r of rows) {
    const fk = familyKeyFromParentId(r.parentSetupId, prefixN);
    if (!fk) continue;
    let e = map.get(fk);
    if (!e) {
      e = {
        familyPrefix: fk,
        prefixSegmentCount: prefixN,
        distinctParents: new Set(),
        rejectedChildren: 0,
        gapBuckets: { nearThreshold: 0, intermediate: 0, far: 0 },
        mutationTypeCounts: Object.create(null),
      };
      map.set(fk, e);
    }
    e.distinctParents.add(String(r.parentSetupId));
    e.rejectedChildren += 1;
    const g = r.tradesGapToPass;
    if (g <= gapNearMax) e.gapBuckets.nearThreshold += 1;
    else if (g <= gapMidMax) e.gapBuckets.intermediate += 1;
    else e.gapBuckets.far += 1;
    const mt =
      r.mutationType == null || r.mutationType === ''
        ? '(none)'
        : String(r.mutationType);
    e.mutationTypeCounts[mt] = (e.mutationTypeCounts[mt] || 0) + 1;
  }
  const list = [...map.values()].map((x) => ({
    familyPrefix: x.familyPrefix,
    prefixSegmentCount: x.prefixSegmentCount,
    distinctParentCount: x.distinctParents.size,
    rejectedChildren: x.rejectedChildren,
    gapBuckets: x.gapBuckets,
    mutationTypeCounts: x.mutationTypeCounts,
  }));
  list.sort(
    (a, b) =>
      b.gapBuckets.far - a.gapBuckets.far ||
      b.rejectedChildren - a.rejectedChildren
  );
  return list;
}

function buildRejectRows(strategies, filtered, bySetupId, minTradesAbsolute, minTradesRatio) {
  const keptIds = new Set(filtered.map((s) => String(s.setupId)));
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
  return allRows;
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
  const topParents = Math.max(1, safeNum(Number(process.env.TOP_PARENTS || 50), 50));
  const sortBy = (process.env.SORT_BY || 'far_first').trim().toLowerCase();
  const familyPrefixN = Math.max(0, Math.floor(safeNum(Number(process.env.FAMILY_PREFIX_N ?? 2), 2)));

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
  const bySetupId = new Map(strategies.map((s) => [String(s.setupId), s]));

  const allRows = buildRejectRows(
    strategies,
    filtered,
    bySetupId,
    minTradesAbsolute,
    minTradesRatio
  );
  const rows = onlySub
    ? allRows.filter((r) =>
        String(r.source || '')
          .toLowerCase()
          .includes(onlySub)
      )
    : allRows;

  const byParent = aggregateByParent(rows, gapNearMax, gapMidMax);
  const sortedParents = sortParents(byParent, sortBy);
  const topSlice = sortedParents.slice(0, topParents);

  const fullFamilyRollup =
    familyPrefixN > 0 ? rollupFamilyPrefix(rows, gapNearMax, gapMidMax, familyPrefixN) : null;
  const familyRollupSlice =
    fullFamilyRollup && fullFamilyRollup.length ? fullFamilyRollup.slice(0, topParents) : null;

  const out = {
    generatedAt: new Date().toISOString(),
    dataRoot: dataRoot.getDataRoot(),
    batchDir,
    batchFileCount: batchFiles.length,
    filter: {
      minTradesAbsolute,
      minTradesRatio,
      onlySourceSubstring: onlySub || null,
      gapNearMaxInclusive: gapNearMax,
      gapMidMaxInclusive: gapMidMax,
      sortBy: sortBy === 'rejects_first' ? 'rejects_first' : 'far_first',
      familyPrefixN: familyPrefixN > 0 ? familyPrefixN : null,
    },
    counts: {
      rejectedRowsInScope: rows.length,
      distinctParentsWithRejects: byParent.length,
    },
    topParentsByPenalty: topSlice,
    topParentsTruncated:
      sortedParents.length > topParents
        ? { note: 'topParentsByPenalty capped', totalParents: sortedParents.length, cap: topParents }
        : null,
    ...(fullFamilyRollup && fullFamilyRollup.length
      ? {
          topFamilyPrefixesByFar: familyRollupSlice,
          topFamilyPrefixesTruncated:
            fullFamilyRollup.length > topParents
              ? {
                  note: 'topFamilyPrefixesByFar capped',
                  totalFamilies: fullFamilyRollup.length,
                  cap: topParents,
                }
              : null,
        }
      : {}),
  };

  if (summaryOnly) {
    const compact = {
      generatedAt: out.generatedAt,
      filter: out.filter,
      counts: out.counts,
      topParentsByPenalty: out.topParentsByPenalty,
      topParentsTruncated: out.topParentsTruncated,
    };
    if (fullFamilyRollup && fullFamilyRollup.length) {
      compact.topFamilyPrefixesByFar = out.topFamilyPrefixesByFar;
      compact.topFamilyPrefixesTruncated = out.topFamilyPrefixesTruncated;
    }
    console.log(JSON.stringify(compact, null, 2));
    return;
  }

  console.log(JSON.stringify(out, null, 2));
}

main();
