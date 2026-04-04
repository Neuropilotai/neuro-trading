'use strict';

/**
 * Discovery Engine — Step 3: Generate candidate strategies from patterns.
 *
 * Input: array of patterns from clusterPatterns (name + rules).
 * Output: write engine/generatedStrategies/setup_XXX.js for each pattern, so they can
 * be loaded and backtested by the existing engine.
 *
 * Each generated file must export a strategy compatible with the backtest (e.g. same
 * interface as trendBreakout / meanReversion: signals from candles + options).
 *
 * TODO: Implement.
 * - Map pattern rules to strategy filter config (body_pct_min → strength filter, etc.)
 * - Generate JS file per pattern that requires the base strategy (e.g. trend_breakout)
 *   and applies the discovered filters
 * - Write to engine/generatedStrategies/setup_001.js, setup_002.js, ...
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');

const GENERATED_DIR = dataRoot.getPath('generated_strategies');

function ensureDir() {
  if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

/**
 * @param {Array<{ name: string, rules: object }>} patterns - from clusterPatterns
 * @returns {string[]} paths of written files
 */
function generateCandidateStrategies(patterns) {
  ensureDir();
  const written = [];
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    const id = String(i + 1).padStart(3, '0');
    const fileName = `setup_${id}.js`;
    const filePath = path.join(GENERATED_DIR, fileName);
    const content = `'use strict';
// Auto-generated from pattern: ${p.name}
// Rules: ${JSON.stringify(p.rules)}
// TODO: implement as strategy module compatible with backtest runner.
module.exports = { name: '${p.name}', rules: ${JSON.stringify(p.rules)} };
`;
    fs.writeFileSync(filePath, content, 'utf8');
    written.push(filePath);
  }
  return written;
}

module.exports = { generateCandidateStrategies, GENERATED_DIR };
