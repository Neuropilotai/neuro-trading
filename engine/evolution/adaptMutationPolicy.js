#!/usr/bin/env node
'use strict';

/**
 * Adaptive mutation policy (P5).
 *
 * Temporal contract (see P5_TEMPORAL_CONTRACT.md):
 * Reads discovery/governance_mini_report.json as *previousGovernance* — in
 * runFullPipelineExpanded.sh, P5 runs BEFORE researchSupervisor + before the
 * end-of-run mini report, so that file reflects the prior cycle unless you
 * reorder the pipeline (Option B).
 *
 * Cycle chain: assertP5MiniMatchesLastCompleted (governance/cycleContext.js) when
 * last_completed_cycle.json exists and mini has cycleId (skip legacy / bootstrap).
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const { appendP5CycleEvent } = require('../observability/p5Metrics');
const { appendPolicyMetricsEvent } = require('../observability/policyMetrics');
const { appendP7GuardEvent } = require('../observability/p7GuardMetrics');
const { applyTrendMemoryToMutationWeights } = require('../governance/trendMemoryApply');
const {
  assertP5MiniMatchesLastCompleted,
  getCurrentCycleId,
  readLastCompletedCycle,
} = require('../governance/cycleContext');

/**
 * Stable one-line audit line. Ops: grep logs with exactly `[P5 cycle]` (do not change prefix).
 * Fields: currentCycleId | lastCompletedCycleId | miniCycleId_prior | chainAssert=(ok|mismatch_will_throw|skipped_*)
 */
function logP5CycleChain(governance, experimentId) {
  const cur = experimentId || getCurrentCycleId() || 'n/a';
  const last = readLastCompletedCycle();
  const seal = last && last.cycleId ? last.cycleId : 'n/a';
  const miniPrior = governance && typeof governance.cycleId === 'string' && governance.cycleId ? governance.cycleId : 'n/a';
  let outcome = 'skipped_no_seal';
  if (last && governance && typeof governance.cycleId === 'string' && governance.cycleId) {
    outcome = governance.cycleId === last.cycleId ? 'ok' : 'mismatch_will_throw';
  } else if (last && (!governance || typeof governance.cycleId !== 'string' || !governance.cycleId)) {
    outcome = 'skipped_legacy_mini';
  }
  const p5Line = `[P5 cycle] currentCycleId=${cur} lastCompletedCycleId=${seal} miniCycleId_prior=${miniPrior} chainAssert=${outcome}`;
  console.log(p5Line);
  appendP5CycleEvent(p5Line);
}

function logPolicyMetrics(policy) {
  const w = (policy && policy.byMutationType) || {};
  const exploitationWeight = Number(w.parameter_jitter || 0);
  const explorationWeight = Number(
    (w.forced_family_shift || 0) +
      (w.session_flip || 0) +
      (w.regime_flip || 0) +
      (w.hybrid_family_shift || 0)
  );
  const active = MUTATION_TYPES.filter((t) => Number(w[t] || 0) >= 0.1).length;
  const diversity = active / MUTATION_TYPES.length;
  const source =
    policy && policy.trendMemoryApply && policy.trendMemoryApply.appliedFromTrendMemory
      ? 'trend'
      : 'fallback';
  const cycleId = policy && policy.cycleId ? policy.cycleId : 'n/a';
  const line =
    `[Policy metrics] cycleId=${cycleId}` +
    ` explorationWeight=${explorationWeight.toFixed(6)}` +
    ` exploitationWeight=${exploitationWeight.toFixed(6)}` +
    ` diversity=${diversity.toFixed(6)}` +
    ` source=${source}`;
  console.log(line);
  appendPolicyMetricsEvent(line);
}

const MUTATION_TYPES = [
  'parameter_jitter',
  'forced_family_shift',
  'session_flip',
  'regime_flip',
  'hybrid_family_shift',
];
const P7_WARNING_REASONS = new Set(['low_report_coverage', 'empty_window', 'no_p7_metrics_events']);
const P7_CRITICAL_REASONS = new Set(['apply_zero_unexpected', 'parse_errors']);
const P7_GUARD_WARNING_FACTOR = 0.5;

const BASE_WEIGHTS = Object.freeze({
  parameter_jitter: 0.35,
  forced_family_shift: 0.25,
  session_flip: 0.2,
  regime_flip: 0.2,
  hybrid_family_shift: 0,
});

const CONSERVATIVE_WEIGHTS = Object.freeze({
  parameter_jitter: 0.42,
  forced_family_shift: 0.26,
  session_flip: 0.16,
  regime_flip: 0.16,
  hybrid_family_shift: 0,
});

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isP7HealthGuardEnabled() {
  return String(process.env.NEUROPILOT_ENABLE_P7_HEALTH_GUARD || '').toLowerCase() === 'true';
}

function resolveGovernanceDirFromDiscovery(discoveryDir) {
  return path.join(path.dirname(path.resolve(discoveryDir)), 'governance');
}

function readP7LastAlertReason(discoveryDir) {
  const p = path.join(resolveGovernanceDirFromDiscovery(discoveryDir), 'p7_metrics.json');
  const j = safeReadJson(p);
  if (!j || typeof j !== 'object') return null;
  const r = j.lastAlertReason;
  return r != null && String(r).trim() !== '' ? String(r).trim() : null;
}

function decideP7GuardAction(lastAlertReason) {
  if (lastAlertReason == null) return { action: 'normal', factor: 1 };
  if (P7_CRITICAL_REASONS.has(lastAlertReason)) return { action: 'skip', factor: 0 };
  if (P7_WARNING_REASONS.has(lastAlertReason)) return { action: 'attenuate', factor: P7_GUARD_WARNING_FACTOR };
  return { action: 'normal', factor: 1 };
}

function logP7Guard(parts, discoveryDir) {
  const line =
    `[P7 guard] enabled=${parts.enabled ? 'true' : 'false'}` +
    ` p7Alert=${parts.p7Alert || 'none'}` +
    ` action=${parts.action}` +
    ` factor=${Number(parts.factor || 0).toFixed(3)}`;
  console.log(line);
  const govDir = discoveryDir ? resolveGovernanceDirFromDiscovery(discoveryDir) : null;
  appendP7GuardEvent(line, govDir ? { governanceDir: govDir } : {});
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalize(weights) {
  const out = {};
  let sum = 0;
  for (const t of MUTATION_TYPES) {
    const v = Number(weights[t] || 0);
    out[t] = Number.isFinite(v) ? Math.max(0, v) : 0;
    sum += out[t];
  }
  if (sum <= 0) return { ...BASE_WEIGHTS };
  for (const t of MUTATION_TYPES) out[t] = out[t] / sum;
  return out;
}

function boundedWeights(weights) {
  const bounded = {};
  for (const t of MUTATION_TYPES) {
    bounded[t] = clamp(Number(weights[t] || 0), 0.03, 0.7);
  }
  return normalize(bounded);
}

function scoreFamilies(metaStrategies, limit = 8) {
  const rows = Array.isArray(metaStrategies) ? metaStrategies.slice(0, 120) : [];
  const byFamily = {};
  for (const s of rows) {
    const fk = s && s.familyKey ? String(s.familyKey) : null;
    if (!fk) continue;
    if (!byFamily[fk]) byFamily[fk] = { count: 0, expectancy: 0, score: 0 };
    byFamily[fk].count += 1;
    byFamily[fk].expectancy += Number(s.expectancy || 0);
    byFamily[fk].score += Number(s.meta_score || 0);
  }
  return Object.entries(byFamily)
    .map(([familyKey, v]) => ({
      familyKey,
      score: v.score / Math.max(1, v.count),
      expectancy: v.expectancy / Math.max(1, v.count),
      count: v.count,
    }))
    .filter((x) => x.expectancy >= 0)
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, Math.max(1, limit))
    .map((x) => x.familyKey);
}

function buildPolicy({ experimentId, mutationPerf, previousGovernance, metaRanking, previousPolicy }) {
  const invalidRatio = Number(previousGovernance && previousGovernance.supervisor && previousGovernance.supervisor.invalidResultRatio) || 0;
  const cycleValid = !!(previousGovernance && previousGovernance.supervisor && previousGovernance.supervisor.cycle_valid);
  const base = { ...BASE_WEIGHTS };

  const perf = mutationPerf && mutationPerf.byMutationType ? mutationPerf.byMutationType : {};
  const perfBoost = {};
  for (const t of MUTATION_TYPES) {
    const row = perf[t] || {};
    const beatsRate = clamp(Number(row.beatsRate || 0), 0, 1);
    const avgExpectancy = clamp(Number(row.avgExpectancy || 0), -0.01, 0.01);
    // bounded adaptation: small additive bias only
    perfBoost[t] = beatsRate * 0.25 + avgExpectancy * 10;
  }

  let weights = {};
  for (const t of MUTATION_TYPES) {
    weights[t] = base[t] + perfBoost[t];
  }
  weights = normalize(weights);

  // Reduce exploration when invalid ratio rises or cycle degraded.
  const riskPressure = clamp(invalidRatio, 0, 0.6) / 0.6;
  const conservativeBlend = cycleValid ? riskPressure : 0.75;
  const blended = {};
  for (const t of MUTATION_TYPES) {
    blended[t] = weights[t] * (1 - conservativeBlend) + CONSERVATIVE_WEIGHTS[t] * conservativeBlend;
  }
  const finalWeights = boundedWeights(blended);

  const familiesToExpand = scoreFamilies(metaRanking && metaRanking.strategies, 8);

  const policy = {
    generatedAt: new Date().toISOString(),
    policyVersion: 'p5-v1',
    experimentId: experimentId || null,
    adaptationInputs: {
      invalidResultRatio: invalidRatio,
      previousCycleValid: cycleValid,
      mutationPerfRows: Object.keys(perf).length,
    },
    byMutationType: finalWeights,
    familiesToExpand: familiesToExpand.length ? familiesToExpand : 'all',
  };

  const prev = previousPolicy && previousPolicy.byMutationType ? previousPolicy.byMutationType : {};
  policy.policyDiff = Object.fromEntries(
    MUTATION_TYPES.map((t) => [t, Number((finalWeights[t] - Number(prev[t] || 0)).toFixed(6))])
  );

  return policy;
}

function appendHistory(discoveryDir, policy) {
  const historyPath = path.join(discoveryDir, 'mutation_policy_history.json');
  const hist = safeReadJson(historyPath) || { entries: [] };
  if (!Array.isArray(hist.entries)) hist.entries = [];
  hist.entries.push({
    generatedAt: policy.generatedAt,
    experimentId: policy.experimentId,
    cycleId: policy.cycleId || null,
    policyVersion: policy.policyVersion,
    byMutationType: policy.byMutationType,
    familiesToExpand: policy.familiesToExpand,
    policyDiff: policy.policyDiff,
  });
  ensureDir(path.dirname(historyPath));
  fs.writeFileSync(historyPath, JSON.stringify(hist, null, 2), 'utf8');
  return historyPath;
}

function run(opts = {}) {
  const discoveryDir = opts.discoveryDir || dataRoot.getPath('discovery');
  const experimentId = opts.experimentId || process.env.EXPERIMENT_ID || null;

  const mutationPerf = safeReadJson(path.join(discoveryDir, 'mutation_perf.json'));
  const governance = safeReadJson(path.join(discoveryDir, 'governance_mini_report.json'));
  const meta = safeReadJson(path.join(discoveryDir, 'meta_ranking.json'));
  const prevPolicy = safeReadJson(path.join(discoveryDir, 'mutation_policy.json'));

  logP5CycleChain(governance, experimentId);
  assertP5MiniMatchesLastCompleted(governance);

  let policy = buildPolicy({
    experimentId,
    mutationPerf,
    previousGovernance: governance,
    metaRanking: meta,
    previousPolicy: prevPolicy,
  });

  policy.cycleId = experimentId || null;

  const p7GuardEnabled = isP7HealthGuardEnabled();
  const p7Alert = p7GuardEnabled ? readP7LastAlertReason(discoveryDir) : null;
  const p7Guard = p7GuardEnabled ? decideP7GuardAction(p7Alert) : { action: 'normal', factor: 1 };
  if (p7GuardEnabled) {
    logP7Guard(
      {
        enabled: true,
        p7Alert,
        action: p7Guard.action,
        factor: p7Guard.factor,
      },
      discoveryDir
    );
  }

  const tmMut =
    p7GuardEnabled && p7Guard.action === 'skip'
      ? {
          byMutationType: policy.byMutationType,
          appliedFromTrendMemory: false,
          appliedDeltas: {
            skipped: true,
            reason: `p7_guard_skip:${p7Alert || 'critical'}`,
          },
          reasons: [`trend_memory_apply_mutations:skipped_p7_guard_critical:${p7Alert || 'critical'}`],
        }
      : applyTrendMemoryToMutationWeights(policy.byMutationType, discoveryDir, {
          deltaMultiplier: p7GuardEnabled && p7Guard.action === 'attenuate' ? p7Guard.factor : 1,
        });
  if (tmMut.appliedFromTrendMemory) {
    policy.byMutationType = tmMut.byMutationType;
    policy.trendMemoryApply = {
      appliedFromTrendMemory: true,
      appliedDeltas: tmMut.appliedDeltas,
    };
    const prev = prevPolicy && prevPolicy.byMutationType ? prevPolicy.byMutationType : {};
    policy.policyDiff = Object.fromEntries(
      MUTATION_TYPES.map((t) => [t, Number((policy.byMutationType[t] - Number(prev[t] || 0)).toFixed(6))])
    );
    if (tmMut.reasons && tmMut.reasons.length) {
      policy.adaptationInputs = policy.adaptationInputs || {};
      policy.adaptationInputs.trendMemoryReasons = tmMut.reasons;
    }
  } else {
    policy.trendMemoryApply = {
      appliedFromTrendMemory: false,
      appliedDeltas: tmMut.appliedDeltas,
    };
    if (tmMut.reasons && tmMut.reasons.length) {
      policy.adaptationInputs = policy.adaptationInputs || {};
      policy.adaptationInputs.trendMemoryReasons = tmMut.reasons;
    }
  }

  const outPath = path.join(discoveryDir, 'mutation_policy.json');
  fs.writeFileSync(outPath, JSON.stringify(policy, null, 2), 'utf8');
  const historyPath = appendHistory(discoveryDir, policy);
  logPolicyMetrics(policy);

  return { outPath, historyPath, policy };
}

if (require.main === module) {
  try {
    const result = run();
    console.log('Adaptive mutation policy updated.');
    console.log('  policy:', result.outPath);
    console.log('  history:', result.historyPath);
  } catch (err) {
    console.error('adaptMutationPolicy failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = { run, buildPolicy };
