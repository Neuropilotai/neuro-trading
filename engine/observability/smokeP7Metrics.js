#!/usr/bin/env node
'use strict';

/**
 * P7 metrics smoke — normal, low coverage, empty, malformed, no events + expect.
 * Run: node engine/observability/smokeP7Metrics.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataRoot = require('../dataRoot');
const p7 = require('./p7Metrics');

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

function ok(msg) {
  console.log('OK:', msg);
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p7met-'));
}

function writeEvents(root, lines) {
  const g = path.join(root, 'governance');
  fs.mkdirSync(g, { recursive: true });
  const body = lines.map((l) => `2026-01-01T00:00:00.000Z ${l}`).join('\n');
  fs.writeFileSync(path.join(g, 'p7_metrics_events.log'), body + (body ? '\n' : ''), 'utf8');
}

function readAlerts(root) {
  const p = path.join(root, 'governance', 'p7_alerts.log');
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

const LINE_OK =
  '[P7 metrics] cycleId=c1 producingCycleId=c1 windowSize=10 reportsConsidered=10 reportsLoaded=10 applyCount=2 applyExpected=0 status=ok source=archive';

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
    fail(`${name}: ${e && e.message ? e.message : e}`);
  } finally {
    process.env.NEUROPILOT_DATA_ROOT = prev;
    dataRoot.resetDataRoot();
  }
}

withTmp('case1_normal', (tmp) => {
  writeEvents(tmp, [LINE_OK, LINE_OK]);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = p7.refreshP7Metrics({ dataRoot: tmp });
  if (r.payload.lastAlertReason !== null) fail('expected healthy');
  if (readAlerts(tmp).trim()) fail('no alerts');
});

withTmp('case2_low_coverage', (tmp) => {
  writeEvents(tmp, [
    '[P7 metrics] cycleId=c1 producingCycleId=c1 windowSize=10 reportsConsidered=10 reportsLoaded=5 applyCount=0 applyExpected=0 status=degraded source=fallback',
  ]);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = p7.refreshP7Metrics({ dataRoot: tmp });
  if (r.payload.lastAlertReason !== 'low_report_coverage') fail('low_report_coverage');
  if (!readAlerts(tmp).includes('low_report_coverage')) fail('alert');
});

withTmp('case3_empty', (tmp) => {
  writeEvents(tmp, [
    '[P7 metrics] cycleId=c1 producingCycleId=c1 windowSize=10 reportsConsidered=0 reportsLoaded=0 applyCount=0 applyExpected=0 status=empty source=none',
  ]);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = p7.refreshP7Metrics({ dataRoot: tmp });
  if (r.payload.lastAlertReason !== 'empty_window') fail('empty_window');
});

withTmp('case4_malformed', (tmp) => {
  writeEvents(tmp, ['[P7 metrics] not valid']);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = p7.refreshP7Metrics({ dataRoot: tmp });
  if (r.payload.parseErrorCount !== 1) fail('parse');
  if (r.payload.lastAlertReason !== 'parse_errors') fail('parse_errors');
});

withTmp('case5_no_events_expect', (tmp) => {
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'discovery', 'run_trend_memory.json'), '{}', 'utf8');
  fs.mkdirSync(path.join(tmp, 'governance'), { recursive: true });
  const r = p7.refreshP7Metrics({ dataRoot: tmp, expectEvents: true });
  if (r.payload.lastAlertReason !== 'no_p7_metrics_events') fail('no_events');
});

console.log('smokeP7Metrics: all passed');
