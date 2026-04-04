#!/usr/bin/env node
'use strict';

/**
 * Risk-containment gate for reconciliation deep-dive work before evolution (or standalone check).
 * Exit 0 if gate N/A or owner approved; exit 1 if pending/blocked while rec is in queue.
 */

const path = require('path');
const { evaluateRecommendationGate, defaultSnapshotDir, REC_RESEARCH_RECONCILE_DEEP } = require('../../execution/ownerApprovalGate');

const dir = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR
  ? path.resolve(process.cwd(), String(process.env.NEUROPILOT_OPS_SNAPSHOT_DIR).trim())
  : defaultSnapshotDir();

const r = evaluateRecommendationGate(dir, REC_RESEARCH_RECONCILE_DEEP);
if (r.allowed) {
  process.exit(0);
}
console.error(`[owner-approval-gate] BLOCKED id=${r.recommendationId} reason=${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
process.exit(1);
