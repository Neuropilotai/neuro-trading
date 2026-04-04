'use strict';

/**
 * Genetic Strategy Evolution — Orchestrator: rank → select top → mutate + crossover → write setup_gen_*.js.
 *
 * Flow: discover → mutate → crossbreed → test (next night batch) → select → evolve.
 * Population evolves night after night; new offspring are written to generated_strategies
 * and picked up by the next run of runStrategyBatch.
 *
 * Usage:
 *   node engine/evolution/runGeneticEvolution.js [topK] [mutationsPerParent] [crossoverPairs]
 *
 * Example:
 *   node engine/evolution/runGeneticEvolution.js 10 3 5
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');
const { rankPopulation } = require('./rankPopulation');
const { loadStrategyMap } = require('./strategyMutation');
const { selectTopWithRules, produceOffspring } = require('./geneticPopulation');

function writeStrategyFile(dir, filename, name, rules) {
  const filePath = path.join(dir, filename);
  const content = `'use strict';
// Genetic evolution: ${name}
// Rules: ${JSON.stringify(rules)}
module.exports = { name: '${name.replace(/'/g, "\\'")}', rules: ${JSON.stringify(rules)} };
`;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/**
 * Run one generation: rank population, select top, produce mutations + crossovers, write setup_gen_*.js.
 *
 * @param {{ discoveryDir?: string, championDir?: string, strategiesDir?: string, outDir?: string, topK?: number, mutationsPerParent?: number, crossoverPairs?: number }} [opts]
 * @returns {{ written: string[], parentsUsed: number, mutations: number, crossovers: number }}
 */
function runGeneticEvolution(opts = {}) {
  const discoveryDir = opts.discoveryDir ?? dataRoot.getPath('discovery');
  const championDir = opts.championDir ?? dataRoot.getPath('champion_setups');
  const strategiesDir = opts.strategiesDir ?? dataRoot.getPath('generated_strategies');
  const outDir = opts.outDir ?? strategiesDir;
  const topK = Math.max(2, Math.min(50, opts.topK ?? 10));
  const mutationsPerParent = Math.max(0, Math.min(10, opts.mutationsPerParent ?? 3));
  const crossoverPairs = Math.max(0, Math.min(30, opts.crossoverPairs ?? 5));

  const ranked = rankPopulation(discoveryDir, championDir);
  const strategyMap = loadStrategyMap(strategiesDir);
  const parents = selectTopWithRules(ranked, strategyMap, topK);

  if (parents.length < 2) {
    return { written: [], parentsUsed: parents.length, mutations: 0, crossovers: 0 };
  }

  const { mutations, crossovers } = produceOffspring(parents, {
    mutationsPerParent,
    crossoverPairs,
  });

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const written = [];
  let idx = 0;
  const pad = String(mutations.length + crossovers.length).length;
  for (const o of mutations) {
    const id = String(idx++).padStart(Math.max(3, pad), '0');
    writeStrategyFile(outDir, `setup_gen_${id}.js`, o.name, o.rules);
    written.push(`setup_gen_${id}.js`);
  }
  for (const o of crossovers) {
    const id = String(idx++).padStart(Math.max(3, pad), '0');
    writeStrategyFile(outDir, `setup_gen_${id}.js`, o.name, o.rules);
    written.push(`setup_gen_${id}.js`);
  }

  return {
    written,
    parentsUsed: parents.length,
    mutations: mutations.length,
    crossovers: crossovers.length,
  };
}

async function main() {
  const topK = parseInt(process.argv[2], 10) || 10;
  const mutationsPerParent = parseInt(process.argv[3], 10) || 3;
  const crossoverPairs = parseInt(process.argv[4], 10) || 5;
  const result = runGeneticEvolution({ topK, mutationsPerParent, crossoverPairs });
  console.log('Genetic Evolution done.');
  console.log('  Parents used:', result.parentsUsed);
  console.log('  Mutations written:', result.mutations);
  console.log('  Crossovers written:', result.crossovers);
  console.log('  Total written:', result.written.length);
  if (result.written.length > 0) {
    console.log('  Files:', result.written.slice(0, 8).join(', '), result.written.length > 8 ? '...' : '');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runGeneticEvolution };
