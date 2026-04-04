'use strict';

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

function governanceDir() {
  const root = process.env.NEUROPILOT_DATA_ROOT || dataRoot.getDataRoot();
  return path.join(root, 'governance');
}

function metricsPath() {
  return path.join(governanceDir(), 'pipeline_phase_substep_metrics.jsonl');
}

/**
 * Append one substep metric row. Fail-soft: never throws.
 * @param {object} row
 * @returns {boolean}
 */
function appendPhaseSubstepMetric(row) {
  try {
    const dir = governanceDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(metricsPath(), `${JSON.stringify(row)}\n`, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  appendPhaseSubstepMetric,
  metricsPath,
};
