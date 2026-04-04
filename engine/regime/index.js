'use strict';

/**
 * NeuroPilot Quant Engine v1 — Regime Engine (public API)
 *
 * Usage:
 *   const { compute } = require('./engine/features');
 *   const { classify } = require('./engine/regime');
 *   const features = compute(ohlcvCandles);
 *   const { regime, confidence } = classify(features);
 *   // e.g. { regime: 'TREND_UP', confidence: 0.75 }
 */
const regimeEngine = require('./regimeEngine');

module.exports = {
  classify: regimeEngine.classify,
  REGIMES: regimeEngine.REGIMES,
  DEFAULT_OPTIONS: regimeEngine.DEFAULT_OPTIONS,
  SCORERS: regimeEngine.SCORERS,
};
