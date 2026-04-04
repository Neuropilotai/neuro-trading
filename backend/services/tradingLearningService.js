'use strict';

/**
 * Stub Trading Learning Service for v2 minimal runnable.
 * Allows paperTradingService and adapters to load without the full learning/pattern chain.
 * Replace with full implementation when adding learning pipeline to v2.
 */

const enabled = false;

async function learnFromTrade(executionResult, orderIntent) {
  // no-op
}

function getMetrics() {
  return {};
}

module.exports = {
  enabled,
  learnFromTrade,
  getMetrics,
};
