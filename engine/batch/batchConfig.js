'use strict';

const os = require('os');

/**
 * Number of parallel backtest workers (M3 Pro = 10+ cores).
 * Override with env BATCH_WORKERS (e.g. BATCH_WORKERS=8).
 * Used so 500 strategies/night → 5000–20000 with parallel batch.
 */
function getWorkerCount() {
  const env = process.env.BATCH_WORKERS;
  if (env != null && env !== '') {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 1) return Math.min(n, 64);
  }
  return Math.max(1, os.cpus().length);
}

module.exports = { getWorkerCount };
