#!/usr/bin/env node
'use strict';

/**
 * Compares legacy strict expectancyPts (linear) vs current (log1p) on rows from strategy_validation.json.
 * Does not change scoring — observability / regression aid only.
 *
 * Usage (from neuropilot_trading_v2):
 *   node engine/governance/smokeStrictExpectancyRecalibration.js [path/to/strategy_validation.json]
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  computeScoreStrategyBreakdown,
  DEFAULT_MODE_RULES,
  computeLearningScoreBreakdown,
} = require('./computeStrategyValidationFramework');

/** Mirrors computeStrategyValidationFramework.validationTier (promotion mode). */
function tierPromotion(score, hardFails) {
  if (hardFails.length > 0) return 'reject';
  if (score >= 80) return 'promote_candidate';
  if (score >= 65) return 'watchlist';
  return 'reject';
}

const promo = DEFAULT_MODE_RULES.promotion;

function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

/** Legacy strict positive expectancy term only (pre–schema 1.5.0). */
function strictExpectancyPtsLegacy(e) {
  if (e > 0) return Math.min(20, e * 10);
  return -25;
}

function computeLegacyScoreBaseClamped(m, flags, rules) {
  const base = 50;
  const expectancyPts = strictExpectancyPtsLegacy(Number(m.expectancy));
  let profitFactorPts = 0;
  if (m.profitFactor != null && Number.isFinite(m.profitFactor)) {
    if (m.profitFactor >= 1) profitFactorPts = Math.min(20, (m.profitFactor - 1) * 20);
    else profitFactorPts = -20;
  }
  let samplePts = 0;
  if (m.trades >= rules.minTrades) samplePts = 12;
  else if (m.trades >= rules.minTradesHard) samplePts = 3;
  else samplePts = -20;
  const maxBarsPenaltyPts = m.maxBarsShare > rules.maxBarsShareWarn ? 8 : 0;
  const suspiciousWinratePenaltyPts = flags.warns.includes('suspicious_high_win_rate_small_sample') ? 10 : 0;
  const rawSum =
    base +
    expectancyPts +
    profitFactorPts +
    samplePts -
    maxBarsPenaltyPts -
    suspiciousWinratePenaltyPts;
  return {
    expectancyPts: round4(expectancyPts),
    scoreBaseClamped: Math.max(0, Math.min(100, Math.round(rawSum))),
  };
}

function rowToInputs(row) {
  const m = {
    strategyId: row.strategyId,
    trades: row.trades,
    expectancy: row.expectancy,
    profitFactor: row.profitFactor,
    maxBarsShare: row.maxBarsShare ?? 0,
    maxDrawdown: row.maxDrawdown,
    totalPnl: row.totalPnl,
  };
  const flags = {
    warns: row.warnings || [],
    hardFails: row.hardFails || [],
  };
  return { m, flags };
}

const IDS = ['EMA_pullback_v2', 'ORB_breakout_v1', 'ICT_liquidity_sweep_v1', 'FVG_scalp_v1'];

function main() {
  const snapPath = path.resolve(
    process.cwd(),
    process.argv[2] || path.join('ops-snapshot', 'strategy_validation.json')
  );
  assert.ok(fs.existsSync(snapPath), `missing ${snapPath}`);

  const doc = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const rows = doc.rows || [];
  const byId = new Map(rows.map((r) => [r.strategyId, r]));

  console.log('[smokeStrictExpectancyRecalibration] source:', snapPath);
  console.log('');
  console.log(
    'strategyId | trades | expectancy | hardFails | score_before | score_after | expPts_before | expPts_after | tier_before | tier_after | learning_unchanged'
  );
  console.log(
    '-----------|--------|------------|-----------|--------------|-------------|---------------|--------------|-------------|------------|--------------------'
  );

  for (const id of IDS) {
    const row = byId.get(id);
    if (!row) {
      console.log(`${id} | (absent from snapshot)`);
      continue;
    }
    const { m, flags } = rowToInputs(row);
    const leg = computeLegacyScoreBaseClamped(m, flags, promo);
    const cur = computeScoreStrategyBreakdown(m, flags, promo);
    const hf = JSON.stringify(row.hardFails || []);
    const tierBefore = tierPromotion(leg.scoreBaseClamped, flags.hardFails || []);
    const tierAfter = tierPromotion(cur.scoreBaseClamped, flags.hardFails || []);
    const lb = computeLearningScoreBreakdown(m, flags, promo);
    const learningOk =
      row.learningScore == null
        ? 'n/a'
        : lb.finalScore === row.learningScore
          ? 'yes'
          : `replay ${lb.finalScore} vs snap ${row.learningScore}`;

    console.log(
      [
        id,
        m.trades,
        m.expectancy,
        hf,
        leg.scoreBaseClamped,
        cur.scoreBaseClamped,
        leg.expectancyPts,
        cur.expectancyPts,
        tierBefore,
        tierAfter,
        learningOk,
      ].join(' | ')
    );
  }

  console.log('');
  console.log('micro-noise check (positive expectancy, 1 trade would still hit hard fails separately):');
  const noiseM = { trades: 1, expectancy: 1e-6, profitFactor: 1.2, maxBarsShare: 0 };
  const noiseFlags = { warns: [], hardFails: ['too_few_trades_hard'] };
  const nLeg = strictExpectancyPtsLegacy(1e-6);
  const nCur = computeScoreStrategyBreakdown(noiseM, noiseFlags, promo).expectancyPts;
  console.log(`  legacy expectancyPts(1e-6)=${nLeg}, log1p strict=${nCur}`);
}

main();
