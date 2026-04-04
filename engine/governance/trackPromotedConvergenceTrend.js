#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

function safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function safeReadJsonlLast(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function appendJsonl(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${JSON.stringify(obj)}\n`, 'utf8');
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildTopRecentPromotedSetups(strictMappingReport) {
  const rows = Array.isArray(strictMappingReport && strictMappingReport.promoted_and_paper_recent)
    ? strictMappingReport.promoted_and_paper_recent
    : [];
  return rows
    .map((r) => ({
      setupKey: r.setupKey || null,
      tradesRecent: toNum(r.tradesRecent, 0),
      pnlRecent: toNum(r.pnlRecent, 0),
      lastTradeTs: r.lastTradeTs || null,
    }))
    .sort((a, b) => b.pnlRecent - a.pnlRecent || b.tradesRecent - a.tradesRecent)
    .slice(0, 10);
}

function computeDelta(prev, curr) {
  if (!prev) return null;
  const fields = [
    'promoted_manifest_count',
    'promoted_in_signals_count',
    'promoted_and_paper_recent',
    'promoted_not_seen_in_paper_last_7d',
    'paper_recent_not_promoted_but_profitable_count',
    'appended_last_run',
    'duplicateSkippedPersistent_last_run',
  ];
  const delta = {};
  for (const f of fields) {
    delta[f] = toNum(curr[f], 0) - toNum(prev[f], 0);
  }
  return delta;
}

function main() {
  const root = dataRoot.getDataRoot();
  const discDir = path.join(root, 'discovery');
  const govDir = path.join(root, 'governance');
  const trendPath = path.join(govDir, 'promoted_convergence_trend.jsonl');

  const promotedChildren = safeReadJson(path.join(discDir, 'promoted_children.json')) || {};
  const promotedManifest = safeReadJson(path.join(discDir, 'promoted_manifest.json')) || {};
  const signalsDoc = safeReadJson(path.join(govDir, 'paper_execution_v1_signals.json')) || {};
  const strictMapping = safeReadJson(path.join(govDir, 'paper_trades_strict_mapping_report.json')) || {};
  const setupAnalysis = safeReadJson(path.join(govDir, 'paper_trades_by_setup_analysis.json')) || {};
  const lastRun = safeReadJson(path.join(govDir, 'paper_exec_v1_last_run.json')) || {};

  const promotedChildrenSet = new Set(
    (Array.isArray(promotedChildren.strategies) ? promotedChildren.strategies : [])
      .map((x) => String((x && x.setupId) || (x && x.strategyId) || '').trim())
      .filter(Boolean)
  );
  const promotedManifestSet = new Set(
    (Array.isArray(promotedManifest.items) ? promotedManifest.items : [])
      .map((x) => String((x && x.setupId) || (x && x.strategyId) || '').trim())
      .filter(Boolean)
  );
  const signalRows = Array.isArray(signalsDoc.signals) ? signalsDoc.signals : [];
  const promotedInSignalsSet = new Set(
    signalRows
      .map((x) => String((x && x.setupId) || (x && x.strategyId) || '').trim())
      .filter((k) => k && promotedChildrenSet.has(k))
  );

  const strictCounts = {
    promoted_and_paper_recent: Array.isArray(strictMapping.promoted_and_paper_recent)
      ? strictMapping.promoted_and_paper_recent.length
      : 0,
    promoted_not_seen_in_paper_last_7d: Array.isArray(strictMapping.promoted_not_seen_in_paper_last_7d)
      ? strictMapping.promoted_not_seen_in_paper_last_7d.length
      : 0,
    paper_recent_not_promoted_but_profitable:
      Array.isArray(strictMapping.paper_recent_not_promoted_but_profitable)
        ? strictMapping.paper_recent_not_promoted_but_profitable.length
        : 0,
  };
  const topRecentPromoted = buildTopRecentPromotedSetups(strictMapping);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    promoted_manifest_count: promotedManifestSet.size,
    promoted_in_signals_count: promotedInSignalsSet.size,
    promoted_and_paper_recent: toNum(strictCounts.promoted_and_paper_recent, 0),
    promoted_not_seen_in_paper_last_7d: toNum(strictCounts.promoted_not_seen_in_paper_last_7d, 0),
    paper_recent_not_promoted_but_profitable_count: toNum(
      strictCounts.paper_recent_not_promoted_but_profitable,
      0
    ),
    appended_last_run: toNum(lastRun.effectiveAppended, 0),
    duplicateSkippedPersistent_last_run: toNum(lastRun.duplicateSkippedPersistent, 0),
    top_recent_promoted_setups: topRecentPromoted,
  };

  const prev = safeReadJsonlLast(trendPath);
  const delta = computeDelta(prev, snapshot);
  const row = {
    ...snapshot,
    delta_vs_previous: delta,
  };
  appendJsonl(trendPath, row);

  console.log(
    JSON.stringify(
      {
        ok: true,
        wrote: trendPath,
        snapshot,
        delta_vs_previous: delta,
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main();
}
