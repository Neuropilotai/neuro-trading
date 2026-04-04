'use strict';

/**
 * Owner-approval gates: when a recommendation id is present in owner_approval_queue.json,
 * evolution / sensitive actions require an explicit approved decision in owner_approval_state.json.
 *
 * Fail-safe: evaluateRecommendationGate calls ensureSnapshotIntegrity — both JSON files must exist
 * and parse (run exportOpsSnapshot / writeOwnerApprovalQueue first).
 *
 * Logging: each in-queue evaluation emits one [OWNER_GATE] line (ALLOW|BLOCK + reason).
 * Set NEUROPILOT_OWNER_GATE_TRACE_VERBOSE=1 to log SKIP for gate_not_applicable.
 */

const fs = require('fs');
const path = require('path');
const { isApproved, isBlocked } = require('./ownerApprovalPolicy');
const C = require('./ownerApprovalConstants');

const EVOLUTION_GATED_RECOMMENDATION_IDS = Object.freeze([
  C.REC_RESEARCH_RECONCILE_DEEP,
  C.REC_GOVERNANCE_ALLOW_NEXT_CYCLE,
]);

const REQUIRED_SNAPSHOT_FILES = Object.freeze(['owner_approval_queue.json', 'owner_approval_state.json']);

/**
 * Fail-closed: refuse to evaluate gates when snapshot artifacts are missing or corrupt.
 * @param {string} dir
 */
function ensureSnapshotIntegrity(dir) {
  const resolved = path.resolve(String(dir || '').trim() || '.');
  for (const file of REQUIRED_SNAPSHOT_FILES) {
    const p = path.join(resolved, file);
    if (!fs.existsSync(p)) {
      throw new Error(`Missing required snapshot file: ${file} (dir=${resolved})`);
    }
    try {
      JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      throw new Error(`Invalid or unreadable JSON: ${file} — ${msg}`);
    }
  }
}

/**
 * Runtime trace for operators (no secrets). Pair with owner_approval_history.json for durable audit.
 * @param {string} recommendationId
 * @param {string} outcome e.g. ALLOW | BLOCK | SKIP
 * @param {string} reason
 */
function logGateDecision(recommendationId, outcome, reason) {
  const id = recommendationId != null ? String(recommendationId) : '';
  const o = outcome != null ? String(outcome) : '';
  const r = reason != null ? String(reason) : '';
  console.log(`[OWNER_GATE] ${id} | ${o} | ${r}`);
}

function defaultSnapshotDir() {
  const env = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR;
  if (env && String(env).trim()) {
    return path.resolve(process.cwd(), String(env).trim());
  }
  return path.join(__dirname, '..', '..', 'ops-snapshot');
}

function readJsonOptional(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function gateDetailForId(recommendationId) {
  if (recommendationId === C.REC_GOVERNANCE_ALLOW_NEXT_CYCLE) {
    return (
      'Recommendation rec_governance_allow_next_cycle is present but not approved. Approve in Owner Ops (or owner_approval_state.json) before running evolution with the gate enabled.'
    );
  }
  if (recommendationId === C.REC_RESEARCH_RECONCILE_DEEP) {
    return (
      'Recommendation rec_research_reconcile_deep is present but not approved. Resolve reconciliation concerns and approve before running evolution with the gate enabled.'
    );
  }
  if (recommendationId === C.REC_RESEARCH_STALE_DIAGNOSTICS) {
    return (
      'Recommendation rec_research_stale_diagnostics is present but not approved. Approve before running stale-data diagnostic jobs.'
    );
  }
  if (recommendationId === C.REC_UPGRADE_FRESHNESS_SENSITIVITY) {
    return (
      'Recommendation rec_upgrade_freshness_sensitivity is present but not approved. Approve before applying freshness threshold changes.'
    );
  }
  return `Recommendation ${recommendationId} is present but not approved.`;
}

/**
 * @param {string} [snapshotDir]
 * @param {string} recommendationId
 * @returns {{ allowed: boolean, reason: string, detail?: string, recommendationId: string }}
 */
function evaluateRecommendationGate(snapshotDir, recommendationId) {
  const dir = snapshotDir || defaultSnapshotDir();
  ensureSnapshotIntegrity(dir);

  const id = String(recommendationId || '').trim();
  const queuePath = path.join(dir, 'owner_approval_queue.json');
  const statePath = path.join(dir, 'owner_approval_state.json');

  const queue = readJsonOptional(queuePath);
  const items = queue && Array.isArray(queue.items) ? queue.items : [];
  const hasGateItem = items.some((i) => i && i.id === id);

  if (!hasGateItem) {
    if (process.env.NEUROPILOT_OWNER_GATE_TRACE_VERBOSE === '1') {
      logGateDecision(id, 'SKIP', 'gate_not_applicable');
    }
    return { allowed: true, reason: 'gate_not_applicable', recommendationId: id };
  }

  const state = readJsonOptional(statePath);

  let result;
  if (isApproved(state, id)) {
    result = { allowed: true, reason: 'owner_approved', recommendationId: id };
  } else if (isBlocked(state, id)) {
    result = {
      allowed: false,
      reason: 'owner_blocked',
      recommendationId: id,
      detail: `Owner blocked ${id} for this snapshot.`,
    };
  } else {
    result = {
      allowed: false,
      reason: 'pending_owner_approval',
      recommendationId: id,
      detail: gateDetailForId(id),
    };
  }

  logGateDecision(id, result.allowed ? 'ALLOW' : 'BLOCK', result.reason);
  return result;
}

/**
 * @param {string} [snapshotDir]
 * @returns {{ allowed: boolean, failures: { recommendationId: string, reason: string, detail?: string }[] }}
 */
function evaluateEvolutionApprovalGates(snapshotDir) {
  const dir = snapshotDir || defaultSnapshotDir();
  const failures = [];
  for (const rid of EVOLUTION_GATED_RECOMMENDATION_IDS) {
    const r = evaluateRecommendationGate(dir, rid);
    if (!r.allowed) {
      failures.push({
        recommendationId: r.recommendationId,
        reason: r.reason,
        detail: r.detail,
      });
    }
  }
  return { allowed: failures.length === 0, failures };
}

/**
 * @param {string} [snapshotDir]
 * @returns {{ allowed: boolean, reason: string, detail?: string }}
 */
function evaluateAllowNextCycleGate(snapshotDir) {
  return evaluateRecommendationGate(snapshotDir, C.REC_GOVERNANCE_ALLOW_NEXT_CYCLE);
}

module.exports = {
  ...C,
  EVOLUTION_GATED_RECOMMENDATION_IDS,
  REQUIRED_SNAPSHOT_FILES,
  ensureSnapshotIntegrity,
  logGateDecision,
  evaluateRecommendationGate,
  evaluateEvolutionApprovalGates,
  evaluateAllowNextCycleGate,
  defaultSnapshotDir,
};
