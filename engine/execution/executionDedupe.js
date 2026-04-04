'use strict';

/**
 * Idempotence: prevent duplicate shadow/live executions for the same logical signal (re-run, retry, double hook).
 *
 * - Prefer explicit upstream key: signal.signalExecutionKey (string, max 256 chars).
 * - Else deterministic hash: strategyId + symbol + side + signalTimeMs (bar close or decision time in ms).
 *
 * Env:
 * - NEUROPILOT_EXECUTION_DEDUPE_DISABLED=1 — bypass checks (emergency / single-threaded lab only; not for prod live).
 */

const crypto = require('crypto');

const MAX_EXPLICIT_KEY_LEN = 256;
/** Cap object keys in state file (FIFO eviction by insertion order). */
const MAX_KEYS_STORED = 2000;

function isDedupeDisabled() {
  return process.env.NEUROPILOT_EXECUTION_DEDUPE_DISABLED === '1';
}

/**
 * @param {object} signal
 * @param {object} context
 * @returns {string|null} stable key, or null if strict inputs missing
 */
function computeSignalExecutionKey(signal, context) {
  const s = signal && typeof signal === 'object' ? signal : {};
  const ctx = context && typeof context === 'object' ? context : {};

  const explicit = s.signalExecutionKey != null ? String(s.signalExecutionKey).trim() : '';
  if (explicit) {
    const slice = explicit.slice(0, MAX_EXPLICIT_KEY_LEN);
    return `explicit:${slice}`;
  }

  const strategyId = s.strategyId != null ? String(s.strategyId) : '';
  const symbol = s.symbol != null ? String(s.symbol) : '';
  const side = s.side != null ? String(s.side).toLowerCase() : '';

  const tRaw =
    s.signalTimeMs != null
      ? Number(s.signalTimeMs)
      : s.barCloseTimeMs != null
        ? Number(s.barCloseTimeMs)
        : ctx.signalTimeMs != null
          ? Number(ctx.signalTimeMs)
          : null;

  if (!strategyId || !symbol || (side !== 'buy' && side !== 'sell') || !Number.isFinite(tRaw)) {
    return null;
  }

  const canonical = JSON.stringify([
    strategyId,
    symbol.toUpperCase().replace(/\s+/g, ''),
    side,
    Math.floor(tRaw),
  ]);
  return `h:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function ensureKeysMap(state) {
  if (!state.executedKeysToday || typeof state.executedKeysToday !== 'object' || Array.isArray(state.executedKeysToday)) {
    state.executedKeysToday = {};
  }
  return state.executedKeysToday;
}

function wasExecutedToday(state, key) {
  const m = ensureKeysMap(state);
  return Object.prototype.hasOwnProperty.call(m, key);
}

/**
 * Record successful shadow or live execution (do not record on broker_error or invalid_order).
 * @param {object} state
 * @param {string} key
 * @param {string|object} modeOrMeta — legacy: mode string; preferred: { mode, strategyId, symbol, side, signalTimeMs, orderId, status }
 */
function recordExecution(state, key, modeOrMeta) {
  const m = ensureKeysMap(state);
  const existing = m[key];
  const at = new Date().toISOString();
  let meta =
    modeOrMeta && typeof modeOrMeta === 'object'
      ? modeOrMeta
      : { mode: String(modeOrMeta || '') };
  const entry = {
    at,
    mode: meta.mode != null ? String(meta.mode) : (existing && existing.mode) || '',
    strategyId: meta.strategyId != null ? String(meta.strategyId) : null,
    symbol: meta.symbol != null ? String(meta.symbol) : null,
    side: meta.side != null ? String(meta.side) : null,
    signalTimeMs:
      meta.signalTimeMs != null && Number.isFinite(Number(meta.signalTimeMs))
        ? Number(meta.signalTimeMs)
        : null,
    orderId: meta.orderId != null ? String(meta.orderId) : null,
    status: meta.status != null ? String(meta.status) : 'ok',
  };
  m[key] = entry;
  const keys = Object.keys(m);
  if (keys.length > MAX_KEYS_STORED) {
    keys.sort((a, b) => String(m[a].at).localeCompare(String(m[b].at)));
    const drop = keys.length - MAX_KEYS_STORED;
    for (let i = 0; i < drop; i++) delete m[keys[i]];
  }
}

function executedKeysTodayCount(state) {
  return Object.keys(ensureKeysMap(state)).length;
}

module.exports = {
  isDedupeDisabled,
  computeSignalExecutionKey,
  wasExecutedToday,
  recordExecution,
  executedKeysTodayCount,
  MAX_EXPLICIT_KEY_LEN,
};
