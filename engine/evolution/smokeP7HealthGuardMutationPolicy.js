#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { run: runMutationPolicy } = require('./adaptMutationPolicy');

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function writeJson(p, o) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8');
}

function baseDiscovery(discoveryDir) {
  writeJson(path.join(discoveryDir, 'mutation_perf.json'), { byMutationType: {} });
  writeJson(path.join(discoveryDir, 'governance_mini_report.json'), {
    supervisor: { cycle_valid: true, invalidResultRatio: 0 },
  });
  writeJson(path.join(discoveryDir, 'mutation_policy.json'), {
    byMutationType: {
      parameter_jitter: 0.45,
      forced_family_shift: 0.25,
      session_flip: 0.12,
      regime_flip: 0.12,
      hybrid_family_shift: 0.06,
    },
  });
  writeJson(path.join(discoveryDir, 'meta_ranking.json'), { strategies: [] });
  writeJson(path.join(discoveryDir, 'run_trend_memory.json'), {
    trendMemoryVersion: 'p7-v1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    suggestions: {
      policyAdjustments: {
        mutationTypeWeightDeltas: {
          parameter_jitter: 0.1,
          hybrid_family_shift: -0.06,
        },
      },
    },
  });
}

function writeP7Alert(governanceDir, reason) {
  writeJson(path.join(governanceDir, 'p7_metrics.json'), {
    p7MetricsSchemaVersion: '1.0.0',
    lastAlertReason: reason,
  });
}

function runWithEnv(discoveryDir, env) {
  const keys = Object.keys(env);
  const old = {};
  for (const k of keys) old[k] = process.env[k];
  try {
    for (const k of keys) process.env[k] = env[k];
    return runMutationPolicy({ discoveryDir, experimentId: 'exp_guard' }).policy;
  } finally {
    for (const k of keys) {
      if (old[k] == null) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np_p7_guard_'));
  const discoveryDir = path.join(tmp, 'discovery');
  const governanceDir = path.join(tmp, 'governance');
  ensureDir(discoveryDir);
  ensureDir(governanceDir);
  baseDiscovery(discoveryDir);

  const commonEnv = {
    TREND_MEMORY_APPLY: 'true',
    TREND_MEMORY_APPLY_MODE: 'conservative',
    TREND_MEMORY_APPLY_MUTATIONS: 'true',
  };

  // Non-regression: flag OFF == current behavior baseline (with healthy signal).
  writeP7Alert(governanceDir, null);
  const off = runWithEnv(discoveryDir, {
    ...commonEnv,
    NEUROPILOT_ENABLE_P7_HEALTH_GUARD: 'false',
  });
  const healthyOn = runWithEnv(discoveryDir, {
    ...commonEnv,
    NEUROPILOT_ENABLE_P7_HEALTH_GUARD: 'true',
  });
  assert.deepStrictEqual(
    healthyOn.byMutationType,
    off.byMutationType,
    'flag ON + healthy/unknown must match flag OFF output'
  );

  // Warning: attenuate trend by factor 0.5.
  writeP7Alert(governanceDir, 'empty_window');
  const warning = runWithEnv(discoveryDir, {
    ...commonEnv,
    NEUROPILOT_ENABLE_P7_HEALTH_GUARD: 'true',
  });
  assert.strictEqual(warning.trendMemoryApply.appliedFromTrendMemory, true, 'warning should still apply trend');
  assert.strictEqual(
    warning.trendMemoryApply.appliedDeltas.deltaMultiplierApplied,
    0.5,
    'warning should attenuate deltas by 0.5'
  );
  assert(
    warning.byMutationType.parameter_jitter < off.byMutationType.parameter_jitter,
    'warning attenuated result must be smaller than full-apply baseline'
  );

  // Critical: skip trend apply.
  writeP7Alert(governanceDir, 'parse_errors');
  const critical = runWithEnv(discoveryDir, {
    ...commonEnv,
    NEUROPILOT_ENABLE_P7_HEALTH_GUARD: 'true',
  });
  assert.strictEqual(critical.trendMemoryApply.appliedFromTrendMemory, false, 'critical should skip trend');
  assert(
    critical.trendMemoryApply.appliedDeltas &&
      critical.trendMemoryApply.appliedDeltas.reason &&
      String(critical.trendMemoryApply.appliedDeltas.reason).startsWith('p7_guard_skip:'),
    'critical skip reason should be tagged by p7 guard'
  );

  console.log('smokeP7HealthGuardMutationPolicy: all passed');
}

main();
