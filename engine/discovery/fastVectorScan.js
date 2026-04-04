'use strict';

/**
 * Fast Vector Scan — Apply rule masks on the pre-computed feature matrix (no full backtest).
 *
 * Evaluates each setup as logical filters on the same in-memory matrix. Eliminates 99%+ of setups
 * very quickly. Output: signal count (and optional win proxy) per setup for Top-K pruning.
 *
 * Usage:
 *   const { fastVectorScan } = require('./engine/discovery/fastVectorScan');
 *   const scored = fastVectorScan(featureMatrix, setups, { minSignals: 20 });
 */

const { computeCanonicalSetupId } = require('../evolution/canonicalSetupId');

/**
 * Check one bar against one setup's rules (logical AND of all conditions).
 */
function barPassesRules(row, rules) {
  if (!row || !rules) return false;
  if (rules.body_pct_min != null && row.body_pct < rules.body_pct_min) return false;
  if (rules.close_strength_min != null && row.close_strength < rules.close_strength_min) return false;
  if (rules.volume_ratio != null) {
    const vr = rules.volume_ratio;
    if (typeof vr === 'number') {
      if (row.volume_ratio < vr * 0.9 || row.volume_ratio > vr * 1.1) return false;
    }
  }
  if (rules.session_phase != null && row.session_phase !== rules.session_phase) return false;
  if (rules.regime != null && row.regime !== rules.regime) return false;
  return true;
}

/**
 * Run fast vector scan: for each setup, count how many bars pass the rules (signal count).
 * Optionally compute a simple win proxy: of passing bars, how many have next-bar positive return.
 *
 * @param {{ rows: Array<object> }} featureMatrix - From buildFeatureMatrix
 * @param {Array<{ name: string, rules: object }>} setups - From parameter grid or mutation
 * @param {{ minSignals?: number }} [opts] - minSignals: minimum bars passing to count (default 1)
 * @returns {Array<{ setupId: string, name: string, rules: object, signalCount: number, score: number }>}
 */
function fastVectorScan(featureMatrix, setups, opts = {}) {
  const minSignals = Math.max(0, opts.minSignals ?? 1);
  const rows = featureMatrix.rows || [];
  const results = [];

  for (const s of setups) {
    const name = (s.name || 'setup').toString();
    const rules = s.rules && typeof s.rules === 'object' ? s.rules : {};
    let signalCount = 0;
    let winProxy = 0;

    for (let i = 0; i < rows.length; i++) {
      if (!barPassesRules(rows[i], rules)) continue;
      signalCount++;
      // Win proxy: next bar close > current close (optional)
      if (opts.winProxy && i + 1 < rows.length) {
        const cur = rows[i];
        const next = featureMatrix.rows[i + 1];
        const curClose = cur && (cur.close ?? cur.c);
        const nextClose = next && (next.close ?? next.c);
        if (curClose != null && nextClose != null && nextClose > curClose) winProxy++;
      }
    }

    const setupId = s.setupId || computeCanonicalSetupId({ name, rules });
    const score = opts.winProxy ? (signalCount > 0 ? winProxy / signalCount : 0) : signalCount;
    results.push({
      ...s,
      setupId,
      name,
      rules,
      signalCount,
      winProxy: opts.winProxy ? winProxy : undefined,
      score,
    });
  }

  return results.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.signalCount - a.signalCount));
}

module.exports = { fastVectorScan, barPassesRules };
