#!/usr/bin/env node
'use strict';

/**
 * Bootstrap / Monte Carlo on trade outcomes (R per trade).
 *
 * Answers: Is the observed expectancy robust or fragile? What is the probability
 * of being negative? How bad could drawdown or losing streaks be?
 *
 * Input: trade audit JSON (e.g. research/trade_audit_SPY_5m.json) with one object
 * per trade and a numeric "rMultiple" (actual R outcome).
 *
 * Usage (from neuropilot_trading_v2):
 *   node engine/exampleBootstrapTrades.js [auditPath] [iterations] [seed]
 *
 * Examples:
 *   node engine/exampleBootstrapTrades.js
 *   node engine/exampleBootstrapTrades.js research/trade_audit_SPY_5m.json 10000 42
 *
 * Prerequisite: export trades first:
 *   node engine/exampleRunResearchFromConfig.js spy_5m_2022_2025 trend_breakout confirmed strength BREAKOUT noopen
 *   node engine/exampleTradeSimulationFromResearch.js SPY 5m audit
 */

const path = require('path');
const fs = require('fs');

const DEFAULT_AUDIT = path.join(__dirname, '..', 'research', 'trade_audit_SPY_5m.json');
const DEFAULT_ITERATIONS = 10_000;

/**
 * Load trade audit JSON and return array of R outcomes (exclude null/non-finite).
 * @param {string} auditPath
 * @returns {{ rValues: number[], nTrades: number, source: string }}
 */
function loadRFromAudit(auditPath) {
  const raw = fs.readFileSync(auditPath, 'utf8');
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error('Audit file must be a JSON array of trades');
  const rValues = list
    .map((t) => (t && t.rMultiple != null ? Number(t.rMultiple) : NaN))
    .filter((r) => Number.isFinite(r));
  return { rValues, nTrades: rValues.length, source: auditPath };
}

/**
 * Max drawdown (in R) from a cumulative equity curve (cumulative sum of R).
 * @param {number[]} rValues - Sample of R per trade (e.g. resampled)
 * @returns {number} Max drawdown from a prior peak (positive number)
 */
function maxDrawdownR(rValues) {
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const r of rValues) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/**
 * Max number of consecutive trades with negative R.
 * @param {number[]} rValues
 * @returns {number}
 */
function maxConsecutiveLosses(rValues) {
  let maxStreak = 0;
  let current = 0;
  for (const r of rValues) {
    if (r < 0) {
      current++;
      if (current > maxStreak) maxStreak = current;
    } else {
      current = 0;
    }
  }
  return maxStreak;
}

/**
 * Simple seeded RNG (mulberry32) for reproducibility.
 * @param {number} seed
 * @returns {() => number} next in [0, 1)
 */
function createSeededRng(seed) {
  let s = Math.imul(seed >>> 0, 1);
  return function next() {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    return ((s >>> 0) % 1e7) / 1e7;
  };
}

/**
 * Bootstrap: resample with replacement, collect expectancy, drawdown, end total, worst streak.
 * @param {number[]} rValues - Original R per trade
 * @param {number} iterations
 * @param {number} [seed] - Optional seed for reproducibility
 * @returns {{ expectancySamples: number[], drawdownSamples: number[], totalRSamples: number[], worstStreakSamples: number[] }}
 */
function bootstrap(rValues, iterations, seed) {
  const n = rValues.length;
  if (n === 0) return { expectancySamples: [], drawdownSamples: [], totalRSamples: [], worstStreakSamples: [] };

  const rng = seed != null && Number.isFinite(seed) ? createSeededRng(seed) : () => Math.random();
  const expectancySamples = [];
  const drawdownSamples = [];
  const totalRSamples = [];
  const worstStreakSamples = [];

  for (let i = 0; i < iterations; i++) {
    const resampled = [];
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n);
      resampled.push(rValues[idx]);
    }
    const meanR = resampled.reduce((a, b) => a + b, 0) / n;
    const totalR = resampled.reduce((a, b) => a + b, 0);
    expectancySamples.push(Math.round(meanR * 1000) / 1000);
    totalRSamples.push(Math.round(totalR * 1000) / 1000);
    drawdownSamples.push(maxDrawdownR(resampled));
    worstStreakSamples.push(maxConsecutiveLosses(resampled));
  }

  return { expectancySamples, drawdownSamples, totalRSamples, worstStreakSamples };
}

/**
 * Percentile of sorted array (0–100). Linear interpolation between indices.
 * @param {number[]} sorted
 * @param {number} p
 * @returns {number}
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function main() {
  const auditPath = process.argv[2] || DEFAULT_AUDIT;
  const iterations = Math.max(100, parseInt(process.argv[3], 10) || DEFAULT_ITERATIONS);
  const seed = process.argv[4] !== undefined ? parseInt(process.argv[4], 10) : undefined;

  let rValues;
  try {
    const loaded = loadRFromAudit(auditPath);
    rValues = loaded.rValues;
    if (rValues.length === 0) {
      console.error('No valid rMultiple in audit. Export trades with "audit" first.');
      process.exit(1);
    }
    console.log('Loaded', rValues.length, 'trades from', path.basename(loaded.source));
  } catch (err) {
    console.error('Load audit failed:', err.message);
    process.exit(1);
  }

  const observedExpectancy = rValues.reduce((a, b) => a + b, 0) / rValues.length;
  const observedTotalR = rValues.reduce((a, b) => a + b, 0);
  const observedDrawdown = maxDrawdownR(rValues);
  const observedWorstStreak = maxConsecutiveLosses(rValues);

  console.log('');
  console.log('--- Observed (original sample) ---');
  console.log('  n trades:', rValues.length);
  console.log('  expectancy (mean R):', Math.round(observedExpectancy * 1000) / 1000);
  console.log('  total R:', Math.round(observedTotalR * 1000) / 1000);
  console.log('  max drawdown (R):', Math.round(observedDrawdown * 1000) / 1000);
  console.log('  max consecutive losses (count):', observedWorstStreak);

  console.log('');
  console.log('--- Bootstrap (resample with replacement,', iterations, 'iterations)', seed != null ? `seed=${seed}` : '');
  const { expectancySamples, drawdownSamples, totalRSamples, worstStreakSamples } = bootstrap(
    rValues,
    iterations,
    seed
  );

  const sortNum = (a, b) => a - b;
  const expSorted = [...expectancySamples].sort(sortNum);
  const ddSorted = [...drawdownSamples].sort(sortNum);
  const totalRSorted = [...totalRSamples].sort(sortNum);
  const streakSorted = [...worstStreakSamples].sort(sortNum);

  const pctNegativeExpectancy = (expectancySamples.filter((e) => e < 0).length / iterations) * 100;
  const pctNegativeTotal = (totalRSamples.filter((t) => t < 0).length / iterations) * 100;

  console.log('');
  const bootMeanExp = expectancySamples.reduce((a, b) => a + b, 0) / iterations;
  const expStd = Math.sqrt(
    expectancySamples.reduce((s, e) => s + (e - bootMeanExp) ** 2, 0) / iterations
  );
  console.log('  Expectancy (mean R per trade):');
  console.log('    bootstrap mean:', bootMeanExp.toFixed(3));
  console.log('    bootstrap std: ', expStd.toFixed(3));
  console.log('    90% CI: [', percentile(expSorted, 5).toFixed(3), ',', percentile(expSorted, 95).toFixed(3), ']');
  console.log('    % of bootstrap samples with expectancy < 0:', pctNegativeExpectancy.toFixed(1) + '%');

  console.log('');
  console.log('  Total R (sum over sample size):');
  console.log('    % of bootstrap samples with total R < 0:', pctNegativeTotal.toFixed(1) + '%');
  console.log('    90% CI total R: [', percentile(totalRSorted, 5).toFixed(2), ',', percentile(totalRSorted, 95).toFixed(2), ']');

  console.log('');
  console.log('  Max drawdown (R):');
  console.log('    median:   ', percentile(ddSorted, 50).toFixed(2));
  console.log('    90th pct:', percentile(ddSorted, 90).toFixed(2));
  console.log('    95th pct:', percentile(ddSorted, 95).toFixed(2));

  console.log('');
  console.log('  Max consecutive losses (count):');
  console.log('    median:   ', percentile(streakSorted, 50).toFixed(0));
  console.log('    90th pct: ', percentile(streakSorted, 90).toFixed(0));
  console.log('    95th pct: ', percentile(streakSorted, 95).toFixed(0));

  console.log('');
  console.log('--- Interpretation ---');
  if (pctNegativeExpectancy > 20) {
    console.log('  Expectancy is fragile: a large share of bootstrap samples are negative. Edge not statistically solid.');
  } else if (pctNegativeExpectancy > 5) {
    console.log('  Expectancy is positive in most samples but uncertainty is material. More data would help.');
  } else {
    console.log('  Expectancy stays positive in most bootstrap samples. Still, sample size is small; out-of-sample and walk-forward remain necessary.');
  }
}

main();
