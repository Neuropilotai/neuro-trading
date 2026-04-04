#!/usr/bin/env node
'use strict';

/**
 * Exit 0 if evolution may proceed under owner-approval gate; exit 1 if any bundled gate fails.
 * Enable: NEUROPILOT_OWNER_APPROVAL_GATE=1
 *
 * Bundled ids (see ownerApprovalGate.EVOLUTION_GATED_RECOMMENDATION_IDS):
 *   rec_research_reconcile_deep, rec_governance_allow_next_cycle
 * Each applies only when present in owner_approval_queue.json; then status must be approved.
 */

const path = require('path');
const { evaluateEvolutionApprovalGates, defaultSnapshotDir } = require('../../execution/ownerApprovalGate');

function runEvolutionOwnerApprovalGateCheck() {
  const dir = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR
    ? path.resolve(process.cwd(), String(process.env.NEUROPILOT_OPS_SNAPSHOT_DIR).trim())
    : defaultSnapshotDir();

  const { allowed, failures } = evaluateEvolutionApprovalGates(dir);
  if (allowed) {
    process.exit(0);
  }
  for (const f of failures) {
    const tail = f.detail ? ` — ${f.detail}` : '';
    console.error(`[owner-approval-gate] BLOCKED id=${f.recommendationId} reason=${f.reason}${tail}`);
  }
  process.exit(1);
}

if (require.main === module) {
  runEvolutionOwnerApprovalGateCheck();
}

module.exports = { runEvolutionOwnerApprovalGateCheck };
