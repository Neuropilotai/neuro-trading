'use strict';

/**
 * Feature Matrix Engine — Pre-compute features once for all bars; all strategies read this matrix.
 *
 * Builds an in-memory matrix: one row per candle with body_pct, close_strength, volume_ratio,
 * session_phase, regime, etc. No per-setup recalculation; fast vector scan applies logical masks on it.
 *
 * Usage:
 *   const { buildFeatureMatrix } = require('./engine/features/buildFeatureMatrix');
 *   const matrix = buildFeatureMatrix(candles, { symbol, timeframe });
 */

const ROW_SCHEMA = [
  'index',
  'time',
  'body_pct',
  'close_strength',
  'volume_ratio',
  'session_phase',
  'regime',
];

/**
 * Body as fraction of range: |close - open| / (high - low). 0 if range is 0.
 */
function bodyPct(c) {
  const range = c.high - c.low;
  if (!range || !Number.isFinite(range)) return 0;
  const body = Math.abs((c.close || c.c) - (c.open || c.o));
  return Math.min(1, body / range);
}

/**
 * Close strength: (close - low) / (high - low). 0 if range is 0.
 */
function closeStrength(c) {
  const range = (c.high || c.h) - (c.low || c.l);
  if (!range || !Number.isFinite(range)) return 0;
  const close = c.close || c.c;
  const low = c.low || c.l;
  return Math.max(0, Math.min(1, (close - low) / range));
}

/**
 * Session phase from timestamp (ms): open / mid / close (US session 14:30–21:00 UTC ≈ 6.5h).
 * Split into 3 buckets by time of day (UTC).
 */
function sessionPhase(timeMs) {
  if (timeMs == null || !Number.isFinite(timeMs)) return 'mid';
  const d = new Date(timeMs);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const sessionStart = 14 * 60 + 30;
  const sessionEnd = 21 * 60;
  if (utcMin < sessionStart || utcMin >= sessionEnd) return 'close';
  const sessionLen = sessionEnd - sessionStart;
  const intoSession = utcMin - sessionStart;
  if (intoSession < sessionLen / 3) return 'open';
  if (intoSession < (2 * sessionLen) / 3) return 'mid';
  return 'close';
}

/**
 * Volume ratio: volume / MA(volume, 20). Clamped to [0, 3] for stability.
 */
function volumeRatio(candles, index, period = 20) {
  const v = candles[index] && (candles[index].volume ?? candles[index].v);
  if (v == null || !Number.isFinite(v)) return 1;
  let sum = 0;
  let count = 0;
  for (let i = Math.max(0, index - period + 1); i <= index; i++) {
    const vv = candles[i] && (candles[i].volume ?? candles[i].v);
    if (vv != null && Number.isFinite(vv)) { sum += vv; count++; }
  }
  const ma = count > 0 ? sum / count : v;
  if (!ma || !Number.isFinite(ma)) return 1;
  const ratio = v / ma;
  return Math.max(0, Math.min(3, ratio));
}

/**
 * Regime placeholder: breakout when close > open and body_pct high; else range.
 */
function regime(c) {
  const bp = bodyPct(c);
  const close = c.close || c.c;
  const open = c.open || c.o;
  if (bp >= 0.5 && close > open) return 'breakout';
  return 'range';
}

/**
 * Build feature matrix from OHLCV candles. One row per bar.
 *
 * @param {Array<{ open, high, low, close, volume, time? }>} candles - Normalized candles (oldest first)
 * @param {{ symbol?: string, timeframe?: string }} [meta]
 * @returns {{ rows: Array<object>, schema: string[], symbol: string, timeframe: string }}
 */
function buildFeatureMatrix(candles, meta = {}) {
  const symbol = (meta.symbol || '').toString() || 'SPY';
  const timeframe = (meta.timeframe || '').toString() || '5m';
  const rows = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const time = c && (c.time ?? c.t ?? c.timestamp ?? c.date);
    const timeMs = typeof time === 'number' ? (time < 1e12 ? time * 1000 : time) : (time ? new Date(time).getTime() : null);
    rows.push({
      index: i,
      time: timeMs,
      body_pct: bodyPct(c),
      close_strength: closeStrength(c),
      volume_ratio: volumeRatio(candles, i),
      session_phase: sessionPhase(timeMs),
      regime: regime(c),
      close: c && (c.close ?? c.c),
      open: c && (c.open ?? c.o),
      high: c && (c.high ?? c.h),
      low: c && (c.low ?? c.l),
    });
  }

  return { rows, schema: ROW_SCHEMA, symbol, timeframe };
}

module.exports = { buildFeatureMatrix, bodyPct, closeStrength, sessionPhase, volumeRatio, regime, ROW_SCHEMA };
