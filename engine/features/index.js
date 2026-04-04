'use strict';

/**
 * NeuroPilot Quant Engine v1 — Feature Engine (public API)
 *
 * Usage:
 *   const { compute } = require('./engine/features');
 *   const features = compute(ohlcvCandles);
 *   // { price, ema20, ema50, atr, vwapDistance, volumeSpike, volatility, regimeCandidate, ... }
 */
const FeatureEngine = require('./FeatureEngine');

module.exports = {
  compute: FeatureEngine.compute,
  DEFAULT_OPTIONS: FeatureEngine.DEFAULT_OPTIONS,
  indicators: FeatureEngine.indicators,
};
