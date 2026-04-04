'use strict';

/**
 * Range compression / expansion
 *
 * Bar range = high - low. We compare current range to recent average range (e.g. SMA of range over lookback).
 * Compression = current range < threshold_low * average (tight consolidation).
 * Expansion = current range > threshold_high * average (breakout / volatility expansion).
 *
 * @param {Array<{open, high, low, close, volume}>} candles - OHLCV bars (oldest first)
 * @param {number} [lookback=10] - Period for average range
 * @param {number} [compressThreshold=0.7] - Range < this * avg = compression
 * @param {number} [expandThreshold=1.3] - Range > this * avg = expansion
 * @param {number} [index=candles.length - 1] - Bar index
 * @returns {{ state: 'compression'|'expansion'|'normal', range: number, avgRange: number, ratio: number } | null}
 */
function rangeState(candles, lookback = 10, compressThreshold = 0.7, expandThreshold = 1.3, index = candles.length - 1) {
  if (!candles || candles.length < lookback || index < lookback - 1 || index >= candles.length) {
    return null;
  }
  const currentRange = Number(candles[index].high) - Number(candles[index].low);
  let sumRange = 0;
  for (let i = index - lookback + 1; i <= index; i++) {
    sumRange += Number(candles[i].high) - Number(candles[i].low);
  }
  const avgRange = sumRange / lookback;
  if (avgRange <= 0) return null;
  const ratio = currentRange / avgRange;
  let state = 'normal';
  if (ratio < compressThreshold) state = 'compression';
  else if (ratio > expandThreshold) state = 'expansion';
  return { state, range: currentRange, avgRange, ratio };
}

module.exports = { rangeState };
