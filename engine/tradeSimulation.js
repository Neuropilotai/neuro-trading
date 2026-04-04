'use strict';

/**
 * NeuroPilot Quant Engine v1 — Trade Simulation / Outcome Engine
 *
 * Simulates trade outcomes from allowed signals on historical candles.
 * Pure function; no database writes, no broker interaction.
 *
 * For each signal: enter at entryPrice, stop at stopDistance, target at R multiple.
 * Walk forward bar-by-bar; outcome = win | loss | timeout (time-based exit).
 */

/**
 * Resolve bar index for a signal. Uses signal.barIndex if set; else finds bar from
 * signal timestamp when candles have .time / .timestamp / .t.
 *
 * @param {Array<object>} candles - OHLCV bars (oldest first)
 * @param {object} signal - { barIndex?: number, timestamp?: string|number }
 * @returns {number|null} Bar index or null if not resolvable
 */
function resolveBarIndex(candles, signal) {
  if (signal == null) return null;
  if (typeof signal.barIndex === 'number' && Number.isFinite(signal.barIndex)) {
    return signal.barIndex;
  }
  const ts = signal.timestamp;
  if (ts == null || !Array.isArray(candles) || candles.length === 0) return null;
  const tsMs = typeof ts === 'number' ? (ts >= 1e12 ? ts : ts * 1000) : new Date(ts).getTime();
  if (!Number.isFinite(tsMs)) return null;
  for (let i = 0; i < candles.length; i++) {
    const t = candles[i] && (candles[i].time ?? candles[i].timestamp ?? candles[i].t);
    const barMs = t == null ? NaN : (typeof t === 'number' ? (t >= 1e12 ? t : t * 1000) : new Date(t).getTime());
    if (Number.isFinite(barMs) && barMs >= tsMs) return i;
  }
  return candles.length - 1;
}

/**
 * Simulate one trade: walk bars from entryBarIndex+1 until stop, target, or maxBarsHeld.
 * When both stop and target are breached in the same bar, stop is considered hit first (conservative).
 *
 * @param {Array<object>} candles - OHLCV (open, high, low, close)
 * @param {object} signal - { entryPrice, stopDistance, direction?: 'long'|'short', barIndex }
 * @param {object} opts - { rMultiple, maxBarsHeld, defaultDirection }
 * @returns {object} { symbol, timeframe, entryPrice, stopPrice, targetPrice, outcome, rMultiple, barsHeld, ... }
 */
function simulateOne(candles, signal, opts) {
  const entryPrice = signal && typeof signal.entryPrice === 'number' && Number.isFinite(signal.entryPrice)
    ? signal.entryPrice
    : null;
  const stopDistance = signal && typeof signal.stopDistance === 'number' && Number.isFinite(signal.stopDistance) && signal.stopDistance > 0
    ? signal.stopDistance
    : null;
  const direction = (signal && (signal.direction === 'long' || signal.direction === 'short'))
    ? signal.direction
    : (opts.defaultDirection === 'short' ? 'short' : 'long');
  const barIndex = resolveBarIndex(candles, signal);
  const rMultiple = typeof opts.rMultiple === 'number' && opts.rMultiple > 0 ? opts.rMultiple : 2;
  const maxBarsHeld = typeof opts.maxBarsHeld === 'number' && opts.maxBarsHeld >= 0 ? opts.maxBarsHeld : null;

  const symbol = signal && signal.symbol != null ? signal.symbol : null;
  const timeframe = signal && signal.timeframe != null ? signal.timeframe : null;

  const strategy = signal && signal.strategy != null ? signal.strategy : null;
  const regime = signal && signal.regime != null ? signal.regime : null;

  if (entryPrice == null || stopDistance == null || barIndex == null || barIndex < 0) {
    return {
      symbol,
      timeframe,
      entryPrice: entryPrice != null ? entryPrice : null,
      stopPrice: null,
      targetPrice: null,
      outcome: 'skip',
      rMultiple: null,
      barsHeld: 0,
      reason: 'Missing entryPrice, stopDistance, or barIndex',
      strategy,
      regime,
      direction: direction || null,
      entryBarTimeMs: null,
    };
  }

  const stopPrice = direction === 'long'
    ? entryPrice - stopDistance
    : entryPrice + stopDistance;
  const targetDistance = stopDistance * rMultiple;
  const targetPrice = direction === 'long'
    ? entryPrice + targetDistance
    : entryPrice - targetDistance;

  const totalBars = candles.length;
  let outcome = null;
  let barsHeld = 0;
  let exitPrice = null;

  for (let i = barIndex + 1; i < totalBars; i++) {
    barsHeld++;
    const bar = candles[i];
    if (!bar || typeof bar.high !== 'number' || typeof bar.low !== 'number') continue;
    const high = bar.high;
    const low = bar.low;

    if (direction === 'long') {
      if (low <= stopPrice) {
        outcome = 'loss';
        exitPrice = stopPrice;
        break;
      }
      if (high >= targetPrice) {
        outcome = 'win';
        exitPrice = targetPrice;
        break;
      }
    } else {
      if (high >= stopPrice) {
        outcome = 'loss';
        exitPrice = stopPrice;
        break;
      }
      if (low <= targetPrice) {
        outcome = 'win';
        exitPrice = targetPrice;
        break;
      }
    }

    if (maxBarsHeld != null && barsHeld >= maxBarsHeld) {
      outcome = 'timeout';
      exitPrice = bar.close != null && Number.isFinite(bar.close) ? bar.close : (bar.open != null ? bar.open : entryPrice);
      break;
    }
  }

  if (outcome == null) {
    outcome = 'timeout';
    const lastBar = candles[candles.length - 1];
    exitPrice = lastBar && (typeof lastBar.close === 'number' && Number.isFinite(lastBar.close))
      ? lastBar.close
      : entryPrice;
  }

  const riskDistance = stopDistance;
  const pnlPrice = exitPrice != null ? (direction === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice) : 0;
  const actualR = riskDistance > 0 ? pnlPrice / riskDistance : null;

  const entryBar = candles[barIndex];
  const rawTime = entryBar && (entryBar.time ?? entryBar.timestamp ?? entryBar.t);
  const entryBarTimeMs = rawTime != null
    ? (typeof rawTime === 'number' ? (rawTime >= 1e12 ? rawTime : rawTime * 1000) : new Date(rawTime).getTime())
    : null;

  return {
    symbol,
    timeframe,
    entryPrice,
    stopPrice,
    targetPrice,
    outcome,
    rMultiple: actualR != null ? Math.round(actualR * 100) / 100 : null,
    barsHeld,
    exitPrice: exitPrice != null ? exitPrice : null,
    direction,
    strategy,
    regime,
    entryBarTimeMs: Number.isFinite(entryBarTimeMs) ? entryBarTimeMs : null,
  };
}

/**
 * Build summary from trade results.
 *
 * @param {Array<object>} trades - Results from simulateOne (outcome, rMultiple, etc.)
 * @returns {object} { totalTrades, wins, losses, timeouts, winRate, avgR, expectancyR }
 */
function buildSummary(trades) {
  const list = Array.isArray(trades) ? trades.filter((t) => t && t.outcome && t.outcome !== 'skip') : [];
  return summaryFromList(list);
}

/**
 * Compute summary stats for a list of trades (same shape as buildSummary).
 * @param {Array<object>} list - Filtered trades (no skip)
 * @returns {object} { totalTrades, wins, losses, timeouts, winRate, avgR, expectancyR }
 */
function summaryFromList(list) {
  const totalTrades = list.length;
  const wins = list.filter((t) => t.outcome === 'win').length;
  const losses = list.filter((t) => t.outcome === 'loss').length;
  const timeouts = list.filter((t) => t.outcome === 'timeout').length;
  const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 10000) / 100 : 0;
  const rValues = list.map((t) => t.rMultiple).filter((r) => r != null && Number.isFinite(r));
  const sumR = rValues.reduce((a, b) => a + b, 0);
  const avgR = rValues.length > 0 ? Math.round((sumR / rValues.length) * 100) / 100 : null;
  const expectancyR = totalTrades > 0 && rValues.length > 0 ? Math.round((sumR / totalTrades) * 100) / 100 : null;
  return {
    totalTrades,
    wins,
    losses,
    timeouts,
    winRate,
    avgR,
    expectancyR,
  };
}

/**
 * Performance breakdown by strategy, regime, and direction.
 * Trades should include strategy, regime, direction (e.g. from signals that export those fields).
 *
 * @param {Array<object>} trades - Results from run() (outcome, rMultiple, strategy?, regime?, direction?)
 * @returns {object} { byStrategy: { [key]: summary }, byRegime: { [key]: summary }, byDirection: { [key]: summary } }
 */
function strategyPerformanceBreakdown(trades) {
  const list = Array.isArray(trades) ? trades.filter((t) => t && t.outcome && t.outcome !== 'skip') : [];
  const byStrategy = {};
  const byRegime = {};
  const byDirection = {};

  function groupBy(list, getKey) {
    const map = {};
    for (const t of list) {
      const key = getKey(t);
      const k = key != null && key !== '' ? String(key) : 'null';
      if (!map[k]) map[k] = [];
      map[k].push(t);
    }
    const out = {};
    for (const [k, subset] of Object.entries(map)) {
      out[k] = summaryFromList(subset);
    }
    return out;
  }

  return {
    byStrategy: groupBy(list, (t) => t.strategy),
    byRegime: groupBy(list, (t) => t.regime),
    byDirection: groupBy(list, (t) => t.direction),
  };
}

/** Session bucket labels for time-of-day breakdown. */
const SESSION_BUCKETS = Object.freeze(['open', 'mid', 'late']);

/** Regime labels for baseline trend_breakout (order for reporting). */
const REGIME_BUCKETS = Object.freeze(['BREAKOUT', 'TREND_UP', 'TREND_DOWN']);

/**
 * Regime-level performance breakdown (totalTrades, wins, losses, timeouts, winRate, avgR, expectancyR per regime).
 * Uses existing trade simulation output; groups by trade.regime. Use for baseline (e.g. trend_breakout on SPY 5m)
 * to compare BREAKOUT vs TREND_UP vs TREND_DOWN.
 *
 * @param {Array<object>} trades - Results from run() (outcome, rMultiple, regime?)
 * @returns {object} { byRegime: { BREAKOUT: summary, TREND_UP: summary, TREND_DOWN: summary }, other: summary }
 */
function regimePerformanceBreakdown(trades) {
  const list = Array.isArray(trades) ? trades.filter((t) => t && t.outcome && t.outcome !== 'skip') : [];
  const byRegime = {};
  const knownSet = new Set(REGIME_BUCKETS);
  let other = [];

  for (const t of list) {
    const key = t.regime != null && t.regime !== '' ? String(t.regime).trim() : null;
    if (key && knownSet.has(key)) {
      if (!byRegime[key]) byRegime[key] = [];
      byRegime[key].push(t);
    } else {
      other.push(t);
    }
  }

  const out = { byRegime: {}, other: summaryFromList(other) };
  for (const k of REGIME_BUCKETS) {
    out.byRegime[k] = summaryFromList(byRegime[k] || []);
  }
  return out;
}

/** Default session: US regular 9:30–16:00 ET → 14:30–21:00 UTC (minutes from midnight UTC). */
const DEFAULT_SESSION_OPTIONS = Object.freeze({
  sessionStartMinutesFromMidnight: 14 * 60 + 30,  // 14:30 UTC
  sessionEndMinutesFromMidnight: 21 * 60 + 0,    // 21:00 UTC
  openMinutes: 60,
  lateMinutes: 60,
});

/**
 * Get session bucket for a trade: open (first 60 min), mid (middle), late (last 60 min).
 * Assumes entryBarTimeMs is UTC ms. Returns null if outside session or no time.
 *
 * @param {number} entryBarTimeMs - Entry bar timestamp (UTC ms)
 * @param {object} opts - Session options (sessionStartMinutesFromMidnight, sessionEndMinutesFromMidnight, openMinutes, lateMinutes)
 * @returns {string|null} 'open' | 'mid' | 'late' | null
 */
function getSessionBucket(entryBarTimeMs, opts) {
  if (entryBarTimeMs == null || !Number.isFinite(entryBarTimeMs)) return null;
  const start = opts.sessionStartMinutesFromMidnight;
  const end = opts.sessionEndMinutesFromMidnight;
  const openLen = opts.openMinutes;
  const lateLen = opts.lateMinutes;
  const d = new Date(entryBarTimeMs);
  const minutesFromMidnight = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (minutesFromMidnight < start || minutesFromMidnight >= end) return null;
  const minutesIntoSession = minutesFromMidnight - start;
  const sessionLength = end - start;
  if (minutesIntoSession < openLen) return 'open';
  if (minutesIntoSession >= sessionLength - lateLen) return 'late';
  return 'mid';
}

/**
 * Time-of-day performance breakdown by session bucket (open / mid / late).
 * Trades must have entryBarTimeMs set (from simulateOne when candles have .time).
 *
 * @param {Array<object>} trades - Results from run() (outcome, rMultiple, entryBarTimeMs?)
 * @param {object} [options] - { sessionStartMinutesFromMidnight, sessionEndMinutesFromMidnight, openMinutes, lateMinutes }
 * @returns {object} { bySession: { open: summary, mid: summary, late: summary }, unknown: summary }
 */
function sessionPerformanceBreakdown(trades, options = {}) {
  const opts = { ...DEFAULT_SESSION_OPTIONS, ...options };
  const list = Array.isArray(trades) ? trades.filter((t) => t && t.outcome && t.outcome !== 'skip') : [];
  const bySession = { open: [], mid: [], late: [] };
  let unknown = [];
  for (const t of list) {
    const bucket = getSessionBucket(t.entryBarTimeMs, opts);
    if (bucket === 'open' || bucket === 'mid' || bucket === 'late') {
      bySession[bucket].push(t);
    } else {
      unknown.push(t);
    }
  }
  const out = {
    bySession: {
      open: summaryFromList(bySession.open),
      mid: summaryFromList(bySession.mid),
      late: summaryFromList(bySession.late),
    },
    unknown: summaryFromList(unknown),
  };
  return out;
}

/**
 * Run trade simulation: for each allowed signal, simulate outcome on candles.
 *
 * @param {Array<object>} candles - OHLCV bars (oldest first); same symbol/timeframe as signals
 * @param {Array<object>} allowedSignals - Allowed signal records: { entryPrice, stopDistance, direction?, barIndex?, timestamp?, symbol?, timeframe? }
 * @param {object} [options] - { rMultiple, maxBarsHeld, defaultDirection, includeStrategies: string[] }
 *   - includeStrategies: if set, only signals whose strategy is in this array are simulated (e.g. ['trend_breakout'], ['mean_reversion'])
 * @returns {object} { trades: Array<trade>, summary: { totalTrades, wins, losses, timeouts, winRate, avgR, expectancyR } }
 */
function run(candles, allowedSignals, options = {}) {
  const opts = options || {};
  let list = Array.isArray(allowedSignals) ? allowedSignals : [];
  const candleList = Array.isArray(candles) ? candles : [];

  if (Array.isArray(opts.includeStrategies) && opts.includeStrategies.length > 0) {
    const set = new Set(opts.includeStrategies.map((s) => String(s)));
    list = list.filter((s) => s && set.has(String(s.strategy)));
  }

  const trades = [];
  for (const signal of list) {
    const trade = simulateOne(candleList, signal, opts);
    trades.push(trade);
  }

  const summary = buildSummary(trades);
  return { trades, summary };
}

/**
 * Get period key for a trade (for stability analysis). Uses entryBarTimeMs in UTC.
 *
 * @param {object} trade - Trade with entryBarTimeMs
 * @param {string} periodFormat - 'month' (YYYY-MM) or 'week' (YYYY-Www, ISO week)
 * @returns {string} Period key or 'unknown' if no time
 */
function getPeriodKey(trade, periodFormat) {
  const ms = trade && trade.entryBarTimeMs;
  if (ms == null || !Number.isFinite(ms)) return 'unknown';
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (periodFormat === 'week') {
    const oneJan = new Date(Date.UTC(y, 0, 1));
    const dayOfYear = Math.floor((d - oneJan) / 86400000) + 1;
    const weekNo = Math.min(53, Math.ceil(dayOfYear / 7));
    return `${y}-W${String(weekNo).padStart(2, '0')}`;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * Performance breakdown by time period (e.g. by month). Use to check stability: is expectancy driven by a few periods only?
 *
 * @param {Array<object>} trades - Results from run() (must have entryBarTimeMs for period grouping)
 * @param {object} [options] - { periodFormat: 'month' | 'week' (default 'month') }
 * @returns {object} { byPeriod: { [periodKey]: summary }, periodOrder: string[] }
 */
function performanceBreakdownByPeriod(trades, options = {}) {
  const periodFormat = options.periodFormat === 'week' ? 'week' : 'month';
  const list = Array.isArray(trades) ? trades.filter((t) => t && t.outcome && t.outcome !== 'skip') : [];
  const byPeriod = {};
  const orderSet = new Set();
  for (const t of list) {
    const key = getPeriodKey(t, periodFormat);
    orderSet.add(key);
    if (!byPeriod[key]) byPeriod[key] = [];
    byPeriod[key].push(t);
  }
  const periodOrder = Array.from(orderSet).sort();
  if (periodOrder.indexOf('unknown') >= 0) {
    periodOrder.splice(periodOrder.indexOf('unknown'), 1);
    periodOrder.push('unknown');
  }
  const out = { byPeriod: {}, periodOrder };
  for (const k of periodOrder) {
    out.byPeriod[k] = summaryFromList(byPeriod[k] || []);
  }
  return out;
}

/**
 * Format trades for audit: flat list with entryDate (ISO), direction, regime, outcome, barsHeld, entryPrice, rMultiple, strategy.
 * Use to inspect each win/loss and find patterns (e.g. do losses share a common form? are certain breakout subtypes better?).
 *
 * @param {Array<object>} trades - Results from run()
 * @returns {Array<object>} One object per trade with audit-friendly fields
 */
function formatTradesForAudit(trades) {
  const list = Array.isArray(trades) ? trades : [];
  return list.map((t, i) => {
    const entryDate = t.entryBarTimeMs != null && Number.isFinite(t.entryBarTimeMs)
      ? new Date(t.entryBarTimeMs).toISOString()
      : null;
    return {
      index: i + 1,
      entryDate,
      direction: t.direction ?? null,
      regime: t.regime ?? null,
      strategy: t.strategy ?? null,
      outcome: t.outcome ?? null,
      rMultiple: t.rMultiple ?? null,
      barsHeld: t.barsHeld ?? null,
      entryPrice: t.entryPrice ?? null,
      stopPrice: t.stopPrice ?? null,
      targetPrice: t.targetPrice ?? null,
    };
  });
}

/** Default R multiples for sweep (target = stopDistance * rMultiple). */
const DEFAULT_SWEEP_R_MULTIPLES = Object.freeze([1, 1.25, 1.5, 2]);

/**
 * Run trade simulation across multiple target R multiples (same signals, same candles).
 * Use to compare expectancy at different reward/risk targets.
 *
 * @param {Array<object>} candles - OHLCV bars (oldest first)
 * @param {Array<object>} allowedSignals - Allowed signal records (same as run())
 * @param {object} [options] - Base options for each run (maxBarsHeld, defaultDirection, includeStrategies). rMultiple is overridden per sweep.
 * @param {number[]} [options.rMultiples] - List of R multiples to sweep (default [1, 1.25, 1.5, 2])
 * @returns {object} { results: Array<{ rMultiple: number, summary: object, trades: Array }> }
 */
function runSweepRMultiple(candles, allowedSignals, options = {}) {
  const opts = options || {};
  const rMultiples = Array.isArray(opts.rMultiples) && opts.rMultiples.length > 0
    ? opts.rMultiples
    : [...DEFAULT_SWEEP_R_MULTIPLES];
  const baseOpts = { ...opts };
  delete baseOpts.rMultiples;
  const results = [];
  for (const r of rMultiples) {
    const num = typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : 2;
    const { trades, summary } = run(candles, allowedSignals, { ...baseOpts, rMultiple: num });
    results.push({ rMultiple: num, summary, trades });
  }
  return { results };
}

module.exports = {
  run,
  runSweepRMultiple,
  simulateOne,
  buildSummary,
  strategyPerformanceBreakdown,
  regimePerformanceBreakdown,
  sessionPerformanceBreakdown,
  performanceBreakdownByPeriod,
  getPeriodKey,
  formatTradesForAudit,
  getSessionBucket,
  resolveBarIndex,
  DEFAULT_SWEEP_R_MULTIPLES,
  DEFAULT_SESSION_OPTIONS,
  SESSION_BUCKETS,
  REGIME_BUCKETS,
};
