'use strict';

/**
 * Compact ops snapshot for execution pipeline V1 (no secrets).
 */

const { resolveExecutionMode } = require('./resolveExecutionMode');
const { readMetrics } = require('./executionPipelineJournals');
const { brokerType } = require('./executionAdmissionGate');

function buildExecutionPipelineSnapshotPayload(opts = {}) {
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const env = opts.env || process.env;
  const jopts = opts.dataRoot ? { dataRoot: opts.dataRoot } : {};
  const m = readMetrics(jopts);
  const mode = resolveExecutionMode(env);
  const broker = brokerType(env);

  const brokerHealth = {
    ok: null,
    note: 'not_checked_sync_export_use_enrichBrokerHealthAsync_if_needed',
  };

  return {
    generatedAt,
    schemaVersion: '1.0.0',
    executionMode: mode.mode,
    liveArmed: mode.liveArmed,
    tradingMode: String(env.TRADING_MODE || 'paper').toLowerCase(),
    broker,
    brokerHealth,
    pipelineV1Enabled: ['1', 'true', 'yes', 'on'].includes(
      String(env.NEUROPILOT_EXECUTION_PIPELINE_V1 || '').trim().toLowerCase()
    ),
    recentAccepted: Number(m.accepted) || 0,
    recentBlocked: Number(m.blocked) || 0,
    recentFailed: Number(m.failed) || 0,
    blockedByRisk: Number(m.blockedByRisk) || 0,
    blockedByPolicy: Number(m.blockedByPolicy) || 0,
    brokerErrors: Number(m.brokerErrors) || 0,
    lastOrderAttemptAt: m.lastOrderAttemptAt || null,
    lastAcceptedOrderAt: m.lastAcceptedOrderAt || null,
    lastBlockedReason: m.lastBlockedReason || null,
    metricsUpdatedAt: m.updatedAt || null,
    notes: [
      'counters_since_metrics_file_seed',
      'enable_NEUROPILOT_EXECUTION_PIPELINE_V1_for_journals',
      'metrics_best_effort_not_accounting_truth_under_multi_writer',
    ],
  };
}

/**
 * Optionally enrich with async broker health (call from export script).
 */
async function enrichBrokerHealthAsync(payload, getBrokerAdapter) {
  const out = { ...payload };
  if (typeof getBrokerAdapter !== 'function') return out;
  try {
    const adapter = getBrokerAdapter();
    const h = await Promise.resolve(adapter.healthCheck && adapter.healthCheck());
    out.brokerHealth = {
      ok: !!(h && (h.ok === true || h.connected === true)),
      connected: h && h.connected,
      broker: h && h.broker,
      degraded: h && h.degraded,
      stub: h && h.stub,
    };
  } catch (e) {
    out.brokerHealth = { ok: false, error: e && e.message ? String(e.message).slice(0, 120) : 'health_failed' };
  }
  return out;
}

module.exports = {
  buildExecutionPipelineSnapshotPayload,
  enrichBrokerHealthAsync,
};
