'use strict';

/**
 * Maps owner approval recommendation ids to concrete actions (idempotent at worker level via executedAt).
 */

const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const RECONCILE_SCRIPT = path.join(PROJECT_ROOT, 'engine', 'diagnostics', 'runReconcileDeep.js');

function runReconcileDeep() {
  execSync(process.execPath, [RECONCILE_SCRIPT], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
}

/** @type {Record<string, () => void | Promise<void>>} */
const ACTIONS = {
  rec_research_reconcile_deep: runReconcileDeep,
};

module.exports = {
  ACTIONS,
  runReconcileDeep,
};
