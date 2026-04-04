#!/usr/bin/env node
'use strict';

/**
 * Audit where a setupId sits in the meta funnel (read-only, no writes).
 * Reuses the same steps as runMetaPipeline.js up to capRankedStrategiesByDiversity (meta file top N).
 *
 * Usage (from neuropilot_trading_v2):
 *   export NEUROPILOT_DATA_ROOT=/path/to/data
 *   node engine/meta/auditMetaSetupFunnel.js mut_6c8e2f_mid_df182a
 *   node engine/meta/auditMetaSetupFunnel.js id1 id2
 *
 * Env (optional, align with your pipeline):
 *   TOP_N=30
 *   MIN_TRADES_CHILD=30
 *   MIN_TRADES_RATIO_CHILD=0.3
 */

const dataRoot = require('../dataRoot');
const { computeMetaRanking } = require('./index');
const {
  listBatchFiles,
  groupResultsBySetup,
  buildStrategiesForMeta,
  filterChildrenByMinTrades,
  annotateParentVsChild,
  sortRankedStrategies,
  capRankedStrategiesByDiversity,
  loadPromotedChildren,
  buildPromotedMap,
  enrichWithPromotedChildren,
} = require('./runMetaPipeline');

function safeNum(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function pickStrategyFields(s) {
  if (!s) return null;
  return {
    setupId: s.setupId,
    source: s.source,
    parentSetupId: s.parentSetupId || null,
    mutationType: s.mutationType || null,
    expectancy: s.expectancy,
    trades: s.trades,
    winRate: s.winRate,
    cross_asset_score: s.cross_asset_score,
    timeframe_stability_score: s.timeframe_stability_score,
    stability: s.stability,
    meta_score: s.meta_score,
    rank: s.rank,
    validationPassed: s.validationPassed,
    validation_score: s.validation_score,
    beats_parent: s.beats_parent,
    parent_vs_child_score: s.parent_vs_child_score,
  };
}

function explainChildMinTradesFilter(s, allStrategies, minAbs, minRatio) {
  if (!s || !s.parentSetupId) return { applies: false };
  const byId = new Map((allStrategies || []).map((x) => [String(x.setupId), x]));
  const parent = byId.get(String(s.parentSetupId));
  const parentTrades = parent ? Math.max(0, safeNum(parent.trades, 0)) : 0;
  const minTrades =
    parentTrades > 0
      ? Math.max(minAbs, Math.floor(parentTrades * minRatio))
      : minAbs;
  return {
    applies: true,
    parentSetupId: s.parentSetupId,
    parentTrades,
    childTrades: safeNum(s.trades, 0),
    minTradesRequired: minTrades,
    passed: safeNum(s.trades, 0) >= minTrades,
  };
}

function auditOne(setupId, ctx) {
  const {
    bySetup,
    strategies,
    strategiesFiltered,
    rankedBase,
    reranked,
    top,
    topN,
    minTradesAbsolute,
    minTradesRatio,
  } = ctx;

  const entries = bySetup.get(setupId);
  const inBatch = !!entries && entries.length > 0;
  const batchRowCount = entries ? entries.length : 0;
  const batchFiles = inBatch
    ? [...new Set(entries.map((e) => e.file).filter(Boolean))]
    : [];

  const strat = strategies.find((s) => String(s.setupId) === setupId) || null;
  const stratF =
    strategiesFiltered.find((s) => String(s.setupId) === setupId) || null;

  const rankedRow = rankedBase.find((s) => String(s.setupId) === setupId) || null;
  const idxReranked = reranked.findIndex((s) => String(s.setupId) === setupId);
  const posReranked = idxReranked >= 0 ? idxReranked + 1 : null;
  const inTopN = top.some((s) => String(s.setupId) === setupId);

  const childFilterDetail = strat
    ? explainChildMinTradesFilter(strat, strategies, minTradesAbsolute, minTradesRatio)
    : null;

  return {
    setupId,
    batch: {
      inGroupResultsBySetup: inBatch,
      batchRowCount,
      batchFilesSample: batchFiles.slice(0, 8),
      batchFilesTotal: batchFiles.length,
    },
    afterBuildStrategiesForMeta: pickStrategyFields(strat),
    filterChildrenByMinTrades: {
      survived: !!stratF,
      detail: childFilterDetail,
    },
    afterComputeMetaRanking: pickStrategyFields(rankedRow),
    funnel: {
      totalStrategiesBuilt: strategies.length,
      totalAfterChildTradeFilter: strategiesFiltered.length,
      totalStrategiesRanked: reranked.length,
      topN,
      positionInReranked: posReranked,
      inDiversityCapTopN: inTopN,
      interpretation: !inBatch
        ? 'B0: not in batch aggregation (no valid rows or wrong setupId)'
        : !stratF
          ? 'B2b: dropped by filterChildrenByMinTrades (child trades vs parent)'
          : !rankedRow
            ? 'unexpected: missing after computeMetaRanking'
            : !inTopN
              ? 'B2a: in ranked universe but outside diversity-capped top N written to meta_ranking.json'
              : 'In top N slice that is written to meta_ranking.json',
    },
  };
}

function main() {
  const argv = process.argv.slice(2).filter((a) => a && !a.startsWith('-'));
  if (!argv.length) {
    console.error(
      'Usage: node engine/meta/auditMetaSetupFunnel.js <setupId> [setupId ...]\n' +
        'Env: NEUROPILOT_DATA_ROOT, TOP_N (default 30), MIN_TRADES_CHILD, MIN_TRADES_RATIO_CHILD'
    );
    process.exit(1);
  }

  const setupIds = argv.map(String);
  const batchDir = dataRoot.getPath('batch_results');
  const topN = Math.max(
    1,
    safeNum(Number(process.env.TOP_N || 30), 30)
  );
  const minTradesAbsolute = Math.max(
    0,
    safeNum(Number(process.env.MIN_TRADES_CHILD || 30), 30)
  );
  const minTradesRatio = Math.max(
    0,
    Math.min(1, safeNum(Number(process.env.MIN_TRADES_RATIO_CHILD || 0.3), 0.3))
  );

  const batchFiles = listBatchFiles(batchDir);
  if (!batchFiles.length) {
    console.error(JSON.stringify({ error: 'no_batch_files', batchDir }, null, 2));
    process.exit(2);
  }

  const { bySetup } = groupResultsBySetup(batchFiles);
  const strategies = buildStrategiesForMeta(bySetup, {});
  const strategiesFiltered = filterChildrenByMinTrades(strategies, {
    minTradesAbsolute,
    minTradesRatio,
  });
  const rankedBase = computeMetaRanking(strategiesFiltered);
  const rankedAnnotated = annotateParentVsChild(rankedBase);
  const promotedMap = buildPromotedMap(loadPromotedChildren());
  const enriched = enrichWithPromotedChildren(rankedAnnotated, promotedMap);
  const reranked = sortRankedStrategies(enriched);
  const top = capRankedStrategiesByDiversity(reranked, {
    maxCount: topN,
    maxPerParentFamily: 2,
    maxPerFamilyDiversityKey: 2,
  });

  const ctx = {
    bySetup,
    strategies,
    strategiesFiltered,
    rankedBase,
    reranked,
    top,
    topN,
    minTradesAbsolute,
    minTradesRatio,
  };

  const out = {
    generatedAt: new Date().toISOString(),
    dataRoot: dataRoot.getDataRoot(),
    batchDir,
    batchFileCount: batchFiles.length,
    topN,
    minTradesAbsolute,
    minTradesRatio,
    setups: setupIds.map((id) => auditOne(id, ctx)),
    note:
      'meta_ranking.json only persists `top` (topN). Portfolio/cluster steps after `top` are not replayed here.',
  };

  console.log(JSON.stringify(out, null, 2));
}

main();
