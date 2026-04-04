#!/usr/bin/env node
'use strict';

/**
 * Append-only observability: copy governance_dashboard.json into
 * <dataRoot>/governance/history/governance_<unixEpoch>.json
 * and append one summary line to governance/history/index.jsonl
 *
 * No mutation of learning/policy. Read-only copy for temporal diff of paperLearningInsights.
 *
 * CLI: node engine/governance/snapshotGovernanceDashboardHistory.js
 * Source default: <repo>/ops-snapshot/governance_dashboard.json
 * Override: NEUROPILOT_GOVERNANCE_DASHBOARD_JSON=/abs/path/to/governance_dashboard.json
 *
 * Opt-in hook from build: set NEUROPILOT_GOVERNANCE_HISTORY_SNAPSHOT=1 before buildGovernanceDashboard.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
/** Bump when index line schema changes (operators may filter by this). */
const GOVERNANCE_HISTORY_INDEX_VERSION = '1.2.0';

function defaultSourcePath() {
  const env = process.env.NEUROPILOT_GOVERNANCE_DASHBOARD_JSON;
  if (env && String(env).trim()) {
    return path.resolve(String(env).trim());
  }
  return path.join(REPO_ROOT, 'ops-snapshot', 'governance_dashboard.json');
}

function sha256HexOfFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function pickStrategyId(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.strategyId != null) return String(v.strategyId);
  return null;
}

function summarizeDashboardPayload(payload) {
  const v2 = payload && payload.paperTradesMetricsV2;
  const v1 = payload && payload.paperTradesMetrics;
  const ins = payload && payload.paperLearningInsights;

  const validTradeCount =
    v2 && v2.validTradeCount != null
      ? Number(v2.validTradeCount)
      : v1 && v1.validTradeCount != null
        ? Number(v1.validTradeCount)
        : null;

  let confidence = null;
  if (ins && Object.prototype.hasOwnProperty.call(ins, 'confidence')) {
    confidence = ins.confidence === null || ins.confidence === undefined ? null : ins.confidence;
  }

  const bestFromInsights = ins && ins.summaryBestStrategyId != null ? String(ins.summaryBestStrategyId) : null;
  const worstFromInsights = ins && ins.summaryWorstStrategyId != null ? String(ins.summaryWorstStrategyId) : null;
  const bestFromV2 = v2 ? pickStrategyId(v2.bestStrategy) : null;
  const worstFromV2 = v2 ? pickStrategyId(v2.worstStrategy) : null;

  const dashboardVersion =
    payload && payload.dashboardVersion != null && payload.dashboardVersion !== ''
      ? String(payload.dashboardVersion)
      : null;

  return {
    validTradeCount: Number.isFinite(validTradeCount) ? validTradeCount : null,
    confidence,
    bestStrategyId: bestFromInsights || bestFromV2,
    worstStrategyId: worstFromInsights || worstFromV2,
    dashboardVersion,
  };
}

function appendIndexLine(histDir, indexEntry) {
  const indexPath = path.join(histDir, 'index.jsonl');
  fs.appendFileSync(indexPath, `${JSON.stringify(indexEntry)}\n`, 'utf8');
  return indexPath;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.sourcePath] - governance_dashboard.json to copy
 * @returns {{ ok: true, dest: string, src: string, indexPath?: string, indexEntry?: object } | { ok: false, reason: string, src: string }}
 */
function snapshotGovernanceDashboardHistory(opts = {}) {
  const src = opts.sourcePath || defaultSourcePath();
  if (!fs.existsSync(src)) {
    return { ok: false, reason: 'missing_source', src };
  }
  const gov = dataRoot.getPath('governance', true);
  const histDir = path.join(gov, 'history');
  fs.mkdirSync(histDir, { recursive: true });
  const stamp = Math.floor(Date.now() / 1000);
  const fileName = `governance_${stamp}.json`;
  const dest = path.join(histDir, fileName);
  fs.copyFileSync(src, dest);
  const snapshotSizeBytes = fs.statSync(dest).size;

  const root = dataRoot.getDataRoot();
  /** @type {string} portable path from data root */
  const relativePathNorm = path.relative(root, dest).split(path.sep).join('/');

  const dashboardHash = sha256HexOfFile(dest);
  const snapshotAtIso = new Date(stamp * 1000).toISOString();

  let indexEntry = {
    governanceHistoryIndexVersion: GOVERNANCE_HISTORY_INDEX_VERSION,
    snapshotAtIso,
    unixEpoch: stamp,
    relativePath: relativePathNorm,
    dashboardHash,
    validTradeCount: null,
    confidence: null,
    bestStrategyId: null,
    worstStrategyId: null,
    dashboardVersion: null,
    snapshotSizeBytes,
    parseError: false,
  };

  try {
    const raw = fs.readFileSync(dest, 'utf8');
    const payload = JSON.parse(raw);
    const sum = summarizeDashboardPayload(payload);
    indexEntry = {
      ...indexEntry,
      validTradeCount: sum.validTradeCount,
      confidence: sum.confidence,
      bestStrategyId: sum.bestStrategyId,
      worstStrategyId: sum.worstStrategyId,
      dashboardVersion: sum.dashboardVersion,
    };
    const hasInsightsKey = payload && Object.prototype.hasOwnProperty.call(payload, 'paperLearningInsights');
    indexEntry.paperLearningInsightsPresent = hasInsightsKey;
  } catch {
    indexEntry.parseError = true;
  }

  const indexPath = appendIndexLine(histDir, indexEntry);
  return { ok: true, dest, src, indexPath, indexEntry };
}

module.exports = {
  snapshotGovernanceDashboardHistory,
  defaultSourcePath,
  summarizeDashboardPayload,
  GOVERNANCE_HISTORY_INDEX_VERSION,
};

if (require.main === module) {
  const r = snapshotGovernanceDashboardHistory();
  if (!r.ok) {
    console.error(`[governance_history] skip (${r.reason}): ${r.src}`);
    process.exit(0);
  }
  console.log(`[governance_history] wrote ${r.dest}`);
  if (r.indexPath) {
    console.log(`[governance_history] index ${r.indexPath}`);
  }
  process.exit(0);
}
