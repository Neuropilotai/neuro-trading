#!/usr/bin/env node
'use strict';

/**
 * Smoke: consolidated governanceHealth V2 (4 components incl. P7).
 * Run: node engine/governance/smokeGovernanceHealth.js
 */

const assert = require('assert');
const { computeGovernanceHealth } = require('./computeGovernanceHealth');

const empty = { lastAlertReason: null };
const dash = { dashboardVersion: 'p8.15-v1', generatedAt: '2026-01-01T00:00:00.000Z' };

const base4 = { p5Health: empty, policyHealth: empty, governorHealth: empty, p7Health: empty };

{
  const gh = computeGovernanceHealth({
    ...dash,
    ...base4,
  });
  assert.strictEqual(gh.governanceHealthSchemaVersion, '2.0.0');
  assert.strictEqual(gh.status, 'healthy');
  assert.strictEqual(gh.lastAlertReason, null);
  assert.deepStrictEqual(gh.activeAlerts, []);
  assert.strictEqual(gh.healthyComponentCount, 4);
  assert.strictEqual(gh.alertComponentCount, 0);
}

{
  const gh = computeGovernanceHealth({
    ...dash,
    ...base4,
    policyHealth: { lastAlertReason: 'fallback_frequent' },
  });
  assert.strictEqual(gh.status, 'warning');
  assert.strictEqual(gh.lastAlertReason, 'fallback_frequent');
  assert.deepStrictEqual(gh.activeAlerts, ['policy:fallback_frequent']);
}

{
  const gh = computeGovernanceHealth({
    ...dash,
    ...base4,
    p5Health: { lastAlertReason: 'parse_errors' },
  });
  assert.strictEqual(gh.status, 'critical');
  assert.strictEqual(gh.lastAlertReason, 'parse_errors');
}

{
  const gh = computeGovernanceHealth({
    ...dash,
    p5Health: { lastAlertReason: 'chain_mismatch' },
    policyHealth: { lastAlertReason: 'fallback_frequent' },
    governorHealth: { lastAlertReason: 'decision_flap' },
    p7Health: { lastAlertReason: 'low_report_coverage' },
  });
  assert.strictEqual(gh.status, 'critical');
  assert.strictEqual(gh.lastAlertReason, 'chain_mismatch');
  assert.deepStrictEqual(gh.activeAlerts, [
    'p5:chain_mismatch',
    'governor:decision_flap',
    'policy:fallback_frequent',
    'p7:low_report_coverage',
  ]);
  assert.strictEqual(gh.healthyComponentCount, 0);
  assert.strictEqual(gh.alertComponentCount, 4);
}

{
  const gh = computeGovernanceHealth({
    ...dash,
    ...base4,
    p7Health: { lastAlertReason: 'empty_window' },
  });
  assert.strictEqual(gh.status, 'warning');
  assert.strictEqual(gh.lastAlertReason, 'empty_window');
  assert.deepStrictEqual(gh.activeAlerts, ['p7:empty_window']);
}

{
  const gh = computeGovernanceHealth({
    ...dash,
    ...base4,
    p7Health: { lastAlertReason: 'apply_zero_unexpected' },
    policyHealth: { lastAlertReason: 'fallback_frequent' },
  });
  assert.strictEqual(gh.status, 'critical');
  assert.strictEqual(gh.lastAlertReason, 'apply_zero_unexpected');
}

console.log('smokeGovernanceHealth: all passed');
