'use strict';

/** Stub for v2 minimal runnable. Replace with full implementation when adding indicator pipeline. */
const enabled = false;
const tradingStyle = 'stub';

function evaluateMarketConditions(symbol, timeframe, marketData) {
  return [];
}

async function initialize() {
  return;
}

module.exports = {
  enabled,
  tradingStyle,
  evaluateMarketConditions,
  initialize,
  indicators: { size: 0 },
};
