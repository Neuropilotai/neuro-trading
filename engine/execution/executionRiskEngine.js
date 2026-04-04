'use strict';

/**
 * Pre-broker risk gates for the isolated execution layer (no I/O).
 *
 * Wave 1 desk rollout (optional):
 * - NEUROPILOT_WAVE1_SYMBOLS — CSV of symbols (e.g. ADAUSDT,XRPUSDT,BTCUSDT).
 *   Optional legacy suffix SYMBOL:timeframe — the :timeframe part is stripped (manifest is matched by symbol only).
 * - NEUROPILOT_WAVE1_TRADE_CAPS=1 — enforce daily caps for those symbols (live path)
 * - NEUROPILOT_WAVE1_MAX_TRADES_PER_SYMBOL_PER_DAY — default 3; 0 = disable per-symbol cap
 * - NEUROPILOT_WAVE1_MAX_TRADES_TOTAL_PER_DAY — default 15; 0 = disable total cap
 */

function parseWhitelist() {
  const raw = process.env.NEUROPILOT_EXECUTION_STRATEGY_WHITELIST;
  if (raw && String(raw).trim()) {
    return new Set(
      String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  return new Set(['ORB_breakout_v1', 'EMA_pullback_v2']);
}

function parseWave1SymbolSet() {
  const raw = process.env.NEUROPILOT_WAVE1_SYMBOLS;
  if (!raw || !String(raw).trim()) return new Set();
  return new Set(
    String(raw)
      .split(',')
      .map((s) => {
        const t = s.trim().toUpperCase();
        if (!t) return '';
        const colon = t.indexOf(':');
        return colon > 0 ? t.slice(0, colon).trim() : t;
      })
      .filter(Boolean)
  );
}

function isWave1TradeCapsEnabled() {
  const v = (process.env.NEUROPILOT_WAVE1_TRADE_CAPS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** @returns {number|null} null = cap disabled */
function wave1MaxTradesPerSymbolPerDay() {
  const raw = process.env.NEUROPILOT_WAVE1_MAX_TRADES_PER_SYMBOL_PER_DAY;
  if (raw === undefined || String(raw).trim() === '') return 3;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 3;
  if (n === 0) return null;
  return Math.floor(n);
}

/** @returns {number|null} null = cap disabled */
function wave1MaxTradesTotalPerDay() {
  const raw = process.env.NEUROPILOT_WAVE1_MAX_TRADES_TOTAL_PER_DAY;
  if (raw === undefined || String(raw).trim() === '') return 15;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 15;
  if (n === 0) return null;
  return Math.floor(n);
}

function isKillSwitchOn() {
  return process.env.NEUROPILOT_KILL_SWITCH === '1';
}

function getExecutionMode() {
  return String(process.env.NEUROPILOT_EXECUTION_MODE || 'paper').toLowerCase();
}

function maxTradesPerDay() {
  const n = Number(process.env.NEUROPILOT_EXECUTION_MAX_TRADES_PER_DAY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

function maxUnitsCap() {
  const n = Number(process.env.NEUROPILOT_EXECUTION_MAX_UNITS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

function riskFraction() {
  const n = Number(process.env.NEUROPILOT_EXECUTION_RISK_FRACTION);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.01;
}

/**
 * Conservative unit sizing: min(cap, floor(balance * fraction)).
 * @param {number} balance — account balance in account currency (caller-supplied)
 */
function computeUnits(balance) {
  const cap = maxUnitsCap();
  const frac = riskFraction();
  const b = Number(balance);
  if (!Number.isFinite(b) || b <= 0) return 0;
  return Math.min(cap, Math.floor(b * frac));
}

/**
 * @param {object} context
 * @param {boolean} context.isPromotable
 * @param {string} [context.strategyId]
 * @param {number} [context.liveTradesToday]
 * @param {string} [context.symbol] — for Wave1 caps (uppercase symbol)
 * @param {Record<string, number>} [context.wave1BySymbolToday]
 * @param {number} [context.wave1TotalToday]
 * @param {boolean} [context.riskPaused] — optional external risk flag
 * @returns {{ ok: boolean, reason?: string }}
 */
function canTrade(context) {
  if (!context || context.isPromotable !== true) {
    return { ok: false, reason: 'not_promotable' };
  }
  if (isKillSwitchOn()) {
    return { ok: false, reason: 'kill_switch' };
  }
  const sid = context.strategyId != null ? String(context.strategyId) : '';
  if (!sid || !parseWhitelist().has(sid)) {
    return { ok: false, reason: 'not_whitelisted' };
  }
  const daily = Number(context.liveTradesToday);
  if (Number.isFinite(daily) && daily >= maxTradesPerDay()) {
    return { ok: false, reason: 'max_daily_trades' };
  }
  if (isWave1TradeCapsEnabled()) {
    const w1 = parseWave1SymbolSet();
    const sym = context.symbol != null ? String(context.symbol).toUpperCase().trim() : '';
    if (w1.size > 0 && sym && w1.has(sym)) {
      const perCap = wave1MaxTradesPerSymbolPerDay();
      const totCap = wave1MaxTradesTotalPerDay();
      const by = context.wave1BySymbolToday && typeof context.wave1BySymbolToday === 'object' ? context.wave1BySymbolToday : {};
      const symCount = Number(by[sym]) || 0;
      const totCount = Number(context.wave1TotalToday) || 0;
      if (perCap != null && symCount >= perCap) {
        return { ok: false, reason: 'wave1_symbol_daily_cap' };
      }
      if (totCap != null && totCount >= totCap) {
        return { ok: false, reason: 'wave1_total_daily_cap' };
      }
    }
  }
  if (context.riskPaused === true) {
    return { ok: false, reason: 'risk_paused' };
  }
  return { ok: true };
}

module.exports = {
  parseWhitelist,
  parseWave1SymbolSet,
  isWave1TradeCapsEnabled,
  wave1MaxTradesPerSymbolPerDay,
  wave1MaxTradesTotalPerDay,
  isKillSwitchOn,
  getExecutionMode,
  maxTradesPerDay,
  maxUnitsCap,
  riskFraction,
  computeUnits,
  canTrade,
};
