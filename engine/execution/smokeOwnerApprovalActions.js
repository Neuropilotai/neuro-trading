'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runOwnerApprovalActions } = require('./ownerApprovalActionWorker');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-owner-actions-'));
process.env.NEUROPILOT_OPS_SNAPSHOT_DIR = dir;
delete process.env.NODE_ENV;

const statePath = path.join(dir, 'owner_approval_state.json');
const historyPath = path.join(dir, 'owner_approval_history.json');

fs.writeFileSync(
  statePath,
  JSON.stringify(
    {
      schemaVersion: '1.0.0',
      decisions: {
        rec_research_reconcile_deep: { status: 'approved', updatedAt: new Date().toISOString() },
      },
    },
    null,
    2
  ),
  'utf8'
);
fs.writeFileSync(historyPath, JSON.stringify({ schemaVersion: '1.0.0', events: [] }, null, 2), 'utf8');

fs.writeFileSync(
  path.join(dir, 'execution_status.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    reconciliationHealthy: false,
    reconciliationDegraded: true,
    unmatchedFillsCount: 2,
    matchedFillsCount: 10,
  }),
  'utf8'
);

void (async () => {
  const r1 = await runOwnerApprovalActions(dir);
  if (r1.ran !== 1) {
    console.error('smokeOwnerApprovalActions FAIL: expected ran=1 first pass', r1);
    process.exit(1);
  }

  const state1 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const deep = state1.decisions && state1.decisions.rec_research_reconcile_deep;
  if (!deep || !deep.executedAt) {
    console.error('smokeOwnerApprovalActions FAIL: missing executedAt after run', deep);
    process.exit(1);
  }

  const r2 = await runOwnerApprovalActions(dir);
  if (r2.ran !== 0) {
    console.error('smokeOwnerApprovalActions FAIL: expected ran=0 second pass (idempotent)', r2);
    process.exit(1);
  }

  const hist = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  const executedEvt = (hist.events || []).filter((e) => e && e.action === 'action_executed');
  if (executedEvt.length < 1) {
    console.error('smokeOwnerApprovalActions FAIL: expected action_executed in history');
    process.exit(1);
  }

  console.log('smokeOwnerApprovalActions OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
