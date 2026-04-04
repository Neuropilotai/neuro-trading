'use strict';

/**
 * NeuroPilot Quant Engine v1 — Risk Sizing Engine
 *
 * Converts a valid trade decision into a position sizing decision: risk amount,
 * ATR-based stop distance, and position size. Pure function: same inputs => same output.
 *
 * Inputs:
 *   - features: object from Feature Engine (atr required for stop distance)
 *   - regime: { regime: string, confidence: number } from Regime Engine
 *   - strategyDecision: from Strategy Engine (used only to validate pipeline state)
 *   - tradeDecision: from Trade Decision Engine; must have shouldTrade === true for sizing
 *   - account: { equity: number, dailyPnL: number, openPositions: number }
 *
 * Output:
 *   - { shouldSize, valid, riskPercent, riskAmount, stopDistance, positionSize, maxLossIfStopped, reason }
 *   - If sizing rejected: shouldSize false, valid false, reason explains why.
 */

/** Canonical "no size" decision. */
const NO_SIZE_DECISION = Object.freeze({
  shouldSize: false,
  valid: false,
  riskPercent: null,
  riskAmount: null,
  stopDistance: null,
  positionSize: null,
  maxLossIfStopped: null,
  reason: 'No valid sizing decision',
});

/**
 * Default risk parameters. All overridable via options.
 */
const DEFAULT_OPTIONS = Object.freeze({
  /** Fraction of equity to risk per trade (e.g. 0.01 = 1%). */
  riskPercent: 0.01,
  /** ATR multiplier for stop distance: stopDistance = atr * stopAtrMultiplier. */
  stopAtrMultiplier: 1.0,
  /** Max allowed daily loss as fraction of equity (e.g. 0.02 = 2%); reject if daily loss exceeds this. */
  maxDailyLossPercent: 0.02,
  /** Max concurrent open positions; reject if account.openPositions >= this. */
  maxOpenPositions: 5,
  /** Minimum stop distance in price units (avoid division by zero / tiny stops). */
  minStopDistance: 1e-6,
});

/**
 * Compute ATR-based stop distance. Uses features.atr and stopAtrMultiplier.
 */
function getStopDistance(features, opts) {
  const atr = features && features.atr;
  if (atr == null || typeof atr !== 'number' || atr <= 0) return null;
  return atr * opts.stopAtrMultiplier;
}

/**
 * Validate account and risk limits. Returns rejection reason or null if allowed.
 */
function validateAccountAndLimits(account, opts) {
  if (!account || typeof account.equity !== 'number') {
    return 'Invalid or missing account';
  }
  if (account.equity <= 0) {
    return 'Account equity must be positive';
  }
  const openPositions = typeof account.openPositions === 'number' ? account.openPositions : 0;
  if (openPositions >= opts.maxOpenPositions) {
    return `Open positions (${openPositions}) at or above max (${opts.maxOpenPositions})`;
  }
  const dailyPnL = typeof account.dailyPnL === 'number' ? account.dailyPnL : 0;
  const maxAllowedLoss = account.equity * opts.maxDailyLossPercent;
  if (dailyPnL <= -maxAllowedLoss) {
    return 'Daily loss limit reached';
  }
  return null;
}

/**
 * Compute position sizing from risk and stop distance.
 * positionSize = riskAmount / stopDistance (units); maxLossIfStopped = riskAmount.
 */
function computeSizing(equity, riskPercent, stopDistance, opts) {
  const riskAmount = equity * riskPercent;
  const effectiveStop = Math.max(stopDistance, opts.minStopDistance);
  const positionSize = riskAmount / effectiveStop;
  const maxLossIfStopped = positionSize * effectiveStop;
  return { riskAmount, positionSize, maxLossIfStopped };
}

/**
 * Size position for a valid trade. Pure function.
 *
 * @param {object} features - Feature object (must contain atr for ATR-based stop)
 * @param {object} regime - Regime object (for pipeline consistency; not used in math)
 * @param {object} strategyDecision - Strategy decision (for pipeline consistency)
 * @param {object} tradeDecision - Trade decision; sizing only if shouldTrade === true
 * @param {object} account - { equity: number, dailyPnL: number, openPositions: number }
 * @param {object} [options] - Override riskPercent, stopAtrMultiplier, maxDailyLossPercent, maxOpenPositions, minStopDistance
 * @returns {object} Sizing decision (see module doc)
 */
function size(features, regime, strategyDecision, tradeDecision, account, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!tradeDecision || tradeDecision.shouldTrade !== true || tradeDecision.valid !== true) {
    return {
      ...NO_SIZE_DECISION,
      reason: tradeDecision && !tradeDecision.shouldTrade ? 'Trade decision is no-trade' : 'No valid trade decision',
    };
  }

  const rejectReason = validateAccountAndLimits(account, opts);
  if (rejectReason) {
    return {
      ...NO_SIZE_DECISION,
      reason: rejectReason,
    };
  }

  const stopDistance = getStopDistance(features, opts);
  if (stopDistance == null || stopDistance <= 0) {
    return {
      ...NO_SIZE_DECISION,
      reason: 'ATR unavailable or invalid; cannot compute stop distance',
    };
  }

  const equity = account.equity;
  const { riskAmount, positionSize, maxLossIfStopped } = computeSizing(
    equity,
    opts.riskPercent,
    stopDistance,
    opts
  );

  const reason = `Risk sized using ATR stop and ${(opts.riskPercent * 100).toFixed(1)}% account risk`;

  return {
    shouldSize: true,
    valid: true,
    riskPercent: opts.riskPercent,
    riskAmount: Math.round(riskAmount * 100) / 100,
    stopDistance: Math.round(stopDistance * 100) / 100,
    positionSize: Math.round(positionSize * 100) / 100,
    maxLossIfStopped: Math.round(maxLossIfStopped * 100) / 100,
    reason,
  };
}

module.exports = {
  size,
  NO_SIZE_DECISION,
  DEFAULT_OPTIONS,
  getStopDistance,
  validateAccountAndLimits,
  computeSizing,
};
