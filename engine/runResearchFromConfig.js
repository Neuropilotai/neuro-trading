'use strict';

/**
 * NeuroPilot Quant Engine v1 — Research Run From Config
 *
 * Practical entry point for research runs using named dataset groups from researchConfig.
 * Pure orchestrator over config + runResearch; no database writes.
 */

const researchConfig = require('./researchConfig');
const runResearch = require('./runResearch');

const DEFAULT_GROUP = 'us_indices_core';

/**
 * Resolve requested dataset group with safe fallback to DEFAULT_GROUP.
 *
 * @param {string} [groupName] - Requested group name
 * @returns {{ requestedGroup: string, resolvedGroup: string, usedDefaultGroup: boolean, availableGroups: string[] }}
 */
function resolveGroup(groupName) {
  const availableGroups = researchConfig.listDatasetGroups();
  const requestedGroup = typeof groupName === 'string' && groupName.trim()
    ? groupName.trim()
    : DEFAULT_GROUP;
  const hasRequested = availableGroups.includes(requestedGroup);
  const hasDefault = availableGroups.includes(DEFAULT_GROUP);
  const resolvedGroup = hasRequested ? requestedGroup : (hasDefault ? DEFAULT_GROUP : requestedGroup);
  return {
    requestedGroup,
    resolvedGroup,
    usedDefaultGroup: resolvedGroup !== requestedGroup,
    availableGroups,
  };
}

/**
 * Run research from a configured dataset group.
 *
 * @param {string} [groupName] - Dataset group name; defaults to "us_indices_core"
 * @param {object} [options] - { account?: object, research?: object }.
 *   Config-driven default sets research.multiAsset.useQualityBacktest = true unless explicitly provided.
 * @returns {Promise<{
 *   requestedGroup: string,
 *   resolvedGroup: string,
 *   usedDefaultGroup: boolean,
 *   availableGroups: string[],
 *   definitions: Array,
 *   account: object,
 *   result: { batch: object, multi: object | null }
 * }>}
 */
async function run(groupName = DEFAULT_GROUP, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const groupInfo = resolveGroup(groupName);
  const definitions = researchConfig.getDatasetGroup(groupInfo.resolvedGroup);
  const account = opts.account && typeof opts.account === 'object'
    ? opts.account
    : researchConfig.DEFAULT_ACCOUNT;
  const incomingResearch = opts.research && typeof opts.research === 'object' ? opts.research : {};
  const incomingMultiAsset = incomingResearch.multiAsset && typeof incomingResearch.multiAsset === 'object'
    ? incomingResearch.multiAsset
    : {};
  let batchLoader = opts.batchLoader != null && typeof opts.batchLoader === 'object' ? { ...opts.batchLoader } : {};
  if (Array.isArray(researchConfig.GROUPS_REQUIRING_MERGE) && researchConfig.GROUPS_REQUIRING_MERGE.includes(groupInfo.resolvedGroup)) {
    batchLoader.mergeSameSymbolTimeframe = true;
  }
  if (Array.isArray(researchConfig.GROUPS_SYNTHESIZE_TIMESTAMPS) && researchConfig.GROUPS_SYNTHESIZE_TIMESTAMPS.includes(groupInfo.resolvedGroup)) {
    batchLoader.loader = { ...(batchLoader.loader || {}), synthesizeTimestampsFromIndex: true };
  }
  const researchOptions = {
    ...incomingResearch,
    multiAsset: {
      useQualityBacktest: true,
      ...incomingMultiAsset,
    },
    batchLoader,
  };
  const result = await runResearch.run(definitions, account, researchOptions);

  return {
    ...groupInfo,
    definitions,
    account,
    result,
  };
}

/**
 * Print a concise research summary for run() output.
 *
 * @param {object} runOutput - Output from runResearchFromConfig.run()
 * @param {object} [options] - { includeBySymbol?: boolean, includeByTimeframe?: boolean }
 */
function printSummary(runOutput, options = {}) {
  if (!runOutput || typeof runOutput !== 'object') {
    console.log('Research config run: (no result)');
    return;
  }

  console.log('=== Research From Config ===');
  console.log('Requested group:', runOutput.requestedGroup);
  console.log('Resolved group:', runOutput.resolvedGroup);
  if (runOutput.usedDefaultGroup) {
    console.log('Group fallback: unknown group; using default');
    console.log('Available groups:', (runOutput.availableGroups || []).join(', '));
  }

  // Full research view by default for config-driven runs.
  const summaryOptions = {
    includeBySymbol: true,
    includeByTimeframe: true,
    includeTotals: true,
    ...options,
  };
  runResearch.printSummary(runOutput.result, summaryOptions);

  const batch = runOutput.result && runOutput.result.batch;
  if (runOutput.resolvedGroup === 'spy_5m_2022_2025' && batch && batch.loaded === 0 && batch.failed > 0) {
    console.log('');
    console.log('Hint: For spy_5m_2022_2025 add one CSV per year in data/: spy_5m_2022.csv, spy_5m_2023.csv, spy_5m_2024.csv, spy_5m_2025.csv');
    console.log('      If you only have data/spy_5m.csv, use group spy_only or spy_5m_single instead.');
  }
}

module.exports = {
  DEFAULT_GROUP,
  resolveGroup,
  run,
  printSummary,
};
