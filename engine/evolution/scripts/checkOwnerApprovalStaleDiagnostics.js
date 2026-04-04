#!/usr/bin/env node
'use strict';

/**
 * Investigation trigger: exit 0 only if stale-diagnostics rec is absent or owner-approved.
 * Use in shell: node checkOwnerApprovalStaleDiagnostics.js && ./run-stale-diag.sh
 */

const path = require('path');
const { evaluateRecommendationGate, defaultSnapshotDir, REC_RESEARCH_STALE_DIAGNOSTICS } = require('../../execution/ownerApprovalGate');

const dir = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR
  ? path.resolve(process.cwd(), String(process.env.NEUROPILOT_OPS_SNAPSHOT_DIR).trim())
  : defaultSnapshotDir();

const r = evaluateRecommendationGate(dir, REC_RESEARCH_STALE_DIAGNOSTICS);
if (r.allowed) {
  process.exit(0);
}
console.error(`[owner-approval-gate] SKIP_DIAG id=${r.recommendationId} reason=${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
process.exit(1);
