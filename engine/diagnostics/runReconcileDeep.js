#!/usr/bin/env node
'use strict';

/**
 * Reconciliation deep diagnostic (owner-action bound).
 * Read-only snapshot inspection — no API calls, no secrets in logs.
 * Extend this file with deeper checks as needed.
 */

const fs = require('fs');
const path = require('path');

function defaultSnapshotDir() {
  const env = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR;
  if (env && String(env).trim()) {
    return path.resolve(process.cwd(), String(env).trim());
  }
  return path.join(__dirname, '..', '..', 'ops-snapshot');
}

function main() {
  const dir = defaultSnapshotDir();
  const execPath = path.join(dir, 'execution_status.json');
  console.log(`[reconcile-deep] __filename=${__filename}`);
  console.log(`[reconcile-deep] snapshotDir=${dir}`);

  if (!fs.existsSync(execPath)) {
    console.log('[reconcile-deep] execution_status.json missing — nothing to reconcile-check');
    process.exit(0);
  }

  let exec;
  try {
    exec = JSON.parse(fs.readFileSync(execPath, 'utf8'));
  } catch (e) {
    console.error('[reconcile-deep] invalid execution_status.json');
    process.exit(1);
  }

  const healthy = exec.reconciliationHealthy === true;
  const degraded = exec.reconciliationDegraded === true;
  const unmatched = Number(exec.unmatchedFillsCount) || 0;
  const matched = Number(exec.matchedFillsCount) || 0;
  console.log(
    `[reconcile-deep] reconciliationHealthy=${healthy} reconciliationDegraded=${degraded} matched=${matched} unmatched=${unmatched}`
  );
  console.log('[reconcile-deep] done (diagnostic only)');
  process.exit(0);
}

main();
