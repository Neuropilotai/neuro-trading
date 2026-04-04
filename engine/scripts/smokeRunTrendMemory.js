#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { runTrendMemory } = require('../governance/runTrendMemory');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function makeReport(i, status, opts = {}) {
  return {
    generatedAt: new Date(Date.now() + i * 1000).toISOString(),
    experimentId: `exp_smoke_${i}`,
    governanceStatus: status,
    supervisor: {
      invalidResultRatio: opts.invalidRatio != null ? opts.invalidRatio : 0.03,
      holdCash: !!opts.holdCash,
    },
    budgetAudit: {
      mutationBudget: 10,
      files_written: opts.filesWritten != null ? opts.filesWritten : 8,
    },
    expansion: {
      leaders_selected: opts.leaders != null ? opts.leaders : 10,
      fallbackApplied: !!opts.fallback,
      familiesToExpand: opts.families || ['familyA', 'familyB'],
    },
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function scenarioRoot(base, name) {
  const p = path.join(base, name, 'discovery');
  ensureDir(path.join(p, 'reports'));
  return p;
}

function seedCommonHistories(discoveryDir) {
  writeJson(path.join(discoveryDir, 'portfolio_governor_history.json'), [
    { at: new Date().toISOString(), promotionMode: 'normal', holdCash: false },
    { at: new Date().toISOString(), promotionMode: 'normal', holdCash: false },
  ]);
  writeJson(path.join(discoveryDir, 'mutation_policy_history.json'), {
    entries: [
      { generatedAt: new Date().toISOString(), byMutationType: { parameter_jitter: 0.5, forced_family_shift: 0.2 } },
      { generatedAt: new Date().toISOString(), byMutationType: { parameter_jitter: 0.48, forced_family_shift: 0.22 } },
    ],
  });
}

function runScenarioAHealthy(tmp) {
  const discoveryDir = scenarioRoot(tmp, 'A_healthy');
  seedCommonHistories(discoveryDir);
  for (let i = 0; i < 8; i += 1) {
    writeJson(
      path.join(discoveryDir, 'reports', `governance_mini_report_exp_smoke_A_${i}.json`),
      makeReport(i, 'OK', { invalidRatio: 0.02, filesWritten: 8, fallback: false, leaders: 10 })
    );
  }
  const r = runTrendMemory({ discoveryDir, windowSize: 8 });
  assert(r.payload.signals.blockedRate === 0, 'A blockedRate should be 0');
  assert(r.payload.signals.degradedRate === 0, 'A degradedRate should be 0');
  assert(r.payload.suggestions.portfolioAdjustments.exposureMultiplier >= 0.95, 'A exposure should be neutral');
  return r.payload;
}

function runScenarioBDegraded(tmp) {
  const discoveryDir = scenarioRoot(tmp, 'B_degraded');
  writeJson(path.join(discoveryDir, 'portfolio_governor_history.json'), [
    { at: new Date().toISOString(), promotionMode: 'blocked', holdCash: true },
    { at: new Date().toISOString(), promotionMode: 'conservative', holdCash: true },
    { at: new Date().toISOString(), promotionMode: 'blocked', holdCash: true },
  ]);
  writeJson(path.join(discoveryDir, 'mutation_policy_history.json'), {
    entries: [
      { generatedAt: new Date().toISOString(), byMutationType: { parameter_jitter: 0.45, forced_family_shift: 0.25 } },
      { generatedAt: new Date().toISOString(), byMutationType: { parameter_jitter: 0.4, forced_family_shift: 0.3 } },
    ],
  });
  for (let i = 0; i < 8; i += 1) {
    const status = i < 4 ? 'DEGRADED' : 'BLOCKED';
    writeJson(
      path.join(discoveryDir, 'reports', `governance_mini_report_exp_smoke_B_${i}.json`),
      makeReport(i, status, {
        invalidRatio: 0.18,
        filesWritten: 1,
        fallback: true,
        leaders: 8,
        holdCash: true,
      })
    );
  }
  const r = runTrendMemory({ discoveryDir, windowSize: 8 });
  assert(r.payload.signals.blockedRate >= 0.45, 'B blockedRate should be high');
  assert(r.payload.suggestions.portfolioAdjustments.exposureMultiplier < 1, 'B should reduce exposure');
  assert(r.payload.suggestions.portfolioAdjustments.admissionThresholdDelta > 0, 'B should increase admission threshold');
  return r.payload;
}

function runScenarioCFallback(tmp) {
  const discoveryDir = scenarioRoot(tmp, 'C_fallback');
  seedCommonHistories(discoveryDir);
  for (let i = 0; i < 8; i += 1) {
    writeJson(
      path.join(discoveryDir, 'reports', `governance_mini_report_exp_smoke_C_${i}.json`),
      makeReport(i, 'DEGRADED', {
        invalidRatio: 0.07,
        filesWritten: 0,
        fallback: true,
        leaders: 6,
        families: ['familySterile', 'familyStable'],
      })
    );
  }
  const r = runTrendMemory({ discoveryDir, windowSize: 8 });
  const deltas = r.payload.suggestions.policyAdjustments.mutationTypeWeightDeltas;
  assert(r.payload.signals.fallbackRate >= 0.8, 'C fallbackRate should be high');
  assert(Object.keys(deltas).length > 0, 'C should suggest mutation deltas');
  return r.payload;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np_p7_smoke_'));
  const A = runScenarioAHealthy(tmp);
  const B = runScenarioBDegraded(tmp);
  const C = runScenarioCFallback(tmp);

  console.log('P7 smoke root:', tmp);
  console.log('\n--- A (healthy) ---');
  console.log(JSON.stringify({ signals: A.signals, suggestions: A.suggestions }, null, 2));
  console.log('\n--- B (degraded/blocked) ---');
  console.log(JSON.stringify({ signals: B.signals, suggestions: B.suggestions }, null, 2));
  console.log('\n--- C (fallback frequent) ---');
  console.log(JSON.stringify({ signals: C.signals, suggestions: C.suggestions }, null, 2));
  console.log('\nP7 smoke: OK');
}

main();
