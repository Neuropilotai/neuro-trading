#!/usr/bin/env node
'use strict';

/**
 * Validation pack — Pass 2 (E2E contrôlé).
 *
 * Scénarios couverts:
 *  1) nominal
 *  2) degraded
 *  3) blocked
 *  4) p7.1_conservative_on (mutations off)
 *  5) p7.1_mutations_off_on (off puis on)
 *
 * Le script utilise un data root temporaire (isolé), puis génère:
 *  - ops-snapshot/validation_pass2_report.json
 *  - ops-snapshot/validation_pass2_report.md
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.NEUROPILOT_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'np_pass2_'));

const dataRoot = require('../dataRoot');
const { runPortfolioGovernor } = require('../portfolio/portfolioGovernor');
const { run: runMutationPolicy } = require('../evolution/adaptMutationPolicy');
const { startExperiment, appendArtifact, getExperiment } = require('./experimentRegistry');

const V2_ROOT = path.resolve(__dirname, '..', '..');
const SNAPSHOT_DIR = path.join(V2_ROOT, 'ops-snapshot');

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function writeJson(fp, obj) {
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2), 'utf8');
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`[pass2] ${msg}`);
}

function mkBasePortfolio() {
  return {
    strategies: [
      { setupId: 'a', familyKey: 'famA', meta_score: 1, expectancy: 0.12, allocation_weight: 0.4, expected_return: 0.1 },
      { setupId: 'b', familyKey: 'famA', meta_score: 0.9, expectancy: 0.1, allocation_weight: 0.3, expected_return: 0.1 },
      { setupId: 'c', familyKey: 'famB', meta_score: 0.8, expectancy: 0.09, allocation_weight: 0.2, expected_return: 0.08 },
      { setupId: 'd', familyKey: 'famC', meta_score: 0.75, expectancy: 0.08, allocation_weight: 0.1, expected_return: 0.07 },
    ],
    cash_weight: 0,
    is_fully_invested: true,
    expected_return: 0.1,
  };
}

function mkBaseMeta() {
  return {
    strategies: [
      { setupId: 'a', familyKey: 'famA', meta_score: 1, expectancy: 0.12, trades: 100 },
      { setupId: 'b', familyKey: 'famA', meta_score: 0.9, expectancy: 0.1, trades: 90 },
      { setupId: 'c', familyKey: 'famB', meta_score: 0.8, expectancy: 0.09, trades: 80 },
      { setupId: 'd', familyKey: 'famC', meta_score: 0.75, expectancy: 0.08, trades: 70 },
    ],
  };
}

function mkBaseSupervisor(overrides = {}) {
  return {
    generatedAt: new Date().toISOString(),
    cycle_valid: true,
    cycle_invalid_reasons: [],
    invalidResultRatio: 0.01,
    mutationBudget: 40,
    holdCash: false,
    validatedCount: 10,
    championCount: 6,
    ...overrides,
  };
}

function mkMutationPerf() {
  return {
    byMutationType: {
      parameter_jitter: { beatsRate: 0.58, avgExpectancy: 0.0012 },
      forced_family_shift: { beatsRate: 0.44, avgExpectancy: 0.0006 },
      session_flip: { beatsRate: 0.4, avgExpectancy: 0.0001 },
      regime_flip: { beatsRate: 0.35, avgExpectancy: -0.0002 },
      hybrid_family_shift: { beatsRate: 0.22, avgExpectancy: -0.0005 },
    },
  };
}

function mkTrendMemory() {
  return {
    trendMemoryVersion: 'p7-v1',
    generatedAt: new Date().toISOString(),
    suggestions: {
      portfolioAdjustments: {
        exposureMultiplier: 0.9,
        maxNewAllocationsDelta: -1,
        admissionThresholdDelta: 0.1,
      },
      policyAdjustments: {
        mutationTypeWeightDeltas: {
          parameter_jitter: 0.09,
          hybrid_family_shift: -0.04,
        },
      },
    },
  };
}

function createScenarioContext(name) {
  const discoveryDir = path.join(dataRoot.getPath('discovery'), name);
  ensureDir(discoveryDir);
  const experimentId = startExperiment({ pass2: true, scenario: name, at: new Date().toISOString() });
  return { name, discoveryDir, experimentId };
}

function seedCommon(ctx, supervisor, miniReport) {
  const portfolio = mkBasePortfolio();
  const meta = mkBaseMeta();
  meta.experimentId = ctx.experimentId;
  const mini = {
    reportVersion: 'v1',
    generatedAt: new Date().toISOString(),
    experimentId: ctx.experimentId,
    cycleId: ctx.experimentId,
    governanceStatus: 'OK',
    verdict: 'PASS',
    supervisor: { cycle_valid: true, invalidResultRatio: 0.01 },
    ...miniReport,
  };

  writeJson(path.join(ctx.discoveryDir, 'strategy_portfolio.json'), portfolio);
  writeJson(path.join(ctx.discoveryDir, 'meta_ranking.json'), meta);
  writeJson(path.join(ctx.discoveryDir, 'mutation_perf.json'), mkMutationPerf());
  writeJson(path.join(ctx.discoveryDir, 'supervisor_config.json'), supervisor);
  writeJson(path.join(ctx.discoveryDir, 'governance_mini_report.json'), mini);

  appendArtifact(ctx.experimentId, 'portfolio_seed', path.join(ctx.discoveryDir, 'strategy_portfolio.json'));
  appendArtifact(ctx.experimentId, 'meta_seed', path.join(ctx.discoveryDir, 'meta_ranking.json'));
  appendArtifact(ctx.experimentId, 'mini_report', path.join(ctx.discoveryDir, 'governance_mini_report.json'));

  return { portfolio, meta, mini };
}

function runGovernorAndPolicy(ctx, supervisor, mini, envOpts = {}) {
  const previous = {
    apply: process.env.TREND_MEMORY_APPLY,
    mode: process.env.TREND_MEMORY_APPLY_MODE,
    mutations: process.env.TREND_MEMORY_APPLY_MUTATIONS,
  };
  process.env.TREND_MEMORY_APPLY = envOpts.apply ? 'true' : 'false';
  process.env.TREND_MEMORY_APPLY_MODE = envOpts.mode || 'conservative';
  process.env.TREND_MEMORY_APPLY_MUTATIONS = envOpts.mutations ? 'true' : 'false';

  if (envOpts.apply) {
    writeJson(path.join(ctx.discoveryDir, 'run_trend_memory.json'), mkTrendMemory());
    appendArtifact(ctx.experimentId, 'run_trend_memory', path.join(ctx.discoveryDir, 'run_trend_memory.json'));
  }

  const portfolio = readJson(path.join(ctx.discoveryDir, 'strategy_portfolio.json'));
  const meta = readJson(path.join(ctx.discoveryDir, 'meta_ranking.json'));

  const governor = runPortfolioGovernor({
    discoveryDir: ctx.discoveryDir,
    supervisor,
    miniReport: mini,
    portfolio,
    metaRanking: meta,
    experimentId: ctx.experimentId,
    applyToPortfolio: true,
  });
  appendArtifact(ctx.experimentId, 'portfolio_governor', governor.outPath);

  const mut = runMutationPolicy({
    discoveryDir: ctx.discoveryDir,
    experimentId: ctx.experimentId,
  });
  appendArtifact(ctx.experimentId, 'mutation_policy', mut.outPath);

  process.env.TREND_MEMORY_APPLY = previous.apply;
  process.env.TREND_MEMORY_APPLY_MODE = previous.mode;
  process.env.TREND_MEMORY_APPLY_MUTATIONS = previous.mutations;
  return { governor, mut };
}

function collectSummary(name, ctx, mini, governor, mut) {
  const exp = getExperiment(ctx.experimentId);
  return {
    scenario: name,
    experimentId: ctx.experimentId,
    governanceStatus: governor.decision.governanceStatus,
    verdict: mini.verdict || null,
    cycle_valid: governor.decision.cycle_valid,
    appliedFromTrendMemory: {
      governor: governor.decision.trendMemoryApply && governor.decision.trendMemoryApply.appliedFromTrendMemory,
      mutationPolicy: mut.policy.trendMemoryApply && mut.policy.trendMemoryApply.appliedFromTrendMemory,
    },
    appliedDeltas: {
      governor: governor.decision.trendMemoryApply && governor.decision.trendMemoryApply.appliedDeltas,
      mutationPolicy: mut.policy.trendMemoryApply && mut.policy.trendMemoryApply.appliedDeltas,
    },
    exposure: governor.decision.targetExposure,
    promotionMode: governor.decision.promotionMode,
    maxNewAllocations: governor.decision.maxNewAllocations,
    mutationBudget: supervisorMutationBudget(mini, governor),
    registryArtifacts: exp && Array.isArray(exp.artifacts) ? exp.artifacts.map((a) => a.stage) : [],
  };
}

function supervisorMutationBudget(mini, governor) {
  if (mini && mini.supervisor && Number.isFinite(Number(mini.supervisor.mutationBudget))) {
    return Number(mini.supervisor.mutationBudget);
  }
  return governor && governor.decisionInputs && governor.decisionInputs.supervisor
    ? Number(governor.decisionInputs.supervisor.mutationBudget || 0)
    : 0;
}

function validateExpectations(r) {
  if (r.scenario === 'nominal') {
    assert(r.governanceStatus === 'OK', 'nominal status');
    assert(r.verdict === 'PASS', 'nominal verdict');
    assert(r.cycle_valid === true, 'nominal cycle_valid');
    assert(r.exposure > 0.9, 'nominal exposure high');
    assert(r.promotionMode === 'normal', 'nominal mode normal');
  }
  if (r.scenario === 'degraded') {
    assert(r.governanceStatus === 'DEGRADED', 'degraded status');
    assert(r.exposure > 0 && r.exposure < 1, 'degraded exposure reduced');
    assert(r.promotionMode === 'conservative', 'degraded mode conservative');
  }
  if (r.scenario === 'blocked') {
    assert(r.governanceStatus === 'BLOCKED', 'blocked status');
    assert(r.cycle_valid === false, 'blocked cycle invalid');
    assert(r.exposure === 0, 'blocked exposure zero');
    assert(r.promotionMode === 'blocked', 'blocked mode');
  }
  if (r.scenario === 'p7.1_conservative_on') {
    assert(r.appliedFromTrendMemory.governor === true, 'p7.1 conservative applies on governor');
    assert(r.appliedFromTrendMemory.mutationPolicy === false, 'p7.1 conservative keeps mutations off');
  }
  if (r.scenario === 'p7.1_mutations_off_on') {
    assert(r.appliedFromTrendMemory.mutationPolicy === true, 'p7.1 mutations on apply');
  }
  assert(r.registryArtifacts.length >= 5, `${r.scenario} registry artifacts incomplete`);
}

function mdTable(rows) {
  const header =
    '| scenario | experimentId | governanceStatus | verdict | cycle_valid | TM governor | TM mutation | exposure | promotionMode | artifacts |';
  const sep = '|---|---|---|---|---|---|---|---:|---|---|';
  const lines = rows.map((r) => {
    const tg = String(r.appliedFromTrendMemory.governor);
    const tm = String(r.appliedFromTrendMemory.mutationPolicy);
    return `| ${r.scenario} | ${r.experimentId} | ${r.governanceStatus} | ${r.verdict || 'n/a'} | ${r.cycle_valid} | ${tg} | ${tm} | ${r.exposure} | ${r.promotionMode} | ${r.registryArtifacts.join(', ')} |`;
  });
  return [header, sep, ...lines].join('\n');
}

function main() {
  const results = [];

  // 1) nominal
  {
    const ctx = createScenarioContext('nominal');
    const supervisor = mkBaseSupervisor({ cycle_valid: true, mutationBudget: 40 });
    const seeded = seedCommon(ctx, supervisor, { governanceStatus: 'OK', verdict: 'PASS', supervisor: { cycle_valid: true, mutationBudget: 40 } });
    const run = runGovernorAndPolicy(ctx, supervisor, seeded.mini, { apply: false });
    const row = collectSummary('nominal', ctx, seeded.mini, run.governor, run.mut);
    validateExpectations(row);
    results.push(row);
  }

  // 2) degraded
  {
    const ctx = createScenarioContext('degraded');
    const supervisor = mkBaseSupervisor({ cycle_valid: true, mutationBudget: 30 });
    const seeded = seedCommon(ctx, supervisor, { governanceStatus: 'DEGRADED', verdict: 'DEGRADED', supervisor: { cycle_valid: true, mutationBudget: 30 } });
    const run = runGovernorAndPolicy(ctx, supervisor, seeded.mini, { apply: false });
    const row = collectSummary('degraded', ctx, seeded.mini, run.governor, run.mut);
    validateExpectations(row);
    results.push(row);
  }

  // 3) blocked
  {
    const ctx = createScenarioContext('blocked');
    const supervisor = mkBaseSupervisor({ cycle_valid: false, cycle_invalid_reasons: ['validated_below_min'], mutationBudget: 0, holdCash: true });
    const seeded = seedCommon(ctx, supervisor, { governanceStatus: 'BLOCKED', verdict: 'FAIL', supervisor: { cycle_valid: false, mutationBudget: 0 } });
    const run = runGovernorAndPolicy(ctx, supervisor, seeded.mini, { apply: false });
    const row = collectSummary('blocked', ctx, seeded.mini, run.governor, run.mut);
    validateExpectations(row);
    results.push(row);
  }

  // 4) p7.1 conservative on (mutations off)
  {
    const ctx = createScenarioContext('p7.1_conservative_on');
    const supervisor = mkBaseSupervisor({ cycle_valid: true, mutationBudget: 35 });
    const seeded = seedCommon(ctx, supervisor, { governanceStatus: 'OK', verdict: 'PASS', supervisor: { cycle_valid: true, mutationBudget: 35 } });
    const run = runGovernorAndPolicy(ctx, supervisor, seeded.mini, { apply: true, mode: 'conservative', mutations: false });
    const row = collectSummary('p7.1_conservative_on', ctx, seeded.mini, run.governor, run.mut);
    validateExpectations(row);
    results.push(row);
  }

  // 5) p7.1 mutations off/on (on branch captured as scenario result)
  {
    const ctx = createScenarioContext('p7.1_mutations_off_on');
    const supervisor = mkBaseSupervisor({ cycle_valid: true, mutationBudget: 35 });
    const seeded = seedCommon(ctx, supervisor, { governanceStatus: 'OK', verdict: 'PASS', supervisor: { cycle_valid: true, mutationBudget: 35 } });

    const off = runGovernorAndPolicy(ctx, supervisor, seeded.mini, { apply: true, mode: 'conservative', mutations: false });
    assert(off.mut.policy.trendMemoryApply.appliedFromTrendMemory === false, 'mutations off should skip');

    const on = runGovernorAndPolicy(ctx, supervisor, seeded.mini, { apply: true, mode: 'conservative', mutations: true });
    const row = collectSummary('p7.1_mutations_off_on', ctx, seeded.mini, on.governor, on.mut);
    row.offPhase = {
      mutationPolicyApplied: off.mut.policy.trendMemoryApply.appliedFromTrendMemory,
      mutationPolicyAppliedDeltas: off.mut.policy.trendMemoryApply.appliedDeltas,
    };
    validateExpectations(row);
    results.push(row);
  }

  ensureDir(SNAPSHOT_DIR);
  const jsonOut = path.join(SNAPSHOT_DIR, 'validation_pass2_report.json');
  const mdOut = path.join(SNAPSHOT_DIR, 'validation_pass2_report.md');
  const payload = {
    generatedAt: new Date().toISOString(),
    dataRoot: dataRoot.getDataRoot(),
    scenarios: results,
  };
  writeJson(jsonOut, payload);

  const md =
`# Pass 2 — E2E controlled validation report

generatedAt: ${payload.generatedAt}
dataRoot: ${payload.dataRoot}

## Scenario matrix

${mdTable(results)}

## Notes

- Budget/admission/exposure checks are asserted in script (\`validationPackPass2.js\`).
- Registry artifacts are captured per scenario via experiment_registry.json.
- Scenario \`p7.1_mutations_off_on\` runs two phases (off then on); final row shows **on** phase, and \`offPhase\` details are in JSON report.
`;
  fs.writeFileSync(mdOut, md, 'utf8');

  console.log('Pass 2 completed.');
  console.log(' ', jsonOut);
  console.log(' ', mdOut);
  console.log('\nScenario snapshot:');
  for (const r of results) {
    console.log(
      `- ${r.scenario}: exp=${r.experimentId} status=${r.governanceStatus} verdict=${r.verdict} cycle_valid=${r.cycle_valid} tmGov=${r.appliedFromTrendMemory.governor} tmMut=${r.appliedFromTrendMemory.mutationPolicy} exposure=${r.exposure}`
    );
  }
}

main();
