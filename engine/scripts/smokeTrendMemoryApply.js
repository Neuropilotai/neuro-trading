#!/usr/bin/env node
'use strict';

/**
 * P7.1 smoke: TREND_MEMORY_APPLY sur P6 (conservative = portfolio only) et P5 (mutations si flag).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { runPortfolioGovernor } = require('../portfolio/portfolioGovernor');
const { run: runMutationPolicy } = require('../evolution/adaptMutationPolicy');

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function writeJson(p, o) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8');
}

function assert(c, m) {
  if (!c) throw new Error(m);
}

function baseSupervisorHealthy() {
  return {
    cycle_valid: true,
    cycle_invalid_reasons: [],
    invalidResultRatio: 0.02,
    holdCash: false,
    validatedCount: 10,
    championCount: 5,
    mutationBudget: 40,
  };
}

function trendMemoryAggressivePortfolio() {
  return {
    trendMemoryVersion: 'p7-v1',
    generatedAt: new Date().toISOString(),
    suggestions: {
      policyAdjustments: {
        mutationTypeWeightDeltas: { parameter_jitter: 0.09, hybrid_family_shift: -0.04 },
      },
      portfolioAdjustments: {
        exposureMultiplier: 0.92,
        maxNewAllocationsDelta: -1,
        admissionThresholdDelta: 0.08,
      },
    },
  };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np_p71_smoke_'));
  const discoveryDir = path.join(tmp, 'discovery');
  ensureDir(discoveryDir);

  writeJson(path.join(discoveryDir, 'run_trend_memory.json'), trendMemoryAggressivePortfolio());

  const portfolio = {
    strategies: [
      { setupId: 'a', meta_score: 1, expectancy: 0.1, allocation_weight: 0.34, expected_return: 0.1 },
      { setupId: 'b', meta_score: 0.9, expectancy: 0.1, allocation_weight: 0.33, expected_return: 0.1 },
      { setupId: 'c', meta_score: 0.8, expectancy: 0.1, allocation_weight: 0.33, expected_return: 0.1 },
    ],
    cash_weight: 0,
    is_fully_invested: true,
    expected_return: 0.1,
  };
  writeJson(path.join(discoveryDir, 'strategy_portfolio.json'), portfolio);
  writeJson(path.join(discoveryDir, 'meta_ranking.json'), {
    experimentId: 'exp_p71',
    strategies: portfolio.strategies,
  });

  process.env.TREND_MEMORY_APPLY = 'true';
  process.env.TREND_MEMORY_APPLY_MODE = 'conservative';

  const r = runPortfolioGovernor({
    discoveryDir,
    supervisor: baseSupervisorHealthy(),
    miniReport: { governanceStatus: 'OK' },
    portfolio,
    metaRanking: { experimentId: 'exp_p71', strategies: portfolio.strategies },
    experimentId: 'exp_p71',
  });

  assert(r.decision.trendMemoryApply.appliedFromTrendMemory === true, 'P6 should apply trend');
  assert(
    r.decision.targetExposure < 1 && r.decision.targetExposure > 0.9,
    'targetExposure should shrink slightly'
  );
  assert(r.decision.maxNewAllocations === 2, 'maxNewAllocations should be 3-1');
  assert(
    r.decision.admissionThresholdMultiplier > 1 && r.decision.admissionThresholdMultiplier <= 1.1,
    'admission mult should increase slightly'
  );

  // P5: conservative sans mutations -> pas d'apply sur poids
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

  const mp = runMutationPolicy({ discoveryDir, experimentId: 'exp_p71' });
  assert(mp.policy.trendMemoryApply.appliedFromTrendMemory === false, 'P5 conservative skips mutations');
  assert(
    mp.policy.trendMemoryApply.appliedDeltas &&
      mp.policy.trendMemoryApply.appliedDeltas.skipped === true,
    'P5 should record skipped mutations'
  );

  // P5: avec mutations explicites
  process.env.TREND_MEMORY_APPLY_MUTATIONS = 'true';
  const mp2 = runMutationPolicy({ discoveryDir, experimentId: 'exp_p71' });
  assert(mp2.policy.trendMemoryApply.appliedFromTrendMemory === true, 'P5 should apply mutation deltas');
  assert(
    mp2.policy.byMutationType.parameter_jitter > mp.policy.byMutationType.parameter_jitter,
    'parameter_jitter should increase'
  );

  console.log('P7.1 smoke OK');
  console.log('  tmp:', tmp);
  console.log('  governor trendMemoryApply:', JSON.stringify(r.decision.trendMemoryApply, null, 2));
}

main();
