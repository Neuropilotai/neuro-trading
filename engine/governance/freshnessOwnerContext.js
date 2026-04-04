'use strict';

/**
 * Owner-facing interpretation of dataset ages vs market session (export/snapshot only).
 * Does not change candle truth: raw ages stay on each row; adds marketClass / marketSessionState
 * and a root freshnessContext for session-adjusted owner thresholds.
 *
 * Conservative: unknown market class → session 'unknown' (still counts toward effective max age).
 */

const US_EQUITY_SYMBOLS = new Set([
  'SPY',
  'QQQ',
  'AAPL',
  'NVDA',
  'TSLA',
  'IWM',
  'MSFT',
  'GOOGL',
  'GOOG',
  'META',
  'AMZN',
  'DIA',
  'XLF',
  'XLE',
]);

/**
 * @param {string} symbol
 * @param {string|null|undefined} provider
 * @param {string|null|undefined} [datasetKey] manifest row key (e.g. XAUUSD_1h) when symbol may not match XAU/XAG
 * @returns {'us_equity'|'fx_or_metal'|'crypto'|'unknown'}
 */
function inferMarketClass(symbol, provider, datasetKey) {
  const s = String(symbol || '')
    .toUpperCase()
    .trim();
  const p = String(provider || '')
    .toLowerCase()
    .trim();
  const keyHead =
    String(datasetKey || '')
      .toUpperCase()
      .trim()
      .split('_')[0] || '';

  const isMetalToken = (t) => t.startsWith('XAU') || t.startsWith('XAG');

  // Owner session calendar only: gold/silver spot symbols follow FX-style weekend (any provider).
  if (isMetalToken(s) || isMetalToken(keyHead)) return 'fx_or_metal';

  if (p === 'binance') return 'crypto';
  if ((s.endsWith('USDT') || s.endsWith('BUSD')) && !s.includes('XAU')) return 'crypto';

  if (p === 'yahoo' && US_EQUITY_SYMBOLS.has(s)) return 'us_equity';
  if (p === 'yahoo') return 'unknown';

  if (p === 'oanda') return 'fx_or_metal';

  return 'unknown';
}

/**
 * @param {number} nowMs
 * @returns {{ weekday: string, hour: number, minute: number }}
 */
function easternWallClock(nowMs) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(nowMs));
  const o = {};
  for (const { type, value } of parts) {
    if (type !== 'literal') o[type] = value;
  }
  return {
    weekday: String(o.weekday || ''),
    hour: parseInt(o.hour, 10) || 0,
    minute: parseInt(o.minute, 10) || 0,
  };
}

function isUsEquityWeekendClosedET(nowMs) {
  const { weekday } = easternWallClock(nowMs);
  return weekday === 'Sat' || weekday === 'Sun';
}

/** Simplified FX / metal retail week: Fri >= 17 ET through Sun < 17 ET. */
function isFxRetailWeekendClosedET(nowMs) {
  const { weekday, hour } = easternWallClock(nowMs);
  if (weekday === 'Sat') return true;
  if (weekday === 'Sun' && hour < 17) return true;
  if (weekday === 'Fri' && hour >= 17) return true;
  return false;
}

/**
 * @param {'us_equity'|'fx_or_metal'|'crypto'|'unknown'} marketClass
 * @param {number} nowMs
 * @returns {'open'|'closed_anticipated'|'unknown'}
 */
function marketSessionStateForClass(marketClass, nowMs) {
  switch (marketClass) {
    case 'crypto':
      return 'open';
    case 'us_equity':
      return isUsEquityWeekendClosedET(nowMs) ? 'closed_anticipated' : 'open';
    case 'fx_or_metal':
      return isFxRetailWeekendClosedET(nowMs) ? 'closed_anticipated' : 'open';
    default:
      return 'unknown';
  }
}

/**
 * @param {Array<{ dataset_age_minutes?: number|null, marketSessionState?: string }>} datasets
 * @param {number} nowMs
 * @param {{ ownerStaleCriticalThresholdMinutes?: number }} [opts]
 */
function buildFreshnessOwnerContext(datasets, nowMs, opts = {}) {
  const threshold = Number.isFinite(Number(opts.ownerStaleCriticalThresholdMinutes))
    ? Number(opts.ownerStaleCriticalThresholdMinutes)
    : 360;

  const rows = Array.isArray(datasets) ? datasets : [];
  const finiteRows = rows.filter((d) => Number.isFinite(Number(d && d.dataset_age_minutes)));

  let rawMax = null;
  for (const d of finiteRows) {
    const a = Number(d.dataset_age_minutes);
    if (rawMax == null || a > rawMax) rawMax = a;
  }

  let effectiveMax = null;
  let staleSuppressedReason = null;

  if (finiteRows.length === 0) {
    effectiveMax = null;
  } else {
    const openOrUnknown = finiteRows.filter((d) => {
      const s = d.marketSessionState;
      return s === 'open' || s === 'unknown';
    });
    const allClosed = finiteRows.every((d) => d.marketSessionState === 'closed_anticipated');

    if (openOrUnknown.length > 0) {
      effectiveMax = Math.max(...openOrUnknown.map((d) => Number(d.dataset_age_minutes)));
    } else if (allClosed) {
      effectiveMax = 0;
      staleSuppressedReason = 'all_finite_age_rows_closed_anticipated_session';
    } else {
      effectiveMax = null;
    }
  }

  const staleSuppressedForClosedSession =
    rawMax != null &&
    rawMax > threshold &&
    Number.isFinite(effectiveMax) &&
    effectiveMax <= threshold;

  if (staleSuppressedForClosedSession && !staleSuppressedReason) {
    staleSuppressedReason = 'open_or_unknown_markets_within_threshold';
  }

  return {
    schemaVersion: '1.0.0',
    evaluatedAt: new Date(nowMs).toISOString(),
    rawMaxDatasetAgeMinutes: rawMax,
    effectiveMaxDatasetAgeMinutesForOwner: effectiveMax,
    ownerStaleCriticalThresholdMinutes: threshold,
    staleSuppressedForClosedSession: !!staleSuppressedForClosedSession,
    staleSuppressedReason,
  };
}

module.exports = {
  inferMarketClass,
  marketSessionStateForClass,
  buildFreshnessOwnerContext,
  easternWallClock,
};
