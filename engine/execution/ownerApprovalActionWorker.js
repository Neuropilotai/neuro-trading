#!/usr/bin/env node
'use strict';

/**
 * Runs bound actions once per owner approval (idempotence: decisions[id].executedAt).
 *
 * Production: set NEUROPILOT_ENABLE_OWNER_ACTIONS=1 or worker exits 0 without doing work.
 * Non-production: runs when invoked (no extra flag required).
 */

const fs = require('fs');
const path = require('path');
const {
  defaultSnapshotDir,
  atomicWriteJson,
  readJsonFile,
  SCHEMA_VERSION,
} = require('./ownerApprovalPersistence');
const { ACTIONS } = require('./ownerApprovalActions');

function historyPath(snapshotDir) {
  return path.join(snapshotDir, 'owner_approval_history.json');
}

function appendHistoryEvent(snapshotDir, evt) {
  const hp = historyPath(snapshotDir);
  let hist = readJsonFile(hp);
  if (!hist || typeof hist !== 'object' || !Array.isArray(hist.events)) {
    hist = { schemaVersion: SCHEMA_VERSION, events: [] };
  }
  hist.events.push(evt);
  const maxEv = Math.max(100, Math.min(2000, Number(process.env.NEUROPILOT_OWNER_APPROVAL_HISTORY_MAX) || 500));
  if (hist.events.length > maxEv) {
    hist.events = hist.events.slice(-maxEv);
  }
  atomicWriteJson(hp, hist);
}

/**
 * @param {string} snapshotDir
 */
async function runOwnerApprovalActions(snapshotDir) {
  if (process.env.NODE_ENV === 'production' && process.env.NEUROPILOT_ENABLE_OWNER_ACTIONS !== '1') {
    console.log('[OWNER_ACTION] Disabled in production (set NEUROPILOT_ENABLE_OWNER_ACTIONS=1 to enable)');
    return { ran: 0, skipped: 'prod_guard' };
  }

  const dir = path.resolve(snapshotDir);
  const statePath = path.join(dir, 'owner_approval_state.json');

  if (!fs.existsSync(statePath)) {
    console.log(`[OWNER_ACTION] No owner_approval_state.json in ${dir} — skip`);
    return { ran: 0, skipped: 'no_state' };
  }

  const state = readJsonFile(statePath);
  if (!state || typeof state !== 'object') {
    console.error('[OWNER_ACTION] Invalid owner_approval_state.json — skip');
    return { ran: 0, skipped: 'bad_state' };
  }

  const decisions =
    state.decisions && typeof state.decisions === 'object' && state.decisions !== null
      ? state.decisions
      : {};

  let ran = 0;
  const now = new Date().toISOString();

  for (const [id, row] of Object.entries(decisions)) {
    if (!row || typeof row !== 'object') continue;
    if (String(row.status) !== 'approved') continue;
    if (row.executedAt) continue;

    const fn = ACTIONS[id];
    if (typeof fn !== 'function') continue;

    console.log(`[OWNER_ACTION] Executing ${id}`);
    try {
      await Promise.resolve(fn());
      row.executedAt = now;
      state.updatedAt = now;
      atomicWriteJson(statePath, state);
      appendHistoryEvent(dir, {
        at: now,
        id,
        action: 'action_executed',
        actor: 'owner_action_worker',
        detail: id,
      });
      ran += 1;
      console.log(`[OWNER_ACTION] SUCCESS ${id}`);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.error(`[OWNER_ACTION] FAILED ${id} — ${msg}`);
      appendHistoryEvent(dir, {
        at: now,
        id,
        action: 'action_failed',
        actor: 'owner_action_worker',
        detail: msg.slice(0, 500),
      });
    }
  }

  return { ran };
}

async function main() {
  const dir =
    process.env.NEUROPILOT_OPS_SNAPSHOT_DIR && String(process.env.NEUROPILOT_OPS_SNAPSHOT_DIR).trim()
      ? path.resolve(process.cwd(), String(process.env.NEUROPILOT_OPS_SNAPSHOT_DIR).trim())
      : defaultSnapshotDir();

  await runOwnerApprovalActions(dir);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[OWNER_ACTION] Fatal', e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = { runOwnerApprovalActions };
