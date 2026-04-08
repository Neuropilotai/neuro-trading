'use strict';

/**
 * Stub Trading Learning Service for v2 minimal runnable.
 * Allows paperTradingService and adapters to load without the full learning/pattern chain.
 * Replace with full implementation when adding learning pipeline to v2.
 */

const enabled = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.ENABLE_TRADING_LEARNING || '').trim().toLowerCase()
);

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
