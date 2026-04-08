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
    const te = Number(t.executionCostBps != null ? t.executionCostBps : t.totalExecutionCostBps);
    const sp = Number(t.spreadCostBps);
    const sl = Number(t.slippageCostBps);
    const fe = Number(t.feeCostBps);

    if (Number.isFinite(te)) totalBps.push(te);
    if (Number.isFinite(sp) && sp >= 0) spreadBps.push(sp);
    if (Number.isFinite(sl) && sl >= 0) slipBps.push(sl);
    if (Number.isFinite(fe) && fe >= 0) feeBps.push(fe);

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
    if (Number.isFinite(te)) {
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
 * Stable summary for APIs / policy / dashboards.
 */
async function getExecutionQualitySummary(options = {}) {
  const limit = parseInt(options.limit, 10) || 200;
  const trades = await loadRecentTrades(limit);
  const summary = summarizeExecutionQuality(trades);
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
  getExecutionQualitySummary,
  buildExecutionOverview: getExecutionQualitySummary,
  persistLatest,
};
