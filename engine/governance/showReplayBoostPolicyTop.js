#!/usr/bin/env node
'use strict';

/** Quick stdout summary of replay_boost_policy.json (no deps). */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const dataRoot = process.env.NEUROPILOT_DATA_ROOT
  ? path.resolve(process.env.NEUROPILOT_DATA_ROOT)
  : path.join(repoRoot, 'data_workspace');
const p = path.join(dataRoot, 'governance', 'replay_boost_policy.json');

if (!fs.existsSync(p)) {
  console.error(`[showReplayBoostPolicyTop] missing ${p}`);
  process.exit(1);
}
const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
const all = Array.isArray(doc.allocations) ? doc.allocations : [];
const boosted = all.filter((a) => a.priorityTier === 'boosted').map((a) => a.setupId);
const frozen = all.filter((a) => a.priorityTier === 'frozen').map((a) => a.setupId);
console.log(JSON.stringify({
  generatedAt: doc.generatedAt,
  policyMode: doc.policyMode,
  summary: doc.summary,
  globalControls: doc.globalControls,
  boostedSample: boosted.sort().slice(0, 24),
  frozenSample: frozen.sort().slice(0, 24),
}, null, 2));
