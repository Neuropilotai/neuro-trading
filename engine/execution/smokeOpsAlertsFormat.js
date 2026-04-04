#!/usr/bin/env node
'use strict';

/**
 * Smoke tests for opsAlerts formatting + alert shape (no network, no snapshot files).
 */

const assert = require('assert');
const {
  formatAlertLine,
  evaluateOpsAlerts,
  ALERT_CODES,
  SEVERITY,
  normalizeAlert,
  severityPrefix,
} = require('./opsAlerts');

assert.strictEqual(severityPrefix(SEVERITY.CRIT), 'CRIT');
assert.strictEqual(severityPrefix(SEVERITY.WARN), 'WARN');
assert.strictEqual(severityPrefix(SEVERITY.INFO), 'INFO');

assert.strictEqual(
  formatAlertLine({ severity: SEVERITY.CRIT, code: 'test_code', message: 'hello' }),
  '[CRIT] test_code | hello'
);

assert.strictEqual(
  formatAlertLine({ level: 'critical', code: 'legacy', message: 'from level only' }),
  '[CRIT] legacy | from level only'
);

const n = normalizeAlert({ level: 'warn', code: 'c', message: 'm' });
assert.strictEqual(n.severity, SEVERITY.WARN);
assert.strictEqual(n.level, 'warn');

const execBase = {
  unmatchedFillsCount: 0,
  reconciliationDegraded: false,
  driftFlags: [],
  generatedAt: '2020-01-01T00:00:00.000Z',
};
const healthOk = { staleDataHardFail: false };
const prevOk = {
  reconciliationDegraded: false,
  driftFlags: [],
  unmatchedFillsCount: 0,
  staleDataHardFail: false,
  laggingPressureActive: false,
};

const noAlerts = evaluateOpsAlerts(execBase, healthOk, prevOk);
assert.strictEqual(noAlerts.alerts.length, 0);

const degraded = evaluateOpsAlerts(
  { ...execBase, reconciliationDegraded: true },
  healthOk,
  prevOk
);
assert.strictEqual(degraded.alerts.length, 1);
const a0 = degraded.alerts[0];
assert.strictEqual(a0.severity, SEVERITY.CRIT);
assert.strictEqual(a0.level, 'critical');
assert.strictEqual(a0.code, ALERT_CODES.RECONCILIATION_DEGRADED);
assert.ok(formatAlertLine(a0).startsWith('[CRIT]'));

console.log('smokeOpsAlertsFormat OK');
