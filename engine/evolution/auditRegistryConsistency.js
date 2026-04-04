#!/usr/bin/env node
'use strict';

/**
 * Standalone audit script for champion_registry.json.
 * Runs the same invariant checks as validateRegistryConsistency (no self-parent,
 * valid status/liveStatus, no base with mutationType, at most one champion per
 * group, champion is group top). Exits 0 if all pass, non-zero and prints
 * errors on invariant failure.
 *
 * Usage (from neuropilot_trading_v2):
 *   node engine/evolution/auditRegistryConsistency.js
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const { validateRegistryConsistency } = require('./strategyEvolution');

function main() {
  const regPath = path.join(dataRoot.getPath('champion_setups'), 'champion_registry.json');
  if (!fs.existsSync(regPath)) {
    console.error('auditRegistryConsistency: registry not found:', regPath);
    process.exit(1);
  }
  let registry;
  try {
    const raw = fs.readFileSync(regPath, 'utf8');
    registry = JSON.parse(raw);
  } catch (e) {
    console.error('auditRegistryConsistency: failed to read or parse registry:', e.message);
    process.exit(1);
  }
  const setups = registry.setups;
  if (!Array.isArray(setups)) {
    console.error('auditRegistryConsistency: registry.setups is not an array');
    process.exit(1);
  }
  const result = validateRegistryConsistency(setups, { strict: false });
  if (!result.ok) {
    console.error('auditRegistryConsistency: invariant failures:');
    for (const err of result.errors) {
      console.error('  ', JSON.stringify(err));
    }
    if (result.warnings && result.warnings.length) {
      for (const w of result.warnings) {
        console.error('  [warn]', JSON.stringify(w));
      }
    }
    process.exit(1);
  }
  process.exit(0);
}

main();
