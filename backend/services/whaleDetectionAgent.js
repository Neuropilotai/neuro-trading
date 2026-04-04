'use strict';

/** Stub for v2 minimal runnable. Replace with full implementation when adding whale detection. */
const enabled = false;
const config = { volumeSpikeThreshold: 0 };

async function initialize() {
  return;
}

function getStats() {
  return {};
}

function getAllWhaleSignals() {
  return [];
}

function getWhaleSignal(symbol) {
  return null;
}

module.exports = {
  enabled,
  config,
  initialize,
  getStats,
  getAllWhaleSignals,
  getWhaleSignal,
};
