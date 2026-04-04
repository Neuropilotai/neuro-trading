#!/usr/bin/env node
'use strict';

/**
 * One-line checkpoint: promoted setups visible in recent paper (strict mapping 7d)
 * vs paper_exec_v1_last_run bypass counters. Optional trend from promoted_convergence_trend.jsonl.
 *
 * Reads:
 *   <DATA_ROOT>/governance/paper_exec_v1_last_run.json
 *   <DATA_ROOT>/governance/paper_trades_strict_mapping_report.json
 *   <DATA_ROOT>/governance/promoted_convergence_trend.jsonl (last 2 lines, optional)
 *
 * If paper_exec last run is newer than strict mapping generatedAt, overlap counts may be
 * stale until you rerun analyze:paper-by-setup (see strictMappingStaleVsLastRun in --json).
 *
 * Usage:
 *   node engine/governance/checkPromotedRecentCheckpoint.js
 *   node engine/governance/checkPromotedRecentCheckpoint.js --json
 */

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

function readJsonlLastN(p, n) {
  try {
    if (!fs.existsSync(p) || n < 1) return [];
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-n).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function toNum(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function parseIsoMs(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function main() {
  const wantJson = process.argv.includes('--json');
  const root = dataRoot.getDataRoot();
  const govDir = path.join(root, 'governance');
  const lastRunPath = path.join(govDir, 'paper_exec_v1_last_run.json');
  const strictPath = path.join(govDir, 'paper_trades_strict_mapping_report.json');
  const trendPath = path.join(govDir, 'promoted_convergence_trend.jsonl');

  const lastRun = safeReadJson(lastRunPath) || {};
  const strict = safeReadJson(strictPath) || {};
  const haveLastRun = fs.existsSync(lastRunPath);
  const haveStrict = fs.existsSync(strictPath);

  const promotedRecent = Array.isArray(strict.promoted_and_paper_recent)
    ? strict.promoted_and_paper_recent.length
    : 0;
  const promotedNotSeen7d = Array.isArray(strict.promoted_not_seen_in_paper_last_7d)
    ? strict.promoted_not_seen_in_paper_last_7d.length
    : 0;

  const bypassOn = lastRun.promotedReplayBypassEnabled === true;
  const bypassCount = toNum(lastRun.promotedReplayBypassCount, 0);
  const bypassMax = toNum(lastRun.promotedReplayMaxPerRun, 0);
  const appended = toNum(lastRun.effectiveAppended, 0);
  const dupPersistent = toNum(lastRun.duplicateSkippedPersistent, 0);

  const strictGenMs = parseIsoMs(strict.generatedAt);
  const lastRunMs = parseIsoMs(lastRun.writtenAt);
  const strictMappingStaleVsLastRun =
    haveStrict &&
    haveLastRun &&
    strictGenMs != null &&
    lastRunMs != null &&
    lastRunMs > strictGenMs + 1000;

  const trendLines = readJsonlLastN(trendPath, 2);
  const prevSnap = trendLines.length >= 2 ? trendLines[0] : null;
  const lastSnap = trendLines.length >= 1 ? trendLines[trendLines.length - 1] : null;

  let deltaRecent = null;
  if (prevSnap && lastSnap) {
    deltaRecent =
      toNum(lastSnap.promoted_and_paper_recent, 0) - toNum(prevSnap.promoted_and_paper_recent, 0);
  }

  let verdict;
  let detail;
  const nTrend = trendLines.length;

  if (!haveStrict) {
    verdict = 'MISSING_STRICT_MAPPING';
    detail = `no ${path.basename(strictPath)}; run: npm run analyze:paper-by-setup`;
  } else if (!haveLastRun) {
    verdict = 'MISSING_LAST_RUN';
    detail = `no ${path.basename(lastRunPath)}; run paper execution at least once`;
  } else if (promotedRecent > 0) {
    verdict = 'OK';
    detail = `promoted recent visible (last_7d count=${promotedRecent})`;
  } else if (deltaRecent != null && deltaRecent < 0) {
    verdict = 'REGRESSION';
    detail = `promoted_and_paper_recent decreased vs previous trend snapshot (delta=${deltaRecent})`;
  } else if (!bypassOn) {
    verdict = 'BYPASS_OFF';
    detail = `promoted replay bypass not enabled; promoted_not_seen_7d=${promotedNotSeen7d} (set NEUROPILOT_PAPER_ALLOW_PROMOTED_REPLAY=1 to test)`;
  } else if (nTrend >= 2 && deltaRecent === 0) {
    verdict = 'NO_PROGRESS';
    detail = `bypass on; promoted+paper overlap still 0 in 7d with flat trend; bypass_used=${bypassCount}/${bypassMax}, appended=${appended}, dup_persistent_skips=${dupPersistent}`;
  } else {
    verdict = 'BYPASS_ACTIVE_WAITING';
    detail = `bypass on; waiting for recent overlap (bypass_used=${bypassCount}/${bypassMax}, appended=${appended}, dup_persistent_skips=${dupPersistent})`;
  }

  if (strictMappingStaleVsLastRun) {
    detail +=
      ' | STALE: strict mapping older than last paper run — rerun npm run analyze:paper-by-setup before trusting overlap counts';
  }

  const oneLine = `[${verdict}] ${detail}`;

  const payload = {
    verdict,
    oneLine,
    dataRoot: root,
    artifactsPresent: { lastRun: haveLastRun, strictMapping: haveStrict },
    strictMappingStaleVsLastRun,
    strictMappingGeneratedAt: strict.generatedAt || null,
    lastRunWrittenAt: lastRun.writtenAt || null,
    sources: {
      lastRun: lastRunPath,
      strictMapping: strictPath,
      trend: fs.existsSync(trendPath) ? trendPath : null,
    },
    metrics: {
      promoted_and_paper_recent_count: promotedRecent,
      promoted_not_seen_in_paper_last_7d_count: promotedNotSeen7d,
      promotedReplayBypassEnabled: bypassOn,
      promotedReplayBypassCount: bypassCount,
      promotedReplayMaxPerRun: bypassMax,
      effectiveAppended: appended,
      duplicateSkippedPersistent: dupPersistent,
    },
    trend: {
      previous_snapshot: prevSnap,
      latest_snapshot: lastSnap,
      delta_promoted_and_paper_recent: deltaRecent,
    },
  };

  if (wantJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(oneLine);
  }
}

if (require.main === module) {
  main();
}
