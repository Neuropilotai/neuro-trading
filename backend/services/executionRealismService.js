'use strict';

/**
 * Paper execution realism — spread / slippage / fee / lite impact (deterministic, auditable).
 * Does not connect to live brokers. Toggle: EXEC_REALISM_ENABLED (default true).
 *
 * Env (see computeExecutionCostEstimate):
 * - EXEC_REALISM_SPREAD_BPS_XAUUSD, EXEC_REALISM_SPREAD_BPS_EURUSD, EXEC_REALISM_DEFAULT_SPREAD_BPS
 * - EXEC_REALISM_SLIPPAGE_BPS_BASE, EXEC_REALISM_SLIPPAGE_BPS_VOL_MULT, EXEC_REALISM_SLIPPAGE_BPS_LATENCY_MULT
 * - EXEC_REALISM_FEE_BPS, EXEC_REALISM_IMPACT_BPS, EXEC_REALISM_MAX_TOTAL_BPS
 */

function isExecRealismEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.EXEC_REALISM_ENABLED || 'true').trim().toLowerCase()
  );
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function round6(x) {
  return Math.round(Number(x) * 1e6) / 1e6;
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function normalizeSymbol(sym) {
  return String(sym || '').toUpperCase().trim();
}

/**
 * Full bid-ask spread in bps (not per-side).
 */
function spreadBpsForSymbol(symbol) {
  const s = normalizeSymbol(symbol);
  const def = parseFloat(process.env.EXEC_REALISM_DEFAULT_SPREAD_BPS || '3');
  const xau = parseFloat(process.env.EXEC_REALISM_SPREAD_BPS_XAUUSD || '4');
  const eur = parseFloat(process.env.EXEC_REALISM_SPREAD_BPS_EURUSD || '2.5');
  if (s.includes('XAU') || s === 'XAUUSD') return Number.isFinite(xau) ? xau : def;
  if (s.includes('EUR') || s === 'EURUSD') return Number.isFinite(eur) ? eur : def;
  return Number.isFinite(def) ? def : 3;
}

function parsePricingMode(ctx) {
  const m = ctx && ctx.pricingMode != null ? String(ctx.pricingMode) : '';
  if (m) return m;
  const q = ctx && ctx.quote;
  if (q && q.source) return String(q.source);
  return 'unknown';
}

/**
 * @param {object} context
 * @returns {object} cost breakdown (dollars + bps components; totalBps capped)
 */
function computeExecutionCostEstimate(context) {
  const symbol = normalizeSymbol(context.symbol);
  const side = String(context.side || 'BUY').toUpperCase();
  const requestedPrice = Number(context.requestedPrice);
  const quantity = Number(context.quantity);
  const notional =
    Number(context.notional) > 0
      ? Number(context.notional)
      : Number.isFinite(requestedPrice) && Number.isFinite(quantity) && quantity > 0
        ? requestedPrice * quantity
        : 0;

  const quote = context.quote && typeof context.quote === 'object' ? context.quote : {};
  const latencyMs =
    context.latencyMs != null
      ? Number(context.latencyMs)
      : quote.latencyMs != null
        ? Number(quote.latencyMs)
        : 50;
  const volProxy = Number(context.volatilityProxy);
  const vol = Number.isFinite(volProxy) ? clamp(volProxy, 0, 1) : 0.25;

  const costMode = isExecRealismEnabled() ? 'paper_realism_v1' : 'disabled';

  if (!isExecRealismEnabled() || !Number.isFinite(requestedPrice) || requestedPrice <= 0 || notional <= 0) {
    return {
      spreadCost: 0,
      spreadBps: 0,
      slippageCost: 0,
      slippageBps: 0,
      feeCost: 0,
      feeBps: 0,
      impactCost: 0,
      impactBps: 0,
      totalCost: 0,
      totalBps: 0,
      costMode,
      reasons: [!isExecRealismEnabled() ? 'exec_realism_disabled' : 'invalid_notional_or_price'],
      assumptions: ['Costs zero when realism off or inputs invalid.'],
    };
  }

  const fullSpreadBps = spreadBpsForSymbol(symbol);
  const halfSpreadBps = fullSpreadBps / 2;

  const baseSlip = parseFloat(process.env.EXEC_REALISM_SLIPPAGE_BPS_BASE || '1.2');
  const volMult = parseFloat(process.env.EXEC_REALISM_SLIPPAGE_BPS_VOL_MULT || '2');
  const latMult = parseFloat(process.env.EXEC_REALISM_SLIPPAGE_BPS_LATENCY_MULT || '0.015');
  const lat = Number.isFinite(latencyMs) ? latencyMs : 50;
  const slipBps =
    baseSlip + vol * volMult + Math.min(80, lat) * latMult + (side === 'SELL' ? 0.05 : 0);

  const feeBps = parseFloat(process.env.EXEC_REALISM_FEE_BPS || '1.5');
  const impactBase = parseFloat(process.env.EXEC_REALISM_IMPACT_BPS || '0.35');
  const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : notional / requestedPrice;
  const impactBps = impactBase * Math.min(1, Math.sqrt(Math.max(qty, 1e-12) / 10));

  const sumBpsUncapped = halfSpreadBps + slipBps + feeBps + impactBps;
  const maxBps = parseFloat(process.env.EXEC_REALISM_MAX_TOTAL_BPS || '80');
  const capScale =
    Number.isFinite(maxBps) && maxBps > 0 && sumBpsUncapped > maxBps
      ? maxBps / sumBpsUncapped
      : 1;

  const halfSpreadBpsAdj = halfSpreadBps * capScale;
  const slipBpsAdj = slipBps * capScale;
  const feeBpsAdj = feeBps * capScale;
  const impactBpsAdj = impactBps * capScale;

  const spreadCost = (notional * halfSpreadBpsAdj) / 10000;
  const slippageCost = (notional * slipBpsAdj) / 10000;
  const feeCost = (notional * feeBpsAdj) / 10000;
  const impactCost = (notional * impactBpsAdj) / 10000;

  const totalCost = spreadCost + slippageCost + feeCost + impactCost;
  const totalBpsEff = (totalCost / notional) * 10000;

  const reasons = [
    `half_spread_${round4(halfSpreadBpsAdj)}bps`,
    `slippage_${round4(slipBpsAdj)}bps`,
    `fee_${round4(feeBpsAdj)}bps`,
    `impact_${round4(impactBpsAdj)}bps`,
    `side_${side}`,
    capScale < 1 ? `capped_to_${round4(maxBps)}bps_total` : 'uncapped',
  ];

  const assumptions = [
    `Spread uses configured bps for ${symbol}; one leg pays half spread on ${side}.`,
    `Slippage scales with volatilityProxy=${round4(vol)} and latencyMs=${round4(lat)}.`,
    `Impact is sqrt-scaled on quantity (lite, bounded).`,
    `pricingMode=${parsePricingMode(context)}`,
  ];

  return {
    spreadCost: round6(spreadCost),
    spreadBps: round4(halfSpreadBpsAdj),
    slippageCost: round6(slippageCost),
    slippageBps: round4(slipBpsAdj),
    feeCost: round6(feeCost),
    feeBps: round4(feeBpsAdj),
    impactCost: round6(impactCost),
    impactBps: round4(impactBpsAdj),
    totalCost: round6(totalCost),
    totalBps: round4(totalBpsEff),
    costMode,
    reasons,
    assumptions,
  };
}

/**
 * Realistic fill for paper: reference vs effective, quality score, diagnostics.
 * BUY: effective >= reference (worse). SELL: effective <= reference (worse).
 */
function computeRealisticPaperFill(context) {
  const referencePrice = Number(context.requestedPrice);
  const side = String(context.side || 'BUY').toUpperCase();
  const qty = Number(context.quantity);
  const notional =
    Number(context.notional) > 0
      ? Number(context.notional)
      : Number.isFinite(referencePrice) && Number.isFinite(qty) && qty > 0
        ? referencePrice * qty
        : 0;

  const est = computeExecutionCostEstimate(context);
  const totalCost = est.totalCost;
  const totalBps = est.totalBps;

  let effectiveFillPrice = referencePrice;
  if (isExecRealismEnabled() && Number.isFinite(referencePrice) && referencePrice > 0 && qty > 0) {
    const adj = totalCost / qty;
    if (side === 'BUY') {
      effectiveFillPrice = referencePrice + adj;
    } else {
      effectiveFillPrice = referencePrice - adj;
    }
  }

  const spreadMove = referencePrice * (est.spreadBps / 10000);
  const spreadAdjustedPrice =
    side === 'BUY' ? referencePrice + spreadMove : referencePrice - spreadMove;
  const restBps = Math.max(0, totalBps - est.spreadBps);
  const slippageAdjustedPrice =
    side === 'BUY'
      ? spreadAdjustedPrice + referencePrice * (restBps / 10000)
      : spreadAdjustedPrice - referencePrice * (restBps / 10000);

  const fillQualityScore = round4(
    clamp(100 - Math.min(100, totalBps * 1.25), 0, 100)
  );

  const executionDiagnostics = {
    costEstimate: est,
    referencePrice: round6(referencePrice),
    effectiveFillPrice: round6(effectiveFillPrice),
    spreadAdjustedPrice: round6(spreadAdjustedPrice),
    slippageAdjustedPrice: round6(slippageAdjustedPrice),
  };

  return {
    referencePrice: round6(referencePrice),
    effectiveFillPrice: round6(effectiveFillPrice),
    spreadAdjustedPrice: round6(spreadAdjustedPrice),
    slippageAdjustedPrice: round6(slippageAdjustedPrice),
    feeCost: est.feeCost,
    totalCost: round6(totalCost),
    totalBps: round4(totalBps),
    fillQualityScore,
    executionDiagnostics,
  };
}

/**
 * Build context for paper execution from order + optional quote.
 */
function buildPaperExecutionContext(orderIntent, overrides = {}) {
  const symbol = normalizeSymbol(orderIntent.symbol);
  const action = String(orderIntent.action || 'BUY').toUpperCase();
  const side =
    overrides.side != null
      ? String(overrides.side).toUpperCase()
      : action === 'CLOSE'
        ? 'SELL'
        : action;
  const price = Number(orderIntent.price);
  const qty = Number(orderIntent.quantity);
  const quote = overrides.quote || null;
  const priceFeedService = require('./priceFeedService');
  const q = quote || priceFeedService.getQuoteSync(symbol);
  const latencyMs = q && q.latencyMs != null ? Number(q.latencyMs) : overrides.latencyMs ?? null;
  const pricingMode = overrides.pricingMode || (q && q.source) || 'fallback';

  const meta = orderIntent.metadata && typeof orderIntent.metadata === 'object' ? orderIntent.metadata : {};
  const sessionTag = meta.sessionTag != null ? String(meta.sessionTag) : overrides.sessionTag || null;
  const source =
    orderIntent.actionSource != null ? String(orderIntent.actionSource) : overrides.source || 'unknown';

  return {
    symbol,
    side,
    requestedPrice: price,
    quantity: qty,
    notional: overrides.notional != null ? Number(overrides.notional) : price * qty,
    quote: q,
    pricingMode,
    latencyMs,
    volatilityProxy: overrides.volatilityProxy != null ? Number(overrides.volatilityProxy) : 0.25,
    sessionTag,
    source,
    setupType: orderIntent.autonomousSetupType != null ? orderIntent.autonomousSetupType : null,
    strategy: orderIntent.strategy != null ? String(orderIntent.strategy) : null,
  };
}

module.exports = {
  isExecRealismEnabled,
  computeExecutionCostEstimate,
  computeRealisticPaperFill,
  buildPaperExecutionContext,
  spreadBpsForSymbol,
};
