'use strict';

/**
 * Normalize raw market_context JSON to a stable shape (P1 stub).
 */

function normalizeMarketContext(raw, sourceTag) {
  if (!raw || typeof raw !== 'object') {
    return {
      regime: 'unknown',
      volatilityScore: 0,
      trendStrength: 0,
      source: sourceTag,
    };
  }
  const regime =
    typeof raw.regime === 'string' && raw.regime.trim()
      ? raw.regime.trim()
      : typeof raw.marketRegime === 'string' && raw.marketRegime.trim()
        ? raw.marketRegime.trim()
        : 'unknown';
  return {
    regime,
    volatilityScore: Number(raw.volatilityScore ?? 0),
    trendStrength: Number(raw.trendStrength ?? 0),
    source: sourceTag,
  };
}

module.exports = {
  normalizeMarketContext,
};
