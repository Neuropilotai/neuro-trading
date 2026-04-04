'use strict';

const fs = require('fs');
const path = require('path');
const { resolveMode } = require('./phaseGate');
const { applyPaperAwarePromotionGates } = require('./promotionGuardPaperAware');

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildThresholds(guardCfg = {}) {
  return {
    minTrades: Math.max(1, safeNum(guardCfg.minTrades, 40)),
    minExpectancy: safeNum(guardCfg.minExpectancy, 0),
    maxDrawdownPct: Math.max(0, safeNum(guardCfg.maxDrawdownPct, 25)),
    minProfitFactor: Math.max(0, safeNum(guardCfg.minProfitFactor, 1.05)),
    maxTopTradesConcentrationPct: Math.min(
      1,
      Math.max(0, safeNum(guardCfg.maxTopTradesPnlShare, 0.65))
    ),
    requireWalkForward: guardCfg.requireWalkForwardPass !== false,
  };
}

function loadMarketContextSafe() {
  try {
    const root = process.env.NEUROPILOT_DATA_ROOT;
    if (!root || !String(root).trim()) return null;
    const p = path.join(String(root), 'discovery', 'market_context.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch (_) {
    return null;
  }
}

function detectSessionUTC(ts) {
  const h = new Date(ts || Date.now()).getUTCHours();
  if (h >= 0 && h < 7) return 'asia';
  if (h >= 7 && h < 13) return 'europe';
  return 'us';
}

function computeContextAdjustment(ctx, session, candidate) {
  if (!ctx || typeof ctx !== 'object') return { bonus: 0, malus: 0, reasons: [] };
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const regime = String(ctx.regime || 'unknown').toLowerCase();
  const direction = String(c.direction || '').toLowerCase();
  const strategyType = String(c.strategyType || '').toLowerCase();
  const avgTradeDuration = safeNum(c.avgTradeDuration, 0);

  let bonus = 0;
  let malus = 0;
  const reasons = [];

  if (regime.includes('bull') && direction === 'long') {
    bonus += 0.02;
    reasons.push({ code: 'CONTEXT_REGIME_ALIGNED', message: 'bull regime aligned with long bias' });
  }
  if (regime.includes('bear') && direction === 'long') {
    malus += 0.03;
    reasons.push({ code: 'CONTEXT_REGIME_MISMATCH', message: 'bear regime mismatch with long bias' });
  }
  if (safeNum(ctx.volatilityScore, 0) > 0.7 && avgTradeDuration > 0 && avgTradeDuration < 5) {
    bonus += 0.01;
    reasons.push({ code: 'CONTEXT_REGIME_ALIGNED', message: 'high volatility aligned with short duration' });
  }
  if (session === 'asia' && strategyType === 'breakout') {
    malus += 0.02;
    reasons.push({ code: 'CONTEXT_SESSION_MISMATCH', message: 'asia session mismatch with breakout style' });
  } else if (session === 'us' && strategyType === 'breakout') {
    bonus += 0.01;
    reasons.push({ code: 'CONTEXT_SESSION_ALIGNED', message: 'us session aligned with breakout style' });
  }

  const rawDelta = bonus - malus;
  const contextScoreDelta = Math.max(-0.08, Math.min(0.08, rawDelta));
  if (contextScoreDelta > 0) {
    bonus = contextScoreDelta;
    malus = 0;
  } else if (contextScoreDelta < 0) {
    bonus = 0;
    malus = -contextScoreDelta;
  } else {
    bonus = 0;
    malus = 0;
  }

  return { bonus, malus, reasons, contextScoreDelta };
}

/**
 * Profit factor from candidate: finite number, +Infinity (all wins), or null if missing/invalid.
 * Does not coerce null to 0.
 */
function extractProfitFactorRaw(c) {
  const o = c && typeof c === 'object' ? c : {};
  const pick = o.profitFactor != null && o.profitFactor !== '' ? o.profitFactor : o.pf;
  if (pick == null || pick === '') return null;
  if (pick === Infinity || pick === -Infinity) return pick;
  const n = Number(pick);
  if (n === Infinity || n === -Infinity) return n;
  return Number.isFinite(n) ? n : null;
}

function extractWalkForwardPassRaw(c) {
  const o = c && typeof c === 'object' ? c : {};
  if (o.walkForwardPass === true || o.walk_forward_pass === true) return true;
  if (o.walkForwardPass === false || o.walk_forward_pass === false) return false;
  const wf = o.walkforward && typeof o.walkforward === 'object' ? o.walkforward : null;
  if (wf && wf.present === true && (wf.passed === true || wf.passed === false)) {
    return wf.passed === true;
  }
  return undefined;
}

function extractMetrics(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const wfSnap =
    c.walkforward && typeof c.walkforward === 'object' ? c.walkforward : null;
  const ddRaw =
    Number.isFinite(Number(c.drawdownPct)) ? Number(c.drawdownPct)
      : Number.isFinite(Number(c.maxDrawdownPct)) ? Number(c.maxDrawdownPct)
        : Number.isFinite(Number(c.maxDrawdown)) ? Number(c.maxDrawdown)
          : null;
  const pfRaw = extractProfitFactorRaw(c);
  const topRaw =
    Number.isFinite(Number(c.topTradesConcentrationPct)) ? Number(c.topTradesConcentrationPct)
      : Number.isFinite(Number(c.topTradesPnlShare)) ? Number(c.topTradesPnlShare)
        : null;
  return {
    trades: safeNum(c.trades, 0),
    expectancy: Number.isFinite(Number(c.expectancy)) ? Number(c.expectancy) : null,
    drawdownPct: ddRaw,
    profitFactor: pfRaw,
    topTradesConcentrationPct: topRaw,
    walkForwardPass: extractWalkForwardPassRaw(c),
    ...(wfSnap ? { walkforward: wfSnap } : {}),
  };
}

function evaluatePromotionCandidate(candidate, guardCfg = {}, modeName = null, paperContext = null) {
  const thresholds = buildThresholds(guardCfg);
  const m = extractMetrics(candidate);
  const ctx = loadMarketContextSafe();
  const session = detectSessionUTC(Date.now());
  const ctxAdj = computeContextAdjustment(ctx, session, candidate);
  const baseScore = Number.isFinite(Number(m.expectancy)) ? Number(m.expectancy) : 0;
  const adjustedScore = baseScore + (ctxAdj.contextScoreDelta || 0);
  const reasons = [];

  let paperDiag = null;
  if (paperContext && paperContext.root) {
    paperDiag = applyPaperAwarePromotionGates(candidate, paperContext, reasons);
  }

  if (m.trades < thresholds.minTrades) {
    reasons.push({
      code: 'REJECT_MIN_TRADES',
      message: 'min trades not met',
      actual: m.trades,
      required: thresholds.minTrades,
    });
  }
  if (!(Number(adjustedScore) > thresholds.minExpectancy)) {
    reasons.push({
      code: 'REJECT_EXPECTANCY',
      message: 'expectancy threshold not met after context adjustment',
      actual: adjustedScore,
      required: thresholds.minExpectancy,
    });
  }
  if (!(Number(m.drawdownPct) <= thresholds.maxDrawdownPct)) {
    reasons.push({
      code: 'REJECT_MAX_DRAWDOWN',
      message: 'drawdown exceeds maximum threshold',
      actual: m.drawdownPct,
      required: thresholds.maxDrawdownPct,
    });
  }
  const hasPF =
    m.profitFactor != null &&
    (Number.isFinite(m.profitFactor) || m.profitFactor === Infinity);
  if (!hasPF) {
    reasons.push({
      code: 'REJECT_PROFIT_FACTOR_MISSING',
      message: 'profit factor not available for evaluation',
      actual: m.profitFactor,
      required: thresholds.minProfitFactor,
    });
  } else if (!(Number(m.profitFactor) >= thresholds.minProfitFactor)) {
    reasons.push({
      code: 'REJECT_PROFIT_FACTOR',
      message: 'profit factor below threshold',
      actual: m.profitFactor,
      required: thresholds.minProfitFactor,
    });
  }
  if (!(Number(m.topTradesConcentrationPct) <= thresholds.maxTopTradesConcentrationPct)) {
    reasons.push({
      code: 'REJECT_TOP_TRADE_CONCENTRATION',
      message: 'top trades concentration exceeds threshold',
      actual: m.topTradesConcentrationPct,
      required: thresholds.maxTopTradesConcentrationPct,
    });
  }
  if (thresholds.requireWalkForward) {
    const hasWF = typeof m.walkForwardPass === 'boolean';
    if (!hasWF) {
      reasons.push({
        code: 'REJECT_WALKFORWARD_MISSING',
        message: 'walk-forward pass not available for evaluation',
        actual: null,
        required: true,
      });
    } else if (m.walkForwardPass !== true) {
      reasons.push({
        code: 'REJECT_WALKFORWARD',
        message: 'walk-forward gate failed',
        actual: m.walkForwardPass,
        required: true,
      });
    }
  }
  const minScore = guardCfg && Number.isFinite(Number(guardCfg.minScore))
    ? Number(guardCfg.minScore)
    : null;
  if (minScore != null && adjustedScore < minScore) {
    reasons.push({
      code: 'CONTEXT_REJECT',
      message: 'rejected after context adjustment',
      actual: adjustedScore,
      required: minScore,
    });
  }

  const mode =
    modeName != null && String(modeName).trim() !== ''
      ? String(modeName)
      : String(process.env.NEUROPILOT_LEARNING_MODE || 'core_3m');
  const eligible = reasons.length === 0;
  const result = {
    eligible,
    target: 'paper',
    mode,
    reasons: reasons.concat(ctxAdj.reasons || []),
    thresholdsApplied: thresholds,
    metricsSnapshot: {
      ...m,
      baseScore,
      adjustedScore,
      contextScoreDelta: ctxAdj.contextScoreDelta || 0,
      ...(paperDiag ? { paperPromotion: paperDiag } : {}),
    },
    contextApplied: !!ctx,
    marketContext: ctx
      ? {
          regime: ctx.regime || 'unknown',
          volatility: Number.isFinite(Number(ctx.volatilityScore)) ? Number(ctx.volatilityScore) : null,
          trendStrength: Number.isFinite(Number(ctx.trendStrength)) ? Number(ctx.trendStrength) : null,
          session,
        }
      : {
          regime: 'unknown',
          volatility: null,
          trendStrength: null,
          session,
        },
    contextAlignment: {
      hasRegimeAlignment: (ctxAdj.reasons || []).some((r) => r && r.code === 'CONTEXT_REGIME_ALIGNED'),
      hasRegimeMismatch: (ctxAdj.reasons || []).some((r) => r && r.code === 'CONTEXT_REGIME_MISMATCH'),
      hasSessionAlignment: (ctxAdj.reasons || []).some((r) => r && r.code === 'CONTEXT_SESSION_ALIGNED'),
      hasSessionMismatch: (ctxAdj.reasons || []).some((r) => r && r.code === 'CONTEXT_SESSION_MISMATCH'),
    },
    contextScoreDelta: ctxAdj.contextScoreDelta || 0,
    // Backward compatibility
    ok: eligible,
    metrics: {
      trades: m.trades,
      expectancy: m.expectancy,
      drawdownPct: m.drawdownPct,
      profitFactor: m.profitFactor,
      topTradesPnlShare: m.topTradesConcentrationPct,
      walkForwardPass: m.walkForwardPass,
      ...(m.walkforward && typeof m.walkforward === 'object' ? { walkforward: m.walkforward } : {}),
    },
  };

  if (!eligible) {
    console.log(
      JSON.stringify({
        tag: 'PROMOTION_CONTEXT_REJECT',
        setupId: candidate && candidate.setupId != null
          ? String(candidate.setupId)
          : (candidate && candidate.strategyId != null ? String(candidate.strategyId) : 'unknown'),
        regime: result.marketContext.regime,
        session,
        bonus: ctxAdj.bonus || 0,
        malus: ctxAdj.malus || 0,
        finalScore: adjustedScore,
      })
    );
  }

  return result;
}

function evaluatePromotionBatch(candidates, modeName) {
  const { mode, config } = resolveMode(modeName);
  const guardCfg = config && config.promotionGuard ? config.promotionGuard : {};
  const targetEnvironment = String(guardCfg.targetEnvironment || 'paper');
  const rows = (Array.isArray(candidates) ? candidates : []).map((c) => {
    const evalOne = evaluatePromotionCandidate(c, guardCfg, mode);
    return {
      strategyId: c && c.strategyId != null ? String(c.strategyId) : 'unknown',
      eligible: evalOne.eligible,
      ok: evalOne.eligible,
      reasons: evalOne.reasons,
      thresholdsApplied: evalOne.thresholdsApplied,
      metricsSnapshot: evalOne.metricsSnapshot,
      targetEnvironment,
      mode,
    };
  });
  return {
    mode,
    targetEnvironment,
    evaluated: rows.length,
    promoted: rows.filter((r) => r.ok).length,
    rejected: rows.filter((r) => !r.ok).length,
    rows,
  };
}

function enforcePaperOnlyRuntime(modeName) {
  const { mode, config } = resolveMode(modeName);
  const paperOnly = config && config.paperOnly === true;
  return {
    mode,
    paperOnly,
    executionMode: paperOnly ? 'paper' : (config.liveTradingEnabled === true ? 'live' : 'paper'),
    liveTradingAllowed: paperOnly ? false : config.liveTradingEnabled === true,
  };
}

module.exports = {
  evaluatePromotionCandidate,
  evaluatePromotionBatch,
  enforcePaperOnlyRuntime,
};
