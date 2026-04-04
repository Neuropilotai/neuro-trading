'use strict';

/**
 * Isolated broker execution layer — call only after paper → validation → promotable.
 *
 * Env:
 * - NEUROPILOT_EXECUTION_MODE — "live" | "shadow" | "paper" (default paper)
 * - NEUROPILOT_KILL_SWITCH=1 — block all paths
 * - NEUROPILOT_EXECUTION_STRATEGY_WHITELIST — comma-separated strategy ids (default ORB_breakout_v1,EMA_pullback_v2)
 * - NEUROPILOT_WAVE1_TRADE_CAPS=1 — per-symbol / total caps for NEUROPILOT_WAVE1_SYMBOLS (live orders)
 * - NEUROPILOT_WAVE1_MAX_TRADES_PER_SYMBOL_PER_DAY / NEUROPILOT_WAVE1_MAX_TRADES_TOTAL_PER_DAY
 * - NEUROPILOT_EXECUTION_MAX_TRADES_PER_DAY — default 5
 * - NEUROPILOT_EXECUTION_MAX_UNITS — default 1000
 * - NEUROPILOT_EXECUTION_RISK_FRACTION — default 0.01 (use 0.005 for micro live)
 * - NEUROPILOT_EXECUTION_ASSUMED_BALANCE — optional if context.balance missing (shadow/live sizing only)
 * - NEUROPILOT_EXECUTION_DEDUPE_DISABLED=1 — disable idempotence (lab only)
 * - NEUROPILOT_EXECUTION_PAUSE_LIVE_IF_RECONCILE_DEGRADED=1 — block live orders while reconciliationDegraded (after failed broker read)
 *
 * Idempotence (shadow + live): provide signal.signalExecutionKey OR signalTimeMs / barCloseTimeMs (+ strategyId, symbol, side).
 *
 * Does not log secrets.
 */

const riskEngine = require('./executionRiskEngine');
const stateStore = require('./executionStateStore');
const executionDedupe = require('./executionDedupe');
const oandaExecution = require('./providers/oandaExecution');

/** Symbol → OANDA instrument (underscore). Extend when enabling new products. */
const SYMBOL_TO_INSTRUMENT = {
  XAUUSD: 'XAU_USD',
  EURUSD: 'EUR_USD',
};

function mapSymbolToInstrument(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/\s+/g, '');
  const inst = SYMBOL_TO_INSTRUMENT[s];
  if (!inst) {
    throw new Error(
      `execution: unsupported symbol "${symbol}". Known: ${Object.keys(SYMBOL_TO_INSTRUMENT).join(', ')}`
    );
  }
  return inst;
}

/**
 * @param {object} signal
 * @param {string} signal.strategyId
 * @param {string} signal.symbol
 * @param {'buy'|'sell'} signal.side
 * @param {number} [signal.units] — optional override (still capped by risk engine rules in build)
 * @param {object} context
 * @param {boolean} context.isPromotable
 * @param {number} [context.balance] — for sizing; else NEUROPILOT_EXECUTION_ASSUMED_BALANCE
 */
function buildOandaOrder(signal, context) {
  const instrument = mapSymbolToInstrument(signal.symbol);
  const side = String(signal.side || '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') {
    throw new Error('execution: signal.side must be buy or sell');
  }
  let units =
    signal.units != null && Number.isFinite(Number(signal.units))
      ? Math.floor(Number(signal.units))
      : null;
  if (units == null || units <= 0) {
    const balRaw =
      context && context.balance != null
        ? Number(context.balance)
        : Number(process.env.NEUROPILOT_EXECUTION_ASSUMED_BALANCE);
    units = riskEngine.computeUnits(balRaw);
  }
  const cap = riskEngine.maxUnitsCap();
  units = Math.min(cap, Math.max(0, Math.floor(Math.abs(units))));
  if (units <= 0) {
    throw new Error('execution: computed units is zero (balance / sizing)');
  }
  return { instrument, units, side };
}

/**
 * @param {object} signal
 * @param {object} context
 * @returns {Promise<object>}
 */
async function executeSignal(signal, context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const strategyId = signal && signal.strategyId != null ? String(signal.strategyId) : '';
  const mode = riskEngine.getExecutionMode();

  const symbolUpper = signal && signal.symbol != null ? String(signal.symbol).toUpperCase().trim() : '';

  const gateCtx = {
    isPromotable: ctx.isPromotable === true,
    strategyId,
    symbol: symbolUpper,
    liveTradesToday: 0,
    wave1BySymbolToday: {},
    wave1TotalToday: 0,
    riskPaused: ctx.riskPaused === true,
  };

  const state = stateStore.readState();
  stateStore.rollDaily(state);
  gateCtx.liveTradesToday = state.liveTradesToday;
  gateCtx.wave1BySymbolToday =
    state.wave1LiveBySymbolToday && typeof state.wave1LiveBySymbolToday === 'object'
      ? state.wave1LiveBySymbolToday
      : {};
  gateCtx.wave1TotalToday = Number(state.wave1LiveTotalToday) || 0;

  const pre = riskEngine.canTrade(gateCtx);
  if (!pre.ok) {
    return { skipped: true, reason: pre.reason };
  }

  if (riskEngine.isKillSwitchOn()) {
    return { skipped: true, reason: 'kill_switch' };
  }

  if (
    mode === 'live' &&
    process.env.NEUROPILOT_EXECUTION_PAUSE_LIVE_IF_RECONCILE_DEGRADED === '1' &&
    state.reconciliationDegraded === true
  ) {
    return { skipped: true, reason: 'reconciliation_degraded' };
  }

  if (mode === 'paper') {
    return { skipped: true, reason: 'paper_mode' };
  }

  let executionKey = null;
  if (!executionDedupe.isDedupeDisabled()) {
    executionKey = executionDedupe.computeSignalExecutionKey(signal, ctx);
    if (!executionKey) {
      return {
        skipped: true,
        reason: 'missing_execution_key',
        detail:
          'Set signal.signalExecutionKey or signal.signalTimeMs / barCloseTimeMs (or context.signalTimeMs) with strategyId, symbol, side',
      };
    }
    if (executionDedupe.wasExecutedToday(state, executionKey)) {
      return { skipped: true, reason: 'duplicate_signal' };
    }
  }

  let order;
  try {
    order = buildOandaOrder(signal, ctx);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'build_order_failed';
    state.lastError = { at: new Date().toISOString(), message: msg };
    state.updatedAt = new Date().toISOString();
    stateStore.writeState(state);
    return { skipped: true, reason: 'invalid_order', detail: msg };
  }

  const signalTimeMs =
    signal.signalTimeMs != null
      ? Number(signal.signalTimeMs)
      : signal.barCloseTimeMs != null
        ? Number(signal.barCloseTimeMs)
        : ctx.signalTimeMs != null
          ? Number(ctx.signalTimeMs)
          : null;

  if (mode === 'shadow') {
    state.shadowEventsToday = (state.shadowEventsToday || 0) + 1;
    state.lastShadowAt = new Date().toISOString();
    state.lastInstrument = order.instrument;
    state.lastSide = order.side;
    state.lastStrategyId = strategyId;
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    if (executionKey) {
      executionDedupe.recordExecution(state, executionKey, {
        mode: 'shadow',
        strategyId,
        symbol: signal.symbol,
        side: order.side,
        signalTimeMs: Number.isFinite(signalTimeMs) ? signalTimeMs : null,
        orderId: null,
        status: 'simulated',
      });
    }
    stateStore.pushEvent(state, {
      at: state.updatedAt,
      kind: 'shadow',
      strategyId,
      instrument: order.instrument,
      side: order.side,
      units: order.units,
      executionKeyTail: executionKey ? executionKey.slice(-10) : null,
    });
    stateStore.writeState(state);
    return {
      ok: true,
      simulated: true,
      reason: 'shadow',
      order: { instrument: order.instrument, units: order.units, side: order.side },
    };
  }

  if (mode !== 'live') {
    return { skipped: true, reason: 'execution_disabled' };
  }

  const correlation =
    executionKey && String(executionKey).trim()
      ? {
          signalExecutionKey: executionKey,
          strategyId,
          symbol: String(signal.symbol || ''),
          side: order.side,
        }
      : null;

  const res = await oandaExecution.placeMarketOrder(order, correlation);
  state.updatedAt = new Date().toISOString();
  state.lastInstrument = order.instrument;
  state.lastSide = order.side;
  state.lastStrategyId = strategyId;

  if (res.ok && res.orderId) {
    state.liveTradesToday = (state.liveTradesToday || 0) + 1;
    if (
      riskEngine.isWave1TradeCapsEnabled() &&
      symbolUpper &&
      riskEngine.parseWave1SymbolSet().has(symbolUpper)
    ) {
      state.wave1LiveBySymbolToday = state.wave1LiveBySymbolToday || {};
      state.wave1LiveBySymbolToday[symbolUpper] =
        (Number(state.wave1LiveBySymbolToday[symbolUpper]) || 0) + 1;
      state.wave1LiveTotalToday = (Number(state.wave1LiveTotalToday) || 0) + 1;
    }
    state.lastLiveOrderId = res.orderId;
    state.lastError = null;
    if (executionKey) {
      executionDedupe.recordExecution(state, executionKey, {
        mode: 'live',
        strategyId,
        symbol: signal.symbol,
        side: order.side,
        signalTimeMs: Number.isFinite(signalTimeMs) ? signalTimeMs : null,
        orderId: res.orderId,
        status: 'submitted',
      });
    }
    stateStore.pushEvent(state, {
      at: state.updatedAt,
      kind: 'live',
      strategyId,
      orderId: res.orderId,
      instrument: order.instrument,
      side: order.side,
      units: order.units,
      executionKeyTail: executionKey ? executionKey.slice(-10) : null,
    });
    stateStore.writeState(state);
    return { ok: true, orderId: res.orderId };
  }

  const errMsg = res.errorMessage || 'oanda_reject';
  state.lastError = {
    at: state.updatedAt,
    message: errMsg,
    statusCode: res.statusCode,
  };
  stateStore.pushEvent(state, {
    at: state.updatedAt,
    kind: 'error',
    strategyId,
    message: errMsg,
    statusCode: res.statusCode,
  });
  stateStore.writeState(state);
  return {
    ok: false,
    skipped: false,
    reason: 'broker_error',
    detail: errMsg,
    statusCode: res.statusCode,
  };
}

module.exports = {
  executeSignal,
  buildOandaOrder,
  SYMBOL_TO_INSTRUMENT,
  computeSignalExecutionKey: executionDedupe.computeSignalExecutionKey,
};
