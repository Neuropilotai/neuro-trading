#!/usr/bin/env node
'use strict';

/**
 * Print mutationHotspotPolicy from discovery/next_generation_report.json
 * using NEUROPILOT_DATA_ROOT (same resolution as buildNextGenerationFromChampions).
 *
 * Usage (from neuropilot_trading_v2):
 *   export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
 *   node engine/evolution/scripts/printMutationHotspotPolicy.js
 *
 * Exit 0 always if file exists; inspect JSON for enabled / applications[] before batch/meta.
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../../dataRoot');

const reportPath = path.join(dataRoot.getPath('discovery'), 'next_generation_report.json');

if (!fs.existsSync(reportPath)) {
  console.error(
    JSON.stringify({ error: 'missing_next_generation_report', path: reportPath }, null, 2)
  );
  process.exit(2);
}

let j;
try {
  j = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (e) {
  console.error(JSON.stringify({ error: 'invalid_json', path: reportPath }, null, 2));
  process.exit(2);
}

const block = j.mutationHotspotPolicy != null ? j.mutationHotspotPolicy : {};
console.log(JSON.stringify(block, null, 2));
console.error('__source_report', reportPath);
