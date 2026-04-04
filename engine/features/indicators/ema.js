'use strict';

/**
 * Exponential Moving Average (EMA)
 *
 * Formula: EMA_today = α * close_today + (1 - α) * EMA_yesterday
 * where α = 2 / (period + 1) (smoothing factor).
 *
 * For the first bar, EMA is the close (or SMA of first period bars if warmup).
 * Used for trend direction and slope (EMA 20 = short-term, EMA 50 = medium-term).
 *
 * @param {Array<{open, high, low, close, volume}>} candles - OHLCV bars (oldest first)
 * @param {number} period - EMA period (e.g. 20, 50)
 * @param {number} [index=candles.length - 1] - Bar index to compute EMA at (default: latest)
 * @returns {{ value: number, slope: number } | null} - EMA value and slope (vs previous bar), or null if insufficient data
 */
function ema(candles, period, index = candles.length - 1) {
  if (!candles || candles.length < 2 || period < 1 || index < 0 || index >= candles.length) {
    return null;
  }
  const k = 2 / (period + 1);
  let emaPrev = Number(candles[0].close);
  for (let i = 1; i <= index; i++) {
    const close = Number(candles[i].close);
    emaPrev = close * k + emaPrev * (1 - k);
  }
  const value = emaPrev;
  const prevIndex = index - 1;
  let slope = 0;
  if (prevIndex >= 0) {
    let emaPrevBar = Number(candles[0].close);
    for (let i = 1; i <= prevIndex; i++) {
      const close = Number(candles[i].close);
      emaPrevBar = close * k + emaPrevBar * (1 - k);
    }
    slope = value - emaPrevBar;
  }
  return { value, slope };
}

/**
 * EMA value only (convenience for callers that don't need slope).
 */
function emaValue(candles, period, index = candles.length - 1) {
  const result = ema(candles, period, index);
  return result ? result.value : null;
}

module.exports = { ema, emaValue };
