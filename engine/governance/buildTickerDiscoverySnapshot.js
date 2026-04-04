'use strict';

/**
 * Compact ops snapshot for ticker discovery / market-intelligence V1.
 * Read-only aggregation of discovery/*.json → dashboard-friendly JSON.
 * Fail-soft: missing files yield empty sections + notes.
 */

const fs = require('fs');
const path = require('path');
const datasetManifest = require('../data/datasetManifest');

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function resolveDataRoot(opts = {}) {
  if (opts.dataRoot) return path.resolve(opts.dataRoot);
  return datasetManifest.getDataRoot();
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataRoot]
 * @param {string} [opts.generatedAt] - ISO
 */
function buildTickerDiscoverySnapshotPayload(opts = {}) {
  const root = resolveDataRoot(opts);
  const disc = path.join(root, 'discovery');
  const generatedAt = opts.generatedAt || new Date().toISOString();

  const mi = readJsonSafe(path.join(disc, 'market_intelligence.json'), null);
  const cand = readJsonSafe(path.join(disc, 'ticker_candidates.json'), null);
  const queue = readJsonSafe(path.join(disc, 'ticker_admission_queue.json'), null);

  const notes = [];
  if (!mi) notes.push('market_intelligence.json missing');
  if (!cand) notes.push('ticker_candidates.json missing');
  if (!queue) notes.push('ticker_admission_queue.json missing');

  const candidates = cand && Array.isArray(cand.candidates) ? cand.candidates : [];
  const topCandidates = [...candidates]
    .sort((a, b) => (b.admissionScore || 0) - (a.admissionScore || 0))
    .slice(0, 10)
    .map((c) => ({
      symbol: c.symbol,
      admissionScore: c.admissionScore,
      discoveryScore: c.discoveryScore,
      fitScore: c.fitScore,
      status: c.status,
      eligibleForPaperAdmission: c.eligibleForPaperAdmission,
      dataCoverage: c.dataCoverage,
    }));

  const queueItems = queue && Array.isArray(queue.items) ? queue.items : [];
  const paperCandidates = queueItems
    .filter((i) => i && i.status === 'paper_candidate')
    .map((i) => ({
      symbol: i.symbol,
      admissionScore: i.admissionScore,
      recommendedAction: i.recommendedAction,
      reason: i.reason,
      paperOnly: i.paperOnly,
    }));

  let summary;
  if (queue && queue.summary && typeof queue.summary === 'object') {
    summary = {
      watchlistCandidates: queue.summary.watchlistCandidates ?? 0,
      paperCandidates: queue.summary.paperCandidates ?? 0,
      ignored: queue.summary.ignored ?? 0,
    };
  } else {
    summary = {
      watchlistCandidates: candidates.filter((c) => c.status === 'watchlist_candidate').length,
      paperCandidates: paperCandidates.length,
      ignored: candidates.filter((c) => c.status === 'ignored').length,
    };
  }

  const riskFlags = mi && Array.isArray(mi.newsRiskFlags) ? mi.newsRiskFlags.slice(0, 30) : [];

  const out = {
    generatedAt,
    summary,
    topCandidates,
    paperCandidates,
    riskFlags,
  };
  if (notes.length) out.notes = notes;
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.opsSnapshotDir - absolute ops-snapshot directory
 * @param {string} [opts.generatedAt]
 * @param {string} [opts.dataRoot]
 */
function writeTickerDiscoveryOpsSnapshot(opts = {}) {
  const opsDir = opts.opsSnapshotDir;
  if (!opsDir || typeof opsDir !== 'string') {
    throw new Error('writeTickerDiscoveryOpsSnapshot: opsSnapshotDir required');
  }
  const payload = buildTickerDiscoverySnapshotPayload({
    generatedAt: opts.generatedAt,
    dataRoot: opts.dataRoot,
  });
  fs.mkdirSync(opsDir, { recursive: true });
  const filePath = path.join(opsDir, 'ticker_discovery.json');
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { path: filePath, payload };
}

module.exports = {
  buildTickerDiscoverySnapshotPayload,
  writeTickerDiscoveryOpsSnapshot,
};
