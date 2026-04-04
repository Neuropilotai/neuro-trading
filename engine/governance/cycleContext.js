'use strict';

/**
 * Pipeline cycle identity: one stable cycleId per run (aligned with EXPERIMENT_ID).
 * Seals `last_completed_cycle.json` when a governance mini report is written (end of cycle).
 * P5 (Option A) can assert the on-disk mini matches the last sealed cycle (machine-enforced chain).
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const { readJsonStore } = require('./jsonArtifactStore');

function lastCompletedPath() {
  return path.join(dataRoot.getPath('governance'), 'last_completed_cycle.json');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Prefer NEUROPILOT_CYCLE_ID (set with EXPERIMENT_ID in full pipeline), else EXPERIMENT_ID.
 */
function getCurrentCycleId() {
  const c = process.env.NEUROPILOT_CYCLE_ID && String(process.env.NEUROPILOT_CYCLE_ID).trim();
  const e = process.env.EXPERIMENT_ID && String(process.env.EXPERIMENT_ID).trim();
  return c || e || null;
}

/**
 * @returns {{ cycleId: string, completedAt?: string } | null}
 */
function readLastCompletedCycle() {
  const p = lastCompletedPath();
  if (!fs.existsSync(p)) return null;
  return readJsonStore(p, {
    label: 'last_completed_cycle',
    empty: () => {
      throw new Error('[last_completed_cycle] internal: missing file after exists check');
    },
    isValidShape: (j) =>
      j != null &&
      typeof j === 'object' &&
      typeof j.cycleId === 'string' &&
      j.cycleId.length > 0,
  });
}

function writeLastCompletedCycle(cycleId) {
  if (!cycleId || typeof cycleId !== 'string') return;
  const p = lastCompletedPath();
  ensureDir(path.dirname(p));
  const payload = {
    cycleId,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * Option A: on-disk governance_mini_report.json must be the last sealed cycle before P5 runs.
 * Skip if no seal file (bootstrap), or mini has no cycleId (legacy), or NEUROPILOT_SKIP_CYCLE_P5_ASSERT=true.
 */
function assertP5MiniMatchesLastCompleted(governance) {
  if (String(process.env.NEUROPILOT_SKIP_CYCLE_P5_ASSERT || '').toLowerCase() === 'true') {
    return;
  }
  const last = readLastCompletedCycle();
  if (!last) return;
  if (!governance || typeof governance !== 'object') return;
  if (typeof governance.cycleId !== 'string' || !governance.cycleId) return;
  if (governance.cycleId !== last.cycleId) {
    throw new Error(
      `[P5 cycle contract] governance_mini_report.cycleId (${governance.cycleId}) !== last_completed_cycle.cycleId (${last.cycleId}). ` +
        'Option A: P5 must read the mini from the previous sealed cycle. Check pipeline order or run with NEUROPILOT_SKIP_CYCLE_P5_ASSERT=true (recovery only).'
    );
  }
}

module.exports = {
  getCurrentCycleId,
  readLastCompletedCycle,
  writeLastCompletedCycle,
  assertP5MiniMatchesLastCompleted,
  lastCompletedPath,
};
