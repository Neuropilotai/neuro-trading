'use strict';

/**
 * P7 trend memory quality metrics — `[P7 metrics]` lines → p7_metrics.json, p7_alerts.log (anomaly-only).
 * Contract: P7_METRICS_SCHEMA.md
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');

const P7_METRICS_SCHEMA_VERSION = '1.0.0';

const LINE_RE =
  /^\[P7 metrics\] cycleId=(\S+)\s+producingCycleId=(\S+)\s+windowSize=(\d+)\s+reportsConsidered=(\d+)\s+reportsLoaded=(\d+)\s+applyCount=(\d+)\s+applyExpected=(0|1)\s+status=(ok|degraded|empty)\s+source=(archive|fallback|none)$/;
const PREFIX_TS_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s+(\[P7 metrics\].*)$/;

const LOW_COVERAGE_RATIO = 0.8;
const LOW_COVERAGE_MIN_CONSIDERED = 3;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolveGovernanceDir(opts = {}) {
  if (opts.governanceDir) return path.resolve(opts.governanceDir);
  if (opts.dataRoot) return path.join(path.resolve(opts.dataRoot), 'governance');
  return dataRoot.getPath('governance');
}

function eventsLogPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'p7_metrics_events.log');
}

function metricsPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'p7_metrics.json');
}

function alertsLogPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'p7_alerts.log');
}

/**
 * Build the canonical one-line audit string (no timestamp).
 */
function buildP7MetricsLogLine(o) {
  const cycleId = o.cycleId != null ? String(o.cycleId) : 'n/a';
  const producingCycleId = o.producingCycleId != null ? String(o.producingCycleId) : 'n/a';
  const windowSize = Math.max(0, Math.floor(Number(o.windowSize) || 0));
  const reportsConsidered = Math.max(0, Math.floor(Number(o.reportsConsidered) || 0));
  const reportsLoaded = Math.max(0, Math.floor(Number(o.reportsLoaded) || 0));
  const applyCount = Math.max(0, Math.floor(Number(o.applyCount) || 0));
  const applyExpected = o.applyExpected ? 1 : 0;
  const status = o.status === 'empty' || o.status === 'degraded' ? o.status : 'ok';
  let source = 'none';
  if (o.source === 'archive' || o.source === 'fallback' || o.source === 'none') source = o.source;
  return (
    `[P7 metrics] cycleId=${cycleId} producingCycleId=${producingCycleId} windowSize=${windowSize}` +
    ` reportsConsidered=${reportsConsidered} reportsLoaded=${reportsLoaded} applyCount=${applyCount}` +
    ` applyExpected=${applyExpected} status=${status} source=${source}`
  );
}

function appendP7MetricsEvent(line) {
  if (!line || typeof line !== 'string' || !line.startsWith('[P7 metrics]')) return;
  const governanceDir = dataRoot.getPath('governance');
  ensureDir(governanceDir);
  fs.appendFileSync(eventsLogPath(), `${new Date().toISOString()} ${line}\n`, 'utf8');
}

function parseP7MetricsLine(raw) {
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

  return {
    cycleId: m[1],
    producingCycleId: m[2],
    windowSize: Number(m[3]),
    reportsConsidered: Number(m[4]),
    reportsLoaded: Number(m[5]),
    applyCount: Number(m[6]),
    applyExpected: m[7] === '1' ? 1 : 0,
    status: m[8],
    source: m[9],
    ts,
    coverageRatio:
      Number(m[4]) > 0 ? Number(m[5]) / Number(m[4]) : Number(m[5]) > 0 ? 1 : 0,
  };
}

function computeFromParsedRows(rows) {
  const totalLines = rows.length;
  let parseErrorCount = 0;
  let last = null;
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
    last = r;
    if (r.ts) lastObserved = r.ts;
  }

  let degradedCount = 0;
  let emptyCount = 0;
  for (const r of valid) {
    if (r.status === 'degraded') degradedCount += 1;
    if (r.status === 'empty') emptyCount += 1;
  }
  const vlen = valid.length;
  const degradedRate = vlen ? round4(degradedCount / vlen) : 0;
  const emptyRate = vlen ? round4(emptyCount / vlen) : 0;

  const coverageRate =
    last && last.reportsConsidered > 0
      ? round4(last.reportsLoaded / last.reportsConsidered)
      : last && last.reportsLoaded > 0
        ? 1
        : 0;

  return {
    totalLines,
    parseErrorCount,
    degradedRate,
    emptyRate,
    lastCycleId: last ? last.cycleId : null,
    lastProducingCycleId: last ? last.producingCycleId : null,
    lastWindowSize: last ? last.windowSize : null,
    lastReportsConsidered: last ? last.reportsConsidered : null,
    lastReportsLoaded: last ? last.reportsLoaded : null,
    lastApplyCount: last ? last.applyCount : null,
    lastApplyExpected: last ? last.applyExpected : null,
    lastStatus: last ? last.status : null,
    lastSource: last ? last.source : null,
    coverageRate,
    lastObserved: lastObserved || new Date().toISOString(),
    lastParseErrorAt,
  };
}

function appendAlert(parts, governanceDir) {
  const p = path.join(governanceDir, 'p7_alerts.log');
  ensureDir(path.dirname(p));
  const tail = Object.keys(parts)
    .filter((k) => k !== 'ts' && k !== 'severity' && k !== 'reason')
    .filter((k) => parts[k] != null && String(parts[k]) !== '')
    .map((k) => `${k}=${parts[k]}`)
    .join(' ');
  const line = `[P7 alert] ts=${parts.ts} severity=${parts.severity} reason=${parts.reason}${tail ? ` ${tail}` : ''}`;
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

function refreshP7Metrics(opts = {}) {
  const governanceDir = resolveGovernanceDir(opts);
  ensureDir(governanceDir);
  const eventsFile = opts.eventsFile || eventsLogPath(opts);
  const rows = readLines(eventsFile).map((l) => parseP7MetricsLine(l));
  const agg = computeFromParsedRows(rows);

  const discoveryDirResolved =
    opts.discoveryDir ||
    (opts.dataRoot ? path.join(path.resolve(opts.dataRoot), 'discovery') : dataRoot.getPath('discovery'));
  const tmPath = opts.runTrendMemoryPath || path.join(discoveryDirResolved, 'run_trend_memory.json');
  const trendMemoryExists = fs.existsSync(tmPath);

  const wantEmptyAlert =
    opts.expectEvents === true || String(process.env.NEUROPILOT_P7_METRICS_EXPECT_EVENTS || '') === 'true';
  const noEvents = wantEmptyAlert && trendMemoryExists && agg.totalLines === 0;

  const last = rows.filter((r) => !r.error).pop();
  const emptyWindow = !!last && (last.status === 'empty' || last.reportsLoaded === 0);
  const lowCoverage =
    !!last &&
    !emptyWindow &&
    last.reportsConsidered >= LOW_COVERAGE_MIN_CONSIDERED &&
    last.reportsLoaded / last.reportsConsidered < LOW_COVERAGE_RATIO - 1e-9;
  const applyZeroUnexpected = !!last && last.applyExpected === 1 && last.applyCount === 0;

  const lastAlertReason =
    agg.parseErrorCount > 0
      ? 'parse_errors'
      : applyZeroUnexpected
        ? 'apply_zero_unexpected'
        : emptyWindow
          ? 'empty_window'
          : lowCoverage
            ? 'low_report_coverage'
            : noEvents
              ? 'no_p7_metrics_events'
              : null;

  const generatedAt = new Date().toISOString();
  const payload = {
    p7MetricsSchemaVersion: P7_METRICS_SCHEMA_VERSION,
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
  if (applyZeroUnexpected) {
    appendAlert(
      {
        ts,
        severity: 'error',
        reason: 'apply_zero_unexpected',
        cycleId: last.cycleId || '',
        applyExpected: '1',
        applyCount: String(last.applyCount),
      },
      governanceDir
    );
  }
  if (emptyWindow) {
    appendAlert(
      {
        ts,
        severity: 'warning',
        reason: 'empty_window',
        reportsLoaded: String(last.reportsLoaded),
        status: last.status || '',
      },
      governanceDir
    );
  }
  if (lowCoverage) {
    appendAlert(
      {
        ts,
        severity: 'warning',
        reason: 'low_report_coverage',
        reportsConsidered: String(last.reportsConsidered),
        reportsLoaded: String(last.reportsLoaded),
      },
      governanceDir
    );
  }
  if (noEvents) {
    appendAlert(
      {
        ts,
        severity: 'warning',
        reason: 'no_p7_metrics_events',
        hint: 'run_trend_memory_present_but_no_p7_metric_lines',
      },
      governanceDir
    );
  }

  return { payload, metricsPath: outPath, governanceDir };
}

function p7HealthFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    p7MetricsSchemaVersion: payload.p7MetricsSchemaVersion,
    lastStatus: payload.lastStatus,
    lastSource: payload.lastSource,
    lastWindowSize: payload.lastWindowSize,
    lastReportsConsidered: payload.lastReportsConsidered,
    lastReportsLoaded: payload.lastReportsLoaded,
    lastApplyCount: payload.lastApplyCount,
    coverageRate: payload.coverageRate,
    degradedRate: payload.degradedRate,
    emptyRate: payload.emptyRate,
    lastAlertReason: payload.lastAlertReason,
    lastObserved: payload.lastObserved,
    lastParseErrorAt: payload.lastParseErrorAt,
  };
}

function round4(x) {
  return Math.round(Number(x || 0) * 10000) / 10000;
}

module.exports = {
  P7_METRICS_SCHEMA_VERSION,
  buildP7MetricsLogLine,
  appendP7MetricsEvent,
  parseP7MetricsLine,
  computeFromParsedRows,
  refreshP7Metrics,
  p7HealthFromPayload,
  resolveGovernanceDir,
  eventsLogPath,
  metricsPath,
  alertsLogPath,
};
