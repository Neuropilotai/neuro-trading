#!/usr/bin/env node
'use strict';

/**
 * Build weekly P7 Guard summary JSON (read-only analytics).
 *
 * Usage:
 *   node engine/governance/p7GuardWeeklySummary.js
 *   node engine/governance/p7GuardWeeklySummary.js --data-root /abs/path/to/data_workspace
 *   node engine/governance/p7GuardWeeklySummary.js --days 7 --out /abs/path/out.json
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const { parseP7GuardLine } = require('../observability/p7GuardMetrics');

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function round4(x) {
  return Math.round(Number(x || 0) * 10000) / 10000;
}

function parseArgs(argv) {
  const out = {
    dataRoot: null,
    days: 7,
    outPath: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--data-root' && argv[i + 1]) {
      out.dataRoot = path.resolve(argv[i + 1]);
      i += 1;
    } else if (a === '--days' && argv[i + 1]) {
      out.days = Math.max(1, Math.min(90, Number(argv[i + 1]) || 7));
      i += 1;
    } else if (a === '--out' && argv[i + 1]) {
      out.outPath = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function toIsoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function parseP7AlertLine(line) {
  // Example:
  // [P7 alert] ts=... severity=warning reason=empty_window reportsLoaded=0
  const m = String(line || '').match(/\[P7 alert\]\s+ts=(\S+)\s+severity=(\S+)\s+reason=(\S+)/);
  if (!m) return null;
  const tsMs = Date.parse(m[1]);
  if (!Number.isFinite(tsMs)) return null;
  return {
    ts: m[1],
    tsMs,
    severity: m[2],
    reason: m[3],
  };
}

function parseReasonLine(prefix, line) {
  // Generic parser for lines such as:
  // [Governor alert] ts=... severity=... reason=decision_flap ...
  const re = new RegExp(`\\[${prefix} alert\\]\\s+ts=(\\S+)\\s+severity=(\\S+)\\s+reason=(\\S+)`);
  const m = String(line || '').match(re);
  if (!m) return null;
  const tsMs = Date.parse(m[1]);
  if (!Number.isFinite(tsMs)) return null;
  return { tsMs, reason: m[3] };
}

function splitInHalves(rows) {
  const n = rows.length;
  if (!n) return { first: [], second: [] };
  const mid = Math.floor(n / 2);
  return {
    first: rows.slice(0, mid),
    second: rows.slice(mid),
  };
}

function computeHalfImprovement(rows, reasonsOfInterest) {
  const { first, second } = splitInHalves(rows);
  const countInterest = (arr) =>
    arr.filter((r) => reasonsOfInterest == null || reasonsOfInterest.has(r.reason)).length;
  const a = countInterest(first);
  const b = countInterest(second);
  if (a === 0 && b === 0) return null;
  return b <= a;
}

function buildSummary(opts = {}) {
  const root = opts.dataRoot || dataRoot.getDataRoot();
  const governanceDir = path.join(root, 'governance');
  const now = new Date();
  const days = Math.max(1, Math.min(90, Number(opts.days) || 7));
  const sinceMs = now.getTime() - days * 24 * 60 * 60 * 1000;

  const guardEventLines = readLines(path.join(governanceDir, 'p7_guard_events.log'));
  const guardRows = guardEventLines
    .map((l) => parseP7GuardLine(l))
    .filter(Boolean)
    .filter((r) => (r.ts ? Date.parse(r.ts) >= sinceMs : true));

  const counts = { normal: 0, attenuate: 0, skip: 0 };
  for (const r of guardRows) {
    if (r.action === 'normal') counts.normal += 1;
    else if (r.action === 'attenuate') counts.attenuate += 1;
    else if (r.action === 'skip') counts.skip += 1;
  }
  const nGuard = guardRows.length;
  const skipRate = nGuard ? round4(counts.skip / nGuard) : 0;
  const attenuateRate = nGuard ? round4(counts.attenuate / nGuard) : 0;

  const p7AlertLines = readLines(path.join(governanceDir, 'p7_alerts.log'));
  const p7Alerts = p7AlertLines
    .map(parseP7AlertLine)
    .filter(Boolean)
    .filter((r) => r.tsMs >= sinceMs);
  const knownP7 = [
    'low_report_coverage',
    'empty_window',
    'apply_zero_unexpected',
    'parse_errors',
    'no_p7_metrics_events',
  ];
  const topP7Alerts = {};
  const totalP7 = p7Alerts.length;
  for (const k of knownP7) {
    const c = p7Alerts.filter((r) => r.reason === k).length;
    if (c > 0) topP7Alerts[k] = round4(c / totalP7);
  }

  const governorAlertLines = readLines(path.join(governanceDir, 'governor_alerts.log'));
  const governorAlerts = governorAlertLines
    .map((l) => parseReasonLine('Governor', l))
    .filter(Boolean)
    .filter((r) => r.tsMs >= sinceMs)
    .sort((a, b) => a.tsMs - b.tsMs);
  const governorImprovement = computeHalfImprovement(
    governorAlerts,
    new Set(['decision_flap', 'invalid_decision'])
  );

  const policyAlertLines = readLines(path.join(governanceDir, 'policy_alerts.log'));
  const policyAlerts = policyAlertLines
    .map((l) => parseReasonLine('Policy', l))
    .filter(Boolean)
    .filter((r) => r.tsMs >= sinceMs)
    .sort((a, b) => a.tsMs - b.tsMs);
  const policyStabilityImprovement = computeHalfImprovement(policyAlerts, null);

  const atLeastOneImprovement = governorImprovement === true || policyStabilityImprovement === true;
  let decision = 'v2_not_justified_yet';
  if (skipRate < 0.05 && attenuateRate < 0.1 && !atLeastOneImprovement) {
    decision = 'hold_v1';
  } else if ((skipRate >= 0.05 || attenuateRate >= 0.15) && atLeastOneImprovement) {
    decision = 'consider_v2';
  }

  return {
    week: toIsoWeek(now),
    generatedAt: now.toISOString(),
    windowDays: days,
    skipRate,
    attenuateRate,
    eventsConsidered: nGuard,
    topP7Alerts,
    governorImprovement,
    policyStabilityImprovement,
    decision,
    sources: {
      p7GuardEvents: path.join(governanceDir, 'p7_guard_events.log'),
      p7Alerts: path.join(governanceDir, 'p7_alerts.log'),
      governorAlerts: path.join(governanceDir, 'governor_alerts.log'),
      policyAlerts: path.join(governanceDir, 'policy_alerts.log'),
    },
  };
}

function main() {
  const args = parseArgs(process.argv);
  const summary = buildSummary({ dataRoot: args.dataRoot, days: args.days });
  const root = args.dataRoot || dataRoot.getDataRoot();
  const defaultOut = path.join(root, 'governance', 'p7_guard_weekly_summary.json');
  const outPath = args.outPath || defaultOut;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`p7GuardWeeklySummary written: ${outPath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('p7GuardWeeklySummary failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = {
  buildSummary,
};

