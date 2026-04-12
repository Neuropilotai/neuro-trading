'use strict';

/**
 * Weekend-aware symbol filtering for dynamic universe (selection only; no execution).
 * Uses configurable IANA timezone for Sat/Sun detection.
 */

function parseBool(v, defaultValue = false) {
  if (v === undefined || v === null || v === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

function parseCsv(s) {
  return String(s || '')
    .split(',')
    .map((x) => String(x || '').toUpperCase().trim())
    .filter(Boolean);
}

/**
 * Resolved weekend policy from merged dynamic-universe config (env + overrides).
 */
function getWeekendPolicyConfig(config = {}) {
  const e = process.env;
  const weekendExtra =
    Array.isArray(config.weekendExtraSymbols) && config.weekendExtraSymbols.length
      ? config.weekendExtraSymbols
      : parseCsv(e.DYNAMIC_UNIVERSE_WEEKEND_EXTRA_SYMBOLS || '');
  return {
    weekendPolicyEnabled:
      config.weekendPolicyEnabled != null
        ? !!config.weekendPolicyEnabled
        : parseBool(e.DYNAMIC_UNIVERSE_WEEKEND_POLICY_ENABLED, false),
    weekendOnly24x7:
      config.weekendOnly24x7 != null
        ? !!config.weekendOnly24x7
        : parseBool(e.DYNAMIC_UNIVERSE_WEEKEND_ONLY_24X7, true),
    weekendExtraSymbols: weekendExtra,
    weekendKeepNon24x7InWatchlist:
      config.weekendKeepNon24x7InWatchlist != null
        ? !!config.weekendKeepNon24x7InWatchlist
        : parseBool(e.DYNAMIC_UNIVERSE_WEEKEND_KEEP_NON_24X7_IN_WATCHLIST, false),
    universeTimezone:
      config.universeTimezone != null && String(config.universeTimezone).trim()
        ? String(config.universeTimezone).trim()
        : String(e.DYNAMIC_UNIVERSE_TIMEZONE || '').trim() || null,
  };
}

/**
 * Resolve trading schedule from metadata; default crypto -> 24x7, else weekdays.
 */
function getTradingSchedule(symbol, symbolMetadata) {
  const sym = String(symbol || '').toUpperCase().trim();
  const meta = symbolMetadata && symbolMetadata[sym];
  if (!meta) return 'unknown';
  const s = meta.tradingSchedule;
  if (s === '24x7' || s === 'weekdays' || s === 'session_based') return s;
  if (meta.assetClass === 'crypto') return '24x7';
  return 'weekdays';
}

/**
 * @param {Date} date
 * @param {{ universeTimezone?: string|null }} config
 * @returns {boolean}
 */
function isWeekendForUniverse(date, config = {}) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return false;

  const wp = getWeekendPolicyConfig(config);
  const tz = wp.universeTimezone || null;
  if (!tz) {
    const day = d.getUTCDay();
    return day === 0 || day === 6;
  }

  try {
    const long = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d);
    const x = String(long).toLowerCase();
    return x === 'saturday' || x === 'sunday';
  } catch (e) {
    const day = d.getUTCDay();
    return day === 0 || day === 6;
  }
}

const FALLBACK_24X7 = 'BTCUSD';

/**
 * Apply weekend-only-24x7 selection to an already sorted eligible row list.
 *
 * @param {object[]} eligibleSorted - rows with { symbol, totalScore, ... }
 * @param {object} opts
 * @returns {{
 *   activeSymbols: string[],
 *   watchlistSymbols: string[],
 *   weekendPolicy: object,
 *   reasonsPatch: Record<string, string[]>
 * }}
 */
function applyWeekendUniversePolicy(eligibleSorted, opts) {
  const {
    config,
    symbolMetadata,
    now,
    maxActive,
    maxWatchlist,
  } = opts;

  const wp = getWeekendPolicyConfig(config);
  const reasonsPatch = {};
  const tzLabel = wp.universeTimezone || 'UTC';
  const emptyPolicy = {
    enabled: wp.weekendPolicyEnabled,
    active: false,
    timezone: tzLabel,
    mode: 'off',
    filteredOutSymbols: [],
    eligibleSymbols: [],
    warnings: [],
  };

  if (!wp.weekendPolicyEnabled) {
    return {
      activeSymbols: eligibleSorted.slice(0, maxActive).map((r) => r.symbol),
      watchlistSymbols: eligibleSorted.slice(maxActive, maxActive + maxWatchlist).map((r) => r.symbol),
      weekendPolicy: emptyPolicy,
      reasonsPatch: {},
    };
  }

  const d = now instanceof Date ? now : new Date(now);
  const weekend = isWeekendForUniverse(d, config);

  if (!weekend) {
    return {
      activeSymbols: eligibleSorted.slice(0, maxActive).map((r) => r.symbol),
      watchlistSymbols: eligibleSorted.slice(maxActive, maxActive + maxWatchlist).map((r) => r.symbol),
      weekendPolicy: {
        ...emptyPolicy,
        active: false,
        mode: 'weekday_no_filter',
      },
      reasonsPatch: {},
    };
  }

  if (!wp.weekendOnly24x7) {
    return {
      activeSymbols: eligibleSorted.slice(0, maxActive).map((r) => r.symbol),
      watchlistSymbols: eligibleSorted.slice(maxActive, maxActive + maxWatchlist).map((r) => r.symbol),
      weekendPolicy: {
        enabled: true,
        active: false,
        timezone: tzLabel,
        mode: 'weekend_relaxed_no_24x7_filter',
        filteredOutSymbols: [],
        eligibleSymbols: [],
        warnings: [],
      },
      reasonsPatch: {},
    };
  }

  const warnings = [];
  const rank24 = [];
  const rankOther = [];

  for (const row of eligibleSorted) {
    const sched = getTradingSchedule(row.symbol, symbolMetadata);
    if (sched === '24x7') {
      rank24.push(row);
      reasonsPatch[row.symbol] = ['weekend_policy_active', 'weekend_24x7_eligible'];
    } else {
      rankOther.push(row);
      reasonsPatch[row.symbol] = ['weekend_policy_active', 'excluded_non_24x7_on_weekend'];
    }
  }

  let poolActive = rank24;
  if (poolActive.length === 0) {
    warnings.push('weekend_no_24x7_eligible_attempting_btc_fallback');
    const btc = eligibleSorted.find((r) => r.symbol === FALLBACK_24X7);
    if (btc && getTradingSchedule(btc.symbol, symbolMetadata) === '24x7') {
      poolActive = [btc];
      reasonsPatch[FALLBACK_24X7] = [
        'weekend_policy_active',
        'weekend_24x7_eligible',
        'weekend_fallback_btc_only',
      ];
    } else {
      warnings.push('weekend_fallback_failed_no_btc');
    }
  }

  const activeSymbols = poolActive.slice(0, maxActive).map((r) => r.symbol);
  let watchlistSymbols = poolActive.slice(maxActive, maxActive + maxWatchlist).map((r) => r.symbol);

  if (wp.weekendKeepNon24x7InWatchlist && rankOther.length > 0) {
    const wlSlots = maxWatchlist - watchlistSymbols.length;
    if (wlSlots > 0) {
      const extra = rankOther.slice(0, wlSlots).map((r) => r.symbol);
      watchlistSymbols = [...watchlistSymbols, ...extra];
      for (const s of extra) {
        reasonsPatch[s] = ['weekend_policy_active', 'weekend_non_24x7_watchlist_only'];
      }
    }
  }

  const picked = new Set([...activeSymbols, ...watchlistSymbols]);

  const filteredOut = rankOther.map((r) => r.symbol).filter((s) => !picked.has(s));

  const mode = wp.weekendOnly24x7 ? '24x7_only' : 'mixed';

  console.log(
    `[dynamic_universe_weekend] active=${activeSymbols.length} wl=${watchlistSymbols.length} filtered_non24x7=${filteredOut.length}`
  );

  return {
    activeSymbols,
    watchlistSymbols,
    weekendPolicy: {
      enabled: true,
      active: true,
      timezone: wp.universeTimezone || 'UTC',
      mode,
      filteredOutSymbols: filteredOut.sort((a, b) => a.localeCompare(b)),
      eligibleSymbols: poolActive.map((r) => r.symbol),
      warnings,
    },
    reasonsPatch,
  };
}

module.exports = {
  getWeekendPolicyConfig,
  getTradingSchedule,
  isWeekendForUniverse,
  applyWeekendUniversePolicy,
};
