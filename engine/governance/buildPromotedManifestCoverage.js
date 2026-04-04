#!/usr/bin/env node
'use strict';

/**
 * discovery/promoted_manifest_coverage.json — observability:
 * promoted_children → promoted_manifest → paper signals (merge audit) → metrics by strategy.
 *
 * Run: node engine/governance/buildPromotedManifestCoverage.js
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const { PROMOTED_MANIFEST_FILENAME, PROMOTED_MANIFEST_SIGNAL_SOURCE } = require(
  './buildPaperExecutionV1SignalsWave1'
);

function safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeTrim(v) {
  return v == null ? '' : String(v).trim();
}

function countByReason(skipped) {
  const o = Object.create(null);
  for (const row of skipped || []) {
    const code = row && row.reasonCode ? String(row.reasonCode) : 'UNKNOWN';
    o[code] = (o[code] || 0) + 1;
  }
  return o;
}

function itemsBySetupId(items) {
  const o = Object.create(null);
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue;
    const sid = safeTrim(it.setupId);
    if (!sid) continue;
    o[sid] = (o[sid] || 0) + 1;
  }
  return o;
}

function distinctSetupIdsFromPromoted(strategies) {
  const s = new Set();
  for (const row of strategies || []) {
    if (!row || typeof row !== 'object') continue;
    const id = safeTrim(row.setupId);
    if (id) s.add(id);
  }
  return Array.from(s).sort();
}

/**
 * @param {object} byStrategyFile - paper_trades_metrics_by_strategy.json
 * @param {string[]} setupIds
 */
function sliceMetricsByStrategyIds(byStrategyFile, setupIds) {
  const buckets =
    byStrategyFile && Array.isArray(byStrategyFile.buckets) ? byStrategyFile.buckets : [];
  const bucketMap = new Map();
  for (const b of buckets) {
    if (!b || typeof b !== 'object') continue;
    const sid = safeTrim(b.strategyId);
    if (sid) bucketMap.set(sid, b);
  }
  const byStrategyId = Object.create(null);
  for (const sid of setupIds) {
    const b = bucketMap.get(sid);
    if (b) {
      byStrategyId[sid] = {
        trades: b.trades != null ? b.trades : null,
        wins: b.wins != null ? b.wins : null,
        losses: b.losses != null ? b.losses : null,
        winRate: b.winRate != null ? b.winRate : null,
        totalPnl: b.totalPnl != null ? b.totalPnl : null,
        avgPnl: b.avgPnl != null ? b.avgPnl : null,
      };
    } else {
      byStrategyId[sid] = null;
    }
  }
  return {
    metricsFilePresent: !!(byStrategyFile && byStrategyFile.aggregation === 'by_strategy'),
    byStrategyId,
  };
}

/**
 * Roll up strict paper metrics (V2 by_strategy buckets) for setupIds that appear in promoted_manifest items.
 */
function buildPaperSummaryForManifestSetupIds(manifestDistinctIds, byStrategyId) {
  let distinctSetupIdsWithPaper = 0;
  let distinctSetupIdsWithoutPaper = 0;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let totalPnl = 0;

  for (const sid of manifestDistinctIds) {
    const row = byStrategyId[sid];
    if (row == null) {
      distinctSetupIdsWithoutPaper += 1;
      continue;
    }
    distinctSetupIdsWithPaper += 1;
    const t = Number(row.trades);
    if (!Number.isFinite(t) || t <= 0) continue;
    const w = Number(row.wins);
    const l = Number(row.losses);
    if (Number.isFinite(w)) wins += w;
    if (Number.isFinite(l)) losses += l;
    trades += t;
    const p = Number(row.totalPnl);
    if (Number.isFinite(p)) totalPnl += p;
  }

  const winRate = trades > 0 && Number.isFinite(wins) ? Math.round((wins / trades) * 10000) / 100 : null;
  const avgPnl = trades > 0 ? Math.round((totalPnl / trades) * 1e6) / 1e6 : null;

  return {
    distinctSetupIdsWithPaper,
    distinctSetupIdsWithoutPaper,
    trades,
    wins: trades > 0 ? wins : null,
    losses: trades > 0 ? losses : null,
    winRate,
    totalPnl: Math.round(totalPnl * 1e8) / 1e8,
    avgPnl,
  };
}

function pickPromotedPaperRows(promotedDistinctIds, byStrategyId) {
  const out = [];
  for (const sid of promotedDistinctIds) {
    const row = byStrategyId[sid];
    if (!row) continue;
    const t = Number(row.trades);
    if (!Number.isFinite(t) || t <= 0) continue;
    if (row.totalPnl == null || !Number.isFinite(Number(row.totalPnl))) continue;
    out.push({
      setupId: sid,
      trades: row.trades,
      wins: row.wins != null ? row.wins : null,
      losses: row.losses != null ? row.losses : null,
      winRate: row.winRate != null ? row.winRate : null,
      totalPnl: row.totalPnl,
      avgPnl: row.avgPnl != null ? row.avgPnl : null,
    });
  }
  return out;
}

function topNByTotalPnl(rows, dir, n) {
  const lim = Math.max(0, Math.min(20, Number(n) || 5));
  const sorted = rows.slice().sort((a, b) => {
    const pa = Number(a.totalPnl);
    const pb = Number(b.totalPnl);
    if (dir === 'asc') return pa - pb;
    return pb - pa;
  });
  return sorted.slice(0, lim);
}

function envNum(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * Audit flags derived from coverage inputs + optional V2 by_day / by_cycle artefacts (no JSONL scan).
 * @param {object} params
 * @param {object} params.promotedCohortPaperSummary
 * @param {string[]} params.manifestDistinctIds
 * @param {object} params.byId - paper metrics by setupId
 * @param {object|null} params.byDayFile - paper_trades_metrics_by_day.json shape
 * @param {object|null} params.byCycleFile - paper_trades_metrics_by_cycle.json shape
 */
function buildPaperRealityCheck(params) {
  const promotedCohortPaperSummary =
    params.promotedCohortPaperSummary && typeof params.promotedCohortPaperSummary === 'object'
      ? params.promotedCohortPaperSummary
      : {};
  const manifestDistinctIds = Array.isArray(params.manifestDistinctIds) ? params.manifestDistinctIds : [];
  const byId =
    params.byId && typeof params.byId === 'object' ? params.byId : Object.create(null);
  const byDayFile = params.byDayFile && typeof params.byDayFile === 'object' ? params.byDayFile : null;
  const byCycleFile = params.byCycleFile && typeof params.byCycleFile === 'object' ? params.byCycleFile : null;

  const d =
    promotedCohortPaperSummary.distinctSetupIdsWithPaper != null
      ? Number(promotedCohortPaperSummary.distinctSetupIdsWithPaper)
      : NaN;
  const distinctPaper = Number.isFinite(d) && d >= 0 ? d : 0;

  const singleManifestedSetupWithPaper = distinctPaper === 1;
  const manifestCohortTooNarrowForRanking = distinctPaper < 2;

  const minSuspiciousTrades = Math.max(1, Math.floor(envNum('NEUROPILOT_DASHBOARD_SUSPICIOUS_DAY_MIN_TRADES', 20)));
  const unknownDominantThr = envNum('NEUROPILOT_REALITY_UNKNOWN_CYCLE_DOMINANT_THRESHOLD', 0.5);
  const cycleCoverageLowThr = envNum('NEUROPILOT_REALITY_CYCLE_COVERAGE_LOW_THRESHOLD', 0.3);
  const concPctThr = envNum('NEUROPILOT_REALITY_HIGH_SETUP_CONCENTRATION_PCT', 90);

  const bucketsDay = byDayFile && Array.isArray(byDayFile.buckets) ? byDayFile.buckets : null;
  const bucketsCycle = byCycleFile && Array.isArray(byCycleFile.buckets) ? byCycleFile.buckets : null;

  const validTradeCountRaw =
    byCycleFile && byCycleFile.validTradeCount != null
      ? Number(byCycleFile.validTradeCount)
      : byDayFile && byDayFile.validTradeCount != null
        ? Number(byDayFile.validTradeCount)
        : null;
  const validTradeCount =
    validTradeCountRaw != null && Number.isFinite(validTradeCountRaw) ? validTradeCountRaw : null;

  let tradesMissingCycleKeyShare = null;
  let unknownCycleTrades = null;
  if (bucketsCycle && validTradeCount != null && validTradeCount > 0) {
    const unk = bucketsCycle.find((b) => b && b.cycleKey === '_unknown_cycle');
    if (unk && unk.trades != null) {
      unknownCycleTrades = Number(unk.trades);
      if (Number.isFinite(unknownCycleTrades)) {
        tradesMissingCycleKeyShare = unknownCycleTrades / validTradeCount;
      }
    }
  }

  const unknownCycleDominant =
    tradesMissingCycleKeyShare != null && tradesMissingCycleKeyShare >= unknownDominantThr;
  const cycleCoverageLow =
    tradesMissingCycleKeyShare != null && tradesMissingCycleKeyShare >= cycleCoverageLowThr;

  const suspiciousDays = [];
  if (bucketsDay) {
    for (const b of bucketsDay) {
      if (!b || typeof b !== 'object') continue;
      if (b.day === 'unknown') continue;
      const tr = Number(b.trades);
      if (!Number.isFinite(tr) || tr < minSuspiciousTrades) continue;
      const wr = b.winRate;
      if (wr == null || !Number.isFinite(Number(wr))) continue;
      const wn = Number(wr);
      if (wn === 0) {
        suspiciousDays.push({
          day: String(b.day),
          trades: tr,
          winRate: wn,
          totalPnl: b.totalPnl != null ? b.totalPnl : null,
          reasonCode: 'suspicious_full_loss_day',
        });
      } else if (wn === 100) {
        suspiciousDays.push({
          day: String(b.day),
          trades: tr,
          winRate: wn,
          totalPnl: b.totalPnl != null ? b.totalPnl : null,
          reasonCode: 'suspicious_full_win_day',
        });
      }
    }
  }
  suspiciousDays.sort((a, b) => String(a.day).localeCompare(String(b.day)));

  const rows = pickPromotedPaperRows(manifestDistinctIds, byId);
  let totalCohortTrades = 0;
  for (const r of rows) {
    const t = Number(r.trades);
    if (Number.isFinite(t) && t > 0) totalCohortTrades += t;
  }
  let maxT = 0;
  let maxSid = null;
  for (const r of rows) {
    const t = Number(r.trades);
    if (!Number.isFinite(t) || t <= 0) continue;
    if (t > maxT) {
      maxT = t;
      maxSid = r.setupId != null ? String(r.setupId) : null;
    }
  }
  const maxSharePct =
    totalCohortTrades > 0 && maxT > 0 ? (maxT / totalCohortTrades) * 100 : null;
  const highSingleSetupConcentration =
    maxSharePct != null && maxSharePct >= concPctThr && distinctPaper >= 1;

  return {
    paperRealityCheckSchemaVersion: '1.0.0',
    singleManifestedSetupWithPaper,
    manifestCohortTooNarrowForRanking,
    unknownCycleDominant,
    tradesMissingCycleKeyShare:
      tradesMissingCycleKeyShare != null
        ? Math.round(tradesMissingCycleKeyShare * 10000) / 10000
        : null,
    unknownCycleDominantThreshold: unknownDominantThr,
    cycleCoverageLow,
    cycleCoverageLowThreshold: cycleCoverageLowThr,
    tradesMissingCycleKeyCount:
      unknownCycleTrades != null && Number.isFinite(unknownCycleTrades) ? unknownCycleTrades : null,
    validTradeCountForCycleShare: validTradeCount,
    highSingleSetupConcentration,
    highSingleSetupConcentrationDetail:
      highSingleSetupConcentration && maxSid
        ? {
            setupId: maxSid,
            tradesSharePercent:
              maxSharePct != null ? Math.round(maxSharePct * 100) / 100 : null,
            cohortTrades: totalCohortTrades,
          }
        : null,
    singleSetupConcentrationThresholdPercent: concPctThr,
    suspiciousDays,
    suspiciousDayMinTrades: minSuspiciousTrades,
    sources: {
      byDayFilePresent: bucketsDay != null,
      byCycleFilePresent: bucketsCycle != null,
    },
  };
}

function normalizePaperGateSummary(paperGateRaw) {
  const pg = paperGateRaw && typeof paperGateRaw === 'object' ? paperGateRaw : {};
  const skippedByReason =
    pg.skippedByReason && typeof pg.skippedByReason === 'object' ? pg.skippedByReason : {};
  return {
    enabled: pg.enabled === true,
    thresholdsApplied:
      pg.thresholdsApplied && typeof pg.thresholdsApplied === 'object' ? pg.thresholdsApplied : {},
    evaluatedStrategies: Number(pg.evaluatedStrategies || 0),
    noPaperMetricsRowCount: Number(pg.noPaperMetricsRowCount || 0),
    belowMinTradesCount: Number(pg.belowMinTradesCount || 0),
    skippedByReason,
    source: pg.source != null ? String(pg.source) : null,
  };
}

/**
 * Promoted manifested cohort paper money view — NOT global paper PnL.
 * Cohort = distinct setupIds in promoted_manifest items only (manifestDistinctSetupIds).
 * Uses the same byStrategyId slice as paperTradesMetricsByStrategy (promotion_strict eligible trades).
 */
function buildPromotedCohortPaperSummary(manifestDistinctIds, byStrategyId) {
  let distinctSetupIdsWithPaper = 0;
  let distinctSetupIdsWithoutPaper = 0;
  for (const sid of manifestDistinctIds) {
    if (byStrategyId[sid] != null) distinctSetupIdsWithPaper += 1;
    else distinctSetupIdsWithoutPaper += 1;
  }

  const moneyRows = pickPromotedPaperRows(manifestDistinctIds, byStrategyId);
  let trades = 0;
  let totalPnl = 0;
  for (const r of moneyRows) {
    trades += Number(r.trades);
    totalPnl += Number(r.totalPnl);
  }
  const avgPnlPerTrade =
    trades > 0 ? Math.round((totalPnl / trades) * 1e6) / 1e6 : null;

  const wrs = moneyRows
    .map((r) => r.winRate)
    .filter((w) => w != null && Number.isFinite(Number(w)))
    .map(Number);
  const avgWinRateAcrossSetups =
    wrs.length > 0 ? Math.round((wrs.reduce((a, b) => a + b, 0) / wrs.length) * 100) / 100 : null;

  const byPnlDesc = moneyRows.slice().sort((a, b) => Number(b.totalPnl) - Number(a.totalPnl));
  const byPnlAsc = moneyRows.slice().sort((a, b) => Number(a.totalPnl) - Number(b.totalPnl));

  let topWinnerSetupId = null;
  let topWinnerTotalPnl = null;
  let topLoserSetupId = null;
  let topLoserTotalPnl = null;
  if (byPnlDesc.length > 0) {
    topWinnerSetupId = byPnlDesc[0].setupId;
    topWinnerTotalPnl = byPnlDesc[0].totalPnl;
  }
  if (byPnlAsc.length > 0) {
    topLoserSetupId = byPnlAsc[0].setupId;
    topLoserTotalPnl = byPnlAsc[0].totalPnl;
  }

  return {
    cohortDefinition: 'manifestDistinctSetupIds_only',
    distinctSetupIdsWithPaper,
    distinctSetupIdsWithoutPaper,
    trades,
    totalPnl: Math.round(totalPnl * 1e8) / 1e8,
    avgPnlPerTrade,
    avgWinRateAcrossSetups,
    topWinnerSetupId,
    topWinnerTotalPnl,
    topLoserSetupId,
    topLoserTotalPnl,
  };
}

function buildPromotedCohortPaperLeaders(manifestDistinctIds, byStrategyId) {
  const rows = pickPromotedPaperRows(manifestDistinctIds, byStrategyId);
  const mapRow = (r) => ({
    setupId: r.setupId,
    totalPnl: r.totalPnl,
    trades: r.trades,
    winRate: r.winRate != null ? r.winRate : null,
  });
  return {
    winners: topNByTotalPnl(rows, 'desc', 5).map(mapRow),
    losers: topNByTotalPnl(rows, 'asc', 5).map(mapRow),
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataRoot]
 * @param {object} [opts.paperTradesByStrategyFile] - optional in-memory (dashboard build)
 * @param {object} [opts.paperTradesByDayFile] - optional; default read `governance/paper_trades_metrics_by_day.json`
 * @param {object} [opts.paperTradesByCycleFile] - optional; default read `governance/paper_trades_metrics_by_cycle.json`
 * @param {boolean} [opts.write=true]
 */
function buildPromotedManifestCoverage(opts = {}) {
  const root = opts.dataRoot || dataRoot.getDataRoot();
  const discoveryDir = path.join(root, 'discovery');
  const governanceDir = path.join(root, 'governance');
  const promotedPath = path.join(discoveryDir, 'promoted_children.json');
  const manifestPath = path.join(discoveryDir, PROMOTED_MANIFEST_FILENAME);
  const signalsPath = path.join(governanceDir, 'paper_execution_v1_signals.json');
  const metricsPath = path.join(governanceDir, 'paper_trades_metrics_by_strategy.json');
  const metricsByDayPath = path.join(governanceDir, 'paper_trades_metrics_by_day.json');
  const metricsByCyclePath = path.join(governanceDir, 'paper_trades_metrics_by_cycle.json');
  const outPath = path.join(discoveryDir, 'promoted_manifest_coverage.json');
  const write = opts.write !== false;

  const promotedDoc = safeReadJson(promotedPath);
  const strategies = promotedDoc && Array.isArray(promotedDoc.strategies) ? promotedDoc.strategies : [];
  const promotedDistinctIds = distinctSetupIdsFromPromoted(strategies);

  const manifestDoc = safeReadJson(manifestPath);
  const items = manifestDoc && Array.isArray(manifestDoc.items) ? manifestDoc.items : [];
  const skipped = manifestDoc && Array.isArray(manifestDoc.skipped) ? manifestDoc.skipped : [];
  const paperGate = normalizePaperGateSummary(manifestDoc && manifestDoc.paperGate);

  const manifestDistinctSet = new Set();
  for (const it of items) {
    const id = safeTrim(it && it.setupId);
    if (id) manifestDistinctSet.add(id);
  }
  const manifestDistinctIds = Array.from(manifestDistinctSet).sort();

  const skippedByReason = countByReason(skipped);
  const itemsBySetupIdMap = itemsBySetupId(items);

  const signalsDoc = safeReadJson(signalsPath);
  const signals = signalsDoc && Array.isArray(signalsDoc.signals) ? signalsDoc.signals : [];
  let promotedManifestSignalRows = 0;
  const signalSetupIds = new Set();
  for (const s of signals) {
    if (!s || typeof s !== 'object') continue;
    if (s.signalSource !== PROMOTED_MANIFEST_SIGNAL_SOURCE) continue;
    promotedManifestSignalRows += 1;
    const id = safeTrim(s.setupId) || safeTrim(s.strategyId);
    if (id) signalSetupIds.add(id);
  }

  const mergeAudit =
    signalsDoc && signalsDoc.promotedManifestMerge && typeof signalsDoc.promotedManifestMerge === 'object'
      ? {
          manifestPresent: signalsDoc.promotedManifestMerge.manifestPresent === true,
          promotedManifestSignalsIn: Number(signalsDoc.promotedManifestMerge.promotedManifestSignalsIn || 0),
          promotedManifestSignalsOut: Number(signalsDoc.promotedManifestMerge.promotedManifestSignalsOut || 0),
          mergeRejectedCount: Number(signalsDoc.promotedManifestMerge.mergeRejectedCount || 0),
          staleRemovedCount: Number(signalsDoc.promotedManifestMerge.staleRemovedCount || 0),
        }
      : null;

  const byStrategyFile =
    opts.paperTradesByStrategyFile != null
      ? opts.paperTradesByStrategyFile
      : safeReadJson(metricsPath);

  const byDayFile =
    opts.paperTradesByDayFile != null ? opts.paperTradesByDayFile : safeReadJson(metricsByDayPath);
  const byCycleFile =
    opts.paperTradesByCycleFile != null
      ? opts.paperTradesByCycleFile
      : safeReadJson(metricsByCyclePath);

  const idsForMetrics = Array.from(new Set([...promotedDistinctIds, ...manifestDistinctIds])).sort();
  const paperTradesMetricsByStrategy = sliceMetricsByStrategyIds(byStrategyFile, idsForMetrics);
  const byId = paperTradesMetricsByStrategy.byStrategyId || Object.create(null);

  const paperSummaryForManifestSetupIds = buildPaperSummaryForManifestSetupIds(manifestDistinctIds, byId);
  paperSummaryForManifestSetupIds.manifestProducerSkippedCount = skipped.length;
  paperSummaryForManifestSetupIds.note =
    'Cohort = distinct setupIds present in promoted_manifest items; trades/pnl/winRate are sums or cohort-wide rates from paper_trades_metrics_by_strategy (promotion_strict eligible trades).';

  const promotedPaperRows = pickPromotedPaperRows(promotedDistinctIds, byId);
  const topPromotedWinnersByPnl = topNByTotalPnl(promotedPaperRows, 'desc', 5);
  const topPromotedLosersByPnl = topNByTotalPnl(promotedPaperRows, 'asc', 5);

  const promotedCohortPaperSummary = buildPromotedCohortPaperSummary(manifestDistinctIds, byId);
  const promotedCohortPaperLeaders = buildPromotedCohortPaperLeaders(manifestDistinctIds, byId);

  const paperRealityCheck = buildPaperRealityCheck({
    promotedCohortPaperSummary,
    manifestDistinctIds,
    byId,
    byDayFile,
    byCycleFile,
  });

  const doc = {
    coverageSchemaVersion: 4,
    generatedAt: new Date().toISOString(),
    dataRoot: root,
    promotedDistinctSetupIdsCount: promotedDistinctIds.length,
    manifestDistinctSetupIdsCount: manifestDistinctIds.length,
    manifestItemCount: items.length,
    manifestSkippedCount: skipped.length,
    skippedByReason,
    itemsBySetupId: itemsBySetupIdMap,
    promotedManifestSignalRowsInPaperFile: promotedManifestSignalRows,
    distinctSetupIdsInPromotedManifestSignals: signalSetupIds.size,
    promotedDistinctSetupIds: promotedDistinctIds,
    manifestDistinctSetupIds: manifestDistinctIds,
    paperExecutionSignalsPromotedManifestMerge: mergeAudit,
    paperTradesMetricsByStrategy,
    paperSummaryForManifestSetupIds,
    topPromotedWinnersByPnl,
    topPromotedLosersByPnl,
    promotedCohortPaperSummary,
    promotedCohortPaperLeaders,
    paperRealityCheck,
    paperGate,
    sourcePaths: {
      promoted_children: promotedPath,
      promoted_manifest: manifestPath,
      paper_execution_v1_signals: signalsPath,
      paper_trades_metrics_by_strategy: metricsPath,
      paper_trades_metrics_by_day: metricsByDayPath,
      paper_trades_metrics_by_cycle: metricsByCyclePath,
    },
  };

  if (write) {
    ensureDir(discoveryDir);
    fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf8');
  }

  return { outPath, doc };
}

module.exports = {
  buildPromotedManifestCoverage,
  buildPaperSummaryForManifestSetupIds,
  pickPromotedPaperRows,
  topNByTotalPnl,
  buildPromotedCohortPaperSummary,
  buildPromotedCohortPaperLeaders,
  buildPaperRealityCheck,
};

if (require.main === module) {
  try {
    const r = buildPromotedManifestCoverage();
    console.log('[buildPromotedManifestCoverage] wrote', r.outPath);
    console.log(
      '[buildPromotedManifestCoverage] promotedDistinct',
      r.doc.promotedDistinctSetupIdsCount,
      'manifestDistinct',
      r.doc.manifestDistinctSetupIdsCount
    );
  } catch (e) {
    console.error('[buildPromotedManifestCoverage]', e && e.message ? e.message : e);
    process.exit(1);
  }
}
