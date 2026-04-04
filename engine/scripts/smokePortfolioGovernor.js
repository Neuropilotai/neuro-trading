#!/usr/bin/env node
'use strict';

/**
 * Smoke: Portfolio Governor (P6) — three scenarios (sain / dégradé / bloqué).
 * Uses an isolated temp discoveryDir (no NEUROPILOT_DATA_ROOT mutation required).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { runPortfolioGovernor } = require('../portfolio/portfolioGovernor');

function mkStrategy(i, w) {
  return {
    setupId: `setup_smoke_${i}`,
    meta_score: 1 - i * 0.01,
    expectancy: 0.1,
    allocation_weight: w,
    expected_return: 0.1,
  };
}

function basePortfolio() {
  const strategies = [mkStrategy(1, 0.4), mkStrategy(2, 0.3), mkStrategy(3, 0.2), mkStrategy(4, 0.1)];
  return {
    strategies,
    cash_weight: 0,
    is_fully_invested: true,
    expected_return: 0.1,
    allocation_constraints: { min_weight: 0, max_weight: 1, allocation_by: 'meta_score', allow_cash_buffer: true },
  };
}

function baseMeta() {
  const strategies = Array.from({ length: 12 }, (_, i) => ({
    setupId: `meta_${i}`,
    meta_score: 1,
    expectancy: 0,
    trades: 100,
  }));
  return { experimentId: 'smoke_exp_p6', strategies };
}

function baseSupervisor(overrides = {}) {
  return {
    generatedAt: new Date().toISOString(),
    cycle_valid: true,
    cycle_invalid_reasons: [],
    mutationBudget: 40,
    holdCash: false,
    invalidResultRatio: 0.01,
    totalResultsChecked: 1000,
    validatedCount: 10,
    championCount: 5,
    ...overrides,
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function runScenario(name, tmp, { supervisor, miniReport }) {
  const discoveryDir = path.join(tmp, name);
  fs.mkdirSync(discoveryDir, { recursive: true });

  const portfolio = basePortfolio();
  const metaRanking = baseMeta();
  fs.writeFileSync(path.join(discoveryDir, 'strategy_portfolio.json'), JSON.stringify(portfolio), 'utf8');
  fs.writeFileSync(path.join(discoveryDir, 'meta_ranking.json'), JSON.stringify(metaRanking), 'utf8');
  if (miniReport) {
    fs.writeFileSync(path.join(discoveryDir, 'governance_mini_report.json'), JSON.stringify(miniReport), 'utf8');
  }

  const r = runPortfolioGovernor({
    discoveryDir,
    supervisor,
    miniReport: miniReport != null ? miniReport : undefined,
    portfolio,
    metaRanking,
    experimentId: 'smoke_exp_p6',
    applyToPortfolio: true,
  });

  const govPath = path.join(discoveryDir, 'portfolio_governor.json');
  const histPath = path.join(discoveryDir, 'portfolio_governor_history.json');
  const written = JSON.parse(fs.readFileSync(govPath, 'utf8'));
  const hist = JSON.parse(fs.readFileSync(histPath, 'utf8'));

  assert(fs.existsSync(govPath), 'portfolio_governor.json missing');
  assert(Array.isArray(hist) && hist.length >= 1, 'portfolio_governor_history.json not append array');

  const pf = JSON.parse(fs.readFileSync(path.join(discoveryDir, 'strategy_portfolio.json'), 'utf8'));

  return { written, hist, pf, discoveryDir };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np_p6_smoke_'));

  console.log('P6 smoke temp root:', tmp);

  // A — sain (supervisor OK, pas de mini rapport → OK implicite)
  const a = runScenario('A_healthy', tmp, {
    supervisor: baseSupervisor(),
    miniReport: null,
  });
  assert(a.written.governanceStatus === 'OK', 'A governanceStatus');
  assert(a.written.cycle_valid === true, 'A cycle_valid');
  assert(a.written.targetExposure === 1, 'A targetExposure');
  assert(a.written.promotionMode === 'normal', 'A promotionMode');
  assert(a.written.holdCash === false, 'A holdCash');
  assert(a.written.maxNewAllocations > 0, 'A maxNewAllocations');
  assert(a.pf.strategies.length === 4, 'A portfolio strategies preserved');

  // B — dégradé (mini DEGRADED, cycle encore valide)
  const b = runScenario('B_degraded', tmp, {
    supervisor: baseSupervisor(),
    miniReport: { governanceStatus: 'DEGRADED', experimentId: 'smoke_exp_p6' },
  });
  assert(b.written.governanceStatus === 'DEGRADED', 'B governanceStatus');
  assert(b.written.cycle_valid === true, 'B cycle_valid');
  assert(b.written.targetExposure > 0 && b.written.targetExposure < 1, 'B targetExposure reduced');
  assert(b.written.maxNewAllocations < a.written.maxNewAllocations, 'B maxNewAllocations reduced vs A');
  assert(b.written.promotionMode === 'conservative', 'B promotionMode');
  assert(b.written.holdCash === true, 'B holdCash');
  assert(b.written.admissionThresholdMultiplier > 1, 'B admissionThresholdMultiplier');
  assert(b.pf.cash_weight > 0.01, 'B partial cash in portfolio');

  // C — bloqué
  const c = runScenario('C_blocked', tmp, {
    supervisor: baseSupervisor({ cycle_valid: false, cycle_invalid_reasons: ['invalid_ratio_above_max'] }),
    miniReport: null,
  });
  assert(c.written.governanceStatus === 'BLOCKED', 'C governanceStatus');
  assert(c.written.cycle_valid === false, 'C cycle_valid');
  assert(c.written.targetExposure === 0, 'C targetExposure');
  assert(c.written.maxNewAllocations === 0, 'C maxNewAllocations');
  assert(c.written.promotionMode === 'blocked', 'C promotionMode');
  assert(c.written.holdCash === true, 'C holdCash');
  assert(c.pf.strategies.length === 0, 'C no strategies');
  assert(c.pf.cash_weight === 1, 'C full cash');

  const printProof = (label, w) => {
    console.log('\n--- Preuve', label, '---');
    console.log(JSON.stringify({
      experimentId: w.experimentId,
      governanceStatus: w.governanceStatus,
      cycle_valid: w.cycle_valid,
      targetExposure: w.targetExposure,
      maxNewAllocations: w.maxNewAllocations,
      promotionMode: w.promotionMode,
      holdCash: w.holdCash,
      decisionReasons: w.decisionReasons,
    }, null, 2));
  };

  printProof('A', a.written);
  printProof('B', b.written);
  printProof('C', c.written);

  console.log('\n--- Persistance ---');
  console.log('A portfolio_governor:', path.join(a.discoveryDir, 'portfolio_governor.json'));
  console.log('A history:', path.join(a.discoveryDir, 'portfolio_governor_history.json'));
  console.log('B portfolio_governor:', path.join(b.discoveryDir, 'portfolio_governor.json'));
  console.log('C portfolio_governor:', path.join(c.discoveryDir, 'portfolio_governor.json'));

  console.log('\nP6 smoke: OK');
}

main();
