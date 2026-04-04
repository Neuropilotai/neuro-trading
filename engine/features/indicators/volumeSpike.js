'use strict';

/**
 * Volume spike detection
 *
 * Compares current bar volume to the average volume over a lookback window.
 * Spike = current volume > multiplier * SMA(volume, lookback).
 *
 * Used to detect unusual activity (breakouts, news, capitulation).
 *
 * @param {Array<{open, high, low, close, volume}>} candles - OHLCV bars (oldest first)
 * @param {number} [lookback=20] - Period for volume average
 * @param {number} [multiplier=2] - Spike threshold (e.g. 2 = volume > 2x average)
 * @param {number} [index=candles.length - 1] - Bar index to check
 * @returns {{ volumeSpike: boolean, ratio: number } | null} - true if spike, and volume ratio vs average
 */
function volumeSpike(candles, lookback = 20, multiplier = 2, index = candles.length - 1) {
  if (!candles || candles.length < lookback || index < lookback - 1 || index >= candles.length) {
    return null;
  }
  const currentVol = Number(candles[index].volume) || 0;
  let sum = 0;
  for (let i = index - lookback + 1; i < index; i++) {
    sum += Number(candles[i].volume) || 0;
  }
  const avgVol = sum / (lookback - 1);
  if (avgVol <= 0) return { volumeSpike: false, ratio: 0 };
  const ratio = currentVol / avgVol;
  const volumeSpike = ratio >= multiplier;
  return { volumeSpike, ratio };
}

module.exports = { volumeSpike };
