'use strict';

/**
 * Institutional analytics overview for dashboards (PM / risk / quant).
 * Read-only aggregation; failures must not affect execution (caller try/catch).
 */

const closedTradeAnalyticsService = require('./closedTradeAnalyticsService');

function round6(x) {
  return Math.round(Number(x) * 1e6) / 1e6;
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function _mean(arr) {
  const a = (arr || []).filter(Number.isFinite);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

/**
 * Live portfolio snapshot from paper account (long-only book + MTM).
 */
function buildPortfolioOverview() {
  try {
    const paperTradingService = require('./paperTradingService');
    const s = paperTradingService.getAccountSummary();
    const grossExposure = (s.positions || []).reduce(
      (sum, p) => sum + Math.abs(Number(p.marketValue) || 0),
      0
    );
    return {
      equity: round6(s.equity),
      bookEquity: round6(s.bookEquity),
      totalUnrealizedPnL: round6(s.totalUnrealizedPnL),
      totalRealizedPnL: round6(s.totalPnL),
      openPositions: Number(s.openPositions) || 0,
      grossExposure: round6(grossExposure),
      cash: round6(s.balance),
      pricingMode: s.pricingMode != null ? String(s.pricingMode) : null,
      priceLatency: s.priceLatency != null ? s.priceLatency : null,
      initialBalance: round6(s.initialBalance),
      dailyPnL: round6(s.dailyPnL),
    };
  } catch (e) {
    return {
      equity: null,
      bookEquity: null,
      totalUnrealizedPnL: null,
      totalRealizedPnL: null,
      openPositions: 0,
      grossExposure: null,
      cash: null,
      pricingMode: null,
      priceLatency: null,
      initialBalance: null,
      dailyPnL: null,
      error: e.message,
    };
  }
}

function buildExecutionQualitySummary(trades) {
  const rows = Array.isArray(trades) ? trades : [];
  const effs = rows.map((t) => Number(t.efficiencyRatio)).filter(Number.isFinite);
  const mfes = rows.map((t) => Number(t.mfe)).filter(Number.isFinite);
  const maes = rows.map((t) => Number(t.mae)).filter(Number.isFinite);
  const holds = rows.map((t) => Number(t.holdingTimeSec)).filter(Number.isFinite);
  const slips = rows.map((t) => Number(t.slippage)).filter(Number.isFinite);

  let partialCloses = 0;
  let fullCloses = 0;
  for (const t of rows) {
    if (t.tradeGroupId && (t.mfe == null || !Number.isFinite(Number(t.mfe)))) {
      partialCloses++;
    }
    if (Number.isFinite(Number(t.mfe)) && Number(t.mfe) >= 0) {
      fullCloses++;
    }
  }

  const avgEfficiencyRatio = effs.length ? round4(_mean(effs)) : null;
  const avgMFE = mfes.length ? round6(_mean(mfes)) : null;
  const avgMAE = maes.length ? round6(_mean(maes)) : null;
  const avgHoldingTimeSec = holds.length ? Math.round(_mean(holds)) : null;
  const avgSlippage = slips.length ? round6(_mean(slips)) : null;

  const winRatePct =
    rows.length > 0
      ? (rows.filter((t) => (Number(t.realizedPnL) || 0) > 0).length / rows.length) * 100
      : 0;
  let pf = null;
  let gp = 0;
  let gl = 0;
  for (const t of rows) {
    const p = Number(t.realizedPnL) || 0;
    if (p > 0) gp += p;
    if (p < 0) gl += p;
  }
  if (gl !== 0) pf = gp / Math.abs(gl);

  let executionQualityScore = 50;
  if (rows.length > 0) {
    const ePart = avgEfficiencyRatio != null ? Math.min(1, Math.max(0, avgEfficiencyRatio)) * 25 : 0;
    const wPart = (winRatePct / 100) * 25;
    const pfPart =
      pf != null && Number.isFinite(pf)
        ? Math.min(1, Math.max(0, (pf - 0.5) / 1.5)) * 25
        : 0;
    const sPart = avgSlippage != null && avgSlippage !== 0 ? 12.5 : 12.5;
    executionQualityScore = Math.round(
      Math.min(100, Math.max(0, ePart + wPart + pfPart + sPart))
    );
  }

  return {
    tradeCount: rows.length,
    averageEfficiencyRatio: avgEfficiencyRatio,
    averageMFE: avgMFE,
    averageMAE: avgMAE,
    averageHoldingTimeSec: avgHoldingTimeSec,
    averageSlippage: avgSlippage,
    partialCloses,
    fullCloses,
    executionQualityScore,
    winRatePercent: round4(winRatePct),
    profitFactor: pf != null ? round4(pf) : null,
  };
}

function mapAttributionForDashboard(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    groupKey: row.groupKey,
    dimensions: row.dimensions,
    trades: row.trades,
    winRate: row.winRate,
    expectancy: row.expectancy,
    profitFactor: row.profitFactor,
    totalRealizedPnL: row.totalPnL,
    avgPnL: row.avgPnL,
    avgMFE: row.avgMFE,
    avgMAE: row.avgMAE,
    avgEfficiency: row.avgEfficiencyRatio,
    avgHoldingTimeSec: row.avgHoldingTimeSec,
    sharpeProxy: row.sharpeProxy,
    payoffRatio: row.payoffRatio,
    winStreak: row.winStreak,
    lossStreak: row.lossStreak,
  };
}

function mapRegimeRow(row) {
  const m = mapAttributionForDashboard(row);
  return {
    groupKey: m.groupKey,
    trades: m.trades,
    winRate: m.winRate,
    expectancy: m.expectancy,
    totalPnL: m.totalRealizedPnL,
    avgMFE: m.avgMFE,
    avgMAE: m.avgMAE,
    avgEfficiency: m.avgEfficiency,
  };
}

/**
 * @param {object[]} trades
 * @param {string[]} groupBy - passed to closedTradeAnalyticsService.getPerformanceAttribution
 */
function buildAttributionSummary(trades, groupBy) {
  const rows = closedTradeAnalyticsService.getPerformanceAttribution(trades, { groupBy });
  return rows.map(mapAttributionForDashboard);
}

function buildRegimeAttribution(trades) {
  const rows = closedTradeAnalyticsService.getPerformanceAttribution(trades, {
    groupBy: ['regime'],
  });
  return rows.map(mapRegimeRow);
}

function tradeRef(t) {
  return {
    tradeCloseId: t.tradeCloseId || null,
    symbol: t.symbol != null ? String(t.symbol).toUpperCase() : null,
    strategy: t.strategy != null ? t.strategy : null,
    realizedPnL: round6(Number(t.realizedPnL) || 0),
    exitTimestamp: t.exitTimestamp || null,
    mfe: Number.isFinite(Number(t.mfe)) ? round6(t.mfe) : null,
    mae: Number.isFinite(Number(t.mae)) ? round6(t.mae) : null,
    efficiencyRatio: Number.isFinite(Number(t.efficiencyRatio))
      ? round4(t.efficiencyRatio)
      : null,
    holdingTimeSec: Number(t.holdingTimeSec) || 0,
    peakUnrealizedPnL: Number.isFinite(Number(t.peakUnrealizedPnL))
      ? round6(t.peakUnrealizedPnL)
      : null,
  };
}

function buildLifecycleOutliers(trades, options = {}) {
  const rows = Array.isArray(trades) ? [...trades] : [];
  const n = Math.min(Math.max(parseInt(options.outlierLimit, 10) || 5, 1), 50);

  const byPnl = [...rows].sort(
    (a, b) => (Number(b.realizedPnL) || 0) - (Number(a.realizedPnL) || 0)
  );
  const bestByRealizedPnL = byPnl.slice(0, n).map(tradeRef);
  const worstByRealizedPnL = byPnl.slice(-n).reverse().map(tradeRef);

  const withMfe = rows.filter((t) => Number.isFinite(Number(t.mfe)) && Number(t.mfe) > 0);
  const highMfePoorEfficiency = [...withMfe]
    .filter((t) => {
      const e = Number(t.efficiencyRatio);
      return Number.isFinite(e) && e < 0.35;
    })
    .sort((a, b) => (Number(b.mfe) || 0) - (Number(a.mfe) || 0))
    .slice(0, n)
    .map(tradeRef);

  const withMae = rows.filter((t) => Number.isFinite(Number(t.mae)));
  const worstMae = [...withMae]
    .sort((a, b) => (Number(b.mae) || 0) - (Number(a.mae) || 0))
    .slice(0, n)
    .map(tradeRef);

  const longestHolding = [...rows]
    .sort((a, b) => (Number(b.holdingTimeSec) || 0) - (Number(a.holdingTimeSec) || 0))
    .slice(0, n)
    .map(tradeRef);

  const weakConversion = [...rows]
    .filter((t) => {
      const peak = Number(t.peakUnrealizedPnL);
      const pnl = Number(t.realizedPnL);
      return (
        Number.isFinite(peak) &&
        peak > 0 &&
        Number.isFinite(pnl) &&
        pnl < peak * 0.25
      );
    })
    .sort((a, b) => (Number(b.peakUnrealizedPnL) || 0) - (Number(a.peakUnrealizedPnL) || 0))
    .slice(0, n)
    .map(tradeRef);

  return {
    bestByRealizedPnL,
    worstByRealizedPnL,
    highMfePoorEfficiency,
    worstMae,
    longestHolding,
    weakRealizedVsPeakUnrealized: weakConversion,
  };
}

function chronoSort(rows) {
  return [...rows].sort((a, b) =>
    String(a.exitTimestamp || '').localeCompare(String(b.exitTimestamp || ''))
  );
}

function globalStreaks(rows) {
  const chrono = chronoSort(rows);
  let winStreak = 0;
  let lossStreak = 0;
  let curW = 0;
  let curL = 0;
  for (const t of chrono) {
    const pnl = Number(t.realizedPnL) || 0;
    if (pnl > 0) {
      curW++;
      curL = 0;
      winStreak = Math.max(winStreak, curW);
    } else if (pnl < 0) {
      curL++;
      curW = 0;
      lossStreak = Math.max(lossStreak, curL);
    } else {
      curW = 0;
      curL = 0;
    }
  }
  return { winStreak, lossStreak, currentWinStreak: curW, currentLossStreak: curL };
}

function drawdownProxyFromTrades(rows) {
  const chrono = chronoSort(rows);
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const t of chrono) {
    cum += Number(t.realizedPnL) || 0;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return round6(maxDd);
}

function buildRiskDiagnostics(trades, accountSummary) {
  const rows = Array.isArray(trades) ? trades : [];
  const streaks = globalStreaks(rows);
  const maxDrawdownProxy = drawdownProxyFromTrades(rows);

  let exposureConcentration = null;
  let topSymbolExposure = null;
  if (accountSummary && typeof accountSummary === 'object') {
    try {
      const positions = accountSummary.positions || [];
      const be = Number(accountSummary.bookEquity) || 0;
      if (be > 0 && positions.length) {
        let maxFrac = 0;
        let sym = null;
        for (const p of positions) {
          const frac = Math.abs(Number(p.bookValue) || 0) / be;
          if (frac > maxFrac) {
            maxFrac = frac;
            sym = p.symbol;
          }
        }
        exposureConcentration = round4(maxFrac);
        topSymbolExposure = sym;
      }
    } catch (e) {
      /* ignore */
    }
  }

  const stratRows = closedTradeAnalyticsService.getPerformanceAttribution(rows, {
    groupBy: ['strategy'],
  });
  const symRows = closedTradeAnalyticsService.getPerformanceAttribution(rows, {
    groupBy: ['symbol'],
  });

  const byPnl = (a, b) => (Number(a.totalPnL) || 0) - (Number(b.totalPnL) || 0);
  const topUnderperformingStrategies = [...stratRows].sort(byPnl).slice(0, 5).map((r) => ({
    groupKey: r.groupKey,
    totalRealizedPnL: round6(r.totalPnL),
    trades: r.trades,
    expectancy: r.expectancy,
  }));
  const topDeterioratingSymbols = [...symRows].sort(byPnl).slice(0, 5).map((r) => ({
    groupKey: r.groupKey,
    totalRealizedPnL: round6(r.totalPnL),
    trades: r.trades,
    expectancy: r.expectancy,
  }));

  const regimeRows = closedTradeAnalyticsService.getPerformanceAttribution(rows, {
    groupBy: ['regime'],
  });
  const unstableRegimes = regimeRows
    .filter((r) => r.trades >= 2 && (r.expectancy < 0 || r.lossStreak >= 3))
    .map((r) => ({
      regime: r.groupKey,
      trades: r.trades,
      expectancy: r.expectancy,
      lossStreak: r.lossStreak,
    }));

  const degradationFlags = [];
  if (maxDrawdownProxy > 0 && rows.length >= 5) {
    const rel = maxDrawdownProxy / (Math.abs(rows.reduce((s, t) => s + (Number(t.realizedPnL) || 0), 0)) + 1e-9);
    if (rel > 0.5) degradationFlags.push('HIGH_DRAWDOWN_PRESSURE');
  }
  if (streaks.lossStreak >= 4) degradationFlags.push('LONG_LOSS_STREAK');
  if (exposureConcentration != null && exposureConcentration > 0.6) {
    degradationFlags.push('CONCENTRATED_BOOK');
  }

  return {
    streaks,
    drawdownProxy: maxDrawdownProxy,
    exposureConcentration,
    topSymbolExposure,
    topUnderperformingStrategies,
    topDeterioratingSymbols,
    unstableRegimes,
    degradationFlags,
  };
}

function computeHealthScore(executionQuality, riskDiag, portfolio) {
  let h = 50;
  if (executionQuality && Number.isFinite(executionQuality.executionQualityScore)) {
    h += (executionQuality.executionQualityScore - 50) * 0.4;
  }
  if (riskDiag && Array.isArray(riskDiag.degradationFlags)) {
    h -= riskDiag.degradationFlags.length * 8;
  }
  if (portfolio && portfolio.equity != null && portfolio.initialBalance > 0) {
    const rt = portfolio.equity / portfolio.initialBalance - 1;
    h += Math.max(-15, Math.min(15, rt * 100));
  }
  return Math.round(Math.min(100, Math.max(0, h)));
}

function computeEdgeScoresByStrategy(strategyAttribution) {
  const out = {};
  for (const row of strategyAttribution || []) {
    const key = row.groupKey || 'unknown';
    const ex = Number(row.expectancy) || 0;
    const eff = Number(row.avgEfficiency) || 0;
    const score = Math.round(Math.min(100, Math.max(0, 50 + ex * 10 + eff * 25)));
    out[key] = score;
  }
  return out;
}

/**
 * @param {object} options - from, to, symbol, strategy, limit (max rows loaded for analytics)
 */
async function getAnalyticsOverview(options = {}) {
  const generatedAt = new Date().toISOString();
  const listOpts = {
    from: options.from,
    to: options.to,
    symbol: options.symbol,
    strategy: options.strategy,
    limit: options.limit,
  };

  let trades = [];
  try {
    trades = await closedTradeAnalyticsService.listClosedTrades(listOpts);
  } catch (e) {
    trades = [];
  }

  const portfolio = buildPortfolioOverview();
  const executionQuality = buildExecutionQualitySummary(trades);
  const strategyAttribution = buildAttributionSummary(trades, ['strategy']);
  const symbolAttribution = buildAttributionSummary(trades, ['symbol']);
  const hourAttribution = buildAttributionSummary(trades, ['hourUTC']);
  const dayAttribution = buildAttributionSummary(trades, ['date']);
  const weekdayAttribution = buildAttributionSummary(trades, ['weekday']);
  const regimeAttribution = buildRegimeAttribution(trades);

  const outlierLimit = parseInt(options.outlierLimit, 10) || 5;
  const lifecycleOutliers = buildLifecycleOutliers(trades, { outlierLimit });

  let accountSnap = null;
  try {
    accountSnap = require('./paperTradingService').getAccountSummary();
  } catch (e) {
    accountSnap = null;
  }
  const riskDiagnostics = buildRiskDiagnostics(trades, accountSnap);

  const healthScore = computeHealthScore(executionQuality, riskDiagnostics, {
    equity: portfolio.equity,
    initialBalance: portfolio.initialBalance,
  });
  const edgeScoreByStrategy = computeEdgeScoresByStrategy(strategyAttribution);

  return {
    generatedAt,
    portfolio,
    executionQuality,
    strategyAttribution,
    symbolAttribution,
    hourAttribution,
    dayAttribution,
    weekdayAttribution,
    regimeAttribution,
    lifecycleOutliers,
    riskDiagnostics,
    healthScore,
    edgeScoreByStrategy,
    degradationFlags: riskDiagnostics.degradationFlags || [],
    meta: {
      tradeRowsUsed: trades.length,
      filters: {
        from: listOpts.from || null,
        to: listOpts.to || null,
        symbol: listOpts.symbol || null,
        strategy: listOpts.strategy || null,
        limit: listOpts.limit || null,
      },
    },
  };
}

async function getAttributionEndpoint(options = {}) {
  const groupBy = options.groupBy
    ? String(options.groupBy)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : ['strategy', 'symbol'];
  let trades = [];
  try {
    trades = await closedTradeAnalyticsService.listClosedTrades({
      from: options.from,
      to: options.to,
      symbol: options.symbol,
      strategy: options.strategy,
      limit: options.limit,
    });
  } catch (e) {
    trades = [];
  }
  return {
    generatedAt: new Date().toISOString(),
    groupBy,
    attribution: buildAttributionSummary(trades, groupBy),
    tradeRowsUsed: trades.length,
  };
}

async function getLifecycleOutliersEndpoint(options = {}) {
  let trades = [];
  try {
    trades = await closedTradeAnalyticsService.listClosedTrades({
      from: options.from,
      to: options.to,
      symbol: options.symbol,
      strategy: options.strategy,
      limit: options.limit,
    });
  } catch (e) {
    trades = [];
  }
  return {
    generatedAt: new Date().toISOString(),
    lifecycleOutliers: buildLifecycleOutliers(trades, {
      outlierLimit: options.outlierLimit,
    }),
    tradeRowsUsed: trades.length,
  };
}

async function getRiskDiagnosticsEndpoint(options = {}) {
  let trades = [];
  try {
    trades = await closedTradeAnalyticsService.listClosedTrades({
      from: options.from,
      to: options.to,
      symbol: options.symbol,
      strategy: options.strategy,
      limit: options.limit,
    });
  } catch (e) {
    trades = [];
  }
  let accountSnap = null;
  try {
    accountSnap = require('./paperTradingService').getAccountSummary();
  } catch (e) {
    accountSnap = null;
  }
  return {
    generatedAt: new Date().toISOString(),
    riskDiagnostics: buildRiskDiagnostics(trades, accountSnap),
    tradeRowsUsed: trades.length,
  };
}

module.exports = {
  getAnalyticsOverview,
  buildPortfolioOverview,
  buildExecutionQualitySummary,
  buildAttributionSummary,
  buildLifecycleOutliers,
  buildRiskDiagnostics,
  getAttributionEndpoint,
  getLifecycleOutliersEndpoint,
  getRiskDiagnosticsEndpoint,
};
