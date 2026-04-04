#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataRoot = require('../dataRoot');
const policyMetrics = require('./policyMetrics');

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

function ok(msg) {
  console.log('OK:', msg);
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'polmet-'));
}

function writeEvents(root, lines) {
  const g = path.join(root, 'governance');
  fs.mkdirSync(g, { recursive: true });
  const body = lines.map((l) => `2026-01-01T00:00:00.000Z ${l}`).join('\n');
  fs.writeFileSync(path.join(g, 'policy_metrics_events.log'), body + (body ? '\n' : ''), 'utf8');
}

function readAlerts(root) {
  const p = path.join(root, 'governance', 'policy_alerts.log');
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
  } catch (err) {
    fail(`${name}: ${err && err.message ? err.message : err}`);
  } finally {
    process.env.NEUROPILOT_DATA_ROOT = prev;
    dataRoot.resetDataRoot();
  }
}

withTmp('case1_normal_stable', (tmp) => {
  writeEvents(tmp, [
    '[Policy metrics] cycleId=c1 explorationWeight=0.420000 exploitationWeight=0.580000 diversity=0.400000 source=trend',
    '[Policy metrics] cycleId=c2 explorationWeight=0.430000 exploitationWeight=0.570000 diversity=0.400000 source=trend',
  ]);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = policyMetrics.refreshPolicyMetrics({ dataRoot: tmp });
  if (r.payload.lastAlertReason !== null) fail('lastAlertReason must be null');
  if (readAlerts(tmp).trim()) fail('no alert expected');
});

withTmp('case2_drift_jump', (tmp) => {
  writeEvents(tmp, [
    '[Policy metrics] cycleId=c1 explorationWeight=0.200000 exploitationWeight=0.800000 diversity=0.200000 source=trend',
    '[Policy metrics] cycleId=c2 explorationWeight=0.550000 exploitationWeight=0.450000 diversity=0.600000 source=trend',
  ]);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = policyMetrics.refreshPolicyMetrics({ dataRoot: tmp });
  if (!r.payload.driftDetected) fail('drift expected');
  if (r.payload.lastAlertReason !== 'drift_jump') fail('lastAlertReason drift_jump expected');
  if (!readAlerts(tmp).includes('reason=drift_jump')) fail('drift alert missing');
});

withTmp('case3_fallback_frequent', (tmp) => {
  writeEvents(tmp, [
    '[Policy metrics] cycleId=c1 explorationWeight=0.420000 exploitationWeight=0.580000 diversity=0.400000 source=fallback',
    '[Policy metrics] cycleId=c2 explorationWeight=0.410000 exploitationWeight=0.590000 diversity=0.400000 source=fallback',
    '[Policy metrics] cycleId=c3 explorationWeight=0.430000 exploitationWeight=0.570000 diversity=0.400000 source=fallback',
    '[Policy metrics] cycleId=c4 explorationWeight=0.440000 exploitationWeight=0.560000 diversity=0.400000 source=fallback',
    '[Policy metrics] cycleId=c5 explorationWeight=0.450000 exploitationWeight=0.550000 diversity=0.400000 source=fallback',
    '[Policy metrics] cycleId=c6 explorationWeight=0.460000 exploitationWeight=0.540000 diversity=0.400000 source=trend',
  ]);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = policyMetrics.refreshPolicyMetrics({ dataRoot: tmp });
  if (r.payload.lastAlertReason !== 'fallback_frequent') fail('fallback_frequent expected');
  if (!readAlerts(tmp).includes('reason=fallback_frequent')) fail('fallback alert missing');
});

withTmp('case4_malformed_line', (tmp) => {
  writeEvents(tmp, ['[Policy metrics] cycleId=c1 this=is malformed']);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = policyMetrics.refreshPolicyMetrics({ dataRoot: tmp });
  if (r.payload.parseErrorCount !== 1) fail('parseErrorCount expected 1');
  if (r.payload.lastAlertReason !== 'parse_errors') fail('parse_errors expected');
  if (!readAlerts(tmp).includes('reason=parse_errors')) fail('parse alert missing');
});

withTmp('case5_no_events_expect', (tmp) => {
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'discovery', 'mutation_policy.json'), '{}', 'utf8');
  fs.mkdirSync(path.join(tmp, 'governance'), { recursive: true });
  const r = policyMetrics.refreshPolicyMetrics({ dataRoot: tmp, expectEvents: true });
  if (r.payload.lastAlertReason !== 'no_policy_metrics_events') fail('no_policy_metrics_events expected');
  if (!readAlerts(tmp).includes('reason=no_policy_metrics_events')) fail('no-events alert missing');
});

console.log('smokePolicyMetrics: all passed');

