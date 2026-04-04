'use strict';

/**
 * Volatility regime (ATR as % of price)
 *
 * ATR% = ATR / close. Classified into bands (e.g. low / medium / high) using thresholds.
 * Useful for strategy selection: low vol → mean reversion, high vol → breakout / wider stops.
 *
 * @param {number} atr - ATR value (from atr indicator)
 * @param {number} close - Current close price
 * @param {object} [thresholds] - Optional { low: number, high: number } as decimals (e.g. 0.005, 0.02)
 * @returns {{ volatility: 'low'|'medium'|'high', atrPct: number }}
 */
function volatilityRegime(atr, close, thresholds = { low: 0.005, high: 0.02 }) {
  if (close <= 0 || atr < 0) return { volatility: 'medium', atrPct: 0 };
  const atrPct = atr / close;
  let volatility = 'medium';
  if (atrPct < thresholds.low) volatility = 'low';
  else if (atrPct > thresholds.high) volatility = 'high';
  return { volatility, atrPct };
}

module.exports = { volatilityRegime };
