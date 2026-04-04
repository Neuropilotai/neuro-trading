'use strict';

/**
 * Strategy Mutation Engine — Generate nearby variants of the best setups.
 *
 * Pipeline: discovered_setups.json → select best → mutate rules (small deltas) → write to generated_strategies/ → batch backtest.
 * Mutations stay close to parent so exploration is controlled.
 *
 * Usage:
 *   node engine/evolution/strategyMutation.js [topN] [mutationsPerParent]
 *
 * Example:
 *   node engine/evolution/strategyMutation.js 5 8
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');
const { computeCanonicalSetupId } = require('./canonicalSetupId');

// Deltas per rule (stay close to parent)
const MUTATION_DELTAS = {
  body_pct_min: 0.05,
  close_strength_min: 0.05,
  volume_ratio: 0.2,
};
const DEFAULT_DELTA = 0.05;
const NUMERIC_CLAMP = [0, 1];
const VOLUME_RATIO_CLAMP = [0, 2];

/**
 * Clamp value to [min, max] and round to 6 decimals for stability.
 */
function clamp(v, minMax = NUMERIC_CLAMP) {
  const [min, max] = minMax;
  const n = Number(v);
  if (Number.isNaN(n)) return v;
  const c = Math.max(min, Math.min(max, n));
  return Math.round(c * 1e6) / 1e6;
}

/**
 * Mutate one rule value: add random in [-delta, +delta], then clamp.
 */
function mutateNumber(value, delta, minMax = NUMERIC_CLAMP) {
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  const d = (Math.random() * 2 - 1) * delta;
  return clamp(n + d, minMax);
}

/**
 * Clone rules and apply one random mutation pass (each numeric key varied once).
 */
function mutateRules(rules, deltas = MUTATION_DELTAS) {
  const out = { ...rules };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (typeof v !== 'number') continue;
    const delta = deltas[k] ?? DEFAULT_DELTA;
    const minMax = k === 'volume_ratio' ? VOLUME_RATIO_CLAMP : NUMERIC_CLAMP;
    out[k] = mutateNumber(v, delta, minMax);
  }
  return out;
}

/**
 * Load discovered_setups.json and return results sorted by expectancy desc.
 */
function loadDiscoveredSetups(discoveryDir) {
  const p = path.join(discoveryDir, 'discovered_setups.json');
  if (!fs.existsSync(p)) return [];
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const results = data.results || [];
  return results
    .filter((r) => r.setupId && (r.expectancy == null || typeof r.expectancy === 'number'))
    .sort((a, b) => (b.expectancy ?? -1e9) - (a.expectancy ?? -1e9));
}

/**
 * Build map setupId -> { name, rules } from all setup_*.js in dir.
 */
function loadStrategyMap(strategiesDir) {
  const map = Object.create(null);
  if (!fs.existsSync(strategiesDir)) return map;
  const files = fs.readdirSync(strategiesDir).filter((f) => f.endsWith('.js') && f.startsWith('setup_'));
  for (const f of files) {
    const fullPath = path.resolve(strategiesDir, f);
    try {
      const mod = require(fullPath);
      if (!mod || (!mod.name && !mod.rules)) continue;
      const name = mod.name || f.replace('.js', '');
      const rules = mod.rules && typeof mod.rules === 'object' ? mod.rules : {};
      const setupId = computeCanonicalSetupId({ name, rules });
      map[setupId] = { name, rules };
    } catch (_) { /* skip */ }
  }
  return map;
}

/**
 * Write one strategy module to generated_strategies (same format as generateCandidateStrategies).
 */
function writeStrategyFile(dir, filename, name, rules) {
  const filePath = path.join(dir, filename);
  const content = `'use strict';
// Mutation from parent: ${name}
// Rules: ${JSON.stringify(rules)}
module.exports = { name: '${name.replace(/'/g, "\\'")}', rules: ${JSON.stringify(rules)} };
`;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/**
 * Run the mutation pipeline: select best from discovered_setups, generate N mutations each, write to generated_strategies.
 *
 * @param {{ discoveryDir?: string, strategiesDir?: string, topN?: number, mutationsPerParent?: number }} [opts]
 * @returns {{ written: string[], parentsSelected: number, totalMutations: number }}
 */
function runStrategyMutation(opts = {}) {
  const discoveryDir = opts.discoveryDir ?? dataRoot.getPath('discovery');
  const strategiesDir = opts.strategiesDir ?? dataRoot.getPath('generated_strategies');
  const topN = Math.max(1, Math.min(20, opts.topN ?? 5));
  const mutationsPerParent = Math.max(1, Math.min(20, opts.mutationsPerParent ?? 8));

  const results = loadDiscoveredSetups(discoveryDir);
  const top = results.slice(0, topN);
  const strategyMap = loadStrategyMap(strategiesDir);

  const written = [];
  let totalMutations = 0;

  for (let p = 0; p < top.length; p++) {
    const row = top[p];
    const setupId = row.setupId;
    const parent = strategyMap[setupId];
    if (!parent) continue;

    const { name: parentName, rules: parentRules } = parent;
    for (let m = 0; m < mutationsPerParent; m++) {
      const mutatedRules = mutateRules(parentRules);
      const mutName = `${parentName}_m${m + 1}`;
      const filename = `setup_mut_${p}_${m}.js`;
      writeStrategyFile(strategiesDir, filename, mutName, mutatedRules);
      written.push(filename);
      totalMutations++;
    }
  }

  return { written, parentsSelected: top.length, totalMutations };
}

async function main() {
  const topN = parseInt(process.argv[2], 10) || 5;
  const mutationsPerParent = parseInt(process.argv[3], 10) || 8;
  const result = runStrategyMutation({ topN, mutationsPerParent });
  console.log('Strategy Mutation done.');
  console.log('  Parents selected:', result.parentsSelected);
  console.log('  Total mutations written:', result.totalMutations);
  console.log('  Files:', result.written.slice(0, 10).join(', '), result.written.length > 10 ? '...' : '');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  runStrategyMutation,
  loadDiscoveredSetups,
  loadStrategyMap,
  mutateRules,
  MUTATION_DELTAS,
  DEFAULT_DELTA,
};
