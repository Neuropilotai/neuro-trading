'use strict';

/**
 * Discovery Engine — Step 4: Backtest many strategies in batch.
 *
 * Input: list of setup ids or paths (e.g. generatedStrategies/setup_001.js … setup_500.js).
 * For each: run backtest (existing qualityAdaptiveBacktestRunner or trade sim from research).
 * Output: array of { setupId, expectancy, trades, winRate, ... } for ranking.
 *
 * Usage:
 *   node engine/batch/runStrategyBatch.js <dataGroup> [setupDir]
 *
 * Example:
 *   node engine/batch/runStrategyBatch.js spy_5m_2022_2025
 *
 * Optimisations: see engine/batch/BATCH_OPTIMIZATIONS.md (parallel workers, cache OHLC, streaming CSV).
 *
 * TODO: Implement.
 * - Resolve generatedStrategies/*.js or accept list of setup names
 * - For each: load candles (by dataGroup), run research/backtest with that setup’s filters
 * - Collect metrics; write research/strategy_batch_results.json
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');
const { computeCanonicalSetupId } = require('../evolution/canonicalSetupId');
const { getWorkerCount } = require('./batchConfig');

async function runStrategyBatch(dataGroup, setupDir) {
  const dir = setupDir || dataRoot.getPath('generated_strategies');
  const outPath = path.join(dataRoot.getPath('batch_results'), 'strategy_batch_results.json');
  let setups = [];
  if (fs.existsSync(dir)) {
    setups = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f.startsWith('setup_'));
  }
  const workers = getWorkerCount();
  // TODO: load OHLC once (loadOHLCCache), then runInParallel(setups, workers, (setup) => runOneBacktest(setup, candles))
  const results = setups.map((f) => {
    let setupId = f.replace('.js', '');
    const fullPath = path.resolve(dir, f);
    try {
      const mod = require(fullPath);
      if (mod && (mod.name || mod.rules)) {
        const canonical = computeCanonicalSetupId({ name: mod.name || setupId, rules: mod.rules || {} });
        if (canonical) setupId = canonical;
      }
    } catch (_) { /* fallback to filename */ }
    return {
      setupId,
      expectancy: null,
      trades: 0,
      winRate: null,
      _stub: true,
    };
  });
  dataRoot.getPath('batch_results');
  fs.writeFileSync(outPath, JSON.stringify({ dataGroup, results }, null, 2), 'utf8');
  console.log('Written (stub):', outPath);
  console.log('  Setups:', results.length, '| Workers (for future parallel backtest):', workers);
  return results;
}

async function main() {
  const dataGroup = process.argv[2] || 'spy_5m_2022_2025';
  const setupDir = process.argv[3] || null;
  await runStrategyBatch(dataGroup, setupDir);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runStrategyBatch };
