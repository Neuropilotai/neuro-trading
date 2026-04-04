'use strict';

/** Stub for v2 minimal runnable. Replace with full implementation when adding autopilot. */
const enabled = false;
const config = { targetAccuracy: 0 };

function getPerformance() {
  return {};
}

async function start() {
  return;
}

function stop() {
  return;
}

function getStatus() {
  return { enabled: false };
}

module.exports = {
  enabled,
  config,
  getPerformance,
  start,
  stop,
  getStatus,
};
