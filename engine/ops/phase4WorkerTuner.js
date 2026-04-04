'use strict';

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const { readPhaseMetrics } = require('./phaseMetricsStore');

const PHASE_KEY = 'phase4_validation';

function rootDir() {
  return process.env.NEUROPILOT_DATA_ROOT || dataRoot.getDataRoot();
}

function governanceDir() {
  return path.join(rootDir(), 'governance');
}

function policyPath() {
  return path.join(governanceDir(), 'phase_policy.json');
}

function statePath() {
  return path.join(governanceDir(), 'phase_tuner_state.json');
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeWriteJson(filePath, payload) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function clampInt(v, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function defaultPolicy(currentWorkers) {
  return {
    phase4_validation: {
      allowAutoTune: true,
      minWorkers: 1,
      maxWorkers: 16,
      currentWorkers: clampInt(currentWorkers, 1, 16),
      maxStep: 1,
      minImprovementPct: 8,
      maxErrorIncreasePct: 0,
      requiredGoodCycles: 2,
    },
  };
}

function resolvePolicy(currentWorkers) {
  const existing = safeReadJson(policyPath());
  const base = existing && typeof existing === 'object' ? existing : defaultPolicy(currentWorkers);
  if (!base[PHASE_KEY] || typeof base[PHASE_KEY] !== 'object') {
    base[PHASE_KEY] = defaultPolicy(currentWorkers)[PHASE_KEY];
  }
  const p = base[PHASE_KEY];
  p.minWorkers = Math.max(1, clampInt(p.minWorkers, 1, 256));
  p.maxWorkers = Math.max(p.minWorkers, clampInt(p.maxWorkers, p.minWorkers, 256));
  p.currentWorkers = clampInt(
    Number.isFinite(Number(p.currentWorkers)) ? p.currentWorkers : currentWorkers,
    p.minWorkers,
    p.maxWorkers
  );
  p.maxStep = Math.max(1, clampInt(p.maxStep, 1, 2));
  p.minImprovementPct = Math.max(1, Number(p.minImprovementPct) || 8);
  p.requiredGoodCycles = Math.max(1, clampInt(p.requiredGoodCycles, 1, 3));
  p.maxErrorIncreasePct = Math.max(0, Number(p.maxErrorIncreasePct) || 0);
  safeWriteJson(policyPath(), base);
  return base;
}

function resolvePhase4Workers(defaultWorkers, runId = null) {
  const enabled = String(process.env.NEUROPILOT_PHASE_TUNER_ENABLED || '0') === '1';
  const policyDoc = resolvePolicy(defaultWorkers);
  const policy = policyDoc[PHASE_KEY];
  const baseWorkers = clampInt(policy.currentWorkers, policy.minWorkers, policy.maxWorkers);
  const stateDoc = safeReadJson(statePath()) || {};
  const phaseState = stateDoc[PHASE_KEY] && typeof stateDoc[PHASE_KEY] === 'object' ? stateDoc[PHASE_KEY] : {};

  const decision = {
    phase: PHASE_KEY,
    decision: 'keep_current',
    reason: 'TUNER_DISABLED',
    currentWorkers: baseWorkers,
    selectedWorkers: baseWorkers,
    candidateWorkers: null,
    policyPath: policyPath(),
    statePath: statePath(),
    enabled,
  };

  if (!enabled || policy.allowAutoTune !== true) {
    return decision;
  }

  const hist = readPhaseMetrics(PHASE_KEY, 100).filter((r) => Number.isFinite(Number(r.durationMs)));
  if (hist.length < 3) {
    decision.reason = 'INSUFFICIENT_HISTORY';
    return decision;
  }

  const latest = hist[hist.length - 1];
  if (latest && String(latest.status || '') !== 'success') {
    decision.reason = 'LAST_CYCLE_FAILED';
    return decision;
  }

  const baselineRows = hist
    .filter((r) => Number(r.workerCount) === baseWorkers && String(r.status || '') === 'success')
    .slice(-10);
  if (baselineRows.length < 2) {
    decision.reason = 'NO_BASELINE_FOR_CURRENT_WORKERS';
    return decision;
  }
  const baselineAvg = baselineRows.reduce((a, b) => a + Number(b.durationMs), 0) / baselineRows.length;

  const candidate =
    phaseState && phaseState.inProgress === true && Number.isFinite(Number(phaseState.candidateWorkers))
      ? clampInt(phaseState.candidateWorkers, policy.minWorkers, policy.maxWorkers)
      : Math.min(policy.maxWorkers, baseWorkers + 1);

  const candidateRows = hist.filter((r) => Number(r.workerCount) === candidate).slice(-policy.requiredGoodCycles);
  const candidateSuccessRows = candidateRows.filter((r) => String(r.status || '') === 'success');
  const candidateFailed = candidateRows.some((r) => String(r.status || '') !== 'success');

  if (phaseState && phaseState.inProgress === true) {
    if (candidateFailed) {
      policy.currentWorkers = baseWorkers;
      stateDoc[PHASE_KEY] = { inProgress: false, finalDecision: 'rollback', reason: 'CANDIDATE_FAILED' };
      safeWriteJson(policyPath(), policyDoc);
      safeWriteJson(statePath(), stateDoc);
      decision.reason = 'ROLLBACK_CANDIDATE_FAILED';
      return decision;
    }
    if (candidateSuccessRows.length >= policy.requiredGoodCycles) {
      const candAvg = candidateSuccessRows.reduce((a, b) => a + Number(b.durationMs), 0) / candidateSuccessRows.length;
      const improvePct = ((baselineAvg - candAvg) / Math.max(1, baselineAvg)) * 100;
      if (improvePct >= policy.minImprovementPct) {
        policy.currentWorkers = candidate;
        stateDoc[PHASE_KEY] = {
          inProgress: false,
          finalDecision: 'adopt',
          improvementPct: Number(improvePct.toFixed(3)),
          adoptedAtRun: runId || null,
        };
        safeWriteJson(policyPath(), policyDoc);
        safeWriteJson(statePath(), stateDoc);
        decision.decision = 'adopt';
        decision.reason = 'CANDIDATE_IMPROVED';
        decision.selectedWorkers = candidate;
        decision.candidateWorkers = candidate;
        return decision;
      }
      stateDoc[PHASE_KEY] = {
        inProgress: false,
        finalDecision: 'rollback',
        reason: 'NO_IMPROVEMENT',
      };
      safeWriteJson(statePath(), stateDoc);
      decision.reason = 'ROLLBACK_NO_IMPROVEMENT';
      return decision;
    }
    decision.decision = 'test_candidate';
    decision.reason = 'EXPERIMENT_IN_PROGRESS';
    decision.selectedWorkers = candidate;
    decision.candidateWorkers = candidate;
    return decision;
  }

  if (candidate === baseWorkers) {
    decision.reason = 'AT_MAX_OR_NO_STEP';
    return decision;
  }
  stateDoc[PHASE_KEY] = {
    inProgress: true,
    baselineWorkers: baseWorkers,
    candidateWorkers: candidate,
    requiredGoodCycles: policy.requiredGoodCycles,
    startedAtRun: runId || null,
  };
  safeWriteJson(statePath(), stateDoc);
  decision.decision = 'test_candidate';
  decision.reason = 'START_EXPERIMENT';
  decision.selectedWorkers = candidate;
  decision.candidateWorkers = candidate;
  return decision;
}

module.exports = {
  resolvePhase4Workers,
  PHASE_KEY,
};

