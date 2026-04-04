#!/usr/bin/env node
'use strict';

/**
 * Governor metrics smoke — stable, flap, malformed, reason missing, no events + expect.
 * Run from neuropilot_trading_v2: node engine/observability/smokeGovernorMetrics.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataRoot = require('../dataRoot');
const governorMetrics = require('./governorMetrics');

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

function ok(msg) {
  console.log('OK:', msg);
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'govmet-'));
}

function writeEvents(root, lines) {
  const g = path.join(root, 'governance');
  fs.mkdirSync(g, { recursive: true });
  const body = lines.map((l) => `2026-01-01T00:00:00.000Z ${l}`).join('\n');
  fs.writeFileSync(path.join(g, 'governor_metrics_events.log'), body + (body ? '\n' : ''), 'utf8');
}

function readAlerts(root) {
  const p = path.join(root, 'governance', 'governor_alerts.log');
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

withTmp('case1_decision_stable', (tmp) => {
  writeEvents(tmp, [
    `[Governor metrics] cycleId=c1 decision=OK mode=healthy reason=r_ok policySource=baseline riskState=healthy`,
    `[Governor metrics] cycleId=c2 decision=OK mode=healthy reason=r_ok2 policySource=baseline riskState=healthy`,
  ]);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = governorMetrics.refreshGovernorMetrics({ dataRoot: tmp });
  if (r.payload.lastAlertReason !== null) fail('expected null lastAlertReason');
  if (r.payload.decisionFlapDetected) fail('no flap');
  if (readAlerts(tmp).trim()) fail('no alerts');
});

withTmp('case2_decision_flap', (tmp) => {
  writeEvents(tmp, [
    `[Governor metrics] cycleId=c1 decision=OK mode=healthy reason=a policySource=baseline riskState=healthy`,
    `[Governor metrics] cycleId=c2 decision=DEGRADED mode=degraded reason=b policySource=baseline riskState=degraded`,
    `[Governor metrics] cycleId=c3 decision=OK mode=healthy reason=c policySource=baseline riskState=healthy`,
    `[Governor metrics] cycleId=c4 decision=DEGRADED mode=degraded reason=d policySource=baseline riskState=degraded`,
    `[Governor metrics] cycleId=c5 decision=OK mode=healthy reason=e policySource=baseline riskState=healthy`,
  ]);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = governorMetrics.refreshGovernorMetrics({ dataRoot: tmp });
  if (!r.payload.decisionFlapDetected) fail('flap expected');
  if (r.payload.lastAlertReason !== 'decision_flap') fail('lastAlertReason decision_flap');
  if (!readAlerts(tmp).includes('reason=decision_flap')) fail('alert missing');
});

withTmp('case3_malformed_line', (tmp) => {
  writeEvents(tmp, ['[Governor metrics] not a valid line']);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = governorMetrics.refreshGovernorMetrics({ dataRoot: tmp });
  if (r.payload.parseErrorCount !== 1) fail('parseErrorCount');
  if (r.payload.lastAlertReason !== 'parse_errors') fail('parse_errors');
  if (!readAlerts(tmp).includes('reason=parse_errors')) fail('parse alert');
});

withTmp('case4_reason_missing', (tmp) => {
  writeEvents(tmp, [
    `[Governor metrics] cycleId=c1 decision=OK mode=healthy reason=n/a policySource=baseline riskState=healthy`,
  ]);
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  const r = governorMetrics.refreshGovernorMetrics({ dataRoot: tmp });
  if (r.payload.reasonMissingCount !== 1) fail('reasonMissingCount');
  if (r.payload.lastAlertReason !== 'reason_missing') fail('reason_missing');
  if (!readAlerts(tmp).includes('reason=reason_missing')) fail('reason_missing alert');
});

withTmp('case5_no_events_expect', (tmp) => {
  fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'discovery', 'portfolio_governor.json'), '{}', 'utf8');
  fs.mkdirSync(path.join(tmp, 'governance'), { recursive: true });
  const r = governorMetrics.refreshGovernorMetrics({ dataRoot: tmp, expectEvents: true });
  if (r.payload.lastAlertReason !== 'no_governor_metrics_events') fail('no_events');
  if (!readAlerts(tmp).includes('no_governor_metrics_events')) fail('no_events alert');
});

console.log('smokeGovernorMetrics: all passed');
