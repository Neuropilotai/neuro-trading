#!/usr/bin/env node
'use strict';

/**
 * Smoke: P5 metrics — healthy paths + anomalies (incl. malformed line / schema fields).
 * Run from neuropilot_trading_v2: node engine/observability/smokeP5Metrics.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const dataRoot = require('../dataRoot');
const p5 = require('./p5Metrics');

const OK_LINE =
  '[P5 cycle] currentCycleId=expA lastCompletedCycleId=c1 miniCycleId_prior=c1 chainAssert=ok';
const SKIP_LINE =
  '[P5 cycle] currentCycleId=expA lastCompletedCycleId=c1 miniCycleId_prior=n/a chainAssert=skipped_legacy_mini';
const MISMATCH_LINE =
  '[P5 cycle] currentCycleId=expA lastCompletedCycleId=c1 miniCycleId_prior=c2 chainAssert=mismatch_will_throw';

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

function ok(msg) {
  console.log('OK:', msg);
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p5met-'));
}

function writeEvents(root, lines) {
  const g = path.join(root, 'governance');
  fs.mkdirSync(g, { recursive: true });
  const p = path.join(g, 'p5_cycle_events.log');
  const body = lines.map((l) => `2026-01-01T00:00:00.000Z ${l}`).join('\n');
  fs.writeFileSync(p, body + (body ? '\n' : ''), 'utf8');
  return p;
}

function readAlerts(root) {
  const p = path.join(root, 'governance', 'p5_alerts.log');
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

function withTmp(name, fn) {
  const prev = process.env.NEUROPILOT_DATA_ROOT;
  dataRoot.resetDataRoot();
  const tmp = mkTmp();
  process.env.NEUROPILOT_DATA_ROOT = tmp;
  dataRoot.resetDataRoot();
  try {
    fn(tmp);
    ok(name);
  } catch (e) {
    console.error(e);
    fail(`${name}: ${e && e.message ? e.message : e}`);
  } finally {
    process.env.NEUROPILOT_DATA_ROOT = prev;
    dataRoot.resetDataRoot();
  }
}

withTmp('case1_all_ok — metrics ok, no alerts', (tmp) => {
  writeEvents(tmp, [OK_LINE, OK_LINE]);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = p5.refreshP5Metrics({ dataRoot: tmp });
  if (r.payload.okCount !== 2) fail('okCount expected 2');
  if (r.payload.mismatchCount !== 0) fail('mismatchCount');
  if (r.payload.p5MetricsSchemaVersion !== p5.P5_METRICS_SCHEMA_VERSION) fail('schema version');
  if (r.payload.lastAlertReason != null) fail('lastAlertReason should be null when healthy');
  if (readAlerts(tmp).trim()) fail(`unexpected alerts: ${readAlerts(tmp)}`);
  const h = p5.p5HealthFromPayload(r.payload);
  if (h.lastStatus !== 'ok' || h.cycleAlignment !== 'aligned') fail(JSON.stringify(h));
});

withTmp('case2_skipped_legacy — no alerts', (tmp) => {
  writeEvents(tmp, [SKIP_LINE]);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = p5.refreshP5Metrics({ dataRoot: tmp });
  if (r.payload.skipCount !== 1) fail('skipCount');
  if (readAlerts(tmp).trim()) fail('alerts on skip');
});

withTmp('case3_mismatch — chain_mismatch alert + ids', (tmp) => {
  writeEvents(tmp, [MISMATCH_LINE]);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = p5.refreshP5Metrics({ dataRoot: tmp });
  if (r.payload.lastAlertReason !== 'chain_mismatch') fail('lastAlertReason');
  if (r.payload.lastMismatchAt !== '2026-01-01T00:00:00.000Z') fail('lastMismatchAt');
  const alerts = readAlerts(tmp);
  if (!alerts.includes('reason=chain_mismatch')) fail('missing chain_mismatch');
  if (!alerts.includes('miniCycleId_prior=c2')) fail('expected mini id in alert');
});

withTmp('case4_no_p5_events + expectEvents — warning', (tmp) => {
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'discovery', 'mutation_policy.json'), '{}', 'utf8');
  fs.mkdirSync(path.join(tmp, 'governance'), { recursive: true });
  const r = p5.refreshP5Metrics({ dataRoot: tmp, expectEvents: true });
  if (r.payload.lastAlertReason !== 'no_p5_cycle_events') fail('lastAlertReason no_p5');
  const alerts = readAlerts(tmp);
  if (!alerts.includes('no_p5_cycle_events')) fail('expected no_p5_cycle_events');
});

withTmp('case5_malformed_line — parse_errors + lastParseErrorAt', (tmp) => {
  const g = path.join(tmp, 'governance');
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(
    path.join(g, 'p5_cycle_events.log'),
    '2026-06-15T12:00:00.000Z [P5 cycle] this is not a valid line\n',
    'utf8'
  );
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = p5.refreshP5Metrics({ dataRoot: tmp });
  if (r.payload.parseErrorCount !== 1) fail('parseErrorCount');
  if (r.payload.lastParseErrorAt !== '2026-06-15T12:00:00.000Z') fail('lastParseErrorAt');
  if (r.payload.lastAlertReason !== 'parse_errors') fail('lastAlertReason parse');
  const alerts = readAlerts(tmp);
  if (!alerts.includes('reason=parse_errors')) fail('parse alert');
});

console.log('smokeP5Metrics: all passed');
