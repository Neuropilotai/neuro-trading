'use strict';

/**
 * NeuroPilot Quant Engine v1 — Backtest Harness / Replay Runner
 *
 * Replays historical OHLCV bar-by-bar: runs the full signal pipeline at each bar,
 * converts each signal to a journal record, and returns a structured research result.
 * No trades placed; account is not mutated. Signal research mode only.
 *
 * Inputs:
 *   - candles: OHLCV array (oldest first)
 *   - account: { equity, dailyPnL, openPositions } (passed to pipeline each bar; not mutated)
 *   - symbol: instrument identifier (e.g. "XAUUSD")
 *   - timeframe: bar granularity (e.g. "2m")
 *   - options: optional { pipeline, startIndex, minBars, barTimestamp }
 *   - startIndex: optional; first bar index to run (default: minBars from feature warmup)
 *
 * Output:
 *   - { totalBars, totalSignals, validSignals, tradeableSignals, noTradeSignals, records, summary }
 */

const signalPipeline = require('./signalPipeline');
const journal = require('./journal');

/** Minimum bars required for feature computation (EMA50 + ATR warmup). */
const DEFAULT_MIN_BARS = 51;

/**
 * Get timestamp for a bar. Uses candle.time, .timestamp, or .t; else fallback for unique IDs.
 */
function getBarTimestamp(candle, index, fallbackMs) {
  const t = candle && (candle.time ?? candle.timestamp ?? candle.t);
  if (t != null) return typeof t === 'number' ? t : new Date(t).getTime();
  return fallbackMs != null ? fallbackMs + index : null;
}

/**
 * Summarize journal records by regime. Returns object: regime string -> count.
 */
function summarizeByRegime(records) {
  if (!Array.isArray(records)) return {};
  const out = {};
  for (const r of records) {
    const key = r.regime != null ? String(r.regime) : 'null';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Summarize journal records by strategy. Returns object: strategy string -> count.
 */
function summarizeByStrategy(records) {
  if (!Array.isArray(records)) return {};
  const out = {};
  for (const r of records) {
    const key = r.strategy != null ? String(r.strategy) : 'null';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Summarize journal records by direction. Returns object: "long" | "short" | "null" -> count.
 */
function summarizeByDirection(records) {
  if (!Array.isArray(records)) return {};
  const out = { long: 0, short: 0, null: 0 };
  for (const r of records) {
    const key = r.direction === 'long' ? 'long' : r.direction === 'short' ? 'short' : 'null';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Build summary object from records (byRegime, byStrategy, byDirection).
 */
function buildSummary(records) {
  return {
    byRegime: summarizeByRegime(records),
    byStrategy: summarizeByStrategy(records),
    byDirection: summarizeByDirection(records),
  };
}

/**
 * Run backtest replay: bar-by-bar pipeline run + journal record per bar. Pure function.
 *
 * @param {Array<object>} candles - OHLCV bars (oldest first); candles may have .time / .timestamp / .t
 * @param {object} account - Account state (passed to pipeline each bar; not mutated)
 * @param {string} symbol - Instrument symbol (e.g. "XAUUSD")
 * @param {string} timeframe - Bar timeframe (e.g. "2m")
 * @param {object} [options] - { pipeline: module options, startIndex: number, minBars: number, barTimestamp: { baseMs, intervalMs } }
 * @returns {object} { totalBars, totalSignals, validSignals, tradeableSignals, noTradeSignals, records, summary }
 */
function run(candles, account, symbol, timeframe, options = {}) {
  const opts = options || {};
  const minBars = typeof opts.minBars === 'number' && opts.minBars >= 0 ? opts.minBars : DEFAULT_MIN_BARS;
  const startIndex = typeof opts.startIndex === 'number' && opts.startIndex >= 0
    ? opts.startIndex
    : minBars;
  const pipelineOptions = opts.pipeline != null ? opts.pipeline : {};
  const barTs = opts.barTimestamp || {};
  const baseMs = barTs.baseMs != null ? barTs.baseMs : 0;
  const intervalMs = barTs.intervalMs != null ? barTs.intervalMs : 1;

  const totalBars = Array.isArray(candles) ? candles.length : 0;
  const records = [];

  if (totalBars === 0 || startIndex >= totalBars) {
    return {
      totalBars,
      totalSignals: 0,
      validSignals: 0,
      tradeableSignals: 0,
      noTradeSignals: 0,
      records: [],
      summary: buildSummary([]),
    };
  }

  for (let i = startIndex; i < totalBars; i++) {
    const signal = signalPipeline.run(candles, account, pipelineOptions, i);
    const fallbackMs = baseMs + (i - startIndex) * intervalMs;
    const barTime = getBarTimestamp(candles[i], i, fallbackMs);
    const record = journal.toRecord(signal, symbol, timeframe, barTime != null ? barTime : undefined);
    records.push(record);
  }

  const totalSignals = records.length;
  const validSignals = records.filter((r) => r.valid === true).length;
  const tradeableSignals = records.filter((r) => r.shouldTrade === true).length;
  const noTradeSignals = totalSignals - tradeableSignals;

  return {
    totalBars,
    totalSignals,
    validSignals,
    tradeableSignals,
    noTradeSignals,
    records,
    summary: buildSummary(records),
  };
}

module.exports = {
  run,
  summarizeByRegime,
  summarizeByStrategy,
  summarizeByDirection,
  buildSummary,
  getBarTimestamp,
  DEFAULT_MIN_BARS,
};
