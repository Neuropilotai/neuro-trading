'use strict';

/**
 * Durable owner approval writeback: ops-snapshot/owner_approval_state.json + owner_approval_history.json
 * Never logs tokens or secrets.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1.0.0';

const VALID_ACTIONS = new Set([
  'approved',
  'passed',
  'snoozed',
  'need_more_info',
  'blocked',
]);

function defaultSnapshotDir() {
  const env = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR;
  if (env && String(env).trim()) {
    return path.resolve(process.cwd(), String(env).trim());
  }
  return path.join(__dirname, '..', '..', 'ops-snapshot');
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * @param {{
 *   snapshotDir?: string,
 *   recommendationId: string,
 *   action: string,
 *   actor?: string,
 * }} opts
 */
function applyOwnerApprovalDecision(opts) {
  const recommendationId = opts.recommendationId != null ? String(opts.recommendationId).trim() : '';
  const action = opts.action != null ? String(opts.action).trim() : '';
  if (!recommendationId) throw new Error('recommendationId required');
  if (!VALID_ACTIONS.has(action)) throw new Error(`invalid action: ${action}`);

  const snapshotDir = opts.snapshotDir || defaultSnapshotDir();
  const statePath = path.join(snapshotDir, 'owner_approval_state.json');
  const historyPath = path.join(snapshotDir, 'owner_approval_history.json');

  let state = readJsonFile(statePath);
  if (!state || typeof state !== 'object') {
    state = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      decisions: {},
    };
  }
  state.decisions =
    state.decisions && typeof state.decisions === 'object' && state.decisions !== null
      ? state.decisions
      : {};
  const now = new Date().toISOString();
  state.decisions[recommendationId] = { status: action, updatedAt: now };
  state.updatedAt = now;
  atomicWriteJson(statePath, state);

  let hist = readJsonFile(historyPath);
  if (!hist || typeof hist !== 'object' || !Array.isArray(hist.events)) {
    hist = { schemaVersion: SCHEMA_VERSION, events: [] };
  }
  hist.events.push({
    at: now,
    id: recommendationId,
    action,
    actor: opts.actor != null ? String(opts.actor) : 'unknown',
  });
  const maxEv = Math.max(100, Math.min(2000, Number(process.env.NEUROPILOT_OWNER_APPROVAL_HISTORY_MAX) || 500));
  if (hist.events.length > maxEv) {
    hist.events = hist.events.slice(-maxEv);
  }
  atomicWriteJson(historyPath, hist);

  return { ok: true, statePath, historyPath, updatedAt: now };
}

module.exports = {
  applyOwnerApprovalDecision,
  defaultSnapshotDir,
  SCHEMA_VERSION,
  VALID_ACTIONS,
  atomicWriteJson,
  readJsonFile,
};
