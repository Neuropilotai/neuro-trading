'use strict';

/**
 * Genetic Strategy Evolution — Population: select top by fitness, hold name+rules for offspring production.
 *
 * Uses rankPopulation (discovery + champion registry) and strategy map (generated_strategies)
 * to get the best setups with their rules, then mutate + crossover produce next generation.
 *
 * Usage:
 *   const { selectTopWithRules, produceOffspring } = require('./geneticPopulation');
 */

const { rankPopulation } = require('./rankPopulation');
const { loadStrategyMap } = require('./strategyMutation');
const { mutateRules } = require('./strategyMutation');
const { crossover } = require('./strategyCrossover');

/**
 * Select top K from ranked population that have rules in the strategy map.
 *
 * @param {Array<{ setupId: string }>} ranked - from rankPopulation()
 * @param {object} strategyMap - setupId -> { name, rules } from loadStrategyMap()
 * @param {number} topK
 * @returns {Array<{ setupId: string, name: string, rules: object }>}
 */
function selectTopWithRules(ranked, strategyMap, topK = 20) {
  const out = [];
  for (const row of ranked) {
    if (out.length >= topK) break;
    const parent = strategyMap[row.setupId];
    if (!parent || !parent.rules) continue;
    out.push({
      setupId: row.setupId,
      name: parent.name || row.setupId,
      rules: parent.rules,
    });
  }
  return out;
}

/**
 * Produce offspring: mutations (each parent mutated N times) + crossovers (pairs of parents).
 *
 * @param {Array<{ setupId: string, name: string, rules: object }>} parents - from selectTopWithRules
 * @param {{ mutationsPerParent?: number, crossoverPairs?: number }} [opts]
 * @returns {{ mutations: Array<{ name: string, rules: object }>, crossovers: Array<{ name: string, rules: object }> }}
 */
function produceOffspring(parents, opts = {}) {
  const mutationsPerParent = Math.max(0, Math.min(10, opts.mutationsPerParent ?? 3));
  const crossoverPairs = Math.max(0, Math.min(20, opts.crossoverPairs ?? 5));

  const mutations = [];
  for (let i = 0; i < parents.length; i++) {
    const p = parents[i];
    for (let m = 0; m < mutationsPerParent; m++) {
      mutations.push({
        name: `${p.name}_gen_m${m + 1}`,
        rules: mutateRules(p.rules),
      });
    }
  }

  const crossovers = [];
  for (let n = 0; n < crossoverPairs && parents.length >= 2; n++) {
    const i = n % parents.length;
    const j = (n + 1) % parents.length;
    if (i === j) continue;
    const childRules = crossover(parents[i].rules, parents[j].rules, { mode: 'pick' });
    crossovers.push({
      name: `gen_cx_${n + 1}`,
      rules: childRules,
    });
  }

  return { mutations, crossovers };
}

module.exports = { selectTopWithRules, produceOffspring };
