'use strict';

/**
 * Volume-Weighted Average Price (VWAP)
 *
 * Typical price for a bar = (high + low + close) / 3.
 * Cumulative VWAP (session) = sum(typicalPrice * volume) / sum(volume) over the window.
 *
 * Used to measure whether price is above or below average execution price;
 * distance from VWAP is a mean-reversion / momentum signal.
 *
 * @param {Array<{open, high, low, close, volume}>} candles - OHLCV bars (oldest first)
 * @param {number} [index=candles.length - 1] - Bar index; VWAP is computed from start of array to this index
 * @returns {{ vwap: number, vwapDistance: number } | null} - VWAP and (close - vwap) at index, or null
 */
function vwap(candles, index = candles.length - 1) {
  if (!candles || candles.length < 1 || index < 0 || index >= candles.length) {
    return null;
  }
  let sumPV = 0;
  let sumV = 0;
  for (let i = 0; i <= index; i++) {
    const h = Number(candles[i].high);
    const l = Number(candles[i].low);
    const c = Number(candles[i].close);
    const v = Number(candles[i].volume) || 0;
    const typical = (h + l + c) / 3;
    sumPV += typical * v;
    sumV += v;
  }
  if (sumV <= 0) return null;
  const vwapVal = sumPV / sumV;
  const close = Number(candles[index].close);
  const vwapDistance = close - vwapVal;
  return { vwap: vwapVal, vwapDistance };
}

module.exports = { vwap };
