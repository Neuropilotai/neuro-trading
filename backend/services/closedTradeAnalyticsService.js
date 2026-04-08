'use strict';

/**
 * Closed trade analytics — append-only JSONL journal for partial/full exits.
 * Failures here must never break execution (caller wraps in try/catch).
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const CLOSE_REASONS = new Set([
  'SELL',
  'CLOSE',
  'STOP_LOSS',
  'TAKE_PROFIT',
  'MANUAL',
  'FORCED_EXIT',
  'UNKNOWN',
]);

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getClosedTradesPath() {
  return path.join(getDataDir(), 'closed_trades.jsonl');
}

function isEnabled() {
  return String(process.env.ENABLE_CLOSED_TRADE_ANALYTICS || 'true').toLowerCase() !== 'false';
}

function normalizeCloseReason(action) {
  const a = String(action || '').toUpperCase().trim();
  if (a === 'CLOSE') return 'CLOSE';
  if (a === 'SELL') return 'SELL';
  return CLOSE_REASONS.has(a) ? a : 'UNKNOWN';
}

/**
 * Build institution-grade closed trade row (pure).
 * Long-only: realized PnL = (exit - entry) * qty.
 */
function buildClosedTradeRecord(input) {
  const {
    symbol,
    side = 'LONG',
    entryPriceAvg,
    exitPriceAvg,
    closedQuantity,
    realizedPnL,
    entryTimestamp,
    exitTimestamp,
    closeReason,
    actionSource = 'webhook',
    strategy = null,
    setupId = null,
    alertId = null,
    priceSourceAtExit = null,
    fees = 0,
    slippage = null,
    tradeGroupId = null,
    closeSequence = null,
    stopLoss = null,
    regime = null,
    lifecycleSummary = null,
    referenceEntryPrice = null,
    executedEntryPrice = null,
    referenceExitPrice = null,
    executedExitPrice = null,
    entryExecutionCost = null,
    exitExecutionCost = null,
    entrySpreadCost = null,
    entrySlippageCost = null,
    entryFeeCost = null,
    entryImpactCost = null,
    exitSpreadCost = null,
    exitSlippageCost = null,
    exitFeeCost = null,
    exitImpactCost = null,
    grossRealizedPnL = null,
    netRealizedPnL = null,
    totalExecutionCost = null,
    costToGrossRatio = null,
    executionCostBps = null,
    netEfficiency = null,
    spreadCostBps = null,
    slippageCostBps = null,
    feeCostBps = null,
    fillQualityScore = null,
    sessionTagAtEntry = null,
    execution_realism_penalty = null,
    gross_net_divergence_high = null,
    costs_eroding_edge = null,
    poor_fill_quality = null,
  } = input;

  const entry = Number(entryPriceAvg);
  const exitPx = Number(exitPriceAvg);
  const qty = Number(closedQuantity);
  const pnl = Number(realizedPnL);
  const netP = netRealizedPnL != null ? Number(netRealizedPnL) : pnl;
  const grossP = grossRealizedPnL != null ? Number(grossRealizedPnL) : null;

  const realizedPnLPercent =
    entry > 0 && Number.isFinite(entry) ? ((exitPx - entry) / entry) * 100 : 0;

  const entryMs = Date.parse(entryTimestamp);
  const exitMs = Date.parse(exitTimestamp);
  const holdingTimeSec =
    Number.isFinite(entryMs) && Number.isFinite(exitMs)
      ? Math.max(0, Math.round((exitMs - entryMs) / 1000))
      : 0;
  const holdingTimeMin = holdingTimeSec / 60;

  const bookValueClosed = qty * entry;
  const marketValueAtExit = qty * exitPx;

  let riskDollars = 0;
  if (stopLoss != null && Number.isFinite(Number(stopLoss)) && Number.isFinite(entry)) {
    const stop = Number(stopLoss);
    riskDollars = Math.abs(entry - stop) * qty;
  }
  const rMultiple =
    riskDollars > 0 && Number.isFinite(pnl) ? pnl / riskDollars : null;

  const exitD = new Date(exitTimestamp);
  const closedAtDate = exitD.toISOString().slice(0, 10);
  const closedAtHourUTC = exitD.getUTCHours();

  const tradeCloseId = `close_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

  const lc = lifecycleSummary && typeof lifecycleSummary === 'object' ? lifecycleSummary : null;

  return {
    tradeCloseId,
    symbol: String(symbol || '').toUpperCase().trim(),
    side,
    entryPriceAvg: entry,
    exitPriceAvg: exitPx,
    referenceEntryPrice:
      referenceEntryPrice != null && Number.isFinite(Number(referenceEntryPrice))
        ? Number(referenceEntryPrice)
        : null,
    executedEntryPrice:
      executedEntryPrice != null && Number.isFinite(Number(executedEntryPrice))
        ? Number(executedEntryPrice)
        : null,
    referenceExitPrice:
      referenceExitPrice != null && Number.isFinite(Number(referenceExitPrice))
        ? Number(referenceExitPrice)
        : null,
    executedExitPrice:
      executedExitPrice != null && Number.isFinite(Number(executedExitPrice))
        ? Number(executedExitPrice)
        : null,
    entryExecutionCost:
      entryExecutionCost != null && Number.isFinite(Number(entryExecutionCost))
        ? Number(entryExecutionCost)
        : null,
    exitExecutionCost:
      exitExecutionCost != null && Number.isFinite(Number(exitExecutionCost))
        ? Number(exitExecutionCost)
        : null,
    entrySpreadCost:
      entrySpreadCost != null && Number.isFinite(Number(entrySpreadCost)) ? Number(entrySpreadCost) : null,
    entrySlippageCost:
      entrySlippageCost != null && Number.isFinite(Number(entrySlippageCost))
        ? Number(entrySlippageCost)
        : null,
    entryFeeCost:
      entryFeeCost != null && Number.isFinite(Number(entryFeeCost)) ? Number(entryFeeCost) : null,
    entryImpactCost:
      entryImpactCost != null && Number.isFinite(Number(entryImpactCost)) ? Number(entryImpactCost) : null,
    exitSpreadCost:
      exitSpreadCost != null && Number.isFinite(Number(exitSpreadCost)) ? Number(exitSpreadCost) : null,
    exitSlippageCost:
      exitSlippageCost != null && Number.isFinite(Number(exitSlippageCost)) ? Number(exitSlippageCost) : null,
    exitFeeCost:
      exitFeeCost != null && Number.isFinite(Number(exitFeeCost)) ? Number(exitFeeCost) : null,
    exitImpactCost:
      exitImpactCost != null && Number.isFinite(Number(exitImpactCost)) ? Number(exitImpactCost) : null,
    totalExecutionCost:
      totalExecutionCost != null && Number.isFinite(Number(totalExecutionCost))
        ? Number(totalExecutionCost)
        : null,
    costToGrossRatio:
      costToGrossRatio != null && Number.isFinite(Number(costToGrossRatio)) ? Number(costToGrossRatio) : null,
    executionCostBps:
      executionCostBps != null && Number.isFinite(Number(executionCostBps)) ? Number(executionCostBps) : null,
    netEfficiency:
      netEfficiency != null && Number.isFinite(Number(netEfficiency)) ? Number(netEfficiency) : null,
    spreadCostBps:
      spreadCostBps != null && Number.isFinite(Number(spreadCostBps)) ? Number(spreadCostBps) : null,
    slippageCostBps:
      slippageCostBps != null && Number.isFinite(Number(slippageCostBps)) ? Number(slippageCostBps) : null,
    feeCostBps: feeCostBps != null && Number.isFinite(Number(feeCostBps)) ? Number(feeCostBps) : null,
    fillQualityScore:
      fillQualityScore != null && Number.isFinite(Number(fillQualityScore)) ? Number(fillQualityScore) : null,
    sessionTagAtEntry: sessionTagAtEntry != null ? String(sessionTagAtEntry) : null,
    execution_realism_penalty: execution_realism_penalty === true,
    gross_net_divergence_high: gross_net_divergence_high === true,
    costs_eroding_edge: costs_eroding_edge === true,
    poor_fill_quality: poor_fill_quality === true,
    closedQuantity: qty,
    realizedPnL: pnl,
    netRealizedPnL: netP,
    grossRealizedPnL: grossP != null && Number.isFinite(grossP) ? grossP : null,
    realizedPnLPercent,
    holdingTimeSec,
    holdingTimeMin,
    entryTimestamp,
    exitTimestamp,
    closeReason: normalizeCloseReason(closeReason),
    actionSource,
    strategy,
    setupId,
    alertId,
    priceSourceAtExit,
    regime: regime == null ? null : String(regime),
    bookValueClosed,
    marketValueAtExit,
    fees: Number(fees) || 0,
    slippage: slippage === undefined ? null : slippage,
    rMultiple,
    won: netP > 0,
    closedAtDate,
    closedAtHourUTC,
    tradeGroupId: tradeGroupId || null,
    closeSequence: closeSequence == null ? null : Number(closeSequence),
    mfe: lc ? lc.mfe : null,
    mae: lc ? lc.mae : null,
    mfePercent: lc ? lc.mfePercent : null,
    maePercent: lc ? lc.maePercent : null,
    peakUnrealizedPnL: lc ? lc.peakUnrealizedPnL : null,
    worstUnrealizedPnL: lc ? lc.worstUnrealizedPnL : null,
    efficiencyRatio: lc ? lc.efficiencyRatio : null,
    lifecycleDurationSec: lc ? lc.lifecycleDurationSec : null,
    lifecycleDurationMin: lc ? lc.lifecycleDurationMin : null,
    groupEntryTimestamp: lc ? lc.entryTimestamp : null,
    groupFinalExitTimestamp: lc ? lc.finalExitTimestamp : null,
    groupCumulativeRealizedPnL: lc ? lc.cumulativeRealizedPnL : null,
  };
}

async function recordClosedTrade(payload) {
  if (!isEnabled()) return null;
  const row =
    payload.tradeCloseId != null && payload.symbol != null
      ? payload
      : buildClosedTradeRecord(payload);
  const file = getClosedTradesPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

async function loadClosedTrades() {
  const file = getClosedTradesPath();
  try {
    const text = await fs.readFile(file, 'utf8');
    const out = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch (e) {
        console.warn(`[closed-trades] skip corrupt line ${i + 1}: ${e.message}`);
      }
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.warn(`[closed-trades] load error: ${e.message}`);
    return [];
  }
}

function filterTrades(trades, options = {}) {
  let rows = [...trades];
  const sym = options.symbol
    ? String(options.symbol).toUpperCase().trim()
    : null;
  const strat = options.strategy != null ? String(options.strategy) : null;
  const won =
    options.won === 'true' || options.won === true
      ? true
      : options.won === 'false' || options.won === false
        ? false
        : null;
  const from = options.from ? String(options.from) : null;
  const to = options.to ? String(options.to) : null;

  if (sym) {
    rows = rows.filter((t) => String(t.symbol || '').toUpperCase() === sym);
  }
  if (strat) {
    rows = rows.filter((t) => t.strategy === strat);
  }
  if (won === true) rows = rows.filter((t) => t.won === true);
  if (won === false) rows = rows.filter((t) => t.won === false);
  if (from) {
    rows = rows.filter((t) => (t.exitTimestamp || '') >= from);
  }
  if (to) {
    rows = rows.filter((t) => (t.exitTimestamp || '') <= to);
  }

  rows.sort((a, b) => String(b.exitTimestamp).localeCompare(String(a.exitTimestamp)));

  const limit = parseInt(options.limit, 10);
  if (Number.isFinite(limit) && limit > 0) {
    rows = rows.slice(0, limit);
  }
  return rows;
}

async function listClosedTrades(options = {}) {
  const all = await loadClosedTrades();
  return filterTrades(all, options);
}

async function getRecentClosedTrades(limit = 20) {
  return listClosedTrades({ limit: String(limit) });
}

function getClosedTradeStats(trades) {
  const rows = Array.isArray(trades) ? trades : [];
  const count = rows.length;
  if (count === 0) {
    return {
      count: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalRealizedPnL: 0,
      grossProfit: 0,
      grossLoss: 0,
      profitFactor: null,
      avgWin: 0,
      avgLoss: 0,
      expectancy: 0,
      bestTrade: null,
      worstTrade: null,
      avgHoldingTimeSec: 0,
      avgHoldingTimeMin: 0,
    };
  }

  let wins = 0;
  let losses = 0;
  let totalRealizedPnL = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let sumWin = 0;
  let sumLoss = 0;
  let sumHoldSec = 0;
  let bestTrade = -Infinity;
  let worstTrade = Infinity;

  for (const t of rows) {
    const pnl = Number(t.realizedPnL) || 0;
    totalRealizedPnL += pnl;
    if (pnl > 0) {
      wins++;
      grossProfit += pnl;
      sumWin += pnl;
    } else if (pnl < 0) {
      losses++;
      grossLoss += pnl;
      sumLoss += pnl;
    }
    if (pnl > bestTrade) bestTrade = pnl;
    if (pnl < worstTrade) worstTrade = pnl;
    sumHoldSec += Number(t.holdingTimeSec) || 0;
  }

  const winRate = count > 0 ? (wins / count) * 100 : 0;
  const profitFactor =
    grossLoss !== 0 ? grossProfit / Math.abs(grossLoss) : null;
  const avgWin = wins > 0 ? sumWin / wins : 0;
  const avgLoss = losses > 0 ? sumLoss / losses : 0;
  const expectancy = count > 0 ? totalRealizedPnL / count : 0;
  const avgHoldingTimeSec = count > 0 ? sumHoldSec / count : 0;
  const avgHoldingTimeMin = avgHoldingTimeSec / 60;

  return {
    count,
    wins,
    losses,
    winRate: Math.round(winRate * 100) / 100,
    totalRealizedPnL: Math.round(totalRealizedPnL * 1e6) / 1e6,
    grossProfit: Math.round(grossProfit * 1e6) / 1e6,
    grossLoss: Math.round(grossLoss * 1e6) / 1e6,
    profitFactor: profitFactor != null ? Math.round(profitFactor * 100) / 100 : null,
    avgWin: Math.round(avgWin * 1e6) / 1e6,
    avgLoss: Math.round(avgLoss * 1e6) / 1e6,
    expectancy: Math.round(expectancy * 1e6) / 1e6,
    bestTrade: bestTrade === -Infinity ? null : Math.round(bestTrade * 1e6) / 1e6,
    worstTrade: worstTrade === Infinity ? null : Math.round(worstTrade * 1e6) / 1e6,
    avgHoldingTimeSec: Math.round(avgHoldingTimeSec),
    avgHoldingTimeMin: Math.round(avgHoldingTimeMin * 100) / 100,
  };
}

async function getClosedTradeStatsFiltered(options = {}) {
  const rows = await listClosedTrades(options);
  return getClosedTradeStats(rows);
}

function _mean(arr) {
  const a = arr.filter(Number.isFinite);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

function _stdSample(arr) {
  const a = arr.filter(Number.isFinite);
  if (a.length < 2) return 0;
  const m = _mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v);
}

function _winLossStreaks(rowsChrono) {
  let winStreak = 0;
  let lossStreak = 0;
  let curW = 0;
  let curL = 0;
  for (const t of rowsChrono) {
    const pnl = Number(t.realizedPnL) || 0;
    if (pnl > 0) {
      curW++;
      curL = 0;
      winStreak = Math.max(winStreak, curW);
    } else if (pnl < 0) {
      curL++;
      curW = 0;
      lossStreak = Math.max(lossStreak, curL);
    } else {
      curW = 0;
      curL = 0;
    }
  }
  return { winStreak, lossStreak };
}

/**
 * Multi-dimensional attribution over closed-trade rows.
 * options.groupBy: array of 'symbol' | 'strategy' | 'hourUTC' | 'date' | 'weekday' | 'regime' | 'priceSource'
 */
function normalizeAttributionDims(groupBy) {
  if (!Array.isArray(groupBy) || !groupBy.length) return ['symbol', 'strategy'];
  return groupBy.map((d) => {
    const x = String(d || '').trim();
    if (x === 'hour') return 'hourUTC';
    if (x === 'day') return 'date';
    return x;
  });
}

function getPerformanceAttribution(trades, options = {}) {
  const dims = normalizeAttributionDims(options.groupBy);
  const rows = Array.isArray(trades) ? trades : [];

  function keyOf(t) {
    return dims
      .map((d) => {
        if (d === 'symbol') return String(t.symbol || '').toUpperCase() || 'UNKNOWN';
        if (d === 'strategy') return t.strategy != null ? String(t.strategy) : 'null';
        if (d === 'hourUTC')
          return String(t.closedAtHourUTC != null ? t.closedAtHourUTC : '');
        if (d === 'date') return String(t.closedAtDate || '');
        if (d === 'weekday') {
          const ex = t.exitTimestamp;
          if (!ex) return '';
          return String(new Date(ex).getUTCDay());
        }
        if (d === 'regime') return t.regime != null ? String(t.regime) : 'unknown';
        if (d === 'priceSource')
          return t.priceSourceAtExit != null ? String(t.priceSourceAtExit) : 'unknown';
        return '';
      })
      .join('|');
  }

  const groups = new Map();
  for (const t of rows) {
    const k = keyOf(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }

  const out = [];
  for (const [groupKey, gRows] of groups) {
    const stats = getClosedTradeStats(gRows);
    const pnls = gRows.map((x) => Number(x.realizedPnL) || 0);
    const mfes = gRows.map((x) => Number(x.mfe)).filter((x) => Number.isFinite(x));
    const maes = gRows.map((x) => Number(x.mae)).filter((x) => Number.isFinite(x));
    const effs = gRows
      .map((x) => Number(x.efficiencyRatio))
      .filter((x) => Number.isFinite(x));
    const holds = gRows.map((x) => Number(x.holdingTimeSec) || 0);

    const wins = gRows.filter((x) => (Number(x.realizedPnL) || 0) > 0);
    const losses = gRows.filter((x) => (Number(x.realizedPnL) || 0) < 0);
    const wrDec = stats.count > 0 ? wins.length / stats.count : 0;
    const avgWin = wins.length ? _mean(wins.map((x) => Number(x.realizedPnL))) : 0;
    const avgLoss = losses.length ? _mean(losses.map((x) => Number(x.realizedPnL))) : 0;
    const lossMag = losses.length ? Math.abs(avgLoss) : 0;
    const expectancy =
      wrDec * avgWin - (1 - wrDec) * lossMag;

    const payoffRatio =
      losses.length && avgWin !== 0 && lossMag > 0 ? avgWin / lossMag : null;

    const sig = _stdSample(pnls);
    const sharpeProxy = sig > 1e-12 ? _mean(pnls) / sig : null;

    const chrono = [...gRows].sort((a, b) =>
      String(a.exitTimestamp || '').localeCompare(String(b.exitTimestamp || ''))
    );
    const streaks = _winLossStreaks(chrono);

    out.push({
      groupKey,
      dimensions: dims,
      trades: stats.count,
      winRate: stats.winRate,
      winRateDecimal: Math.round(wrDec * 1e4) / 1e4,
      totalPnL: stats.totalRealizedPnL,
      avgPnL: stats.count > 0 ? stats.totalRealizedPnL / stats.count : 0,
      expectancy: Math.round(expectancy * 1e6) / 1e6,
      profitFactor: stats.profitFactor,
      avgMFE: mfes.length ? Math.round(_mean(mfes) * 1e6) / 1e6 : null,
      avgMAE: maes.length ? Math.round(_mean(maes) * 1e6) / 1e6 : null,
      avgHoldingTimeSec: holds.length ? Math.round(_mean(holds)) : 0,
      avgEfficiencyRatio: effs.length ? Math.round(_mean(effs) * 1e4) / 1e4 : null,
      payoffRatio: payoffRatio != null ? Math.round(payoffRatio * 100) / 100 : null,
      sharpeProxy: sharpeProxy != null ? Math.round(sharpeProxy * 100) / 100 : null,
      winStreak: streaks.winStreak,
      lossStreak: streaks.lossStreak,
    });
  }

  out.sort((a, b) => Math.abs(b.totalPnL) - Math.abs(a.totalPnL));
  return out;
}

async function getPerformanceAttributionFiltered(options = {}) {
  const { groupBy, ...listOpts } = options;
  const rows = await listClosedTrades(listOpts);
  return getPerformanceAttribution(rows, { groupBy });
}

module.exports = {
  isEnabled,
  getClosedTradesPath,
  buildClosedTradeRecord,
  recordClosedTrade,
  loadClosedTrades,
  listClosedTrades,
  getRecentClosedTrades,
  getClosedTradeStats,
  getClosedTradeStatsFiltered,
  getPerformanceAttribution,
  getPerformanceAttributionFiltered,
  filterTrades,
  CLOSE_REASONS,
};
