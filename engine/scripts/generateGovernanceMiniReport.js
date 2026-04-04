#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const { getExperiment, listExperiments } = require('../governance/experimentRegistry');
const { writeLastCompletedCycle } = require('../governance/cycleContext');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function archiveMiniReport(discoveryDir, report) {
  const reportsDir = path.join(discoveryDir, 'reports');
  ensureDir(reportsDir);
  const experimentId =
    report && report.experimentId ? String(report.experimentId) : `unknown_${Date.now()}`;
  const archivePath = path.join(reportsDir, `governance_mini_report_${experimentId}.json`);
  fs.writeFileSync(archivePath, JSON.stringify(report, null, 2), 'utf8');

  const maxFiles = Math.max(1, Number(process.env.TREND_MEMORY_MAX_FILES || 200));
  const files = fs
    .readdirSync(reportsDir)
    .filter((f) => /^governance_mini_report_.*\.json$/i.test(f))
    .map((f) => path.join(reportsDir, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);

  while (files.length > maxFiles) {
    const victim = files.shift();
    try {
      fs.unlinkSync(victim);
    } catch {
      break;
    }
  }

  return archivePath;
}

function listBatchFiles(batchDir) {
  if (!fs.existsSync(batchDir)) return [];
  return fs
    .readdirSync(batchDir)
    .filter((f) => /^strategy_batch_results_.*\.json$/i.test(f))
    .map((f) => path.join(batchDir, f))
    .sort();
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function resolveExperimentId() {
  if (process.env.EXPERIMENT_ID && String(process.env.EXPERIMENT_ID).trim()) {
    return String(process.env.EXPERIMENT_ID).trim();
  }
  const latest = listExperiments(1);
  return latest.length ? String(latest[0].experimentId) : null;
}

function inferExpansionStatus(supervisor, familyExpansionReport) {
  if (supervisor && supervisor.cycle_valid === false) {
    return 'skipped_due_to_cycle_invalid';
  }
  if (!familyExpansionReport) return 'unknown';
  if (Number(familyExpansionReport.files_written || 0) > 0) return 'executed';
  return 'executed_zero_output';
}

function buildReport() {
  const root = dataRoot.getDataRoot();
  const discoveryDir = dataRoot.getPath('discovery');
  const championDir = dataRoot.getPath('champion_setups');
  const batchDir = dataRoot.getPath('batch_results');

  const experimentId = resolveExperimentId();
  const experiment = experimentId ? getExperiment(experimentId) : null;

  const meta = readJson(path.join(discoveryDir, 'meta_ranking.json'));
  const registry = readJson(path.join(championDir, 'champion_registry.json'));
  const supervisor = readJson(path.join(discoveryDir, 'supervisor_config.json'));
  const expansion = readJson(path.join(discoveryDir, 'family_expansion_report.json'));
  const portfolioGovernor = readJson(path.join(discoveryDir, 'portfolio_governor.json'));
  const mutationPolicy = readJson(path.join(discoveryDir, 'mutation_policy.json'));

  const batchFiles = listBatchFiles(batchDir);
  const batchExperimentIds = [];
  const datasetVersionIds = [];
  for (const file of batchFiles) {
    const j = readJson(file);
    if (!j) continue;
    if (j.experimentId) batchExperimentIds.push(String(j.experimentId));
    if (Array.isArray(j.results)) {
      for (const row of j.results) {
        if (row && row.datasetVersionId) datasetVersionIds.push(String(row.datasetVersionId));
      }
    }
  }

  const artifacts = experiment && Array.isArray(experiment.artifacts) ? experiment.artifacts : [];
  const stagesPresent = uniq(artifacts.map((a) => a && a.stage));
  const requiredStages = ['discovery', 'meta', 'portfolio', 'registry', 'ops_snapshot'];
  const missingStages = requiredStages.filter((s) => !stagesPresent.includes(s));

  const mutationBudget = Number(supervisor && supervisor.mutationBudget);
  const filesWritten = Number(expansion && expansion.files_written);
  const budgetRespected =
    Number.isFinite(mutationBudget) && Number.isFinite(filesWritten)
      ? filesWritten <= mutationBudget
      : null;

  const exitCode = Number(process.env.PIPELINE_EXIT_CODE || 0);
  const durationMs = Number(process.env.PIPELINE_DURATION_MS || 0);
  const cycleValid = !!(supervisor && supervisor.cycle_valid === true);
  const hasReasons =
    !!(supervisor && Array.isArray(supervisor.cycle_invalid_reasons) && supervisor.cycle_invalid_reasons.length);

  let governanceStatus = 'OK';
  if (
    exitCode !== 0 ||
    !experimentId ||
    !meta ||
    !registry ||
    !meta.experimentId ||
    !registry.experimentId ||
    missingStages.length > 0 ||
    budgetRespected === false
  ) {
    governanceStatus = 'BLOCKED';
  } else if (!cycleValid || hasReasons || inferExpansionStatus(supervisor, expansion) !== 'executed') {
    governanceStatus = 'DEGRADED';
  }

  const verdict =
    governanceStatus === 'OK' ? 'PASS' : governanceStatus === 'DEGRADED' ? 'DEGRADED' : 'FAIL';

  return {
    reportVersion: 'v1',
    generatorVersion: 'v1',
    generatedAt: new Date().toISOString(),
    dataRoot: root,
    experimentId: experimentId || null,
    /** Stable pipeline cycle id for this run (same as experimentId when set). */
    cycleId: experimentId || null,
    governanceStatus,
    verdict,
    identity: {
      metaExperimentId: (meta && meta.experimentId) || null,
      registryExperimentId: (registry && registry.experimentId) || null,
      batchExperimentIds: uniq(batchExperimentIds),
      datasetVersionIds: uniq(datasetVersionIds),
    },
    supervisor: {
      cycle_valid: supervisor ? supervisor.cycle_valid : null,
      cycle_invalid_reasons: supervisor && Array.isArray(supervisor.cycle_invalid_reasons)
        ? supervisor.cycle_invalid_reasons
        : [],
      validatedCount: supervisor ? supervisor.validatedCount : null,
      championCount: supervisor ? supervisor.championCount : null,
      invalidResultRatio: supervisor ? supervisor.invalidResultRatio : null,
      holdCash: supervisor ? supervisor.holdCash : null,
    },
    budgetAudit: {
      budgetFormulaVersion: supervisor ? supervisor.budgetFormulaVersion || null : null,
      rawBudget:
        supervisor &&
        supervisor.budgetInputs &&
        supervisor.budgetInputs.rawBudget != null
          ? supervisor.budgetInputs.rawBudget
          : null,
      mutationBudget: Number.isFinite(mutationBudget) ? mutationBudget : null,
      files_written: Number.isFinite(filesWritten) ? filesWritten : null,
      budgetRespected,
    },
    expansion: {
      status: inferExpansionStatus(supervisor, expansion),
      leaders_selected: expansion ? expansion.leaders_selected : null,
      familiesToExpand: supervisor ? supervisor.familiesToExpand : null,
      fallbackApplied:
        expansion && typeof expansion.fallbackApplied === 'boolean'
          ? expansion.fallbackApplied
          : (supervisor && typeof supervisor.fallbackApplied === 'boolean'
            ? supervisor.fallbackApplied
            : false),
      fallbackReason:
        (expansion && expansion.fallbackReason) ||
        (supervisor && supervisor.fallbackReason) ||
        null,
      originalFamiliesToExpand:
        (expansion && expansion.originalFamiliesToExpand) ||
        (supervisor && supervisor.originalFamiliesToExpand) ||
        null,
      effectiveFamiliesToExpand:
        (expansion && expansion.effectiveFamiliesToExpand) ||
        (supervisor && supervisor.effectiveFamiliesToExpand) ||
        null,
    },
    registry: {
      stagesPresent,
      missingStages,
      artifactsWritten: artifacts.length,
    },
    portfolioGovernor: portfolioGovernor
      ? {
          governorVersion: portfolioGovernor.governorVersion || null,
          governanceStatus: portfolioGovernor.governanceStatus || null,
          cycle_valid: portfolioGovernor.cycle_valid,
          targetExposure: portfolioGovernor.targetExposure,
          maxNewAllocations: portfolioGovernor.maxNewAllocations,
          promotionMode: portfolioGovernor.promotionMode || null,
          holdCash: portfolioGovernor.holdCash,
          generatedAt: portfolioGovernor.generatedAt || null,
          trendMemoryApply: portfolioGovernor.trendMemoryApply || null,
        }
      : null,
    trendMemoryApply: {
      envEnabled: String(process.env.TREND_MEMORY_APPLY || '').toLowerCase() === 'true',
      envMode: process.env.TREND_MEMORY_APPLY_MODE || null,
      envMutationsEnabled: String(process.env.TREND_MEMORY_APPLY_MUTATIONS || '').toLowerCase() === 'true',
      governor: portfolioGovernor && portfolioGovernor.trendMemoryApply ? portfolioGovernor.trendMemoryApply : null,
      mutationPolicy: mutationPolicy && mutationPolicy.trendMemoryApply ? mutationPolicy.trendMemoryApply : null,
    },
    exitSummary: {
      exit_code: exitCode,
      duration_ms: Number.isFinite(durationMs) ? durationMs : 0,
      artifacts_written: artifacts.length,
    },
  };
}

function main() {
  try {
    const report = buildReport();
    const discoveryDir = dataRoot.getPath('discovery');
    const outPath = path.join(discoveryDir, 'governance_mini_report.json');
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    const archivePath = archiveMiniReport(discoveryDir, report);
    if (report.cycleId) {
      writeLastCompletedCycle(report.cycleId);
    }
    console.log(`Governance mini report: ${outPath}`);
    console.log(`Governance mini archived: ${archivePath}`);
    console.log(`  governanceStatus=${report.governanceStatus} verdict=${report.verdict}`);
  } catch (err) {
    console.error('generateGovernanceMiniReport failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
};
