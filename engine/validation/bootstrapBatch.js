'use strict';

/**
 * Discovery Engine — Step 5 (validation): Bootstrap many strategies in batch.
 *
 * Input: strategy_batch_results.json (or list of audit files / trade lists per setup).
 * For each setup that has enough trades: run bootstrap (exampleBootstrapTrades logic).
 * Output: add bootstrap_risk (% samples with expectancy < 0) to each row; write updated results.
 *
 * Used to filter and rank: keep only setups with bootstrap_risk < 20%, trades >= 30, expectancy > 0.
 *
 * TODO: Implement.
 * - Load batch results or per-setup audit paths
 * - For each: load R outcomes (from audit or re-run sim), run bootstrap, get % < 0
 * - Merge back; write research/discovered_setups.json with ranking
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');

async function bootstrapBatch(resultsPath) {
  const defaultPath = path.join(dataRoot.getPath('batch_results'), 'strategy_batch_results.json');
  const p = resultsPath || defaultPath;
  if (!fs.existsSync(p)) {
    console.warn('No batch results at', p);
    return [];
  }
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const results = data.results || [];
  // TODO: for each result, if trades >= 20, run bootstrap; set bootstrap_risk
  const withBootstrap = results.map((r) => ({ ...r, bootstrap_risk: r._stub ? null : null }));
  const outPath = path.join(dataRoot.getPath('discovery'), 'discovered_setups.json');
  fs.writeFileSync(outPath, JSON.stringify({ ...data, results: withBootstrap }, null, 2), 'utf8');
  console.log('Written (stub):', outPath);
  return withBootstrap;
}

async function main() {
  const resultsPath = process.argv[2] || null;
  await bootstrapBatch(resultsPath);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { bootstrapBatch };
