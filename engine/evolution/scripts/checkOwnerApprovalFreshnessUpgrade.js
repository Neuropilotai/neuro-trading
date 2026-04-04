#!/usr/bin/env node
'use strict';

/**
 * Config-change gate: exit 0 if freshness-sensitivity upgrade may be applied (N/A or approved).
 * Exit 1 if rec is in queue and not approved — skip threshold changes.
 */

const path = require('path');
const { evaluateRecommendationGate, defaultSnapshotDir, REC_UPGRADE_FRESHNESS_SENSITIVITY } = require('../../execution/ownerApprovalGate');

const dir = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR
  ? path.resolve(process.cwd(), String(process.env.NEUROPILOT_OPS_SNAPSHOT_DIR).trim())
  : defaultSnapshotDir();

const r = evaluateRecommendationGate(dir, REC_UPGRADE_FRESHNESS_SENSITIVITY);
if (r.allowed) {
  process.exit(0);
}
console.error(`[owner-approval-gate] SKIP_UPGRADE id=${r.recommendationId} reason=${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
process.exit(1);
