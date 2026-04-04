'use strict';

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function listBatchFiles(batchDir) {
  if (!fs.existsSync(batchDir)) return [];
  return fs
    .readdirSync(batchDir)
    .filter((f) => /^strategy_batch_results_.*\.json$/i.test(f))
    .map((f) => path.join(batchDir, f));
}

function readState(config = {}) {
  const discoveryDir = config.discoveryDir || dataRoot.getPath('discovery');
  const championDir = config.championDir || dataRoot.getPath('champion_setups');
  const batchDir = config.batchDir || dataRoot.getPath('batch_results');
  const governanceDir = config.governanceDir || dataRoot.getPath('governance');

  const meta = safeReadJson(path.join(discoveryDir, 'meta_ranking.json'));
  const registry = safeReadJson(path.join(championDir, 'champion_registry.json'));
  const mutationPolicy = safeReadJson(path.join(discoveryDir, 'mutation_policy.json'));
  const experiments = safeReadJson(path.join(governanceDir, 'experiment_registry.json'));

  const batchFiles = listBatchFiles(batchDir);
  let totalResultsChecked = 0;
  let invalidResults = 0;
  for (const file of batchFiles) {
    const j = safeReadJson(file);
    if (!j || !Array.isArray(j.results)) continue;
    for (const r of j.results) {
      totalResultsChecked += 1;
      if (r && r.backtestInvalid === true) invalidResults += 1;
    }
  }

  return {
    discoveryDir,
    batchDir,
    meta,
    registry,
    mutationPolicy,
    experiments,
    totalResultsChecked,
    invalidResults,
  };
}

function computeDecisions(state) {
  const total = state.totalResultsChecked || 0;
  const invalidRatio = total > 0 ? state.invalidResults / total : 0;
  const strategyCount =
    state.meta && Array.isArray(state.meta.strategies) ? state.meta.strategies.length : 0;
  const validatedCount = Number(
    (state.registry && state.registry.validatedCount) ||
      ((state.registry && Array.isArray(state.registry.validated) && state.registry.validated.length) || 0)
  ) || 0;
  const championCount = Number(
    (state.registry && state.registry.championsCount) ||
      ((state.registry && Array.isArray(state.registry.champions) && state.registry.champions.length) || 0)
  ) || 0;
  const byMutationType =
    state.mutationPolicy &&
    state.mutationPolicy.byMutationType &&
    typeof state.mutationPolicy.byMutationType === 'object'
      ? state.mutationPolicy.byMutationType
      : null;

  let cycleValid = true;
  const reasons = [];
  const minValidated = Math.max(0, Number(process.env.SUPERVISOR_MIN_VALIDATED || 5));
  const minChampions = Math.max(0, Number(process.env.SUPERVISOR_MIN_CHAMPIONS || 2));
  const maxInvalidRatio = Math.max(
    0,
    Math.min(1, Number(process.env.SUPERVISOR_MAX_INVALID_RATIO || 0.2))
  );

  if (strategyCount === 0) {
    reasons.push('no_meta_strategies');
  }
  if (invalidRatio > maxInvalidRatio) {
    reasons.push('invalid_ratio_above_max');
  }
  if (validatedCount < minValidated) {
    reasons.push('validated_below_min');
  }
  if (championCount < minChampions) {
    reasons.push('champions_below_min');
  }
  cycleValid = reasons.length === 0;

  const baseBudget = Math.max(1, Number(process.env.SUPERVISOR_BASE_BUDGET || 40));
  const minBudget = Math.max(1, Number(process.env.SUPERVISOR_MIN_BUDGET || 2));
  const maxBudget = Math.max(minBudget, Number(process.env.SUPERVISOR_MAX_BUDGET || 80));
  const qualityRaw =
    (validatedCount / Math.max(minValidated, 1) + championCount / Math.max(minChampions, 1)) / 2;
  const qualityMultiplier = Math.max(
    0.5,
    Math.min(1.5, Number.isFinite(qualityRaw) ? qualityRaw : 1)
  );
  const delta =
    state.registry &&
    state.registry.metadata &&
    Number.isFinite(Number(state.registry.metadata.learningScore))
      ? Number(state.registry.metadata.learningScore)
      : 0;
  const deltaMultiplier = Math.max(0.8, Math.min(1.2, 1 + delta * 20));
  const rawBudget = baseBudget * (1 - invalidRatio) * qualityMultiplier * deltaMultiplier;
  const mutationBudget = Math.max(
    minBudget,
    Math.min(maxBudget, Math.floor(rawBudget))
  );

  return {
    generatedAt: new Date().toISOString(),
    cycle_valid: cycleValid,
    degradedReason: reasons.length ? reasons.join(',') : null,
    cycle_invalid_reasons: reasons,
    mutationBudget,
    mutationTypeWeights: byMutationType || {},
    holdCash: !cycleValid,
    invalidResultRatio: Number(invalidRatio.toFixed(6)),
    totalResultsChecked: total,
    validatedCount,
    championCount,
    budgetFormulaVersion: 'v1_base_x_invalid_x_quality_x_delta',
    budgetInputs: {
      baseBudget,
      minBudget,
      maxBudget,
      qualityMultiplier: Number(qualityMultiplier.toFixed(6)),
      deltaMultiplier: Number(deltaMultiplier.toFixed(6)),
      invalidRatio: Number(invalidRatio.toFixed(6)),
      learningScore: delta,
      rawBudget: Number(rawBudget.toFixed(6)),
    },
    familiesToExpand:
      state.mutationPolicy &&
      Array.isArray(state.mutationPolicy.familiesToExpand) &&
      state.mutationPolicy.familiesToExpand.length
        ? state.mutationPolicy.familiesToExpand
        : 'all',
  };
}

function writeSupervisorConfig(outPath, decisions) {
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(decisions, null, 2), 'utf8');
  return outPath;
}

function run(config = {}) {
  const state = readState(config);
  const decisions = computeDecisions(state);
  const outPath = path.join(state.discoveryDir, 'supervisor_config.json');
  writeSupervisorConfig(outPath, decisions);
  return { state, decisions, outPath };
}

module.exports = {
  readState,
  computeDecisions,
  writeSupervisorConfig,
  run,
};

if (require.main === module) {
  try {
    const result = run();
    console.log('Research Supervisor done.');
    console.log('  cycle_valid:', result.decisions.cycle_valid);
    console.log('  invalidResultRatio:', result.decisions.invalidResultRatio);
    console.log('  out:', result.outPath);
  } catch (err) {
    console.error('Research Supervisor failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}
