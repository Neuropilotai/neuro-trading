'use strict';

/**
 * Build owner-facing approval queue JSON for ops-snapshot (no secrets).
 * Reads: execution_status.json, datasets_freshness.json, run_health.json, owner_transition_alerts.json
 * Merges persisted decisions from owner_approval_state.json (optional).
 * Writes: owner_approval_queue.json
 */

const fs = require('fs');
const path = require('path');
const { REC_GOVERNANCE_ALLOW_NEXT_CYCLE } = require('./ownerApprovalConstants');
const { rawMaxDatasetAgeMinutes, ownerStaleAgeForThreshold } = require('./ownerFreshnessEffectiveAge');

const SCHEMA_VERSION = '1.0.0';

const STALE_DATASET_MINUTES = 360;
const AGING_DATASET_MINUTES = 120;
const UNMATCHED_WARN_MIN = 5;

const VALID_STATUSES = new Set([
  'pending',
  'approved',
  'passed',
  'snoozed',
  'blocked',
  'need_more_info',
  'executed',
  'expired',
]);

function loadJsonOptional(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function transitionCodes(transitionFile) {
  const alerts = transitionFile && Array.isArray(transitionFile.alerts) ? transitionFile.alerts : [];
  return new Set(alerts.map((a) => (a && a.code != null ? String(a.code) : '')).filter(Boolean));
}

/**
 * @param {{
 *   outDir: string,
 *   generatedAt?: string,
 * }} opts
 * @returns {{ generatedAt: string, schemaVersion: string, items: object[] }}
 */
function buildOwnerApprovalQueue(opts) {
  const outDir = opts.outDir;
  const generatedAt = opts.generatedAt || new Date().toISOString();

  const exec = loadJsonOptional(path.join(outDir, 'execution_status.json'));
  const freshness = loadJsonOptional(path.join(outDir, 'datasets_freshness.json'));
  const health = loadJsonOptional(path.join(outDir, 'run_health.json'));
  const transitions = loadJsonOptional(path.join(outDir, 'owner_transition_alerts.json'));
  const stateFile = loadJsonOptional(path.join(outDir, 'owner_approval_state.json'));

  const codes = transitionCodes(transitions);
  const rawMaxAge = rawMaxDatasetAgeMinutes(freshness);
  const ownerAge = ownerStaleAgeForThreshold(freshness);
  const unmatched = exec ? Number(exec.unmatchedFillsCount) || 0 : 0;
  const degraded = exec && exec.reconciliationDegraded === true;
  const reconHealthy = exec && exec.reconciliationHealthy === true;
  const staleFail = health && health.staleDataHardFail === true;
  const driftN = exec ? Number(exec.driftFlagsCount) || 0 : 0;

  const items = [];

  if (!exec) {
    items.push({
      id: 'rec_ops_snapshot_restore',
      priority: 'critical',
      type: 'research',
      title: 'Restore execution snapshot',
      reason: 'execution_status.json missing — export ops snapshot before trading decisions.',
      impact: 'high',
      confidence: 'high',
      status: 'pending',
      recommendedAction: 'approve_next_run',
      sourceCodes: ['ops_snapshot_missing'],
      createdAt: generatedAt,
    });
    items.push({
      id: 'rec_governance_manual_promotion_gate',
      priority: 'critical',
      type: 'governance',
      title: 'Require manual approval before promotion / rollout',
      reason: 'Execution snapshot missing — halt automated promotion until ops data is valid.',
      impact: 'high',
      confidence: 'high',
      status: 'pending',
      recommendedAction: 'escalate_review',
      sourceCodes: ['governance_manual_gate', 'ops_snapshot_missing'],
      createdAt: generatedAt,
    });
  } else {
    if (
      degraded ||
      codes.has('unmatched_fills_increase') ||
      (!reconHealthy && unmatched >= UNMATCHED_WARN_MIN)
    ) {
      items.push({
        id: 'rec_research_reconcile_deep',
        priority: degraded || codes.has('unmatched_fills_increase') ? 'critical' : 'warn',
        type: 'research',
        title: 'Run reconciliation deep check',
        reason:
          degraded || codes.has('unmatched_fills_increase')
            ? 'reconciliation degraded and/or unmatched fills increased vs checkpoint.'
            : 'Unmatched fills elevated while reconciliation is not healthy.',
        impact: 'high',
        confidence: 'high',
        status: 'pending',
        recommendedAction: 'approve_next_run',
        sourceCodes: [
          ...(degraded ? ['reconciliation_degraded'] : []),
          ...(codes.has('unmatched_fills_increase') ? ['unmatched_fills_increase'] : []),
        ],
        createdAt: generatedAt,
      });
    }
  }

  if (staleFail || (ownerAge != null && ownerAge > STALE_DATASET_MINUTES)) {
    items.push({
      id: 'rec_research_stale_diagnostics',
      priority: 'critical',
      type: 'research',
      title: 'Refresh stale datasets / run stale-data diagnosis',
      reason: staleFail
        ? 'run_health reports staleDataHardFail.'
        : rawMaxAge != null &&
            ownerAge != null &&
            Math.round(rawMaxAge) > Math.round(ownerAge)
          ? `Oldest open/unknown-session dataset ~${Math.round(ownerAge)} min (raw oldest ~${Math.round(rawMaxAge)} min).`
          : `Oldest manifest dataset ~${Math.round(ownerAge)} min.`,
      impact: 'high',
      confidence: 'high',
      status: 'pending',
      recommendedAction: 'approve_next_run',
      sourceCodes: staleFail ? ['stale_data_hard_fail'] : ['market_data_stale'],
      createdAt: generatedAt,
    });
  } else if (ownerAge != null && ownerAge > AGING_DATASET_MINUTES) {
    items.push({
      id: 'rec_upgrade_freshness_sensitivity',
      priority: 'warn',
      type: 'upgrade',
      title: 'Raise freshness monitoring sensitivity',
      reason: `Recurring aging trend — oldest dataset ~${Math.round(ownerAge)} min.`,
      impact: 'medium',
      confidence: 'medium',
      status: 'pending',
      recommendedAction: 'watch_or_approve',
      sourceCodes: ['market_data_aging'],
      createdAt: generatedAt,
    });
  }

  if (codes.has('drift_flag_new') || driftN > 0) {
    items.push({
      id: 'rec_research_drift_inspect',
      priority: codes.has('drift_flag_new') ? 'warn' : 'info',
      type: 'research',
      title: 'Review drift signal and validation',
      reason: codes.has('drift_flag_new')
        ? 'New drift flag vs previous ops alert checkpoint.'
        : `${driftN} drift flag(s) present on book.`,
      impact: codes.has('drift_flag_new') ? 'medium' : 'low',
      confidence: 'medium',
      status: 'pending',
      recommendedAction: 'watch_or_approve',
      sourceCodes: codes.has('drift_flag_new') ? ['drift_flag_new'] : ['drift_flags_present'],
      createdAt: generatedAt,
    });
  }

  if (
    exec &&
    (degraded || staleFail || (ownerAge != null && ownerAge > STALE_DATASET_MINUTES))
  ) {
    items.push({
      id: 'rec_governance_manual_promotion_gate',
      priority: 'critical',
      type: 'governance',
      title: 'Require manual approval before promotion / rollout',
      reason: 'Critical operational signals active — gate auto-promotion until cleared.',
      impact: 'high',
      confidence: 'high',
      status: 'pending',
      recommendedAction: 'escalate_review',
      sourceCodes: ['governance_manual_gate'],
      createdAt: generatedAt,
    });
  }

  if (
    exec &&
    !degraded &&
    !staleFail &&
    (ownerAge == null || ownerAge <= AGING_DATASET_MINUTES) &&
    driftN === 0 &&
    exec.oandaCredentialsPresent !== true &&
    !reconHealthy
  ) {
    items.push({
      id: 'rec_info_broker_reconciliation_inactive',
      priority: 'info',
      type: 'research',
      title: 'Broker reconciliation inactive (expected in paper lab)',
      reason:
        'No OANDA credentials in snapshot — live reconciliation not running; not an incident for research-only.',
      impact: 'low',
      confidence: 'high',
      status: 'pending',
      recommendedAction: 'watch_or_approve',
      sourceCodes: ['broker_reconciliation_inactive'],
      createdAt: generatedAt,
    });
  } else if (
    exec &&
    !degraded &&
    !staleFail &&
    exec.oandaCredentialsPresent === true &&
    !reconHealthy
  ) {
    items.push({
      id: 'rec_research_confirm_broker',
      priority: 'warn',
      type: 'research',
      title: 'Confirm broker connectivity and reconciliation',
      reason:
        'Credentials are configured but reconciliation is not healthy — review broker read and errors.',
      impact: 'medium',
      confidence: 'high',
      status: 'pending',
      recommendedAction: 'approve_next_run',
      sourceCodes: ['reconciliation_not_healthy'],
      createdAt: generatedAt,
    });
  }

  if (
    exec &&
    items.length === 0 &&
    !degraded &&
    !staleFail &&
    (ownerAge == null || ownerAge <= AGING_DATASET_MINUTES) &&
    driftN === 0
  ) {
    items.push({
      id: REC_GOVERNANCE_ALLOW_NEXT_CYCLE,
      priority: 'info',
      type: 'governance',
      title: 'Allow next evolution / research cycle',
      reason:
        'No blocking ops signals in this snapshot — you may proceed with planned research or evolution runs.',
      impact: 'low',
      confidence: 'medium',
      status: 'pending',
      recommendedAction: 'watch_or_approve',
      sourceCodes: ['ops_green_snapshot'],
      createdAt: generatedAt,
    });
  }

  const decisions =
    stateFile && typeof stateFile.decisions === 'object' && stateFile.decisions !== null
      ? stateFile.decisions
      : {};

  for (const item of items) {
    const d = decisions[item.id];
    if (d && d.status && VALID_STATUSES.has(String(d.status))) {
      item.status = String(d.status);
      if (d.updatedAt) item.ownerUpdatedAt = d.updatedAt;
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    items,
  };
}

/**
 * @param {string} outDir
 * @param {string} [generatedAt]
 */
function writeOwnerApprovalQueue(outDir, generatedAt) {
  const payload = buildOwnerApprovalQueue({ outDir, generatedAt });
  fs.mkdirSync(outDir, { recursive: true });
  const queuePath = path.join(outDir, 'owner_approval_queue.json');
  fs.writeFileSync(queuePath, JSON.stringify(payload, null, 2), 'utf8');

  const statePath = path.join(outDir, 'owner_approval_state.json');
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION,
          generatedAt: generatedAt || new Date().toISOString(),
          decisions: {},
        },
        null,
        2
      ),
      'utf8'
    );
  }

  const historyPath = path.join(outDir, 'owner_approval_history.json');
  if (!fs.existsSync(historyPath)) {
    fs.writeFileSync(
      historyPath,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, events: [] }, null, 2),
      'utf8'
    );
  }

  return queuePath;
}

module.exports = {
  buildOwnerApprovalQueue,
  writeOwnerApprovalQueue,
  SCHEMA_VERSION,
};
