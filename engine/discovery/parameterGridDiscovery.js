'use strict';

/**
 * Strategy Parameter Space Engine — Explore a parameter grid instead of individual strategy files.
 *
 * One grid = body_pct_min × close_strength_min × volume_ratio × session_phase.
 * Example: 4×3×3×3 = 108 setups per pattern; 10 patterns → 1080 strategies.
 * With Mutation Engine (e.g. 5 mutations each): 1080 × 5 = 5400 strategies/night.
 *
 * Usage:
 *   node engine/discovery/parameterGridDiscovery.js [patternCount] [writeToDisk]
 *   const { buildParameterGrid, writeGridToStrategies } = require('./parameterGridDiscovery');
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');

// Default grid (stay close to known-good ranges)
const DEFAULT_GRID = {
  body_pct_min: [0.4, 0.5, 0.6, 0.7],
  close_strength_min: [0.6, 0.7, 0.8],
  volume_ratio: [1.0, 1.2, 1.5],
  session_phase: ['open', 'mid', 'close'],
};

const DEFAULT_PATTERN_NAMES = ['pattern_breakout'];

/**
 * Cartesian product of grid dimensions. Keys order fixed for reproducibility.
 * @param {{ [key: string]: any[] }} grid - e.g. { body_pct_min: [0.4,0.5], close_strength_min: [0.6,0.7] }
 * @returns {Array<object>} Array of rule objects (one per combination)
 */
function cartesianProduct(grid) {
  const keys = Object.keys(grid).sort();
  if (keys.length === 0) return [{}];
  const values = keys.map((k) => grid[k]);
  const result = [];
  function recurse(i, acc) {
    if (i === keys.length) {
      result.push({ ...acc });
      return;
    }
    const k = keys[i];
    for (const v of values[i]) {
      acc[k] = v;
      recurse(i + 1, acc);
    }
  }
  recurse(0, {});
  return result;
}

/**
 * Build all setups from parameter grid × pattern names.
 * @param {{ grid?: object, patternNames?: string[] }} [opts]
 * @returns {Array<{ name: string, rules: object }>}
 */
function buildParameterGrid(opts = {}) {
  const grid = opts.grid || DEFAULT_GRID;
  const patternNames = opts.patternNames || DEFAULT_PATTERN_NAMES;
  const ruleCombos = cartesianProduct(grid);
  const setups = [];
  for (const name of patternNames) {
    for (const rules of ruleCombos) {
      setups.push({ name, rules: { ...rules } });
    }
  }
  return setups;
}

/**
 * Write grid setups to generated_strategies as setup_grid_XXX.js (same format as generateCandidateStrategies).
 * runStrategyBatch loads all setup_*.js so these are picked up.
 * @param {Array<{ name: string, rules: object }>} setups - from buildParameterGrid
 * @param {string} [outDir] - default dataRoot.getPath('generated_strategies')
 * @returns {string[]} paths written
 */
function writeGridToStrategies(setups, outDir) {
  const dir = outDir || dataRoot.getPath('generated_strategies');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const pad = String(setups.length).length;
  for (let i = 0; i < setups.length; i++) {
    const p = setups[i];
    const id = String(i).padStart(Math.max(3, pad), '0');
    const fileName = `setup_grid_${id}.js`;
    const filePath = path.join(dir, fileName);
    const content = `'use strict';
// Parameter grid discovery: ${p.name}
// Rules: ${JSON.stringify(p.rules)}
module.exports = { name: '${p.name}', rules: ${JSON.stringify(p.rules)} };
`;
    fs.writeFileSync(filePath, content, 'utf8');
    written.push(filePath);
  }
  return written;
}

/**
 * Run parameter grid discovery: build grid and optionally write to disk.
 * @param {{ patternNames?: string[], grid?: object, writeToDisk?: boolean, outDir?: string }} [opts]
 * @returns {{ setups: Array<{ name: string, rules: object }>, written: string[], count: number }}
 */
function runParameterGridDiscovery(opts = {}) {
  const patternNames = opts.patternNames || DEFAULT_PATTERN_NAMES;
  const setups = buildParameterGrid({ grid: opts.grid || DEFAULT_GRID, patternNames });
  let written = [];
  if (opts.writeToDisk !== false) {
    written = writeGridToStrategies(setups, opts.outDir);
  }
  return { setups, written, count: setups.length };
}

async function main() {
  const patternCount = Math.max(1, Math.min(20, parseInt(process.argv[2], 10) || 1));
  const writeToDisk = process.argv[3] !== 'no-write';
  const patternNames = Array.from({ length: patternCount }, (_, i) => `pattern_${String(i + 1).padStart(3, '0')}`);
  const result = runParameterGridDiscovery({ patternNames, writeToDisk });
  console.log('Parameter Grid Discovery');
  console.log('  Grid:', Object.keys(DEFAULT_GRID).join(', '));
  console.log('  Combinations per pattern:', result.count / patternCount);
  console.log('  Patterns:', patternCount);
  console.log('  Total setups:', result.count);
  console.log('  Written:', result.written.length, 'files');
  if (result.written.length > 0) {
    console.log('  Dir:', path.dirname(result.written[0]));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  buildParameterGrid,
  writeGridToStrategies,
  runParameterGridDiscovery,
  cartesianProduct,
  DEFAULT_GRID,
  DEFAULT_PATTERN_NAMES,
};
