'use strict';

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');

const POLICY_METRICS_SCHEMA_VERSION = '1.0.0';
const KNOWN_SOURCES = new Set(['trend', 'fallback']);
const DRIFT_JUMP_THRESHOLD = 0.2;
const FALLBACK_FREQ_WINDOW = 10;
const FALLBACK_FREQ_MIN_ROWS = 5;
const FALLBACK_FREQ_THRESHOLD = 0.7;

const LINE_RE =
  /^\[Policy metrics\] cycleId=(\S+)\s+explorationWeight=(\S+)\s+exploitationWeight=(\S+)\s+diversity=(\S+)\s+source=(\S+)$/;
const PREFIX_TS_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s+(\[Policy metrics\].*)$/;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolveGovernanceDir(opts = {}) {
  if (opts.governanceDir) return path.resolve(opts.governanceDir);
  if (opts.dataRoot) return path.join(path.resolve(opts.dataRoot), 'governance');
  return dataRoot.getPath('governance');
}

function eventsLogPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'policy_metrics_events.log');
}

function metricsPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'policy_metrics.json');
}

function alertsLogPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'policy_alerts.log');
}

function appendPolicyMetricsEvent(line) {
  if (!line || typeof line !== 'string' || !line.startsWith('[Policy metrics]')) return;
  const governanceDir = dataRoot.getPath('governance');
  ensureDir(governanceDir);
  fs.appendFileSync(eventsLogPath(), `${new Date().toISOString()} ${line}\n`, 'utf8');
}

function parsePolicyMetricsLine(raw) {
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
  const explorationWeight = Number(m[2]);
  const exploitationWeight = Number(m[3]);
  const diversity = Number(m[4]);
  const source = m[5];

  if (!Number.isFinite(explorationWeight) || !Number.isFinite(exploitationWeight) || !Number.isFinite(diversity)) {
    return { error: 'malformed_numeric', ts, raw: s };
  }
  if (!KNOWN_SOURCES.has(source)) {
    return { error: 'unknown_source', ts, raw: s, cycleId, explorationWeight, exploitationWeight, diversity, source };
  }

  const sum = explorationWeight + exploitationWeight;
  const invalidWeights =
    explorationWeight < 0 ||
    explorationWeight > 1 ||
    exploitationWeight < 0 ||
    exploitationWeight > 1 ||
    Math.abs(sum - 1) > 0.0001;
  const invalidDiversity = diversity < 0 || diversity > 1;

  return {
    cycleId,
    explorationWeight,
    exploitationWeight,
    diversity,
    source,
    ts,
    invalidWeights,
    invalidDiversity,
  };
}

function computeFromParsedRows(rows) {
  const totalLines = rows.length;
  let parseErrorCount = 0;
  let invalidWeightsCount = 0;
  let invalidDiversityCount = 0;
  let unknownSourceCount = 0;
  let trendCount = 0;
  let fallbackCount = 0;
  let last = null;
  let lastObserved = null;
  let lastParseErrorAt = null;

  const valid = [];
  for (const r of rows) {
    if (r.error) {
      parseErrorCount += 1;
      if (r.error === 'unknown_source') unknownSourceCount += 1;
      if (r.ts) lastParseErrorAt = r.ts;
      continue;
    }
    valid.push(r);
    last = r;
    if (r.ts) lastObserved = r.ts;
    if (r.invalidWeights) invalidWeightsCount += 1;
    if (r.invalidDiversity) invalidDiversityCount += 1;
    if (r.source === 'trend') trendCount += 1;
    if (r.source === 'fallback') fallbackCount += 1;
  }

  const prev = valid.length >= 2 ? valid[valid.length - 2] : null;
  const driftDetected =
    !!(last && prev) &&
    (Math.abs(last.explorationWeight - prev.explorationWeight) > DRIFT_JUMP_THRESHOLD ||
      Math.abs(last.exploitationWeight - prev.exploitationWeight) > DRIFT_JUMP_THRESHOLD);

  const windowRows = valid.slice(-FALLBACK_FREQ_WINDOW);
  const fallbackRate =
    windowRows.length > 0 ? windowRows.filter((r) => r.source === 'fallback').length / windowRows.length : 0;
  const fallbackFrequent =
    windowRows.length >= FALLBACK_FREQ_MIN_ROWS && fallbackRate > FALLBACK_FREQ_THRESHOLD;

  return {
    totalLines,
    parseErrorCount,
    unknownSourceCount,
    invalidWeightsCount,
    invalidDiversityCount,
    trendCount,
    fallbackCount,
    driftDetected,
    fallbackRate,
    fallbackFrequent,
    lastStatus: last ? (last.invalidWeights || last.invalidDiversity ? 'invalid' : 'ok') : null,
    lastCycleId: last ? last.cycleId : null,
    lastExplorationWeight: last ? round4(last.explorationWeight) : null,
    lastExploitationWeight: last ? round4(last.exploitationWeight) : null,
    lastDiversity: last ? round4(last.diversity) : null,
    lastSource: last ? last.source : null,
    lastObserved: lastObserved || new Date().toISOString(),
    lastParseErrorAt,
  };
}

function appendAlert(parts, governanceDir) {
  const p = path.join(governanceDir, 'policy_alerts.log');
  ensureDir(path.dirname(p));
  const tail = Object.keys(parts)
    .filter((k) => k !== 'ts' && k !== 'severity' && k !== 'reason')
    .filter((k) => parts[k] != null && String(parts[k]) !== '')
    .map((k) => `${k}=${parts[k]}`)
    .join(' ');
  const line = `[Policy alert] ts=${parts.ts} severity=${parts.severity} reason=${parts.reason}${tail ? ` ${tail}` : ''}`;
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

function refreshPolicyMetrics(opts = {}) {
  const governanceDir = resolveGovernanceDir(opts);
  ensureDir(governanceDir);
  const eventsFile = opts.eventsFile || eventsLogPath(opts);
  const rows = readLines(eventsFile).map((l) => parsePolicyMetricsLine(l));
  const agg = computeFromParsedRows(rows);

  const discoveryDirResolved =
    opts.discoveryDir ||
    (opts.dataRoot ? path.join(path.resolve(opts.dataRoot), 'discovery') : dataRoot.getPath('discovery'));
  const mpPath = opts.mutationPolicyPath || path.join(discoveryDirResolved, 'mutation_policy.json');
  const policyExists = fs.existsSync(mpPath);
  const wantEmptyAlert =
    opts.expectEvents === true || String(process.env.NEUROPILOT_POLICY_METRICS_EXPECT_EVENTS || '') === 'true';
  const noEvents = wantEmptyAlert && policyExists && agg.totalLines === 0;

  const lastAlertReason =
    agg.invalidWeightsCount > 0 || agg.invalidDiversityCount > 0
      ? 'invalid_weights'
      : agg.driftDetected
        ? 'drift_jump'
        : agg.fallbackFrequent
          ? 'fallback_frequent'
          : agg.parseErrorCount > 0
            ? 'parse_errors'
            : noEvents
              ? 'no_policy_metrics_events'
              : null;

  const payload = {
    policyMetricsSchemaVersion: POLICY_METRICS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: path.resolve(eventsFile),
    ...agg,
    fallbackRate: round4(agg.fallbackRate),
    lastAlertReason,
  };

  const outPath = opts.metricsOutPath || metricsPath(opts);
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  const ts = payload.generatedAt;
  if (agg.parseErrorCount > 0) {
    appendAlert(
      { ts, severity: 'error', reason: 'parse_errors', parseErrorCount: String(agg.parseErrorCount) },
      governanceDir
    );
  }
  if (agg.invalidWeightsCount > 0 || agg.invalidDiversityCount > 0) {
    appendAlert(
      {
        ts,
        severity: 'error',
        reason: 'invalid_weights',
        invalidWeightsCount: String(agg.invalidWeightsCount),
        invalidDiversityCount: String(agg.invalidDiversityCount),
      },
      governanceDir
    );
  }
  if (agg.driftDetected) {
    appendAlert(
      {
        ts,
        severity: 'warning',
        reason: 'drift_jump',
        lastCycleId: agg.lastCycleId || '',
        lastExplorationWeight: agg.lastExplorationWeight == null ? '' : String(agg.lastExplorationWeight),
        lastExploitationWeight: agg.lastExploitationWeight == null ? '' : String(agg.lastExploitationWeight),
      },
      governanceDir
    );
  }
  if (agg.fallbackFrequent) {
    appendAlert(
      {
        ts,
        severity: 'warning',
        reason: 'fallback_frequent',
        fallbackRate: String(round4(agg.fallbackRate)),
      },
      governanceDir
    );
  }
  if (noEvents) {
    appendAlert(
      { ts, severity: 'warning', reason: 'no_policy_metrics_events', hint: 'mutation_policy_present_but_no_events' },
      governanceDir
    );
  }

  return { payload, metricsPath: outPath, governanceDir };
}

function policyHealthFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    policyMetricsSchemaVersion: payload.policyMetricsSchemaVersion,
    lastExplorationWeight: payload.lastExplorationWeight,
    lastExploitationWeight: payload.lastExploitationWeight,
    lastDiversity: payload.lastDiversity,
    source: payload.lastSource,
    driftDetected: payload.driftDetected,
    lastAlertReason: payload.lastAlertReason,
    lastObserved: payload.lastObserved,
    lastParseErrorAt: payload.lastParseErrorAt,
  };
}

function round4(x) {
  return Math.round(Number(x || 0) * 10000) / 10000;
}

module.exports = {
  POLICY_METRICS_SCHEMA_VERSION,
  appendPolicyMetricsEvent,
  parsePolicyMetricsLine,
  computeFromParsedRows,
  refreshPolicyMetrics,
  policyHealthFromPayload,
  resolveGovernanceDir,
  eventsLogPath,
  metricsPath,
  alertsLogPath,
};

