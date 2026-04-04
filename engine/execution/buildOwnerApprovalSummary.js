'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1.0.0';

function readJsonOptional(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} outDir
 * @param {string} [generatedAt]
 */
function buildOwnerApprovalSummaryPayload(outDir, generatedAt) {
  const queue = readJsonOptional(path.join(outDir, 'owner_approval_queue.json'));
  const state = readJsonOptional(path.join(outDir, 'owner_approval_state.json'));
  const history = readJsonOptional(path.join(outDir, 'owner_approval_history.json'));

  const items = queue && Array.isArray(queue.items) ? queue.items : [];
  const decisions =
    state && state.decisions && typeof state.decisions === 'object' ? state.decisions : {};

  let pending = 0;
  let approved = 0;
  let blocked = 0;
  let passed = 0;
  let other = 0;

  for (const item of items) {
    if (!item || !item.id) continue;
    const row = decisions[item.id];
    const st = row && row.status != null ? String(row.status) : item.status != null ? String(item.status) : 'pending';
    if (st === 'pending' || st === 'need_more_info') pending += 1;
    else if (st === 'approved' || st === 'executed') approved += 1;
    else if (st === 'blocked') blocked += 1;
    else if (st === 'passed' || st === 'snoozed' || st === 'expired') passed += 1;
    else other += 1;
  }

  let lastDecisionAt = state && state.updatedAt != null ? String(state.updatedAt) : null;
  const events = history && Array.isArray(history.events) ? history.events : [];
  if (events.length) {
    const last = events[events.length - 1];
    if (last && last.at) lastDecisionAt = String(last.at);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    pending,
    approved,
    blocked,
    passed,
    other,
    totalItems: items.length,
    lastDecisionAt,
  };
}

function writeOwnerApprovalSummary(outDir, generatedAt) {
  const payload = buildOwnerApprovalSummaryPayload(outDir, generatedAt);
  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(outDir, 'owner_approval_summary.json');
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
  return p;
}

module.exports = {
  buildOwnerApprovalSummaryPayload,
  writeOwnerApprovalSummary,
  SCHEMA_VERSION,
};
