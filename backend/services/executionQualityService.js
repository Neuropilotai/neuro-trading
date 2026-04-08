'use strict';

/**
 * Execution quality diagnostics over recent closed trades (paper realism).
 * Persists optional snapshot: DATA_DIR/execution_quality_latest.json
 * Append history: DATA_DIR/execution_quality_history.jsonl (optional, small periodic writes from callers)
 */

const fs = require('fs').promises;
const path = require('path');
const closedTradeAnalyticsService = require('./closedTradeAnalyticsService');

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function round6(x) {
  return Math.round(Number(x) * 1e6) / 1e6;
}

function _mean(arr) {
  const a = (arr || []).filter(Number.isFinite);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

/** Notional for bps: prefer reference exit * qty, else exit avg * qty, else |marketValueAtExit|. */
function notionalForBps(t) {
  const qty = Number(t.closedQuantity);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const refEx = Number(t.referenceExitPrice);
  const ex = Number(t.exitPriceAvg);
  const px = Number.isFinite(refEx) && refEx > 0 ? refEx : Number.isFinite(ex) && ex > 0 ? ex : null;
  if (px != null) return px * qty;
  const mv = Number(t.marketValueAtExit);
  if (Number.isFinite(mv) && Math.abs(mv) > 0) return Math.abs(mv);
  return null;
}

/**
 * Resolve bps from stored fields or dollar cost breakdown (backward compatible with pre-realism rows).
 * @returns {{ te: number|null, sp: number|null, sl: number|null, fe: number|null }}
 */
function bpsComponentsForRow(t) {
  const N = notionalForBps(t);
  let te = Number(t.executionCostBps != null ? t.executionCostBps : t.totalExecutionCostBps);
  let sp = Number(t.spreadCostBps);
  let sl = Number(t.slippageCostBps);
  let fe = Number(t.feeCostBps);

  if (!Number.isFinite(te) && N != null && N > 0) {
    const tc = Number(t.totalExecutionCost);
    if (Number.isFinite(tc)) te = (Math.abs(tc) / N) * 10000;
  }

  const spread$ =
    (Number(t.entrySpreadCost) || 0) + (Number(t.exitSpreadCost) || 0);
  const slip$ =
    (Number(t.entrySlippageCost) || 0) +
    (Number(t.exitSlippageCost) || 0) +
    (Number(t.entryImpactCost) || 0) +
    (Number(t.exitImpactCost) || 0);
  const fee$ = (Number(t.entryFeeCost) || 0) + (Number(t.exitFeeCost) || 0);

  if (N != null && N > 0) {
    if (!Number.isFinite(sp) && spread$ > 0) sp = (spread$ / N) * 10000;
    if (!Number.isFinite(sl) && slip$ > 0) sl = (slip$ / N) * 10000;
    if (!Number.isFinite(fe) && fee$ > 0) fe = (fee$ / N) * 10000;
  }

  return {
    te: Number.isFinite(te) ? te : null,
    sp: Number.isFinite(sp) && sp >= 0 ? sp : null,
    sl: Number.isFinite(sl) && sl >= 0 ? sl : null,
    fe: Number.isFinite(fe) && fe >= 0 ? fe : null,
  };
}

/**
 * @param {object[]} trades - closed trade rows
 */
function summarizeExecutionQuality(trades) {
  const rows = Array.isArray(trades) ? trades : [];
  const n = rows.length;
  if (n === 0) {
    return {
      tradeCount: 0,
      avgSpreadCostBps: null,
      avgSlippageCostBps: null,
      avgFeeCostBps: null,
      avgTotalExecutionCostBps: null,
      avgCostToGrossRatio: null,
      percentTradesWhereCostsFlippedGrossWinToNetLoss: 0,
      percentTradesWithPoorFillQuality: 0,
      costAdjustedWinRate: null,
      grossVsNetPnLGap: null,
      worstExecutionSymbols: [],
      worstExecutionStrategies: [],
      worstExecutionSessions: [],
      executionRealismWarnings: [],
    };
  }

  const spreadBps = [];
  const slipBps = [];
  const feeBps = [];
  const totalBps = [];
  const costToGross = [];
  let flipCount = 0;
  let poorFill = 0;
  let grossWins = 0;
  let netWins = 0;
  let sumGross = 0;
  let sumNet = 0;

  const bySym = new Map();
  const byStrat = new Map();
  const bySess = new Map();

  for (const t of rows) {
    const bps = bpsComponentsForRow(t);
    const te = bps.te;
    const sp = bps.sp;
    const sl = bps.sl;
    const fe = bps.fe;

    if (Number.isFinite(te)) totalBps.push(te);
    if (sp != null) spreadBps.push(sp);
    if (sl != null) slipBps.push(sl);
    if (fe != null) feeBps.push(fe);

    const g = Number(t.grossRealizedPnL);
    const net = Number(t.netRealizedPnL != null ? t.netRealizedPnL : t.realizedPnL);
    const gross = Number.isFinite(g) ? g : net;
    const tc = Number(t.totalExecutionCost);
    if (Number.isFinite(gross) && Math.abs(gross) > 1e-12 && Number.isFinite(tc)) {
      costToGross.push(Math.abs(tc / gross));
    }
    if (Number.isFinite(gross) && gross > 0 && Number.isFinite(net) && net <= 0) flipCount++;
    const fq = Number(t.fillQualityScore);
    if (Number.isFinite(fq) && fq < 40) poorFill++;

    if (Number.isFinite(gross) && gross > 0) grossWins++;
    if (Number.isFinite(net) && net > 0) netWins++;

    sumGross += Number.isFinite(gross) ? gross : 0;
    sumNet += Number.isFinite(net) ? net : 0;

    const sym = String(t.symbol || 'UNKNOWN').toUpperCase();
    const st = t.strategy != null ? String(t.strategy) : 'null';
    const sess = t.sessionTagAtEntry != null ? String(t.sessionTagAtEntry) : 'unknown';
    const push = (m, k, delta) => {
      if (!m.has(k)) m.set(k, { costBps: 0, n: 0 });
      const o = m.get(k);
      o.costBps += delta;
      o.n++;
    };
    if (te != null && Number.isFinite(te)) {
      push(bySym, sym, te);
      push(byStrat, st, te);
      push(bySess, sess, te);
    }
  }

  const worst = (m, lim) =>
    [...m.entries()]
      .map(([k, v]) => ({ key: k, avgExecutionCostBps: v.n ? v.costBps / v.n : 0, trades: v.n }))
      .sort((a, b) => b.avgExecutionCostBps - a.avgExecutionCostBps)
      .slice(0, lim);

  const warnings = [];
  const avgCostBps = _mean(totalBps);
  if (avgCostBps != null && avgCostBps > 25) warnings.push('HIGH_AVG_EXECUTION_COST_BPS');
  if (n > 0 && flipCount / n > 0.08) warnings.push('COSTS_FLIPPING_WINS_TO_NET_LOSSES');
  if (n > 0 && poorFill / n > 0.2) warnings.push('POOR_FILL_QUALITY_FREQUENT');

  return {
    tradeCount: n,
    /** Closed-trade journal only; may be null when no rows or legacy rows without bps */
    avgSpreadCostBps: spreadBps.length ? round4(_mean(spreadBps)) : null,
    avgSlippageCostBps: slipBps.length ? round4(_mean(slipBps)) : null,
    avgFeeCostBps: feeBps.length ? round4(_mean(feeBps)) : null,
    avgTotalExecutionCostBps: totalBps.length ? round4(_mean(totalBps)) : null,
    avgCostToGrossRatio: costToGross.length ? round4(_mean(costToGross)) : null,
    percentTradesWhereCostsFlippedGrossWinToNetLoss: round4((flipCount / n) * 100),
    percentTradesWithPoorFillQuality: round4((poorFill / n) * 100),
    costAdjustedWinRate: round4((netWins / n) * 100),
    grossWinRate: round4((grossWins / n) * 100),
    grossVsNetPnLGap: round6(sumGross - sumNet),
    worstExecutionSymbols: worst(bySym, 8),
    worstExecutionStrategies: worst(byStrat, 8),
    worstExecutionSessions: worst(bySess, 8),
    executionRealismWarnings: warnings,
  };
}

async function loadRecentTrades(limit = 200) {
  try {
    return await closedTradeAnalyticsService.listClosedTrades({
      limit: String(limit),
    });
  } catch (e) {
    return [];
  }
}

/**
 * Aggregate entry-leg execution bps from open paper positions (reference vs avg + optional friction split).
 */
function summarizeOpenBookPositions(positions) {
  const rows = Array.isArray(positions) ? positions : [];
  const spread = [];
  const slipImpact = [];
  const fee = [];
  const total = [];
  let n = 0;
  for (const p of rows) {
    const q = Number(p.quantity);
    if (!Number.isFinite(q) || q <= 0) continue;
    const x = p.executionFrictionAtEntry;
    if (!x || !Number.isFinite(Number(x.totalBps))) continue;
    n++;
    if (Number.isFinite(x.spreadBps)) spread.push(Number(x.spreadBps));
    const sim = (Number(x.slippageBps) || 0) + (Number(x.impactBps) || 0);
    if (sim > 0) slipImpact.push(sim);
    if (Number.isFinite(x.feeBps)) fee.push(Number(x.feeBps));
    total.push(Number(x.totalBps));
  }
  const openPositionCount = rows.filter((p) => Number(p.quantity) > 0).length;
  if (n === 0) {
    return {
      openPositionCount,
      positionsWithFriction: 0,
      avgSpreadCostBps: null,
      avgSlippageCostBps: null,
      avgFeeCostBps: null,
      avgTotalExecutionCostBps: null,
      source: null,
    };
  }
  return {
    openPositionCount,
    positionsWithFriction: n,
    avgSpreadCostBps: spread.length ? round4(_mean(spread)) : null,
    avgSlippageCostBps: slipImpact.length ? round4(_mean(slipImpact)) : null,
    avgFeeCostBps: fee.length ? round4(_mean(fee)) : null,
    avgTotalExecutionCostBps: total.length ? round4(_mean(total)) : null,
    source: 'open_book_entry_leg',
  };
}

/**
 * Merge closed-trade averages with open-book entry proxies when closed metrics are empty.
 */
function mergeClosedAndOpenExecutionSummary(closedSummary, openBook) {
  const usedOpen = {
    spread: closedSummary.avgSpreadCostBps == null && openBook.avgSpreadCostBps != null,
    slip: closedSummary.avgSlippageCostBps == null && openBook.avgSlippageCostBps != null,
    fee: closedSummary.avgFeeCostBps == null && openBook.avgFeeCostBps != null,
    total: closedSummary.avgTotalExecutionCostBps == null && openBook.avgTotalExecutionCostBps != null,
  };
  const any = usedOpen.spread || usedOpen.slip || usedOpen.fee || usedOpen.total;
  return {
    ...closedSummary,
    openBookExecution: openBook,
    avgSpreadCostBps: closedSummary.avgSpreadCostBps ?? openBook.avgSpreadCostBps ?? null,
    avgSlippageCostBps: closedSummary.avgSlippageCostBps ?? openBook.avgSlippageCostBps ?? null,
    avgFeeCostBps: closedSummary.avgFeeCostBps ?? openBook.avgFeeCostBps ?? null,
    avgTotalExecutionCostBps: closedSummary.avgTotalExecutionCostBps ?? openBook.avgTotalExecutionCostBps ?? null,
    openBookFillsSummaryGaps: any === true,
    openBookFieldsUsed: any ? usedOpen : null,
  };
}

/**
 * Stable summary for APIs / policy / dashboards.
 */
async function getExecutionQualitySummary(options = {}) {
  const limit = parseInt(options.limit, 10) || 200;
  const trades = await loadRecentTrades(limit);
  const closedSummary = summarizeExecutionQuality(trades);

  let openBook = {
    openPositionCount: 0,
    positionsWithFriction: 0,
    avgSpreadCostBps: null,
    avgSlippageCostBps: null,
    avgFeeCostBps: null,
    avgTotalExecutionCostBps: null,
    source: null,
  };
  try {
    const paperTradingService = require('./paperTradingService');
    const acc = paperTradingService.getAccountSummary();
    openBook = summarizeOpenBookPositions(acc.positions || []);
  } catch (e) {
    void e;
  }

  const summary = mergeClosedAndOpenExecutionSummary(closedSummary, openBook);
  return {
    generatedAt: new Date().toISOString(),
    tradesUsed: trades.length,
    ...summary,
  };
}

async function persistLatest(summary) {
  const file = path.join(getDataDir(), 'execution_quality_latest.json');
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(summary, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[execution-quality] persistLatest: ${e.message}`);
  }
}

module.exports = {
  summarizeExecutionQuality,
  summarizeOpenBookPositions,
  mergeClosedAndOpenExecutionSummary,
  getExecutionQualitySummary,
  buildExecutionOverview: getExecutionQualitySummary,
  persistLatest,
};
