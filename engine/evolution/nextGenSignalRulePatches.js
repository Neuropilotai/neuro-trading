'use strict';

/**
 * Next-gen signal-oriented rule patches (R multiple + entry tightness).
 * Deterministic from seed; no learning / guard coupling.
 */

const R_MIN = 1.2;
const R_MAX = 1.5;

function numericSeed(str) {
  const s = String(str || '');
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    n = (n * 31 + s.charCodeAt(i)) >>> 0;
  }
  return n || 1;
}

/**
 * Deterministic R in [R_MIN, R_MAX] from integer seed.
 */
function derivedRMultiple(seed) {
  const s = Number(seed) >>> 0;
  const u = (s % 10001) / 10000;
  return Math.round((R_MIN + u * (R_MAX - R_MIN)) * 100) / 100;
}

/**
 * @param {object} rules
 * @param {number} [seed] - unsigned-ish int; if omitted, derived from JSON snapshot of rules
 * @returns {object} shallow clone with patches
 */
function applyNextGenSignalRulePatches(rules, seed) {
  const out = { ...(rules && typeof rules === 'object' ? rules : {}) };
  const s =
    seed != null && Number.isFinite(Number(seed))
      ? Number(seed) >>> 0
      : numericSeed(JSON.stringify(out));

  out.rMultiple = derivedRMultiple(s);

  if (Object.prototype.hasOwnProperty.call(out, 'close_strength_min')) {
    const v = Number(out.close_strength_min);
    if (Number.isFinite(v)) out.close_strength_min = Math.max(v, 0.55);
  }
  if (Object.prototype.hasOwnProperty.call(out, 'body_pct_min')) {
    const v = Number(out.body_pct_min);
    if (Number.isFinite(v)) out.body_pct_min = Math.max(v, 0.5);
  }
  if (Object.prototype.hasOwnProperty.call(out, 'volume_ratio')) {
    const v = Number(out.volume_ratio);
    if (Number.isFinite(v)) out.volume_ratio = Math.max(v, 1.2);
  }

  return out;
}

module.exports = {
  applyNextGenSignalRulePatches,
  derivedRMultiple,
  numericSeed,
  R_MIN,
  R_MAX,
};
