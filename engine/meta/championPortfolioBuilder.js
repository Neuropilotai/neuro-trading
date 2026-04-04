'use strict';

/**
 * Champion Portfolio Builder — NeuroPilot builds a portfolio of strategies, not a single champion.
 *
 * Supports allocation by expectancy, meta_score, or portfolio_score.
 * Adds optional min/max caps per strategy.
 *
 * allowCashBuffer:
 *   - false (default): always renormalize weights to 1 after caps.
 *   - true: if caps prevent reaching 100% allocation, keep residual as cash_weight.
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round6(v) {
  return Math.round(safeNum(v, 0) * 1e6) / 1e6;
}

/** For defensive portfolio output: family diversity key (parentFamilyId|mutationType). */
function buildFamilyDiversityKey(strategy) {
  if (!strategy || typeof strategy !== 'object') return 'unknown';
  const parentFamilyId =
    strategy.parentFamilyId ||
    strategy.parentSetupId ||
    strategy.familyKey ||
    'unknown_parent';
  const mutationType = String(strategy.mutationType || 'base');
  return `${parentFamilyId}|${mutationType}`;
}

/** For defensive portfolio output: lineage depth from setupId. */
function computeLineageDepth(setupId) {
  return (String(setupId || '').match(/familyexp_/g) || []).length;
}

/** For defensive portfolio output: depth penalty factor. */
function computeLineageDepthPenaltyFactor(depth) {
  if (!Number.isFinite(depth) || depth <= 2) return 1;
  if (depth <= 4) return 0.97;
  if (depth <= 6) return 0.92;
  return 0.85;
}

function normalizeWeights(rows) {
  const total = rows.reduce((sum, r) => sum + safeNum(r.allocation_weight, 0), 0);
  if (total <= 0) {
    const equal = rows.length ? 1 / rows.length : 0;
    return rows.map((r) => ({ ...r, allocation_weight: equal }));
  }
  return rows.map((r) => ({
    ...r,
    allocation_weight: safeNum(r.allocation_weight, 0) / total,
  }));
}

function applyAllocationCaps(rows, opts = {}) {
  const minWeight = Math.max(0, safeNum(opts.minWeight, 0));
  const maxWeight = Math.max(minWeight, safeNum(opts.maxWeight, 1));
  const allowCashBuffer = !!opts.allowCashBuffer;

  let capped = (rows || []).map((r) => ({
    ...r,
    allocation_weight: Math.min(maxWeight, Math.max(minWeight, safeNum(r.allocation_weight, 0))),
  }));

  for (let iter = 0; iter < 12; iter += 1) {
    const total = capped.reduce((sum, r) => sum + safeNum(r.allocation_weight, 0), 0);
    const diff = 1 - total;

    if (Math.abs(diff) < 1e-9) break;

    const adjustable = capped.filter((r) => {
      const w = safeNum(r.allocation_weight, 0);
      if (diff > 0) return w < maxWeight - 1e-9;
      return w > minWeight + 1e-9;
    });

    if (!adjustable.length) break;

    const base = adjustable.reduce((sum, r) => sum + safeNum(r.allocation_weight, 0), 0);
    const equalShare = Math.abs(base) < 1e-9 ? diff / adjustable.length : null;

    capped = capped.map((r) => {
      const match = adjustable.find((a) => a.setupId === r.setupId);
      if (!match) return r;

      const current = safeNum(r.allocation_weight, 0);
      let delta = 0;

      if (equalShare != null) delta = equalShare;
      else delta = diff * (current / base);

      return {
        ...r,
        allocation_weight: Math.min(maxWeight, Math.max(minWeight, current + delta)),
      };
    });
  }

  const total = capped.reduce((sum, r) => sum + safeNum(r.allocation_weight, 0), 0);

  if (allowCashBuffer && total < 1 - 1e-9) {
    return capped;
  }

  return normalizeWeights(capped);
}

function buildChampionPortfolio(strategies, opts = {}) {
  const maxStrategies = Number(opts.maxStrategies || 10);
  const allocationBy = opts.allocationBy || 'meta_score';

  const minWeight =
    opts.minWeight != null
      ? Number(opts.minWeight)
      : Number(process.env.PORTFOLIO_MIN_WEIGHT || 0);

  const maxWeight =
    opts.maxWeight != null
      ? Number(opts.maxWeight)
      : Number(process.env.PORTFOLIO_MAX_WEIGHT || 1);

  const allowCashBuffer =
    opts.allowCashBuffer != null
      ? !!opts.allowCashBuffer
      : String(process.env.PORTFOLIO_ALLOW_CASH_BUFFER || '0') === '1';

  const scoreField =
    allocationBy === 'expectancy'
      ? 'expectancy'
      : allocationBy === 'portfolio_score'
        ? 'portfolio_score'
        : 'meta_score';

  const selected = (Array.isArray(strategies) ? strategies : []).slice(0, maxStrategies);

  let weighted = normalizeWeights(
    selected.map((s) => ({
      ...s,
      expected_return: round6(safeNum(s.expectancy, 0)),
      meta_score: round6(safeNum(s.meta_score, 0)),
      portfolio_score: round6(safeNum(s.portfolio_score, 0)),
      trades: safeNum(s.trades, 0),
      allocation_weight: safeNum(s[scoreField], 0),
    }))
  );

  weighted = applyAllocationCaps(weighted, {
    minWeight,
    maxWeight,
    allowCashBuffer,
  });

  const strategyWeights = weighted.map((r) => safeNum(r.allocation_weight, 0));
  const totalAllocated = strategyWeights.reduce((a, b) => a + b, 0);

  const cash_weight =
    allowCashBuffer && totalAllocated < 1 - 1e-9 ? round6(1 - totalAllocated) : 0;
  const is_fully_invested = cash_weight <= 1e-9;
  const constraint_status =
    allowCashBuffer && !is_fully_invested ? 'max_weight_binding' : 'ok';

  const expectedReturn = weighted.reduce(
    (sum, row) => sum + safeNum(row.allocation_weight, 0) * safeNum(row.expected_return, 0),
    0
  );

  const portfolioStrategies = weighted.map((r) => {
    const depth = safeNum(r.lineage_depth, computeLineageDepth(r.setupId));
    return {
      ...r,
      parentFamilyId:
        r.parentFamilyId || r.parentSetupId || r.familyKey || 'unknown_parent_family',
      family_diversity_key: r.family_diversity_key || buildFamilyDiversityKey(r),
      promotedLeader: !!r.promotedLeader,
      lineage_depth: depth,
      lineage_depth_penalty_factor: safeNum(
        r.lineage_depth_penalty_factor,
        computeLineageDepthPenaltyFactor(depth)
      ),
      portfolio_score: safeNum(r.portfolio_score, 0),
      allocation_weight: round6(safeNum(r.allocation_weight, 0)),
      validationAvailable:
        typeof r.validationAvailable === 'boolean' ? r.validationAvailable : false,
      validationExpectancy: Number.isFinite(r.validationExpectancy) ? r.validationExpectancy : null,
      validationTrades: safeNum(r.validationTrades, 0),
      validationWinRate: Number.isFinite(r.validationWinRate) ? r.validationWinRate : null,
      validationPassed: !!r.validationPassed,
      validation_score: safeNum(r.validation_score, 0),
      validation_gate_factor: safeNum(r.validation_gate_factor, 1),
    };
  });

  return {
    strategies: portfolioStrategies,
    expected_return: expectedReturn,
    correlation_notes:
      'Correlation to be computed from strategy returns (e.g. walk-forward or live paper).',
    cash_weight,
    is_fully_invested,
    constraint_status,
    allocation_constraints: {
      min_weight: round6(minWeight),
      max_weight: round6(maxWeight),
      allocation_by: allocationBy,
      allow_cash_buffer: allowCashBuffer,
    },
  };
}

/**
 * Write strategy_portfolio.json to discovery or a custom path.
 *
 * @param {object} portfolio - Output of buildChampionPortfolio
 * @param {string} [outPath] - Default: dataRoot/discovery/strategy_portfolio.json
 */
function writePortfolio(portfolio, outPath) {
  const dir = outPath ? path.dirname(outPath) : dataRoot.getPath('discovery');
  const file = outPath || path.join(dir, 'strategy_portfolio.json');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(portfolio, null, 2), 'utf8');
  return file;
}

module.exports = {
  buildChampionPortfolio,
  applyAllocationCaps,
  normalizeWeights,
  writePortfolio,
};
