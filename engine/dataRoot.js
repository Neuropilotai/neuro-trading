'use strict';

/**
 * Data root for heavy outputs (Discovery Engine, batch, bootstrap, brain).
 *
 * Set NEUROPILOT_DATA_ROOT to point at 5TB (e.g. /Volumes/My Passport/NeuroPilotAI).
 * If unset or path not available, uses local fallback: <project>/data_workspace.
 *
 * Usage:
 *   const dataRoot = require('./engine/dataRoot');
 *   const featuresDir = dataRoot.getPath('features');
 *   const outFile = path.join(featuresDir, 'features_SPY_5m.json');
 */

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATA_ROOT = path.join(PROJECT_ROOT, 'data_workspace');

const SUBDIRS = Object.freeze({
  datasets: 'datasets',
  features: 'features',
  discovery: 'discovery',
  generated_strategies: 'generated_strategies',
  batch_results: 'batch_results',
  bootstrap: 'bootstrap',
  walkforward: 'walkforward',
  brain_snapshots: 'brain_snapshots',
  champion_setups: 'champion_setups',
  nightly_logs: 'nightly_logs',
  archives: 'archives',
  governance: 'governance',
  evolution_runs: 'evolution_runs',
  paper: 'paper',
  loop_runs: 'loop_runs',
});

let _root = null;

/**
 * Get the data root directory. Uses NEUROPILOT_DATA_ROOT if set and present; else local fallback.
 * @returns {string} Absolute path to data root
 */
function getDataRoot() {
  if (_root != null) return _root;
  const env = process.env.NEUROPILOT_DATA_ROOT;
  if (env && typeof env === 'string' && env.trim()) {
    const candidate = path.resolve(env.trim());
    if (fs.existsSync(candidate)) {
      _root = candidate;
      return _root;
    }
  }
  _root = DEFAULT_DATA_ROOT;
  return _root;
}

/**
 * Get path for a known subdir (e.g. 'features', 'batch_results').
 * Directory is created if it doesn't exist when ensureDir is true.
 * @param {string} key - One of: datasets, features, discovery, generated_strategies, batch_results, bootstrap, walkforward, brain_snapshots, archives
 * @param {boolean} [ensureDir=true] - Create directory if missing
 * @returns {string} Absolute path to subdir
 */
function getPath(key, ensureDir = true) {
  const sub = SUBDIRS[key];
  if (!sub) return path.join(getDataRoot(), key);
  const full = path.join(getDataRoot(), sub);
  if (ensureDir && !fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
  return full;
}

/**
 * Reset cached root (e.g. for tests or after changing env).
 */
function resetDataRoot() {
  _root = null;
}

/**
 * Whether the current root is the 5TB (env set and path exists).
 */
function isUsingExternalDrive() {
  const env = process.env.NEUROPILOT_DATA_ROOT;
  if (!env || typeof env !== 'string' || !env.trim()) return false;
  return fs.existsSync(path.resolve(env.trim()));
}

module.exports = {
  getDataRoot,
  getPath,
  resetDataRoot,
  isUsingExternalDrive,
  SUBDIRS,
  DEFAULT_DATA_ROOT,
};
