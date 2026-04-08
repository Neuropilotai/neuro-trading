'use strict';

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function parseEnabledSetupFlags() {
  return {
    breakout: String(process.env.AUTO_ENTRY_ENABLE_BREAKOUT || 'true').toLowerCase() !== 'false',
    pullback: String(process.env.AUTO_ENTRY_ENABLE_PULLBACK || 'true').toLowerCase() !== 'false',
    meanrev: String(process.env.AUTO_ENTRY_ENABLE_MEANREV || 'false').toLowerCase() === 'true',
  };
}

function summarizeWindow(prices) {
  const arr = Array.isArray(prices) ? prices.filter((x) => Number.isFinite(Number(x))) : [];
  if (arr.length < 3) return null;
  const first = Number(arr[0]);
  const last = Number(arr[arr.length - 1]);
  const prev = Number(arr[arr.length - 2]);
  const hi = Math.max(...arr);
  const lo = Math.min(...arr);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  let varSum = 0;
  for (const p of arr) varSum += (p - mean) * (p - mean);
  const sd = Math.sqrt(varSum / arr.length);
  return {
    len: arr.length,
    first,
    last,
    prev,
    high: hi,
    low: lo,
    movePct: first > 0 ? (last - first) / first : 0,
    shortMomentum: prev > 0 ? (last - prev) / prev : 0,
    volatilityProxy: mean > 0 ? sd / mean : 0,
  };
}

function buildCandidateBase(input) {
  const {
    symbol,
    setupType,
    side,
    timeframe = '1m',
    entryReferencePrice,
    stopLoss,
    takeProfit,
    expectedHoldingClass,
    regime = 'unknown',
    features,
    rawSetupScore,
    reasons,
    metadata,
  } = input || {};
  return {
    candidateId: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    generatedAt: new Date().toISOString(),
    symbol: String(symbol || '').toUpperCase(),
    setupType,
    side,
    timeframe,
    entryReferencePrice: round4(entryReferencePrice),
    stopLoss: round4(stopLoss),
    takeProfit: round4(takeProfit),
    expectedHoldingClass: expectedHoldingClass || 'short',
    regime,
    features: features || {},
    rawSetupScore: round4(rawSetupScore),
    reasons: Array.isArray(reasons) ? reasons : [],
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
  };
}

function detectBreakoutContinuation(symbol, state) {
  const prices = state?.pricesBySymbol?.[symbol] || [];
  const s = summarizeWindow(prices);
  if (!s || s.len < 6) return null;

  const distFromHigh = s.high > 0 ? (s.high - s.last) / s.high : 0;
  const breakoutStrength = clamp((s.movePct * 4 + s.shortMomentum * 6), -1, 1);
  const side = breakoutStrength >= 0 ? 'BUY' : 'SELL';
  const strengthAbs = Math.abs(breakoutStrength);
  if (strengthAbs < parseFloat(process.env.AUTO_ENTRY_BREAKOUT_MIN || '0.06')) return null;

  const vol = Math.max(0.002, s.volatilityProxy);
  const slDist = Math.max(0.0025, vol * 1.2);
  const tpDist = Math.max(0.004, vol * 2.4);
  const entry = s.last;
  const stopLoss = side === 'BUY' ? entry * (1 - slDist) : entry * (1 + slDist);
  const takeProfit = side === 'BUY' ? entry * (1 + tpDist) : entry * (1 - tpDist);
  const hour = new Date().getUTCHours();
  const sessionTag = hour >= 6 && hour <= 16 ? 'london_us' : hour <= 2 ? 'asia' : 'offpeak';

  return buildCandidateBase({
    symbol,
    setupType: 'breakout_continuation',
    side,
    entryReferencePrice: entry,
    stopLoss,
    takeProfit,
    expectedHoldingClass: 'short',
    regime: Math.abs(s.movePct) > 0.006 ? 'trend' : 'range',
    features: {
      recentMovePct: round4(s.movePct),
      distanceFromRecentHigh: round4(distFromHigh),
      distanceFromRecentLow: round4(s.last > 0 ? (s.last - s.low) / s.last : 0),
      shortMomentum: round4(s.shortMomentum),
      mediumMomentum: round4(s.movePct),
      pullbackDepth: 0,
      volatilityProxy: round4(s.volatilityProxy),
      spreadProxy: round4(Number(state?.spreadProxyBySymbol?.[symbol]) || 0),
      sessionTag,
      hourUTC: hour,
      trendBias: side === 'BUY' ? 'up' : 'down',
      trendStrength: round4(clamp(Math.abs(s.movePct) * 4, 0, 1)),
      breakoutStrength: round4(strengthAbs),
    },
    rawSetupScore: clamp(0.45 + strengthAbs * 0.5 - s.volatilityProxy * 0.2, 0, 1),
    reasons: ['breakout_window_signal', `breakout_strength=${round4(strengthAbs)}`],
    metadata: { source: 'autonomous_setup_engine' },
  });
}

function detectTrendPullback(symbol, state) {
  const prices = state?.pricesBySymbol?.[symbol] || [];
  const s = summarizeWindow(prices);
  if (!s || s.len < 8) return null;

  const trend = s.movePct;
  const retrace = s.high > s.low ? (s.high - s.last) / (s.high - s.low + 1e-9) : 0;
  const pullbackDepth = clamp(retrace, 0, 1);
  const pullMin = parseFloat(process.env.AUTO_ENTRY_PULLBACK_MIN || '0.22');
  if (Math.abs(trend) < 0.003 || pullbackDepth < pullMin) return null;

  const side = trend > 0 ? 'BUY' : 'SELL';
  const entry = s.last;
  const vol = Math.max(0.002, s.volatilityProxy);
  const slDist = Math.max(0.002, vol * 1.0);
  const tpDist = Math.max(0.0035, vol * 2.0);
  const stopLoss = side === 'BUY' ? entry * (1 - slDist) : entry * (1 + slDist);
  const takeProfit = side === 'BUY' ? entry * (1 + tpDist) : entry * (1 - tpDist);
  const hour = new Date().getUTCHours();
  const sessionTag = hour >= 6 && hour <= 16 ? 'london_us' : hour <= 2 ? 'asia' : 'offpeak';

  return buildCandidateBase({
    symbol,
    setupType: 'trend_pullback',
    side,
    entryReferencePrice: entry,
    stopLoss,
    takeProfit,
    expectedHoldingClass: 'short_to_medium',
    regime: Math.abs(trend) > 0.005 ? 'trend' : 'mixed',
    features: {
      recentMovePct: round4(s.movePct),
      distanceFromRecentHigh: round4(s.high > 0 ? (s.high - s.last) / s.high : 0),
      distanceFromRecentLow: round4(s.last > 0 ? (s.last - s.low) / s.last : 0),
      shortMomentum: round4(s.shortMomentum),
      mediumMomentum: round4(s.movePct),
      pullbackDepth: round4(pullbackDepth),
      volatilityProxy: round4(s.volatilityProxy),
      spreadProxy: round4(Number(state?.spreadProxyBySymbol?.[symbol]) || 0),
      sessionTag,
      hourUTC: hour,
      trendBias: side === 'BUY' ? 'up' : 'down',
      trendStrength: round4(clamp(Math.abs(trend) * 3, 0, 1)),
      breakoutStrength: round4(clamp(Math.abs(s.shortMomentum) * 5, 0, 1)),
    },
    rawSetupScore: clamp(0.4 + Math.abs(trend) * 7 + pullbackDepth * 0.25 - s.volatilityProxy * 0.15, 0, 1),
    reasons: ['trend_pullback_detected', `pullback_depth=${round4(pullbackDepth)}`],
    metadata: { source: 'autonomous_setup_engine' },
  });
}

function detectAutonomousCandidates(options = {}) {
  const symbols = Array.isArray(options.symbols) ? options.symbols : [];
  const state = options.state || {};
  const flags = parseEnabledSetupFlags();
  const out = [];

  for (const symRaw of symbols) {
    const sym = String(symRaw || '').toUpperCase().trim();
    if (!sym) continue;
    if (flags.breakout) {
      const c = detectBreakoutContinuation(sym, state);
      if (c) out.push(c);
    }
    if (flags.pullback) {
      const c = detectTrendPullback(sym, state);
      if (c) out.push(c);
    }
    if (flags.meanrev) {
      // Reserved for future phase (explicitly disabled by default).
    }
  }
  return out;
}

module.exports = {
  detectBreakoutContinuation,
  detectTrendPullback,
  detectAutonomousCandidates,
  summarizeWindow,
  parseEnabledSetupFlags,
};
