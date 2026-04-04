'use strict';

/**
 * Governor decisions metrics — parse `[Governor metrics]` lines, write governor_metrics.json,
 * append governor_alerts.log on anomalies only.
 *
 * Contract: GOVERNOR_METRICS_SCHEMA.md
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');

const GOVERNOR_METRICS_SCHEMA_VERSION = '1.0.0';

const KNOWN_DECISIONS = new Set(['OK', 'DEGRADED', 'BLOCKED']);
const KNOWN_MODES = new Set(['healthy', 'degraded', 'blocked']);
const KNOWN_POLICY_SOURCES = new Set(['trend', 'mutation', 'baseline']);

const FLAP_WINDOW = 5;
const FLAP_MIN_TRANSITIONS = 3;

const LINE_RE =
  /^\[Governor metrics\] cycleId=(\S+)\s+decision=(\S+)\s+mode=(\S+)\s+reason=(\S+)\s+policySource=(\S+)\s+riskState=(\S+)$/;
const PREFIX_TS_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s+(\[Governor metrics\].*)$/;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolveGovernanceDir(opts = {}) {
  if (opts.governanceDir) return path.resolve(opts.governanceDir);
  if (opts.dataRoot) return path.join(path.resolve(opts.dataRoot), 'governance');
  return dataRoot.getPath('governance');
}

function eventsLogPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'governor_metrics_events.log');
}

function metricsPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'governor_metrics.json');
}

function alertsLogPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'governor_alerts.log');
}

function appendGovernorMetricsEvent(line) {
  if (!line || typeof line !== 'string' || !line.startsWith('[Governor metrics]')) return;
  const governanceDir = dataRoot.getPath('governance');
  ensureDir(governanceDir);
  fs.appendFileSync(eventsLogPath(), `${new Date().toISOString()} ${line}\n`, 'utf8');
}

function parseGovernorMetricsLine(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: 'empty' };
  let ts = null;
  let body = s;
  const pm = s.match(PREFIX_TS_RE);
  if (pm) {
    ts = pm[1];
    body = pm[2];
  }
  const m = body.match(LINE_RE);
  if (!m) return { error: 'malformed', ts, raw: s };

  const cycleId = m[1];
  const decision = String(m[2]).toUpperCase();
  const mode = String(m[3]);
  const reason = String(m[4]);
  const policySource = String(m[5]);
  const riskState = String(m[6]);

  const reasonMissing = reason === 'n/a';
  const invalidDecision = !KNOWN_DECISIONS.has(decision);
  const invalidMode = !KNOWN_MODES.has(mode);
  const invalidPolicySource = !KNOWN_POLICY_SOURCES.has(policySource);
  const invalidRiskState = !KNOWN_MODES.has(riskState);
  const riskStateMismatch = riskState !== mode;

  return {
    cycleId,
    decision,
    mode,
    reason,
    policySource,
    riskState,
    ts,
    reasonMissing,
    invalidDecision,
    invalidMode,
    invalidPolicySource,
    invalidRiskState,
    riskStateMismatch,
  };
}

function countTransitions(windowRows) {
  let t = 0;
  for (let i = 1; i < windowRows.length; i += 1) {
    if (windowRows[i].decision !== windowRows[i - 1].decision) t += 1;
  }
  return t;
}

function computeFromParsedRows(rows) {
  const totalLines = rows.length;
  let parseErrorCount = 0;
  let invalidDecisionRowCount = 0;
  let reasonMissingCount = 0;
  let last = null;
  let prev = null;
  let lastObserved = null;
  let lastParseErrorAt = null;

  const valid = [];
  for (const r of rows) {
    if (r.error) {
      parseErrorCount += 1;
      if (r.ts) lastParseErrorAt = r.ts;
      continue;
    }
    valid.push(r);
    prev = last;
    last = r;
    if (r.ts) lastObserved = r.ts;
    if (r.reasonMissing) reasonMissingCount += 1;
    if (r.invalidDecision || r.invalidMode || r.invalidPolicySource || r.invalidRiskState || r.riskStateMismatch) {
      invalidDecisionRowCount += 1;
    }
  }

  const decisionChangeDetected = !!(last && prev && last.decision !== prev.decision);

  const windowRows = valid.slice(-FLAP_WINDOW);
  const decisionFlapDetected =
    windowRows.length >= FLAP_WINDOW && countTransitions(windowRows) >= FLAP_MIN_TRANSITIONS;

  return {
    totalLines,
    parseErrorCount,
    invalidDecisionRowCount,
    reasonMissingCount,
    decisionFlapDetected,
    decisionChangeDetected,
    lastCycleId: last ? last.cycleId : null,
    lastDecision: last ? last.decision : null,
    lastMode: last ? last.mode : null,
    lastReason: last ? last.reason : null,
    lastPolicySource: last ? last.policySource : null,
    lastRiskState: last ? last.riskState : null,
    lastObserved: lastObserved || new Date().toISOString(),
    lastParseErrorAt,
  };
}

function appendAlert(parts, governanceDir) {
  const p = path.join(governanceDir, 'governor_alerts.log');
  ensureDir(path.dirname(p));
  const tail = Object.keys(parts)
    .filter((k) => k !== 'ts' && k !== 'severity' && k !== 'reason')
    .filter((k) => parts[k] != null && String(parts[k]) !== '')
    .map((k) => `${k}=${parts[k]}`)
    .join(' ');
  const line = `[Governor alert] ts=${parts.ts} severity=${parts.severity} reason=${parts.reason}${tail ? ` ${tail}` : ''}`;
  fs.appendFileSync(p, `${line}\n`, 'utf8');
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function refreshGovernorMetrics(opts = {}) {
  const governanceDir = resolveGovernanceDir(opts);
  ensureDir(governanceDir);
  const eventsFile = opts.eventsFile || eventsLogPath(opts);
  const rows = readLines(eventsFile).map((l) => parseGovernorMetricsLine(l));
  const agg = computeFromParsedRows(rows);

  const discoveryDirResolved =
    opts.discoveryDir ||
    (opts.dataRoot ? path.join(path.resolve(opts.dataRoot), 'discovery') : dataRoot.getPath('discovery'));
  const govPath = opts.portfolioGovernorPath || path.join(discoveryDirResolved, 'portfolio_governor.json');
  const governorExists = fs.existsSync(govPath);

  const wantEmptyAlert =
    opts.expectEvents === true || String(process.env.NEUROPILOT_GOVERNOR_METRICS_EXPECT_EVENTS || '') === 'true';
  const noEvents = wantEmptyAlert && governorExists && agg.totalLines === 0;

  const lastAlertReason =
    agg.invalidDecisionRowCount > 0
      ? 'invalid_decision'
      : agg.reasonMissingCount > 0
        ? 'reason_missing'
        : agg.decisionFlapDetected
          ? 'decision_flap'
          : agg.parseErrorCount > 0
            ? 'parse_errors'
            : noEvents
              ? 'no_governor_metrics_events'
              : null;

  const generatedAt = new Date().toISOString();
  const payload = {
    governorMetricsSchemaVersion: GOVERNOR_METRICS_SCHEMA_VERSION,
    generatedAt,
    source: path.resolve(eventsFile),
    ...agg,
    lastAlertReason,
  };

  const outPath = opts.metricsOutPath || metricsPath(opts);
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  const ts = generatedAt;
  if (agg.parseErrorCount > 0) {
    appendAlert(
      { ts, severity: 'error', reason: 'parse_errors', parseErrorCount: String(agg.parseErrorCount) },
      governanceDir
    );
  }
  if (agg.invalidDecisionRowCount > 0) {
    appendAlert(
      {
        ts,
        severity: 'error',
        reason: 'invalid_decision',
        invalidDecisionRowCount: String(agg.invalidDecisionRowCount),
        lastDecision: agg.lastDecision || '',
        lastMode: agg.lastMode || '',
      },
      governanceDir
    );
  }
  if (agg.reasonMissingCount > 0) {
    appendAlert(
      { ts, severity: 'warning', reason: 'reason_missing', reasonMissingCount: String(agg.reasonMissingCount) },
      governanceDir
    );
  }
  if (agg.decisionFlapDetected) {
    appendAlert({ ts, severity: 'warning', reason: 'decision_flap', window: String(FLAP_WINDOW) }, governanceDir);
  }
  if (noEvents) {
    appendAlert(
      {
        ts,
        severity: 'warning',
        reason: 'no_governor_metrics_events',
        hint: 'portfolio_governor_present_but_no_events',
      },
      governanceDir
    );
  }

  return { payload, metricsPath: outPath, governanceDir };
}

function governorHealthFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    governorMetricsSchemaVersion: payload.governorMetricsSchemaVersion,
    lastDecision: payload.lastDecision,
    lastReason: payload.lastReason,
    lastMode: payload.lastMode,
    policySource: payload.lastPolicySource,
    decisionChangeDetected: payload.decisionChangeDetected,
    lastAlertReason: payload.lastAlertReason,
    lastObserved: payload.lastObserved,
    lastParseErrorAt: payload.lastParseErrorAt,
  };
}

module.exports = {
  GOVERNOR_METRICS_SCHEMA_VERSION,
  appendGovernorMetricsEvent,
  parseGovernorMetricsLine,
  computeFromParsedRows,
  refreshGovernorMetrics,
  governorHealthFromPayload,
  resolveGovernanceDir,
  eventsLogPath,
  metricsPath,
  alertsLogPath,
};
