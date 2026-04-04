'use strict';

/**
 * P7 Health Guard usage metrics — parse `[P7 guard]` lines → `governance/p7_guard_metrics.json`.
 * Contract: P7_GUARD_METRICS_SCHEMA.md
 *
 * Events: `adaptMutationPolicy.js` via `appendP7GuardEvent` (ISO prefix, same pattern as P5/P7 metrics).
 * Refresh: `buildGovernanceDashboard.js` / CLI.
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');

const P7_GUARD_METRICS_SCHEMA_VERSION = '1.0.0';

/** Max parsed events used for counts / rates (most recent). */
const DEFAULT_EVENTS_WINDOW = 200;

const PREFIX_TS_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s+(\[P7 guard\].*)$/;

const VALID_ACTIONS = new Set(['normal', 'attenuate', 'skip']);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolveGovernanceDir(opts = {}) {
  if (opts.governanceDir) return path.resolve(opts.governanceDir);
  if (opts.dataRoot) return path.join(path.resolve(opts.dataRoot), 'governance');
  return dataRoot.getPath('governance');
}

function eventsLogPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'p7_guard_events.log');
}

function metricsPath(opts) {
  return path.join(resolveGovernanceDir(opts || {}), 'p7_guard_metrics.json');
}

function isGuardEnabledInEnv() {
  return String(process.env.NEUROPILOT_ENABLE_P7_HEALTH_GUARD || '').toLowerCase() === 'true';
}

/**
 * Append one guard audit line (no timestamp in `line`; file line gets ISO prefix).
 * @param {string} line Must start with `[P7 guard]`
 * @param {object} [opts] Optional `{ governanceDir }` or `{ dataRoot }` (defaults to `dataRoot` module).
 */
function appendP7GuardEvent(line, opts = {}) {
  if (!line || typeof line !== 'string' || !line.startsWith('[P7 guard]')) return;
  const governanceDir = resolveGovernanceDir(opts);
  ensureDir(governanceDir);
  const p = eventsLogPath(opts);
  fs.appendFileSync(p, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Parse optional `YYYY-MM-DDTHH:mm:ss.sssZ [P7 guard] ...`
 * @returns {{ ts: string|null, body: string }|null}
 */
function splitTimestampPrefix(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(PREFIX_TS_RE);
  if (m) return { ts: m[1], body: m[2] };
  if (s.startsWith('[P7 guard]')) return { ts: null, body: s };
  return null;
}

/**
 * Tolerant key=value parser after `[P7 guard]`.
 * @returns {{ enabled: boolean, p7Alert: string, action: string, factor: number }|null}
 */
function parseP7GuardBody(body) {
  if (!body || typeof body !== 'string' || !body.startsWith('[P7 guard]')) return null;
  const rest = body.slice('[P7 guard]'.length).trim();
  const kv = {};
  for (const part of rest.split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k) kv[k] = v;
  }
  if (kv.enabled !== 'true' && kv.enabled !== 'false') return null;
  const action = kv.action;
  if (!VALID_ACTIONS.has(action)) return null;
  const factor = Number(kv.factor);
  if (!Number.isFinite(factor)) return null;
  const p7Alert = kv.p7Alert != null && kv.p7Alert !== '' ? String(kv.p7Alert) : 'none';
  return {
    enabled: kv.enabled === 'true',
    p7Alert,
    action,
    factor,
  };
}

function parseP7GuardLine(raw) {
  const sp = splitTimestampPrefix(raw);
  if (!sp) return null;
  const fields = parseP7GuardBody(sp.body);
  if (!fields) return null;
  return { ts: sp.ts, ...fields };
}

function round4(x) {
  return Math.round(Number(x || 0) * 10000) / 10000;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataRoot]
 * @param {string} [opts.governanceDir]
 * @param {number} [opts.eventsWindow]
 */
function refreshP7GuardMetrics(opts = {}) {
  const governanceDir = resolveGovernanceDir(opts);
  ensureDir(governanceDir);
  const eventsFile = opts.eventsFile || eventsLogPath(opts);
  const outPath = opts.metricsOutPath || metricsPath(opts);

  const windowSize = Math.max(
    1,
    Math.min(5000, Number(opts.eventsWindow) || DEFAULT_EVENTS_WINDOW)
  );

  const lines = readLines(eventsFile);
  const parsed = [];
  for (const line of lines) {
    const row = parseP7GuardLine(line);
    if (row) parsed.push(row);
  }

  const windowRows = parsed.slice(-windowSize);
  const counts = { normal: 0, attenuate: 0, skip: 0 };
  for (const r of windowRows) {
    if (r.action === 'normal') counts.normal += 1;
    else if (r.action === 'attenuate') counts.attenuate += 1;
    else if (r.action === 'skip') counts.skip += 1;
  }

  const n = windowRows.length;
  const attenuateRate = n ? round4(counts.attenuate / n) : 0;
  const skipRate = n ? round4(counts.skip / n) : 0;

  const last = parsed.length ? parsed[parsed.length - 1] : null;
  const generatedAt = new Date().toISOString();
  const enabled = isGuardEnabledInEnv();

  const lastAlert = last == null ? null : last.p7Alert !== 'none' ? last.p7Alert : null;

  const payload = {
    p7GuardMetricsSchemaVersion: P7_GUARD_METRICS_SCHEMA_VERSION,
    generatedAt,
    enabled,
    lastAction: last ? last.action : null,
    lastAlert,
    counts,
    attenuateRate,
    skipRate,
    eventsConsidered: n,
    eventsWindow: windowSize,
    source: path.resolve(eventsFile),
  };

  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  return { payload, metricsPath: outPath, governanceDir };
}

if (require.main === module) {
  try {
    const rootArg = process.argv[2];
    const r = refreshP7GuardMetrics(rootArg ? { dataRoot: path.resolve(rootArg) } : {});
    console.log('p7_guard_metrics refreshed:', r.metricsPath);
  } catch (e) {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  }
}

module.exports = {
  P7_GUARD_METRICS_SCHEMA_VERSION,
  DEFAULT_EVENTS_WINDOW,
  appendP7GuardEvent,
  parseP7GuardLine,
  refreshP7GuardMetrics,
  eventsLogPath,
  metricsPath,
  resolveGovernanceDir,
};
