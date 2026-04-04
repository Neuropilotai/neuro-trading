'use strict';

/**
 * NeuroPilot Quant Engine v1 — Feature Engine
 *
 * Consumes OHLCV candles and produces a structured feature object for regime detection
 * and strategy selection. Optimized for real-time: pass rolling window of candles and
 * get features for the latest bar.
 *
 * Input: Array of candles { open, high, low, close, volume } (oldest first).
 * Output: { price, ema20, ema50, ema20Slope, atr, vwap, vwapDistance, volumeSpike, rangeState, volatility, regimeCandidate }
 */

const indicators = require('./indicators');

const DEFAULT_OPTIONS = {
  ema20Period: 20,
  ema50Period: 50,
  atrPeriod: 14,
  volumeSpikeLookback: 20,
  volumeSpikeMultiplier: 2,
  rangeLookback: 10,
  rangeCompressThreshold: 0.7,
  rangeExpandThreshold: 1.3,
  volatilityLowThreshold: 0.005,
  volatilityHighThreshold: 0.02,
};

/**
 * Normalize candle shape: accept { o,h,l,c,v } or { open, high, low, close, volume }.
 */
function normalizeCandle(c) {
  return {
    open:  Number(c.open ?? c.o),
    high:  Number(c.high ?? c.h),
    low:   Number(c.low ?? c.l),
    close: Number(c.close ?? c.c),
    volume: Number(c.volume ?? c.v ?? 0),
  };
}

/**
 * Compute a single feature set for the latest bar (or given index).
 *
 * @param {Array<{open, high, low, close, volume}>} candles - OHLCV bars (oldest first)
 * @param {number} [index=candles.length - 1] - Bar index to compute features for
 * @param {object} [options] - Override default periods/thresholds
 * @returns {object} - Structured feature object (see example in module doc)
 */
function compute(candles, index = candles.length - 1, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const normalized = candles.map(normalizeCandle);

  const close = normalized[index].close;
  const price = close;

  // EMA 20 & 50 and EMA slope (short-term trend)
  const ema20 = indicators.ema(normalized, opts.ema20Period, index);
  const ema50 = indicators.ema(normalized, opts.ema50Period, index);
  const ema20Val = ema20 ? ema20.value : null;
  const ema50Val = ema50 ? ema50.value : null;
  const ema20Slope = ema20 ? ema20.slope : null;

  // ATR (volatility)
  const atrVal = indicators.atr(normalized, opts.atrPeriod, index);

  // VWAP and distance from VWAP (mean-reversion signal)
  const vwapResult = indicators.vwap(normalized, index);
  const vwapVal = vwapResult ? vwapResult.vwap : null;
  const vwapDistance = vwapResult ? vwapResult.vwapDistance : null;

  // Volume spike (unusual volume)
  const volSpikeResult = indicators.volumeSpike(
    normalized,
    opts.volumeSpikeLookback,
    opts.volumeSpikeMultiplier,
    index
  );
  const volumeSpike = volSpikeResult ? volSpikeResult.volumeSpike : false;

  // Range compression / expansion
  const rangeResult = indicators.rangeState(
    normalized,
    opts.rangeLookback,
    opts.rangeCompressThreshold,
    opts.rangeExpandThreshold,
    index
  );
  const rangeStateVal = rangeResult ? rangeResult.state : 'normal';

  // Volatility regime (low / medium / high)
  const volRegime = atrVal != null
    ? indicators.volatilityRegime(atrVal, close, {
        low: opts.volatilityLowThreshold,
        high: opts.volatilityHighThreshold,
      })
    : { volatility: 'medium', atrPct: 0 };
  const volatility = volRegime.volatility;

  // Regime candidate (trend vs range) from price vs EMAs
  const regimeCandidate = (ema20Val != null && ema50Val != null)
    ? indicators.regimeCandidateLabel(price, ema20Val, ema50Val)
    : 'range';

  return {
    price,
    ema20: ema20Val,
    ema50: ema50Val,
    ema20Slope,
    atr: atrVal,
    vwap: vwapVal,
    vwapDistance,
    volumeSpike,
    rangeState: rangeStateVal,
    volatility,
    regimeCandidate,
  };
}

/**
 * FeatureEngine: stateless API. For stateful use (e.g. caching), wrap in your own class.
 */
const FeatureEngine = {
  compute,
  DEFAULT_OPTIONS,
  indicators,
};

module.exports = FeatureEngine;
module.exports.compute = compute;
module.exports.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
