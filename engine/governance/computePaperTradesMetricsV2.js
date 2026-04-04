'use strict';

/**
 * Paper trading observability V2 — temporal + strategy buckets (read-only, from JSONL).
 * Contract: PAPER_TRADES_METRICS_V2_SCHEMA.md
 */

const { parsePaperTradesJsonlContent } = require('./parsePaperTradesJsonl');
const { nonProductionNameSignals } = require('./computeStrategyValidationFramework');
const { computeStrategyValidationFromContent } = require('./computeStrategyValidationFramework');

const PAPER_TRADES_METRICS_V2_SCHEMA_VERSION = '1.0.0';

function parseIsoMs(iso) {
  if (iso == null || iso === '') return null;
  const ms = new Date(String(iso)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** UTC calendar date YYYY-MM-DD */
function utcDateKeyFromTrade(t) {
  const ts = t.exitTs || t.ts || null;
  const ms = parseIsoMs(ts);
  if (ms == null) return 'unknown';
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function cycleKeyFromTrade(t) {
  if (t.cycleId != null && String(t.cycleId).trim() !== '') return String(t.cycleId).trim();
  if (t.experimentId != null && String(t.experimentId).trim() !== '') return String(t.experimentId).trim();
  return '_unknown_cycle';
}

function strategyIdFromTrade(t) {
  if (t.strategyId != null && String(t.strategyId).trim() !== '') return String(t.strategyId).trim();
  return 'unknown';
}

function aggregateTrades(list) {
  let wins = 0;
  let losses = 0;
  let flat = 0;
  const byReason = {};
  let totalPnl = 0;
  for (const t of list) {
    if (t.pnl > 0) wins++;
    else if (t.pnl < 0) losses++;
    else flat++;
    totalPnl += t.pnl;
    const r = t.reason != null && String(t.reason).trim() !== '' ? String(t.reason).trim() : 'unknown';
    byReason[r] = (byReason[r] || 0) + 1;
  }
  const n = list.length;
  const winRate = n > 0 ? Math.round((wins / n) * 10000) / 100 : null;
  const totalPnlR = n > 0 ? Math.round(totalPnl * 1e8) / 1e8 : null;
  const avgPnl = n > 0 ? Math.round((totalPnl / n) * 1e8) / 1e8 : null;
  return {
    trades: n,
    wins,
    losses,
    flat,
    winRate,
    totalPnl: totalPnlR,
    avgPnl,
    byReason,
  };
}

/**
 * Deterministic best / worst by totalPnl; ties: higher winRate wins "best"; then lexicographic strategyId.
 * @param {Array<{ strategyId: string } & ReturnType<aggregateTrades>>} rows
 */
function pickBestWorstStrategy(rows) {
  const valid = rows.filter((r) => r.trades > 0);
  if (valid.length === 0) {
    return { bestStrategy: null, worstStrategy: null };
  }
  const sorted = [...valid].sort((a, b) => {
    const tp = (a.totalPnl ?? 0) - (b.totalPnl ?? 0);
    if (tp !== 0) return tp;
    const wr = (a.winRate ?? 0) - (b.winRate ?? 0);
    if (wr !== 0) return wr;
    return String(a.strategyId).localeCompare(String(b.strategyId));
  });
  const worst = sorted[0];
  const best = sorted[sorted.length - 1];
  return {
    bestStrategy: {
      strategyId: best.strategyId,
      totalPnl: best.totalPnl,
      trades: best.trades,
      winRate: best.winRate,
    },
    worstStrategy: {
      strategyId: worst.strategyId,
      totalPnl: worst.totalPnl,
      trades: worst.trades,
      winRate: worst.winRate,
    },
  };
}

/**
 * @param {string} content - JSONL file body
 * @param {object} opts
 * @param {string} [opts.sourceJsonl]
 * @param {boolean} [opts.sourceFilePresent]
 */
function computePaperTradesMetricsV2FromContent(content, opts = {}) {
  const sourceJsonl = opts.sourceJsonl != null ? String(opts.sourceJsonl) : null;
  const generatedAt = new Date().toISOString();
  const sourceExists = opts.sourceFilePresent === true;
  const body = content == null ? '' : String(content);

  const { trades, parseErrors, lineCount } = parsePaperTradesJsonlContent(body);
  const strictValidation = computeStrategyValidationFromContent(body);
  const excludedByValidation = new Set(
    ((strictValidation && Array.isArray(strictValidation.rows)) ? strictValidation.rows : [])
      .filter((r) => r && r.mode === 'promotion' && r.excludedFromRanking === true)
      .map((r) => String(r.strategyId))
  );

  const eligibleTrades = [];
  let excludedNonProductionTrades = 0;
  let excludedByValidationTrades = 0;
  const excludedByStrategy = {};

  for (const t of trades) {
    const sid = strategyIdFromTrade(t);
    const nameSignals = nonProductionNameSignals(sid);
    if (nameSignals.hardMatched) {
      excludedNonProductionTrades += 1;
      excludedByStrategy[sid] = (excludedByStrategy[sid] || 0) + 1;
      continue;
    }
    if (excludedByValidation.has(sid)) {
      excludedByValidationTrades += 1;
      excludedByStrategy[sid] = (excludedByStrategy[sid] || 0) + 1;
      continue;
    }
    eligibleTrades.push(t);
  }

  const dayMap = new Map();
  const cycleMap = new Map();
  const stratMap = new Map();

  for (const t of eligibleTrades) {
    const dk = utcDateKeyFromTrade(t);
    if (!dayMap.has(dk)) dayMap.set(dk, []);
    dayMap.get(dk).push(t);

    const ck = cycleKeyFromTrade(t);
    if (!cycleMap.has(ck)) cycleMap.set(ck, []);
    cycleMap.get(ck).push(t);

    const sk = strategyIdFromTrade(t);
    if (!stratMap.has(sk)) stratMap.set(sk, []);
    stratMap.get(sk).push(t);
  }

  const byDay = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, list]) => ({ day, ...aggregateTrades(list) }));

  const byCycle = Array.from(cycleMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cycleKey, list]) => ({ cycleKey, ...aggregateTrades(list) }));

  const byStrategy = Array.from(stratMap.entries())
    .map(([strategyId, list]) => ({ strategyId, ...aggregateTrades(list) }))
    .sort((a, b) => {
      const tp = (b.totalPnl ?? 0) - (a.totalPnl ?? 0);
      if (tp !== 0) return tp;
      return String(a.strategyId).localeCompare(String(b.strategyId));
    });

  const { bestStrategy, worstStrategy } = pickBestWorstStrategy(byStrategy);

  const base = {
    paperTradesMetricsV2SchemaVersion: PAPER_TRADES_METRICS_V2_SCHEMA_VERSION,
    generatedAt,
    sourceJsonl,
    sourceExists,
    parseErrors,
    lineCount,
    validationExclusionMode: 'promotion_strict',
    rawValidTradeCount: trades.length,
    excludedNonProductionTrades,
    excludedByValidationTrades,
    excludedByStrategy,
    validTradeCount: eligibleTrades.length,
    byDay,
    byCycle,
    byStrategy,
    bestStrategy,
    worstStrategy,
  };

  return {
    full: base,
    byDayFile: {
      paperTradesMetricsV2SchemaVersion: PAPER_TRADES_METRICS_V2_SCHEMA_VERSION,
      generatedAt,
      sourceJsonl,
      aggregation: 'by_day',
      parseErrors,
      lineCount,
      validationExclusionMode: 'promotion_strict',
      rawValidTradeCount: trades.length,
      excludedNonProductionTrades,
      excludedByValidationTrades,
      excludedByStrategy,
      validTradeCount: eligibleTrades.length,
      buckets: byDay,
    },
    byCycleFile: {
      paperTradesMetricsV2SchemaVersion: PAPER_TRADES_METRICS_V2_SCHEMA_VERSION,
      generatedAt,
      sourceJsonl,
      aggregation: 'by_cycle',
      parseErrors,
      lineCount,
      validationExclusionMode: 'promotion_strict',
      rawValidTradeCount: trades.length,
      excludedNonProductionTrades,
      excludedByValidationTrades,
      excludedByStrategy,
      validTradeCount: eligibleTrades.length,
      buckets: byCycle,
    },
    byStrategyFile: {
      paperTradesMetricsV2SchemaVersion: PAPER_TRADES_METRICS_V2_SCHEMA_VERSION,
      generatedAt,
      sourceJsonl,
      aggregation: 'by_strategy',
      parseErrors,
      lineCount,
      validationExclusionMode: 'promotion_strict',
      rawValidTradeCount: trades.length,
      excludedNonProductionTrades,
      excludedByValidationTrades,
      excludedByStrategy,
      validTradeCount: eligibleTrades.length,
      buckets: byStrategy,
      bestStrategy,
      worstStrategy,
    },
  };
}

function computePaperTradesMetricsV2FromFile(filePath, fs = require('fs')) {
  if (!filePath || !fs.existsSync(filePath)) {
    return computePaperTradesMetricsV2FromContent('', {
      sourceJsonl: filePath,
      sourceFilePresent: false,
    });
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return computePaperTradesMetricsV2FromContent(content, {
    sourceJsonl: filePath,
    sourceFilePresent: true,
  });
}

module.exports = {
  computePaperTradesMetricsV2FromContent,
  computePaperTradesMetricsV2FromFile,
  utcDateKeyFromTrade,
  cycleKeyFromTrade,
  strategyIdFromTrade,
  PAPER_TRADES_METRICS_V2_SCHEMA_VERSION,
};
