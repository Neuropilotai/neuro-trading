'use strict';

/**
 * Pre-broker risk evaluation (explicable, loggable). Complements backend/services/riskEngine.js — does not replace it.
 *
 * Fail-closed when critical inputs missing (price, quantity, equity) for open actions.
 * Configure via NEUROPILOT_PRETRADE_* env vars.
 */

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function loadConfig(env = process.env) {
  return {
    maxRiskPerTradePct: num(env.NEUROPILOT_PRETRADE_MAX_RISK_PER_TRADE_PCT, 2),
    maxNotionalPerTrade: num(env.NEUROPILOT_PRETRADE_MAX_NOTIONAL, 1e12),
    maxConcurrentPositions: Math.floor(num(env.NEUROPILOT_PRETRADE_MAX_CONCURRENT_POSITIONS, 20)),
    maxOpenTradesPerStrategy: Math.floor(num(env.NEUROPILOT_PRETRADE_MAX_OPEN_PER_STRATEGY, 5)),
    maxOpenTradesPerSymbol: Math.floor(num(env.NEUROPILOT_PRETRADE_MAX_OPEN_PER_SYMBOL, 3)),
    maxDailyDrawdownPct: num(env.NEUROPILOT_PRETRADE_MAX_DAILY_DRAWDOWN_PCT, 5),
    maxTradesPerDay: Math.floor(num(env.NEUROPILOT_PRETRADE_MAX_TRADES_PER_DAY, 100)),
    cooldownMsPerStrategy: Math.floor(num(env.NEUROPILOT_PRETRADE_COOLDOWN_MS_STRATEGY, 0)),
    cooldownMsPerSymbol: Math.floor(num(env.NEUROPILOT_PRETRADE_COOLDOWN_MS_SYMBOL, 0)),
    minStopDistancePct: num(env.NEUROPILOT_PRETRADE_MIN_STOP_DISTANCE_PCT, 0.05),
    minRewardRisk: num(env.NEUROPILOT_PRETRADE_MIN_REWARD_RISK, 0),
    maxExposurePctPerAssetClass: num(env.NEUROPILOT_PRETRADE_MAX_EXPOSURE_PCT_ASSET_CLASS, 80),
  };
}

function assetClassFromSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.includes('XAU') || s.includes('XAG')) return 'metals';
  if (s.endsWith('USDT') || s.endsWith('BUSD')) return 'crypto';
  return 'other';
}

/**
 * @param {object} orderIntent
 * @param {object} context
 * @param {number} context.equity
 * @param {number} [context.openPositionsCount]
 * @param {Record<string, number>} [context.openCountByStrategy]
 * @param {Record<string, number>} [context.openCountBySymbol]
 * @param {number} [context.tradesTodayTotal]
 * @param {number} [context.dailyRealizedPnl]
 * @param {number} [context.dailyUnrealizedPnl]
 * @param {Record<string, number>} [context.notionalExposureByAssetClass]
 * @param {Record<string, number>} [context.lastTradeTsByStrategy] — ms epoch per strategy id
 * @param {Record<string, number>} [context.lastTradeTsBySymbol] — ms epoch per uppercase symbol
 * @param {object} [env]
 */
function evaluatePreTradeRisk(orderIntent, context = {}, env = process.env) {
  const cfg = loadConfig(env);
  const checks = {};
  const violations = [];
  const warnings = [];

  const action = String(orderIntent?.action || '').toUpperCase();
  const symbol = orderIntent?.symbol != null ? String(orderIntent.symbol) : '';
  const strategyId =
    orderIntent?.setupId != null
      ? String(orderIntent.setupId)
      : orderIntent?.strategyId != null
        ? String(orderIntent.strategyId)
        : '';

  const price = num(orderIntent?.price, NaN);
  const qty = num(orderIntent?.quantity, NaN);
  const stop = orderIntent?.stopLoss != null ? num(orderIntent.stopLoss, NaN) : NaN;
  const tp = orderIntent?.takeProfit != null ? num(orderIntent.takeProfit, NaN) : NaN;

  const equity = num(context.equity, NaN);

  if (!['BUY', 'SELL', 'CLOSE'].includes(action)) {
    violations.push('invalid_action');
    return {
      accepted: false,
      sizingDecision: null,
      violations,
      warnings,
      checks: { ...checks, action },
    };
  }

  if (action === 'CLOSE') {
    return {
      accepted: true,
      sizingDecision: {
        qty,
        units: qty,
        notional: Number.isFinite(price) && Number.isFinite(qty) ? Math.abs(qty * price) : null,
        riskAmount: null,
        stopDistance: null,
      },
      violations,
      warnings,
      checks: { ...checks, close_skip_strict_sizing: true },
    };
  }

  if (!Number.isFinite(equity) || equity <= 0) {
    violations.push('missing_or_invalid_equity_fail_closed');
    return {
      accepted: false,
      sizingDecision: null,
      violations,
      warnings,
      checks: { ...checks, equity },
    };
  }

  if (!symbol) {
    violations.push('missing_symbol');
    return { accepted: false, sizingDecision: null, violations, warnings, checks };
  }

  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty === 0) {
    violations.push('missing_price_or_quantity_fail_closed');
    return { accepted: false, sizingDecision: null, violations, warnings, checks };
  }

  if (!Number.isFinite(stop)) {
    violations.push('missing_stop_loss_fail_closed');
    return { accepted: false, sizingDecision: null, violations, warnings, checks };
  }

  const notional = Math.abs(qty * price);
  const stopDistance = Math.abs(price - stop);
  const stopDistPct = (stopDistance / price) * 100;
  checks.stopDistPct = stopDistPct;
  checks.notional = notional;

  if (stopDistPct < cfg.minStopDistancePct) {
    violations.push(`stop_distance_too_small:${stopDistPct.toFixed(4)}pct_lt_${cfg.minStopDistancePct}`);
  }

  if (cfg.maxNotionalPerTrade > 0 && notional > cfg.maxNotionalPerTrade) {
    violations.push(`max_notional_exceeded:${notional}>${cfg.maxNotionalPerTrade}`);
  }

  const riskPerUnit = stopDistance;
  const riskAmount = Math.abs(qty) * riskPerUnit;
  const riskPct = (riskAmount / equity) * 100;
  checks.riskPct = riskPct;
  if (riskPct > cfg.maxRiskPerTradePct) {
    violations.push(`max_risk_per_trade_exceeded:${riskPct.toFixed(3)}pct_gt_${cfg.maxRiskPerTradePct}`);
  }

  if (Number.isFinite(tp) && cfg.minRewardRisk > 0) {
    const reward = Math.abs(tp - price);
    const rr = stopDistance > 0 ? reward / stopDistance : 0;
    checks.rewardRisk = rr;
    if (rr < cfg.minRewardRisk) {
      violations.push(`reward_risk_too_low:${rr.toFixed(3)}_lt_${cfg.minRewardRisk}`);
    }
  }

  const openPos = Math.floor(num(context.openPositionsCount, 0));
  checks.openPositionsCount = openPos;
  if (openPos >= cfg.maxConcurrentPositions) {
    violations.push(`max_concurrent_positions:${openPos}>=${cfg.maxConcurrentPositions}`);
  }

  if (strategyId) {
    const byS = num(context.openCountByStrategy && context.openCountByStrategy[strategyId], 0);
    if (byS >= cfg.maxOpenTradesPerStrategy) {
      violations.push(`max_open_trades_per_strategy:${strategyId}:${byS}>=${cfg.maxOpenTradesPerStrategy}`);
    }
    if (cfg.cooldownMsPerStrategy > 0 && strategyId) {
      const map =
        context.lastTradeTsByStrategy && typeof context.lastTradeTsByStrategy === 'object'
          ? context.lastTradeTsByStrategy
          : null;
      const lastTsStrategy = map && strategyId ? Number(map[strategyId]) : NaN;
      if (Number.isFinite(lastTsStrategy)) {
        const elapsed = Date.now() - lastTsStrategy;
        if (elapsed < cfg.cooldownMsPerStrategy) {
          violations.push(`strategy_cooldown_active:${strategyId}`);
        }
      }
    }
  }

  const symU = symbol.toUpperCase();
  const bySym = num(context.openCountBySymbol && context.openCountBySymbol[symU], 0);
  if (bySym >= cfg.maxOpenTradesPerSymbol) {
    violations.push(`max_open_trades_per_symbol:${symU}:${bySym}>=${cfg.maxOpenTradesPerSymbol}`);
  }
  if (cfg.cooldownMsPerSymbol > 0 && symU) {
    const map =
      context.lastTradeTsBySymbol && typeof context.lastTradeTsBySymbol === 'object'
        ? context.lastTradeTsBySymbol
        : null;
    const lastTsSymbol = map && symU ? Number(map[symU]) : NaN;
    if (Number.isFinite(lastTsSymbol)) {
      const elapsed = Date.now() - lastTsSymbol;
      if (elapsed < cfg.cooldownMsPerSymbol) {
        violations.push(`symbol_cooldown_active:${symU}`);
      }
    }
  }

  const tradesToday = Math.floor(num(context.tradesTodayTotal, 0));
  if (tradesToday >= cfg.maxTradesPerDay) {
    violations.push(`max_trades_per_day:${tradesToday}>=${cfg.maxTradesPerDay}`);
  }

  const dailyPnL = num(context.dailyRealizedPnl, 0) + num(context.dailyUnrealizedPnl, 0);
  const ddPct = equity > 0 && dailyPnL < 0 ? (Math.abs(dailyPnL) / equity) * 100 : 0;
  checks.dailyDrawdownPctApprox = ddPct;
  if (ddPct >= cfg.maxDailyDrawdownPct) {
    violations.push(`daily_drawdown_cap:${ddPct.toFixed(3)}pct>=${cfg.maxDailyDrawdownPct}`);
  }

  const ac = assetClassFromSymbol(symbol);
  const exp = context.notionalExposureByAssetClass && typeof context.notionalExposureByAssetClass === 'object'
    ? num(context.notionalExposureByAssetClass[ac], 0)
    : 0;
  const projected = exp + notional;
  const expPct = (projected / equity) * 100;
  checks.assetClass = ac;
  checks.exposurePctAfter = expPct;
  if (expPct > cfg.maxExposurePctPerAssetClass) {
    violations.push(`asset_class_exposure_cap:${ac}:${expPct.toFixed(2)}pct>${cfg.maxExposurePctPerAssetClass}`);
  }

  const accepted = violations.length === 0;
  return {
    accepted,
    sizingDecision: {
      qty,
      units: qty,
      notional,
      riskAmount,
      stopDistance,
    },
    violations,
    warnings,
    checks,
  };
}

module.exports = {
  evaluatePreTradeRisk,
  loadConfig,
  assetClassFromSymbol,
};
