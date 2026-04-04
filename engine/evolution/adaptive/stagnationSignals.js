'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Load NDJSON evolution metrics into memory (deterministic for a given file).
 * @param {string} logPath
 * @param {number} [maxLines] — cap parse cost (default 500)
 * @returns {object[]}
 */
function loadMetricsHistoryFromLog(logPath, maxLines = 500) {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8').trim();
  if (!raw) return [];
  const lines = raw.split('\n').filter(Boolean);
  const slice =
    maxLines > 0 && lines.length > maxLines
      ? lines.slice(-maxLines)
      : lines;
  const rows = [];
  for (const line of slice) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return rows;
}

/**
 * @param {object[]} metricsHistory
 */
function readStagnationSignals(metricsHistory = []) {
  if (!metricsHistory.length) {
    return {
      isStagnating: false,
      avgDelta: null,
      zeroPromotions: false,
    };
  }

  const last = metricsHistory.slice(-5);
  const avgDelta =
    last.reduce((acc, x) => acc + Number(x.delta ?? 0), 0) / last.length;

  const zeroPromotions = last.every(
    (x) => Number(x.wildcardPromotions ?? 0) === 0
  );

  return {
    isStagnating: avgDelta <= 0,
    avgDelta,
    zeroPromotions,
  };
}

module.exports = {
  readStagnationSignals,
  loadMetricsHistoryFromLog,
  defaultLogPath: path.join(__dirname, '..', 'logs', 'evolution_metrics.log'),
};
