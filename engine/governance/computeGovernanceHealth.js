'use strict';

/**
 * Consolidated governance health from p7Health / p5Health / policyHealth / governorHealth.
 * Contract: GOVERNANCE_HEALTH_SCHEMA.md
 */

const GOVERNANCE_HEALTH_SCHEMA_VERSION = '2.0.0';

/**
 * Order defines tie-break when two reasons share the same severity (earlier = higher ops priority).
 * V2 adds P7 as 4th brick (after triptyque P5 / Policy / Governor).
 */
const COMPONENT_ORDER = [
  { key: 'p5', label: 'p5' },
  { key: 'policy', label: 'policy' },
  { key: 'governor', label: 'governor' },
  { key: 'p7', label: 'p7' },
];

/**
 * Higher = more severe. Used for global lastAlertReason and activeAlerts ordering.
 * Aligns with user table: chain_mismatch > invalid_* > decision_flap > drift > fallback > no_* .
 */
const SEVERITY_SCORE = {
  chain_mismatch: 100,
  invalid_decision: 96,
  invalid_weights: 96,
  decision_flap: 90,
  apply_zero_unexpected: 87,
  parse_errors: 85,
  drift_jump: 50,
  fallback_frequent: 45,
  reason_missing: 42,
  no_p5_cycle_events: 40,
  no_policy_metrics_events: 40,
  no_governor_metrics_events: 40,
  no_p7_metrics_events: 40,
  low_report_coverage: 38,
  empty_window: 38,
};

const WARNING_REASONS = new Set([
  'drift_jump',
  'fallback_frequent',
  'reason_missing',
  'no_p5_cycle_events',
  'no_policy_metrics_events',
  'no_governor_metrics_events',
  'low_report_coverage',
  'empty_window',
  'no_p7_metrics_events',
]);

function severityScore(reason) {
  if (reason == null || reason === '') return 0;
  if (Object.prototype.hasOwnProperty.call(SEVERITY_SCORE, reason)) return SEVERITY_SCORE[reason];
  return 88;
}

function componentStatus(reason) {
  if (reason == null || reason === '') return 'healthy';
  if (WARNING_REASONS.has(reason)) return 'warning';
  return 'critical';
}

/**
 * @param {object} input
 * @param {object} [input.p5Health]
 * @param {object} [input.policyHealth]
 * @param {object} [input.governorHealth]
 * @param {object} [input.p7Health]
 * @param {string|null} [input.dashboardVersion]
 * @param {string} [input.generatedAt]
 */
function computeGovernanceHealth(input = {}) {
  const {
    p5Health = {},
    policyHealth = {},
    governorHealth = {},
    p7Health = {},
    dashboardVersion = null,
    generatedAt = new Date().toISOString(),
  } = input;

  const byKey = {
    p5: p5Health,
    policy: policyHealth,
    governor: governorHealth,
    p7: p7Health,
  };

  const components = {};
  const entries = [];

  for (let i = 0; i < COMPONENT_ORDER.length; i += 1) {
    const { key, label } = COMPONENT_ORDER[i];
    const h = byKey[key] && typeof byKey[key] === 'object' ? byKey[key] : {};
    const raw = h.lastAlertReason;
    const reason = raw != null && String(raw).trim() !== '' ? String(raw).trim() : null;
    const status = componentStatus(reason);
    components[key] = { status, lastAlertReason: reason };
    if (reason) {
      entries.push({
        label,
        reason,
        status,
        severity: severityScore(reason),
        order: i,
      });
    }
  }

  entries.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    return a.order - b.order;
  });

  const activeAlerts = entries.map((e) => `${e.label}:${e.reason}`);

  let status = 'healthy';
  for (const k of Object.keys(components)) {
    if (components[k].status === 'critical') status = 'critical';
  }
  if (status !== 'critical') {
    for (const k of Object.keys(components)) {
      if (components[k].status === 'warning') status = 'warning';
    }
  }

  const healthyComponentCount = Object.values(components).filter((c) => c.status === 'healthy').length;
  const alertComponentCount = COMPONENT_ORDER.length - healthyComponentCount;

  const lastAlertReason = entries.length ? entries[0].reason : null;

  return {
    governanceHealthSchemaVersion: GOVERNANCE_HEALTH_SCHEMA_VERSION,
    dashboardVersion,
    generatedAt,
    status,
    lastAlertReason,
    activeAlerts,
    healthyComponentCount,
    alertComponentCount,
    components,
  };
}

module.exports = {
  computeGovernanceHealth,
  GOVERNANCE_HEALTH_SCHEMA_VERSION,
  SEVERITY_SCORE,
};
