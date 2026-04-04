#!/usr/bin/env node
'use strict';

/**
 * Test promotion decay: backdate promotedAt in promoted_children.json
 * so that runMetaPipeline applies decay (0.5 at 2 days, 0.25 at 4+ days).
 *
 * Usage:
 *   export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
 *   node engine/scripts/backdatePromotedForDecayTest.js
 *   node engine/meta/runMetaPipeline.js 30 12
 */

const path = require('path');
const fs = require('fs');

const dataRoot = require('../dataRoot');

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function toISO(d) {
  return d.toISOString();
}

function main() {
  const discoveryDir = dataRoot.getPath('discovery');
  const filePath = path.join(discoveryDir, 'promoted_children.json');

  if (!fs.existsSync(filePath)) {
    console.log('promoted_children.json not found at', filePath);
    console.log('Run buildPromotedChildren first (e.g. step 3.5 of runFullPipelineExpanded.sh).');
    process.exit(1);
  }

  const json = safeReadJson(filePath);
  if (!json || !Array.isArray(json.strategies) || !json.strategies.length) {
    console.log('No strategies in promoted_children.json.');
    process.exit(1);
  }

  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);

  let changed = 0;
  json.strategies.forEach((s, i) => {
    if (i === 0) {
      s.promotedAt = toISO(twoDaysAgo);
      s._decayTestBackdated = '2_days';
      changed += 1;
    } else if (i === 1) {
      s.promotedAt = toISO(fourDaysAgo);
      s._decayTestBackdated = '4_days';
      changed += 1;
    }
  });

  if (changed) {
    json._decayTestBackdatedAt = toISO(now);
    json._decayTestNote = 'First 2 strategies backdated for decay test; expected factors 0.5 and 0.25.';
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');
    console.log('Backdated', changed, 'promotedAt in', filePath);
    console.log('  Strategy 0: 2 days ago → expected decay factor 0.5');
    console.log('  Strategy 1: 4 days ago → expected decay factor 0.25');
  }

  console.log('');
  console.log('Run meta to verify decay:');
  console.log('  node engine/meta/runMetaPipeline.js 30 12');
}

main();
