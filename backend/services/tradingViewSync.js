'use strict';

/** Stub for v2 minimal runnable. Replace with full implementation when adding TradingView sync. */
async function exportTrades(format) {
  return null;
}

async function getTradesForWebhook(since) {
  return [];
}

function formatTradeForDisplay(t) {
  return t;
}

module.exports = {
  exportTrades,
  getTradesForWebhook,
  formatTradeForDisplay,
};
