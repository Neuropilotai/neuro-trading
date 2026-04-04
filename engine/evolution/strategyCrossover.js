'use strict';

/**
 * Genetic Strategy Evolution — Crossover: combine two parent setups into offspring.
 *
 * Example: A (body 0.6, close 0.7, session mid) × B (body 0.5, close 0.8, session late)
 *   → offspring (body 0.6, close 0.8, session late) by picking each rule from A or B.
 *
 * Usage:
 *   const { crossover } = require('./strategyCrossover');
 *   const offspring = crossover(parentA.rules, parentB.rules);
 */

const NUMERIC_CLAMP = [0, 1];
const VOLUME_RATIO_CLAMP = [0, 2];

function clamp(n, minMax = NUMERIC_CLAMP) {
  const [min, max] = minMax;
  const v = Number(n);
  if (Number.isNaN(v)) return n;
  return Math.round(Math.max(min, Math.min(max, v)) * 1e6) / 1e6;
}

/**
 * Crossover two rule objects: for each key, pick value from parentA or parentB (random).
 * Keys present in both; if only in one, take that. Numeric values optionally averaged then clamped.
 *
 * @param {object} rulesA - Parent A rules (e.g. body_pct_min, close_strength_min, session_phase)
 * @param {object} rulesB - Parent B rules
 * @param {{ mode?: 'pick'|'average' }} [opts] - pick = random A or B per key; average = (A+B)/2 for numbers
 * @returns {object} Offspring rules
 */
function crossover(rulesA, rulesB, opts = {}) {
  const mode = opts.mode || 'pick';
  const keys = [...new Set([...Object.keys(rulesA || {}), ...Object.keys(rulesB || {})])].sort();
  const out = {};
  for (const k of keys) {
    const a = rulesA && rulesA[k];
    const b = rulesB && rulesB[k];
    if (a === undefined && b === undefined) continue;
    if (a === undefined) { out[k] = b; continue; }
    if (b === undefined) { out[k] = a; continue; }
    if (mode === 'average' && typeof a === 'number' && typeof b === 'number') {
      const minMax = k === 'volume_ratio' ? VOLUME_RATIO_CLAMP : NUMERIC_CLAMP;
      out[k] = clamp((a + b) / 2, minMax);
    } else {
      out[k] = Math.random() < 0.5 ? a : b;
    }
  }
  return out;
}

/**
 * Produce two offspring from two parents (crossover A,B and B,A for diversity).
 * @param {object} rulesA
 * @param {object} rulesB
 * @param {{ mode?: 'pick'|'average' }} [opts]
 * @returns {[object, object]}
 */
function crossoverPair(rulesA, rulesB, opts = {}) {
  return [crossover(rulesA, rulesB, opts), crossover(rulesB, rulesA, opts)];
}

module.exports = { crossover, crossoverPair };
