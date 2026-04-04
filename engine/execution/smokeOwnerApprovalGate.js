'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyOwnerApprovalDecision } = require('./ownerApprovalPersistence');
const {
  evaluateAllowNextCycleGate,
  evaluateEvolutionApprovalGates,
  evaluateRecommendationGate,
  ensureSnapshotIntegrity,
  REC_GOVERNANCE_ALLOW_NEXT_CYCLE,
  REC_RESEARCH_RECONCILE_DEEP,
} = require('./ownerApprovalGate');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-owner-approval-'));
const queuePath = path.join(dir, 'owner_approval_queue.json');
const statePath = path.join(dir, 'owner_approval_state.json');

function writeQueue(items) {
  fs.writeFileSync(queuePath, JSON.stringify({ items }), 'utf8');
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ schemaVersion: '1.0.0', decisions: {} }, null, 2),
      'utf8'
    );
  }
}

// --- Green path: allow-next only, pending then approved ---
writeQueue([{ id: REC_GOVERNANCE_ALLOW_NEXT_CYCLE, status: 'pending' }]);

const a = evaluateAllowNextCycleGate(dir);
if (a.allowed !== false || a.reason !== 'pending_owner_approval') {
  console.error('smokeOwnerApprovalGate FAIL: expected allow-next pending block', a);
  process.exit(1);
}

const evoPending = evaluateEvolutionApprovalGates(dir);
if (evoPending.allowed !== false || evoPending.failures.length !== 1) {
  console.error('smokeOwnerApprovalGate FAIL: evolution bundle should block on allow-next only', evoPending);
  process.exit(1);
}

applyOwnerApprovalDecision({
  snapshotDir: dir,
  recommendationId: REC_GOVERNANCE_ALLOW_NEXT_CYCLE,
  action: 'approved',
  actor: 'smoke',
});

const b = evaluateEvolutionApprovalGates(dir);
if (b.allowed !== true) {
  console.error('smokeOwnerApprovalGate FAIL: expected evolution allow after allow-next approve', b);
  process.exit(1);
}

// --- Reconcile deep: pending blocks evolution until approved ---
writeQueue([{ id: REC_RESEARCH_RECONCILE_DEEP, status: 'pending' }]);

const rPending = evaluateRecommendationGate(dir, REC_RESEARCH_RECONCILE_DEEP);
if (rPending.allowed !== false || rPending.reason !== 'pending_owner_approval') {
  console.error('smokeOwnerApprovalGate FAIL: expected reconcile pending block', rPending);
  process.exit(1);
}

const evoRecon = evaluateEvolutionApprovalGates(dir);
if (evoRecon.allowed !== false || !evoRecon.failures.some((f) => f.recommendationId === REC_RESEARCH_RECONCILE_DEEP)) {
  console.error('smokeOwnerApprovalGate FAIL: evolution should block on reconcile pending', evoRecon);
  process.exit(1);
}

applyOwnerApprovalDecision({
  snapshotDir: dir,
  recommendationId: REC_RESEARCH_RECONCILE_DEEP,
  action: 'approved',
  actor: 'smoke',
});

const rOk = evaluateRecommendationGate(dir, REC_RESEARCH_RECONCILE_DEEP);
if (rOk.allowed !== true) {
  console.error('smokeOwnerApprovalGate FAIL: expected reconcile allow after approve', rOk);
  process.exit(1);
}

const evoOk = evaluateEvolutionApprovalGates(dir);
if (evoOk.allowed !== true) {
  console.error('smokeOwnerApprovalGate FAIL: expected evolution allow after reconcile approve', evoOk);
  process.exit(1);
}

// --- Both in queue: need both approved ---
writeQueue([
  { id: REC_RESEARCH_RECONCILE_DEEP, status: 'pending' },
  { id: REC_GOVERNANCE_ALLOW_NEXT_CYCLE, status: 'pending' },
]);

fs.writeFileSync(
  statePath,
  JSON.stringify({
    schemaVersion: '1.0.0',
    decisions: {
      [REC_RESEARCH_RECONCILE_DEEP]: { status: 'approved', updatedAt: new Date().toISOString() },
    },
  }),
  'utf8'
);

const evoPartial = evaluateEvolutionApprovalGates(dir);
if (evoPartial.allowed !== false) {
  console.error('smokeOwnerApprovalGate FAIL: expected block when allow-next still pending', evoPartial);
  process.exit(1);
}

applyOwnerApprovalDecision({
  snapshotDir: dir,
  recommendationId: REC_GOVERNANCE_ALLOW_NEXT_CYCLE,
  action: 'approved',
  actor: 'smoke',
});

const evoBoth = evaluateEvolutionApprovalGates(dir);
if (evoBoth.allowed !== true) {
  console.error('smokeOwnerApprovalGate FAIL: expected allow when both gates approved', evoBoth);
  process.exit(1);
}

const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-owner-approval-empty-'));
let missingThrow = false;
try {
  ensureSnapshotIntegrity(emptyDir);
} catch (e) {
  missingThrow = e && e.message && String(e.message).includes('Missing required snapshot file');
}
if (!missingThrow) {
  console.error('smokeOwnerApprovalGate FAIL: ensureSnapshotIntegrity should throw when snapshot missing');
  process.exit(1);
}

console.log('smokeOwnerApprovalGate OK');
