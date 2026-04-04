'use strict';

/**
 * P5 cycle metrics — parse [P5 cycle] audit lines, write p5_metrics.json, append p5_alerts.log on anomalies only.
 *
 * Schema contract: see P5_METRICS_SCHEMA.md — bump `p5MetricsSchemaVersion` on breaking / structural changes.
 *
 * Events append: adaptMutationPolicy (see appendP5CycleEvent).
 * Refresh: buildGovernanceDashboard / CLI.
 *
 * CLI:
 *   node engine/observability/p5Metrics.js
 *   node engine/observability/p5Metrics.js /path/to/events.log
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');

/** Semver for p5_metrics.json; document changes in P5_METRICS_SCHEMA.md */
const P5_METRICS_SCHEMA_VERSION = '1.1.0';

const KNOWN_ASSERT = new Set([
  'ok',
  'mismatch_will_throw',
  'skipped_no_seal',
  'skipped_legacy_mini',
]);

const LINE_RE =
  /^\[P5 cycle\] currentCycleId=(\S+)\s+lastCompletedCycleId=(\S+)\s+miniCycleId_prior=(\S+)\s+chainAssert=(\S+)$/;

const PREFIX_TS_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s+(\[P5 cycle\].*)$/;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolveGovernanceDir(opts = {}) {
  if (opts.governanceDir) return path.resolve(opts.governanceDir);
  if (opts.dataRoot) return path.join(path.resolve(opts.dataRoot), 'governance');
  return dataRoot.getPath('governance');
}

function eventsLogPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'p5_cycle_events.log');
}

function metricsPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'p5_metrics.json');
}

function alertsLogPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'p5_alerts.log');
}

/**
 * Append one raw [P5 cycle] line (no timestamp) — timestamp added here for lastObserved.
 */
function appendP5CycleEvent(line) {
  if (!line || typeof line !== 'string' || !line.startsWith('[P5 cycle]')) return;
  const dir = dataRoot.getPath('governance');
  ensureDir(dir);
  const ts = new Date().toISOString();
  fs.appendFileSync(eventsLogPath(), `${ts} ${line}\n`, 'utf8');
}

function parseP5CycleLine(raw) {
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
  if (!m) return { error: 'malformed', raw: s, ts };
  const currentCycleId = m[1];
  const lastCompletedCycleId = m[2];
  const miniCycleId_prior = m[3];
  const chainAssert = m[4];
  if (!KNOWN_ASSERT.has(chainAssert)) {
    return {
      error: 'unknown_assert',
      raw: s,
      currentCycleId,
      lastCompletedCycleId,
      miniCycleId_prior,
      chainAssert,
      ts,
    };
  }
  return {
    currentCycleId,
    lastCompletedCycleId,
    miniCycleId_prior,
    chainAssert,
    ts,
  };
}

function lagStateForRow(row) {
  if (!row || row.error) return 'unknown';
  const seal = row.lastCompletedCycleId;
  const mini = row.miniCycleId_prior;
  if (seal === 'n/a' || mini === 'n/a' || !seal || !mini) return 'unknown';
  if (mini === seal) return 'aligned';
  return 'mismatch';
}

function computeFromParsedRows(rows) {
  const totalLines = rows.length;
  let parseErrorCount = 0;
  let okCount = 0;
  let skipCount = 0;
  let mismatchCount = 0;
  let unexpectedAssertCount = 0;
  let last = null;
  let lastTs = null;
  let lastMismatchRow = null;
  let lastParseErrorAt = null;

  for (const r of rows) {
    if (r.error) {
      parseErrorCount += 1;
      if (r.chainAssert && !KNOWN_ASSERT.has(r.chainAssert)) unexpectedAssertCount += 1;
      if (r.ts) lastParseErrorAt = r.ts;
      continue;
    }
    last = r;
    if (r.ts) lastTs = r.ts;
    if (r.chainAssert === 'ok') okCount += 1;
    else if (r.chainAssert === 'mismatch_will_throw') {
      mismatchCount += 1;
      lastMismatchRow = r;
    } else if (String(r.chainAssert || '').startsWith('skipped_')) skipCount += 1;
  }

  const denom = Math.max(1, totalLines - parseErrorCount);
  const okRate = okCount / denom;
  const skipRate = skipCount / denom;

  const lastStatus = last && !last.error ? last.chainAssert : null;
  const cycleAlignment = last ? lagStateForRow(last) : 'unknown';
  const lastObserved = lastTs || new Date().toISOString();

  return {
    totalLines,
    parseErrorCount,
    okCount,
    skipCount,
    mismatchCount,
    unexpectedAssertCount,
    okRate,
    skipRate,
    lastStatus,
    cycleAlignment,
    lastObserved,
    lastParsed: last,
    lastMismatchRow,
    lastParseErrorAt,
  };
}

function readEventLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

function appendAlert(parts, governanceDir) {
  const dir = path.dirname(path.join(governanceDir, 'p5_alerts.log'));
  ensureDir(dir);
  const keys = Object.keys(parts);
  const tail = keys
    .filter((k) => k !== 'ts' && k !== 'severity' && k !== 'reason')
    .filter((k) => parts[k] != null && String(parts[k]) !== '')
    .map((k) => `${k}=${parts[k]}`)
    .join(' ');
  const line = `[P5 alert] ts=${parts.ts} severity=${parts.severity} reason=${parts.reason}${tail ? ` ${tail}` : ''}`;
  fs.appendFileSync(path.join(governanceDir, 'p5_alerts.log'), `${line}\n`, 'utf8');
}

/**
 * @param {object} [opts]
 * @param {string} [opts.eventsFile]
 * @param {boolean} [opts.expectEvents] — if true and zero parsed P5 lines, one warning alert
 * @param {boolean} [opts.expectMutationPolicy] — if true and mutation_policy.json exists, used with expectEvents
 */
function refreshP5Metrics(opts = {}) {
  const governanceDir = resolveGovernanceDir(opts);
  ensureDir(governanceDir);
  const eventsFile = opts.eventsFile || path.join(governanceDir, 'p5_cycle_events.log');
  const lines = readEventLines(eventsFile);
  const rows = lines.map((l) => parseP5CycleLine(l));
  const agg = computeFromParsedRows(rows);

  const discoveryDirResolved =
    opts.discoveryDir ||
    (opts.dataRoot ? path.join(path.resolve(opts.dataRoot), 'discovery') : dataRoot.getPath('discovery'));
  const mpPath = opts.mutationPolicyPath || path.join(discoveryDirResolved, 'mutation_policy.json');
  const policyExists = fs.existsSync(mpPath);

  const wantEmptyAlert =
    opts.expectEvents === true || String(process.env.NEUROPILOT_P5_METRICS_EXPECT_EVENTS || '') === 'true';
  const noP5Emitted = wantEmptyAlert && policyExists && agg.totalLines === 0;

  const lastMismatchAt =
    agg.lastMismatchRow && agg.lastMismatchRow.ts ? agg.lastMismatchRow.ts : null;
  const lastParseErrorAt = agg.lastParseErrorAt || null;
  const lastAlertReason =
    agg.mismatchCount > 0
      ? 'chain_mismatch'
      : agg.parseErrorCount > 0
        ? 'parse_errors'
        : noP5Emitted
          ? 'no_p5_cycle_events'
          : null;

  const generatedAt = new Date().toISOString();
  const payload = {
    p5MetricsSchemaVersion: P5_METRICS_SCHEMA_VERSION,
    generatedAt,
    source: path.resolve(eventsFile),
    ...agg,
    okRate: round4(agg.okRate),
    skipRate: round4(agg.skipRate),
    lastMismatchAt,
    lastParseErrorAt,
    lastAlertReason,
  };
  delete payload.lastParsed;
  delete payload.lastMismatchRow;

  const outPath = opts.metricsOutPath || path.join(governanceDir, 'p5_metrics.json');
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  const ts = generatedAt;
  if (agg.parseErrorCount > 0) {
    const row = {
      ts,
      severity: 'error',
      reason: 'parse_errors',
      parseErrorCount: String(agg.parseErrorCount),
      totalLines: String(agg.totalLines),
    };
    if (agg.unexpectedAssertCount > 0) {
      row.unexpectedAssertCount = String(agg.unexpectedAssertCount);
    }
    appendAlert(row, governanceDir);
  }
  if (agg.mismatchCount > 0) {
    const mm = agg.lastMismatchRow;
    appendAlert(
      {
        ts,
        severity: 'error',
        reason: 'chain_mismatch',
        mismatchCount: String(agg.mismatchCount),
        currentCycleId: mm ? mm.currentCycleId : '',
        lastCompletedCycleId: mm ? mm.lastCompletedCycleId : '',
        miniCycleId_prior: mm ? mm.miniCycleId_prior : '',
      },
      governanceDir
    );
  }
  if (noP5Emitted) {
    appendAlert(
      {
        ts,
        severity: 'warning',
        reason: 'no_p5_cycle_events',
        hint: 'mutation_policy_present_but_no_p5_cycle_lines',
      },
      governanceDir
    );
  }

  return { payload, agg, metricsPath: outPath, governanceDir };
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function p5HealthFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    p5MetricsSchemaVersion: payload.p5MetricsSchemaVersion,
    lastStatus: payload.lastStatus,
    okRate: payload.okRate,
    skipRate: payload.skipRate,
    mismatchCount: payload.mismatchCount,
    lastObserved: payload.lastObserved,
    cycleAlignment: payload.cycleAlignment,
    lastAlertReason: payload.lastAlertReason,
    lastMismatchAt: payload.lastMismatchAt,
    lastParseErrorAt: payload.lastParseErrorAt,
  };
}

function loadP5MetricsJson(opts) {
  const p = metricsPath(opts);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

if (require.main === module) {
  const arg = process.argv[2];
  const r = refreshP5Metrics(arg ? { eventsFile: path.resolve(arg) } : {});
  console.log('p5_metrics written:', r.metricsPath);
  console.log(JSON.stringify(r.payload, null, 2));
}

module.exports = {
  P5_METRICS_SCHEMA_VERSION,
  parseP5CycleLine,
  lagStateForRow,
  computeFromParsedRows,
  refreshP5Metrics,
  appendP5CycleEvent,
  p5HealthFromPayload,
  loadP5MetricsJson,
  resolveGovernanceDir,
  eventsLogPath,
  metricsPath,
  alertsLogPath,
};
