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
  } = input;

  const entry = Number(entryPriceAvg);
  const exitPx = Number(exitPriceAvg);
  const qty = Number(closedQuantity);
  const pnl = Number(realizedPnL);

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

  return {
    tradeCloseId,
    symbol: String(symbol || '').toUpperCase().trim(),
    side,
    entryPriceAvg: entry,
    exitPriceAvg: exitPx,
    closedQuantity: qty,
    realizedPnL: pnl,
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
    bookValueClosed,
    marketValueAtExit,
    fees: Number(fees) || 0,
    slippage: slippage === undefined ? null : slippage,
    rMultiple,
    won: pnl > 0,
    closedAtDate,
    closedAtHourUTC,
    tradeGroupId: tradeGroupId || null,
    closeSequence: closeSequence == null ? null : Number(closeSequence),
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
  filterTrades,
  CLOSE_REASONS,
};
