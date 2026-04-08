'use strict';

/**
 * Autonomous setup detectors (Phase 1 paper learning).
 *
 * Defaults are tuned for modest candidate flow under live FX/metal prices; scoring + governance
 * remain the primary filters. Env overrides preserve backward compatibility.
 *
 * Key defaults (see parseDetectorEnv):
 * - AUTO_ENTRY_BREAKOUT_MIN: lower floor for composite breakout strength (was 0.06) — relaxed so
 *   weak-but-valid momentum + near-high structure can pass to the scorer.
 * - AUTO_ENTRY_PULLBACK_MIN: minimum pullback depth in the window — relaxed vs 0.22.
 * - AUTO_ENTRY_PULLBACK_TREND_MIN: minimum |window move| to consider a trend leg.
 * - AUTO_ENTRY_MAX_VOLATILITY_PROXY: reject chaotic windows at detector (still fail-soft).
 */

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function parseDetectorEnv() {
  return {
    breakoutMin: parseFloat(process.env.AUTO_ENTRY_BREAKOUT_MIN || '0.018'),
    pullbackMin: parseFloat(process.env.AUTO_ENTRY_PULLBACK_MIN || '0.10'),
    pullbackTrendMin: parseFloat(process.env.AUTO_ENTRY_PULLBACK_TREND_MIN || '0.001'),
    minWindowBreakout: Math.max(1, parseInt(process.env.AUTO_ENTRY_MIN_WINDOW_BREAKOUT || '5', 10) || 5),
    minWindowPullback: Math.max(1, parseInt(process.env.AUTO_ENTRY_MIN_WINDOW_PULLBACK || '6', 10) || 6),
    maxVolatilityProxy: parseFloat(process.env.AUTO_ENTRY_MAX_VOLATILITY_PROXY || '0.12'),
    nearHighPct: parseFloat(process.env.AUTO_ENTRY_NEAR_HIGH_PCT || '0.0015'),
    longOnly: String(process.env.AUTO_ENTRY_LONG_ONLY_DETECTORS || 'true').toLowerCase() !== 'false',
  };
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

function buildBreakoutCandidate(symbol, state, s, env) {
  const distFromHigh = s.high > 0 ? (s.high - s.last) / s.high : 0;
  const nearHigh = distFromHigh >= 0 && distFromHigh <= env.nearHighPct;
  const momentumUp = s.shortMomentum > 0 && s.movePct >= -1e-6;
  const baseStrength = clamp(s.movePct * 3.5 + s.shortMomentum * 4.5, -1, 1);
  const proximityBoost = nearHigh && momentumUp ? 0.045 : 0;
  const breakoutStrength = clamp(baseStrength + proximityBoost, -1, 1);
  const side = breakoutStrength >= 0 ? 'BUY' : 'SELL';
  const strengthAbs = Math.abs(breakoutStrength);

  const breakoutRejectedReasons = [];
  if (s.volatilityProxy > env.maxVolatilityProxy) {
    breakoutRejectedReasons.push(`volatility_too_high volatilityProxy=${round4(s.volatilityProxy)} max=${env.maxVolatilityProxy}`);
    return { candidate: null, breakoutRejectedReasons };
  }

  const relaxedNearHighContinuation =
    nearHigh && momentumUp && strengthAbs >= env.breakoutMin * 0.68 && strengthAbs < env.breakoutMin;
  if (strengthAbs < env.breakoutMin && !relaxedNearHighContinuation) {
    breakoutRejectedReasons.push(
      `strength_below_floor strength=${round4(strengthAbs)} min=${env.breakoutMin} nearHigh=${nearHigh}`
    );
    return { candidate: null, breakoutRejectedReasons };
  }

  const vol = Math.max(0.002, s.volatilityProxy);
  const slDist = Math.max(0.0025, vol * 1.2);
  const tpDist = Math.max(0.004, vol * 2.4);
  const entry = s.last;
  const stopLoss = side === 'BUY' ? entry * (1 - slDist) : entry * (1 + slDist);
  const takeProfit = side === 'BUY' ? entry * (1 + tpDist) : entry * (1 - tpDist);
  const hour = new Date().getUTCHours();
  const sessionTag = hour >= 6 && hour <= 16 ? 'london_us' : hour <= 2 ? 'asia' : 'offpeak';

  const c = buildCandidateBase({
    symbol,
    setupType: 'breakout_continuation',
    side,
    entryReferencePrice: entry,
    stopLoss,
    takeProfit,
    expectedHoldingClass: 'short',
    regime: Math.abs(s.movePct) > 0.004 ? 'trend' : 'range',
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
      nearHighBreakout: nearHigh,
    },
    rawSetupScore: clamp(0.38 + strengthAbs * 0.55 - s.volatilityProxy * 0.18 + (nearHigh ? 0.04 : 0), 0, 1),
    reasons: [
      'breakout_window_signal',
      `breakout_strength=${round4(strengthAbs)}`,
      nearHigh ? 'near_recent_high' : 'momentum_continuation',
    ],
    metadata: { source: 'autonomous_setup_engine', detector: 'breakout_continuation' },
  });
  return { candidate: c, breakoutRejectedReasons: [] };
}

function detectBreakoutContinuation(symbol, state) {
  const env = parseDetectorEnv();
  const prices = state?.pricesBySymbol?.[symbol] || [];
  const s = summarizeWindow(prices);
  if (!s || s.len < env.minWindowBreakout) return null;
  const { candidate } = buildBreakoutCandidate(symbol, state, s, env);
  if (env.longOnly && candidate && String(candidate.side).toUpperCase() !== 'BUY') return null;
  return candidate;
}

function buildPullbackCandidate(symbol, state, s, env) {
  const trend = s.movePct;
  const range = s.high - s.low;
  const retrace = range > 1e-12 ? (s.high - s.last) / range : 0;
  const pullbackDepth = clamp(retrace, 0, 1);
  const trendOk = Math.abs(trend) >= env.pullbackTrendMin;
  const pullbackRejectedReasons = [];

  if (s.volatilityProxy > env.maxVolatilityProxy) {
    pullbackRejectedReasons.push(`volatility_too_high volatilityProxy=${round4(s.volatilityProxy)}`);
    return { candidate: null, pullbackRejectedReasons };
  }

  const reboundHint = s.shortMomentum > 0 && trend > 0;
  const standardOk = trendOk && pullbackDepth >= env.pullbackMin;
  const altOk =
    trendOk &&
    pullbackDepth >= env.pullbackMin * 0.82 &&
    reboundHint &&
    Math.abs(trend) >= env.pullbackTrendMin * 1.15;

  if (!standardOk && !altOk) {
    if (!trendOk) {
      pullbackRejectedReasons.push(`trend_too_weak |movePct|=${round4(Math.abs(trend))}`);
    }
    if (pullbackDepth < env.pullbackMin * 0.82) {
      pullbackRejectedReasons.push(`pullback_shallow depth=${round4(pullbackDepth)} min=${env.pullbackMin}`);
    }
    if (!pullbackRejectedReasons.length) {
      pullbackRejectedReasons.push('pullback_not_standard_or_alt');
    }
    return { candidate: null, pullbackRejectedReasons };
  }

  const side = trend > 0 ? 'BUY' : 'SELL';
  const entry = s.last;
  const vol = Math.max(0.002, s.volatilityProxy);
  const slDist = Math.max(0.002, vol * 1.0);
  const tpDist = Math.max(0.0035, vol * 2.0);
  const stopLoss = side === 'BUY' ? entry * (1 - slDist) : entry * (1 + slDist);
  const takeProfit = side === 'BUY' ? entry * (1 + tpDist) : entry * (1 - tpDist);
  const hour = new Date().getUTCHours();
  const sessionTag = hour >= 6 && hour <= 16 ? 'london_us' : hour <= 2 ? 'asia' : 'offpeak';

  const c = buildCandidateBase({
    symbol,
    setupType: 'trend_pullback',
    side,
    entryReferencePrice: entry,
    stopLoss,
    takeProfit,
    expectedHoldingClass: 'short_to_medium',
    regime: Math.abs(trend) > 0.004 ? 'trend' : 'mixed',
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
      reboundHint,
    },
    rawSetupScore: clamp(
      0.36 + Math.abs(trend) * 6 + pullbackDepth * 0.35 + (reboundHint ? 0.06 : 0) - s.volatilityProxy * 0.15,
      0,
      1
    ),
    reasons: [
      'trend_pullback_detected',
      `pullback_depth=${round4(pullbackDepth)}`,
      altOk ? 'rebound_continuation_hint' : 'directional_retrace',
    ],
    metadata: { source: 'autonomous_setup_engine', detector: 'trend_pullback' },
  });
  return { candidate: c, pullbackRejectedReasons: [] };
}

function detectTrendPullback(symbol, state) {
  const env = parseDetectorEnv();
  const prices = state?.pricesBySymbol?.[symbol] || [];
  const s = summarizeWindow(prices);
  if (!s || s.len < env.minWindowPullback) return null;
  const { candidate } = buildPullbackCandidate(symbol, state, s, env);
  if (env.longOnly && candidate && String(candidate.side).toUpperCase() !== 'BUY') return null;
  return candidate;
}

function emptySymbolDiagnostics(symbol) {
  return {
    symbol: String(symbol || '').toUpperCase(),
    pricesAvailable: 0,
    recentWindowReady: false,
    breakoutEvaluated: false,
    pullbackEvaluated: false,
    breakoutRejectedReasons: [],
    pullbackRejectedReasons: [],
    rawCandidatesEmitted: 0,
  };
}

function evaluateSymbolDetectors(symbol, state, flags) {
  const sym = String(symbol || '').toUpperCase().trim();
  const env = parseDetectorEnv();
  const prices = state?.pricesBySymbol?.[sym] || [];
  const n = Array.isArray(prices) ? prices.filter((x) => Number.isFinite(Number(x))).length : 0;
  const breakoutRejectedReasons = [];
  const pullbackRejectedReasons = [];
  const candidates = [];

  if (!sym) {
    return { ...emptySymbolDiagnostics(''), rawCandidatesEmitted: 0 };
  }

  const s = summarizeWindow(prices);
  const breakoutReady = s && s.len >= env.minWindowBreakout;
  const pullbackReady = s && s.len >= env.minWindowPullback;

  if (!breakoutReady) {
    breakoutRejectedReasons.push(
      n < env.minWindowBreakout
        ? `insufficient_prices need>=${env.minWindowBreakout} have=${n}`
        : 'window_unavailable'
    );
  }
  if (!pullbackReady) {
    pullbackRejectedReasons.push(
      n < env.minWindowPullback
        ? `insufficient_prices need>=${env.minWindowPullback} have=${n}`
        : 'window_unavailable'
    );
  }

  if (flags.breakout && breakoutReady) {
    const br = buildBreakoutCandidate(sym, state, s, env);
    breakoutRejectedReasons.push(...(br.breakoutRejectedReasons || []));
    if (br.candidate) {
      if (!env.longOnly || String(br.candidate.side).toUpperCase() === 'BUY') {
        candidates.push(br.candidate);
      } else {
        breakoutRejectedReasons.push('long_only_skipped_sell');
      }
    }
  }

  if (flags.pullback && pullbackReady) {
    const pb = buildPullbackCandidate(sym, state, s, env);
    pullbackRejectedReasons.push(...(pb.pullbackRejectedReasons || []));
    if (pb.candidate) {
      if (!env.longOnly || String(pb.candidate.side).toUpperCase() === 'BUY') {
        candidates.push(pb.candidate);
      } else {
        pullbackRejectedReasons.push('long_only_skipped_sell');
      }
    }
  }

  return {
    symbol: sym,
    pricesAvailable: n,
    recentWindowReady: breakoutReady || pullbackReady,
    breakoutEvaluated: !!flags.breakout,
    pullbackEvaluated: !!flags.pullback,
    breakoutRejectedReasons,
    pullbackRejectedReasons,
    rawCandidatesEmitted: candidates.length,
    candidates,
  };
}

function detectAutonomousCandidatesWithDiagnostics(options = {}) {
  const symbols = Array.isArray(options.symbols) ? options.symbols : [];
  const state = options.state || {};
  const flags = parseEnabledSetupFlags();
  const detectorDiagnostics = [];
  const out = [];

  for (const symRaw of symbols) {
    const sym = String(symRaw || '').toUpperCase().trim();
    if (!sym) continue;
    const ev = evaluateSymbolDetectors(sym, state, flags);
    const { candidates, ...rest } = ev;
    detectorDiagnostics.push(rest);
    for (const c of candidates || []) out.push(c);
  }

  if (flags.meanrev) {
    // Reserved for future phase (explicitly disabled by default).
  }

  return { candidates: out, detectorDiagnostics: detectorDiagnostics };
}

function detectAutonomousCandidates(options = {}) {
  const { candidates } = detectAutonomousCandidatesWithDiagnostics(options);
  return candidates;
}

module.exports = {
  parseDetectorEnv,
  detectBreakoutContinuation,
  detectTrendPullback,
  detectAutonomousCandidates,
  detectAutonomousCandidatesWithDiagnostics,
  evaluateSymbolDetectors,
  emptySymbolDiagnostics,
  summarizeWindow,
  parseEnabledSetupFlags,
};
