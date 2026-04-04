'use strict';

/**
 * Average True Range (ATR)
 *
 * True Range (TR) for a bar = max(high - low, |high - prevClose|, |low - prevClose|).
 * ATR = EMA of TR over the given period (Wilder smoothing: α = 1/period).
 *
 * Used for volatility and stop-loss sizing. Higher ATR = more volatility.
 *
 * @param {Array<{open, high, low, close, volume}>} candles - OHLCV bars (oldest first)
 * @param {number} [period=14] - ATR period (default 14)
 * @param {number} [index=candles.length - 1] - Bar index to compute ATR at
 * @returns {number | null} - ATR value or null if insufficient data
 */
function atr(candles, period = 14, index = candles.length - 1) {
  if (!candles || candles.length < 2 || period < 1 || index < 0 || index >= candles.length) {
    return null;
  }
  const trs = [];
  for (let i = 0; i <= index; i++) {
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    const close = Number(candles[i].close);
    const prevClose = i === 0 ? close : Number(candles[i - 1].close);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  if (trs.length < period) return null;
  const k = 1 / period;
  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atrVal = trs[i] * k + atrVal * (1 - k);
  }
  return atrVal;
}

module.exports = { atr };
