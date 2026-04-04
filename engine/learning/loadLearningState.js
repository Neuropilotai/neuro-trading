#!/usr/bin/env node
'use strict';

/**
 * Safe load of governance/learning_state.json.
 * Returns a stable minimal shape when file is missing or invalid (never throws).
 */

const fs = require('fs');
const path = require('path');

const LEARNING_STATE_SCHEMA_VERSION = '1.0.0';

function emptyLearningStateShell(generatedAt) {
  return {
    schemaVersion: LEARNING_STATE_SCHEMA_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    window: {
      paperLookbackDays: 30,
      rejectLookbackRuns: 20,
      minTradesPerSetup: 3,
    },
    inputs: {
      paperTrades: { path: null, used: false, warning: null },
      promotedChildren: { path: null, used: false, warning: null },
      paperTradesBySetupAnalysis: { path: null, used: false, warning: null },
      mutationLearning: { path: null, used: false, warning: null },
    },
    globalPolicies: {
      dominantRejectReason: null,
      mutationLearningComputed: null,
      mutationLearningArtifactSummary: null,
      actionBias: null,
    },
    bySetup: {},
    byFamily: {},
    summary: {
      setupsBoosted: 0,
      setupsDownweighted: 0,
      softBlockedSetups: 0,
      familiesBoosted: 0,
      familiesCut: 0,
    },
    warnings: [],
  };
}

/**
 * @param {string} dataRoot
 * @returns {object} Always a valid object (never null); may be empty shell if unreadable.
 */
function loadLearningState(dataRoot) {
  const root = typeof dataRoot === 'string' && dataRoot.trim() ? dataRoot.trim() : '';
  if (!root) {
    return emptyLearningStateShell(new Date().toISOString());
  }
  const p = path.join(root, 'governance', 'learning_state.json');
  try {
    if (!fs.existsSync(p)) {
      return emptyLearningStateShell(new Date().toISOString());
    }
    const raw = fs.readFileSync(p, 'utf8');
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') {
      return emptyLearningStateShell(new Date().toISOString());
    }
    return o;
  } catch {
    return emptyLearningStateShell(new Date().toISOString());
  }
}

module.exports = {
  loadLearningState,
  emptyLearningStateShell,
  LEARNING_STATE_SCHEMA_VERSION,
};
