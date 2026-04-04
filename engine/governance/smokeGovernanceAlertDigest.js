#!/usr/bin/env node
'use strict';

/**
 * Smoke: governanceAlertDigest (top alerts + trend vs prior snapshot count).
 * Run: node engine/governance/smokeGovernanceAlertDigest.js
 */

const assert = require('assert');
const { computeGovernanceAlertDigest } = require('./computeGovernanceAlertDigest');
const { computeGovernanceHealth } = require('./computeGovernanceHealth');

const empty = { lastAlertReason: null };
const dash = { dashboardVersion: 'p8.15-v1', generatedAt: '2026-01-01T00:00:00.000Z' };
const base4 = { p5Health: empty, policyHealth: empty, governorHealth: empty, p7Health: empty };

function ghFrom(input) {
  return computeGovernanceHealth({ ...dash, ...input });
}

// 1) No alerts → healthy, topAlert null, trend unknown (no prior)
{
  const governanceHealth = ghFrom(base4);
  const d = computeGovernanceAlertDigest({
    governanceHealth,
    ...base4,
    previousActiveAlertsCount: null,
    generatedAt: dash.generatedAt,
    dashboardVersion: dash.dashboardVersion,
  });
  assert.strictEqual(d.status, 'healthy');
  assert.strictEqual(d.topAlert, null);
  assert.strictEqual(d.recentTrend, 'unknown');
  assert.deepStrictEqual(d.activeAlerts, []);
}

// 2) One warning → topAlert warning
{
  const governanceHealth = ghFrom({
    ...base4,
    policyHealth: { lastAlertReason: 'fallback_frequent' },
  });
  const d = computeGovernanceAlertDigest({
    governanceHealth,
    ...base4,
    policyHealth: { lastAlertReason: 'fallback_frequent' },
    previousActiveAlertsCount: null,
    generatedAt: dash.generatedAt,
    dashboardVersion: dash.dashboardVersion,
  });
  assert.strictEqual(d.status, 'warning');
  assert.strictEqual(d.topAlert, 'policy:fallback_frequent');
  assert.strictEqual(d.warningCount, 1);
  assert.strictEqual(d.criticalCount, 0);
  assert.deepStrictEqual(d.componentsInAlert, ['policy']);
}

// 3) Critical + warning → topAlert critical (same order as governanceHealth.activeAlerts[0])
{
  const governanceHealth = ghFrom({
    ...base4,
    p5Health: { lastAlertReason: 'parse_errors' },
    policyHealth: { lastAlertReason: 'fallback_frequent' },
  });
  const d = computeGovernanceAlertDigest({
    governanceHealth,
    p5Health: { lastAlertReason: 'parse_errors' },
    policyHealth: { lastAlertReason: 'fallback_frequent' },
    governorHealth: empty,
    p7Health: empty,
    previousActiveAlertsCount: null,
    generatedAt: dash.generatedAt,
    dashboardVersion: dash.dashboardVersion,
  });
  assert.strictEqual(d.status, 'critical');
  assert.strictEqual(d.topAlert, 'p5:parse_errors');
  assert.ok(d.criticalCount >= 1);
  assert.ok(d.warningCount >= 1);
}

// 4) Trend vs previous snapshot count
{
  const governanceHealth = ghFrom({
    ...base4,
    p7Health: { lastAlertReason: 'empty_window' },
  });
  const worsening = computeGovernanceAlertDigest({
    governanceHealth,
    ...base4,
    p7Health: { lastAlertReason: 'empty_window' },
    previousActiveAlertsCount: 0,
    generatedAt: dash.generatedAt,
    dashboardVersion: dash.dashboardVersion,
  });
  assert.strictEqual(worsening.recentTrend, 'worsening');

  const improving = computeGovernanceAlertDigest({
    governanceHealth: ghFrom(base4),
    ...base4,
    previousActiveAlertsCount: 2,
    generatedAt: dash.generatedAt,
    dashboardVersion: dash.dashboardVersion,
  });
  assert.strictEqual(improving.recentTrend, 'improving');

  const stable = computeGovernanceAlertDigest({
    governanceHealth: ghFrom({
      ...base4,
      p7Health: { lastAlertReason: 'empty_window' },
    }),
    ...base4,
    p7Health: { lastAlertReason: 'empty_window' },
    previousActiveAlertsCount: 1,
    generatedAt: dash.generatedAt,
    dashboardVersion: dash.dashboardVersion,
  });
  assert.strictEqual(stable.recentTrend, 'stable');
}

// lastAnomalyAt: max among timestamps
{
  const governanceHealth = ghFrom({
    ...base4,
    p5Health: { lastAlertReason: 'chain_mismatch' },
  });
  const d = computeGovernanceAlertDigest({
    governanceHealth,
    p5Health: {
      lastAlertReason: 'chain_mismatch',
      lastMismatchAt: '2026-01-01T10:00:00.000Z',
      lastParseErrorAt: '2026-01-02T12:00:00.000Z',
    },
    policyHealth: { lastParseErrorAt: '2026-01-01T11:00:00.000Z' },
    governorHealth: empty,
    p7Health: { lastParseErrorAt: '2026-01-03T08:00:00.000Z' },
    previousActiveAlertsCount: null,
    generatedAt: dash.generatedAt,
    dashboardVersion: dash.dashboardVersion,
  });
  assert.strictEqual(d.lastAnomalyAt, '2026-01-03T08:00:00.000Z');
}

console.log('smokeGovernanceAlertDigest: all passed');
