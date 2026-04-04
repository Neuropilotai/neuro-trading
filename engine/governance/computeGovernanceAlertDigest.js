'use strict';

/**
 * Top alerts / trend digest for dashboard (read-only aggregation).
 * Contract: GOVERNANCE_ALERT_DIGEST_SCHEMA.md
 */

const GOVERNANCE_ALERT_DIGEST_SCHEMA_VERSION = '1.0.0';

function parseIsoMs(s) {
  if (s == null || s === '') return NaN;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? t : NaN;
}

function maxIsoString(dates) {
  const ms = dates.map(parseIsoMs).filter((n) => Number.isFinite(n));
  if (!ms.length) return null;
  return new Date(Math.max(...ms)).toISOString();
}

/**
 * @param {object} input
 * @param {object} input.governanceHealth
 * @param {object} [input.p5Health]
 * @param {object} [input.policyHealth]
 * @param {object} [input.governorHealth]
 * @param {object} [input.p7Health]
 * @param {number|null} [input.previousActiveAlertsCount] — length of prior digest activeAlerts; null → trend unknown
 * @param {string|null} [input.generatedAt]
 * @param {string|null} [input.dashboardVersion]
 */
function computeGovernanceAlertDigest(input = {}) {
  const {
    governanceHealth = {},
    p5Health = {},
    policyHealth = {},
    governorHealth = {},
    p7Health = {},
    previousActiveAlertsCount = null,
    generatedAt = new Date().toISOString(),
    dashboardVersion = null,
  } = input;

  const gh = governanceHealth && typeof governanceHealth === 'object' ? governanceHealth : {};
  const activeAlerts = Array.isArray(gh.activeAlerts) ? [...gh.activeAlerts] : [];
  const status = gh.status === 'warning' || gh.status === 'critical' ? gh.status : 'healthy';
  const topAlert = activeAlerts.length ? activeAlerts[0] : null;

  const components = gh.components && typeof gh.components === 'object' ? gh.components : {};
  let criticalCount = 0;
  let warningCount = 0;
  const componentsInAlert = [];
  for (const key of ['p5', 'policy', 'governor', 'p7']) {
    const c = components[key];
    if (!c || typeof c !== 'object') continue;
    if (c.status === 'critical') criticalCount += 1;
    if (c.status === 'warning') warningCount += 1;
    if (c.lastAlertReason != null && String(c.lastAlertReason).trim() !== '') {
      componentsInAlert.push(key);
    }
  }

  const anomalyTs = [
    p5Health.lastMismatchAt,
    p5Health.lastParseErrorAt,
    policyHealth.lastParseErrorAt,
    governorHealth.lastParseErrorAt,
    p7Health.lastParseErrorAt,
  ];
  let lastAnomalyAt = maxIsoString(anomalyTs);
  if (activeAlerts.length && !lastAnomalyAt) {
    lastAnomalyAt = maxIsoString([gh.generatedAt, generatedAt]);
  }

  const n = activeAlerts.length;
  let recentTrend = 'unknown';
  if (previousActiveAlertsCount == null || !Number.isFinite(Number(previousActiveAlertsCount))) {
    recentTrend = 'unknown';
  } else {
    const prev = Number(previousActiveAlertsCount);
    if (n > prev) recentTrend = 'worsening';
    else if (n < prev) recentTrend = 'improving';
    else recentTrend = 'stable';
  }

  return {
    governanceAlertDigestSchemaVersion: GOVERNANCE_ALERT_DIGEST_SCHEMA_VERSION,
    dashboardVersion,
    generatedAt,
    status,
    activeAlerts,
    topAlert,
    criticalCount,
    warningCount,
    componentsInAlert,
    lastAnomalyAt,
    recentTrend,
    previousActiveAlertsCount:
      previousActiveAlertsCount == null ? null : Number(previousActiveAlertsCount),
  };
}

module.exports = {
  computeGovernanceAlertDigest,
  GOVERNANCE_ALERT_DIGEST_SCHEMA_VERSION,
};
