'use strict';

/**
 * Paper Execution V1 — deterministic bar-by-bar simulation (read-only / offline).
 * Contract: engine/governance/PAPER_EXECUTION_V1_SPEC.md
 *
 * Intrabar path: OPEN → LOW → HIGH → CLOSE (evaluate low leg before high leg for stops/targets).
 * Tie-break (same bar, stop + profit level both touched): stop wins → reason stop_intrabar_priority.
 */

const { resolveBarIndex } = require('../tradeSimulation');

const PAPER_EXECUTION_SCHEMA_VERSION = '1.0.0';
const INTRABAR_MODEL = 'OHLC_LOW_FIRST';

/** When signal / opts omit valid rMultiple (aligns with next-gen / wave1 band ~1.2–1.5). */
const PAPER_EXECUTION_V1_DEFAULT_R_MULTIPLE = 1.3;

/**
 * @param {object} bar - { high, low, open?, close? }
 * @param {'long'|'short'} direction
 * @param {number} stopPrice
 * @param {number} targetPrice
 * @returns {{ exitPrice: number, reason: string } | null}
 */
function intrabarExitLowFirst(bar, direction, stopPrice, targetPrice) {
  if (!bar || typeof bar.high !== 'number' || typeof bar.low !== 'number') return null;
  const { high, low } = bar;

  if (direction === 'long') {
    const hitStop = low <= stopPrice;
    const hitTarget = high >= targetPrice;
    if (hitStop && hitTarget) {
      return { exitPrice: stopPrice, reason: 'stop_intrabar_priority' };
    }
    if (hitStop) return { exitPrice: stopPrice, reason: 'stop' };
    if (hitTarget) return { exitPrice: targetPrice, reason: 'target' };
    return null;
  }

  if (direction === 'short') {
    const hitStop = high >= stopPrice;
    const hitTarget = low <= targetPrice;
    if (hitStop && hitTarget) {
      return { exitPrice: stopPrice, reason: 'stop_intrabar_priority' };
    }
    if (hitStop) return { exitPrice: stopPrice, reason: 'stop' };
    if (hitTarget) return { exitPrice: targetPrice, reason: 'target' };
    return null;
  }

  return null;
}

function barTimeMs(bar) {
  if (!bar) return null;
  const raw = bar.time ?? bar.timestamp ?? bar.t;
  if (raw == null) return null;
  const ms = typeof raw === 'number' ? (raw >= 1e12 ? raw : raw * 1000) : new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function msToIso(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Paper trade identity for JSONL: strategyId stays backward-compatible; setupId is optional
 * canonical id from the signal (learning / generated_strategies) when producer supplies it
 * and it differs from strategyId (avoids duplicate keys when only setupId was given).
 */
function resolvePaperTradeIdentityFields(signal) {
  const s = signal && typeof signal === 'object' ? signal : {};
  const strategyId = (s.strategyId || s.setupId || 'unknown').toString();
  const rawSetup =
    s.setupId != null && String(s.setupId).trim() !== '' ? String(s.setupId).trim() : null;
  const out = { strategyId };
  if (rawSetup != null && rawSetup !== strategyId) {
    out.setupId = rawSetup;
  }
  return out;
}

/**
 * Simulate one trade (V1). No I/O, no randomness.
 *
 * @param {Array<object>} candles - OHLCV oldest first
 * @param {object} signal - barIndex|timestamp, entryPrice or entryAtBarClose, stopDistance, direction?, rMultiple?, maxBarsHeld?, strategyId|setupId, symbol?, timeframe?
 * @param {object} [opts]
 * @returns {object} Trade record (including skip) suitable for JSONL
 */
function simulatePaperTradeV1(candles, signal, opts = {}) {
  const candleList = Array.isArray(candles) ? candles : [];
  const s = signal && typeof signal === 'object' ? signal : {};
  const direction =
    s.direction === 'short' ? 'short' : s.direction === 'long' ? 'long' : opts.defaultDirection === 'short' ? 'short' : 'long';
  const rFromSig = Number(s.rMultiple);
  const rFromOpts = Number(opts.rMultiple);
  const rMultiple =
    Number.isFinite(rFromSig) && rFromSig > 0
      ? rFromSig
      : Number.isFinite(rFromOpts) && rFromOpts > 0
        ? rFromOpts
        : PAPER_EXECUTION_V1_DEFAULT_R_MULTIPLE;
  const maxBarsHeld =
    typeof s.maxBarsHeld === 'number' && s.maxBarsHeld >= 0 ? s.maxBarsHeld : opts.maxBarsHeld != null ? opts.maxBarsHeld : null;

  const barIndex = resolveBarIndex(candleList, s);
  let entryPrice =
    typeof s.entryPrice === 'number' && Number.isFinite(s.entryPrice) ? s.entryPrice : null;
  if (s.entryAtBarClose === true && barIndex != null && candleList[barIndex]) {
    const c = candleList[barIndex];
    const cl = typeof c.close === 'number' && Number.isFinite(c.close) ? c.close : null;
    if (cl != null) entryPrice = cl;
  }

  const stopDistance =
    typeof s.stopDistance === 'number' && Number.isFinite(s.stopDistance) && s.stopDistance > 0
      ? s.stopDistance
      : null;

  const identity = resolvePaperTradeIdentityFields(s);
  const symbol = s.symbol != null ? String(s.symbol) : null;
  const timeframe = s.timeframe != null ? String(s.timeframe) : null;

  const cycleId = opts.cycleId != null ? String(opts.cycleId) : null;
  const experimentId = opts.experimentId != null ? String(opts.experimentId) : null;

  const base = {
    paperExecutionSchemaVersion: PAPER_EXECUTION_SCHEMA_VERSION,
    intrabarModel: INTRABAR_MODEL,
    cycleId,
    experimentId,
    ...identity,
    symbol,
    timeframe,
    direction,
    governorDecision: null,
    policyRef: null,
  };

  if (entryPrice == null || stopDistance == null || barIndex == null || barIndex < 0) {
    return {
      ...base,
      ts: null,
      entryTs: null,
      exitTs: null,
      entry: null,
      exit: null,
      reason: 'skip',
      pnl: 0,
      barsHeld: 0,
      detail: 'missing entryPrice/stopDistance/barIndex',
    };
  }

  const stopPrice = direction === 'long' ? entryPrice - stopDistance : entryPrice + stopDistance;
  const targetDistance = stopDistance * rMultiple;
  const targetPrice = direction === 'long' ? entryPrice + targetDistance : entryPrice - targetDistance;

  const entryBar = candleList[barIndex];
  const entryMs = barTimeMs(entryBar);

  let barsHeld = 0;
  let exitPrice = null;
  let reason = null;
  let exitMs = null;

  const totalBars = candleList.length;
  for (let i = barIndex + 1; i < totalBars; i++) {
    barsHeld++;
    const bar = candleList[i];
    const hit = intrabarExitLowFirst(bar, direction, stopPrice, targetPrice);
    if (hit) {
      exitPrice = hit.exitPrice;
      reason = hit.reason;
      exitMs = barTimeMs(bar);
      break;
    }
    if (maxBarsHeld != null && barsHeld >= maxBarsHeld) {
      const cl =
        bar && typeof bar.close === 'number' && Number.isFinite(bar.close)
          ? bar.close
          : bar && typeof bar.open === 'number' && Number.isFinite(bar.open)
            ? bar.open
            : entryPrice;
      exitPrice = cl;
      reason = 'max_bars';
      exitMs = barTimeMs(bar);
      break;
    }
  }

  if (exitPrice == null) {
    const lastBar = candleList[candleList.length - 1];
    const cl =
      lastBar && typeof lastBar.close === 'number' && Number.isFinite(lastBar.close)
        ? lastBar.close
        : entryPrice;
    exitPrice = cl;
    reason = 'time';
    exitMs = barTimeMs(lastBar);
  }

  const pnl =
    direction === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;

  return {
    ...base,
    ts: msToIso(exitMs) || msToIso(entryMs) || new Date(0).toISOString(),
    entryTs: msToIso(entryMs),
    exitTs: msToIso(exitMs),
    entry: entryPrice,
    exit: exitPrice,
    stopPrice,
    targetPrice,
    rMultiple,
    reason,
    pnl: Math.round(pnl * 1e8) / 1e8,
    barsHeld,
  };
}

module.exports = {
  simulatePaperTradeV1,
  intrabarExitLowFirst,
  resolvePaperTradeIdentityFields,
  PAPER_EXECUTION_SCHEMA_VERSION,
  INTRABAR_MODEL,
  PAPER_EXECUTION_V1_DEFAULT_R_MULTIPLE,
};
