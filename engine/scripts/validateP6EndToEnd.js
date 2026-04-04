#!/usr/bin/env node
'use strict';

/**
 * Validation d'intégration P6 sur le DATA_ROOT réel (ex. data_workspace).
 *
 * Enchaîne : Research Supervisor → Portfolio Governor → appendArtifact(registry)
 * → buildPromotedChildren → generateGovernanceMiniReport (buildReport + write).
 *
 * Pendant le governor uniquement : retrait temporaire de governance_mini_report.json
 * (évite un statut BLOCKED obsolète ; équivalent milieu de pipeline).
 *
 * Usage:
 *   cd neuropilot_trading_v2 && node engine/scripts/validateP6EndToEnd.js
 *   node engine/scripts/validateP6EndToEnd.js --keep-changes
 *
 * Si le supervisor marque cycle_valid=false (seuils prod), le governor sera blocked — c’est attendu.
 * Pour forcer un chemin « normal » sur un workspace de dev (démonstration uniquement) :
 *   node engine/scripts/validateP6EndToEnd.js --relax-supervisor
 * (fixe SUPERVISOR_MIN_VALIDATED=0 et SUPERVISOR_MIN_CHAMPIONS=0 pour ce processus seulement).
 *
 * Modes conservative / blocked : `node engine/scripts/smokePortfolioGovernor.js`
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const { run: runSupervisor } = require('../supervisor/researchSupervisor');
const { runPortfolioGovernor } = require('../portfolio/portfolioGovernor');
const { startExperiment, appendArtifact, getExperiment } = require('../governance/experimentRegistry');
const { buildReport } = require('./generateGovernanceMiniReport');
const { buildPromotedChildren } = require('../evolution/buildPromotedChildren');

function backupIfExists(fp) {
  const bak = `${fp}.bak_p6e2e`;
  if (fs.existsSync(fp)) {
    fs.copyFileSync(fp, bak);
    return true;
  }
  return false;
}

function restoreIfBacked(fp) {
  const bak = `${fp}.bak_p6e2e`;
  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, fp);
    fs.unlinkSync(bak);
  }
}

function removeIfExists(fp) {
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`[P6 E2E] ${msg}`);
}

function main() {
  const keepChanges = process.argv.includes('--keep-changes');
  if (process.argv.includes('--relax-supervisor')) {
    if (process.env.SUPERVISOR_MIN_VALIDATED === undefined) process.env.SUPERVISOR_MIN_VALIDATED = '0';
    if (process.env.SUPERVISOR_MIN_CHAMPIONS === undefined) process.env.SUPERVISOR_MIN_CHAMPIONS = '0';
    console.log('[P6 E2E] --relax-supervisor: min validated/champions = 0 (démo uniquement)');
  }
  const discoveryDir = dataRoot.getPath('discovery');
  const root = dataRoot.getDataRoot();

  const paths = {
    mini: path.join(discoveryDir, 'governance_mini_report.json'),
    portfolio: path.join(discoveryDir, 'strategy_portfolio.json'),
    governor: path.join(discoveryDir, 'portfolio_governor.json'),
    governorHist: path.join(discoveryDir, 'portfolio_governor_history.json'),
    promoted: path.join(discoveryDir, 'promoted_children.json'),
  };

  const miniHidden = `${paths.mini}.hidden_p6_e2e`;
  const miniExistedAtStart = fs.existsSync(paths.mini);

  const hadBackup = {
    portfolio: backupIfExists(paths.portfolio),
    promoted: backupIfExists(paths.promoted),
    governor: backupIfExists(paths.governor),
    hist: backupIfExists(paths.governorHist),
  };

  let miniStashed = false;
  try {
    if (miniExistedAtStart) {
      fs.renameSync(paths.mini, miniHidden);
      miniStashed = true;
    }

    const experimentId = startExperiment({
      p6EndToEndValidation: true,
      dataRoot: root,
      at: new Date().toISOString(),
    });
    process.env.EXPERIMENT_ID = experimentId;

    console.log('[P6 E2E] EXPERIMENT_ID=', experimentId);
    console.log('[P6 E2E] discoveryDir=', discoveryDir);

    const sup = runSupervisor();
    assert(sup && sup.decisions, 'supervisor run failed');
    console.log('[P6 E2E] supervisor cycle_valid=', sup.decisions.cycle_valid);

    runPortfolioGovernor({ discoveryDir, experimentId });
    assert(fs.existsSync(paths.governor), 'portfolio_governor.json not written');
    const gov = readJson(paths.governor);
    assert(gov && gov.governorVersion, 'invalid portfolio_governor.json');
    assert(
      gov.experimentId === experimentId,
      `experimentId mismatch governor=${gov.experimentId} vs run=${experimentId}`
    );

    const appended = appendArtifact(
      experimentId,
      'portfolio_governor',
      path.join(root, 'discovery/portfolio_governor.json')
    );
    assert(appended, 'appendArtifact portfolio_governor failed');

    const exp = getExperiment(experimentId);
    assert(exp && Array.isArray(exp.artifacts), 'experiment not found after append');
    assert(
      exp.artifacts.some((a) => a && a.stage === 'portfolio_governor'),
      'portfolio_governor missing from experiment artifacts'
    );

    buildPromotedChildren();
    const promoted = readJson(paths.promoted);
    assert(promoted, 'promoted_children.json missing');
    assert(
      promoted.portfolioGovernor && promoted.portfolioGovernor.promotionMode === gov.promotionMode,
      'promoted_children.portfolioGovernor.promotionMode mismatch'
    );

    const pf = readJson(paths.portfolio);
    assert(pf && pf.portfolio_governor_applied === true, 'strategy_portfolio missing portfolio_governor_applied');
    assert(pf.portfolioGovernor && pf.portfolioGovernor.governorVersion, 'strategy_portfolio missing portfolioGovernor trace');
    assert(
      Array.isArray(pf.strategies) && pf.strategies.length <= gov.maxNewAllocations,
      `strategy count ${pf.strategies.length} exceeds maxNewAllocations ${gov.maxNewAllocations}`
    );

    process.env.PIPELINE_EXIT_CODE = '0';
    process.env.PIPELINE_DURATION_MS = '0';
    const miniReport = buildReport();
    assert(
      miniReport.portfolioGovernor && miniReport.portfolioGovernor.governorVersion,
      'governance mini build missing portfolioGovernor section'
    );
    fs.writeFileSync(paths.mini, JSON.stringify(miniReport, null, 2), 'utf8');

    console.log('\n=== P6 E2E — critères de clôture ===\n');
    console.log(JSON.stringify({
      experimentId: gov.experimentId,
      governorArtifactInRegistry: true,
      portfolioGovernorFile: paths.governor,
      governanceMiniPortfolioGovernor: miniReport.portfolioGovernor,
      strategyPortfolioTrace: {
        portfolio_governor_applied: pf.portfolio_governor_applied,
        strategies: pf.strategies.length,
        maxNewAllocations: gov.maxNewAllocations,
        cash_weight: pf.cash_weight,
        promotionMode: gov.promotionMode,
      },
      promotedChildren: {
        promotionMode: promoted.portfolioGovernor.promotionMode,
        minDistinctBatchFiles: promoted.minDistinctBatchFiles,
        promoted: promoted.promoted,
      },
    }, null, 2));

    console.log('\n[P6 E2E] OK — supervisor → governor → registry → promotions → mini report');
    console.log('[P6 E2E] Modes conservative/blocked : node engine/scripts/smokePortfolioGovernor.js');
  } finally {
    if (!keepChanges) {
      if (hadBackup.portfolio) restoreIfBacked(paths.portfolio);
      if (hadBackup.promoted) restoreIfBacked(paths.promoted);
      if (hadBackup.governor) restoreIfBacked(paths.governor);
      else removeIfExists(paths.governor);
      if (hadBackup.hist) restoreIfBacked(paths.governorHist);
      else removeIfExists(paths.governorHist);

      if (miniStashed && fs.existsSync(miniHidden)) {
        removeIfExists(paths.mini);
        fs.renameSync(miniHidden, paths.mini);
      } else if (!miniExistedAtStart && fs.existsSync(paths.mini)) {
        removeIfExists(paths.mini);
      }
    } else if (miniStashed && fs.existsSync(miniHidden)) {
      removeIfExists(miniHidden);
    }
  }
}

main();
