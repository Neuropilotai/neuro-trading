'use strict';

/**
 * Persistent execution-layer state (trades today, last order, errors).
 * Stored under data root: governance/execution_state.json
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

const MAX_RECENT = 30;

function defaultReconciliationErrors() {
  return {
    totalFailures: 0,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureMessage: null,
    lastSuccessAt: null,
  };
}

function defaultReconciliationBlock() {
  return {
    driftFlags: [],
    unknownPositions: [],
    missingLocalFills: [],
    pendingOrderMismatch: false,
  };
}

function defaultState() {
  return {
    version: '1.4.0',
    updatedAt: null,
    dayUtc: null,
    liveTradesToday: 0,
    /** Wave 1 live fills today (UTC day), keyed by uppercase symbol — see NEUROPILOT_WAVE1_TRADE_CAPS */
    wave1LiveBySymbolToday: {},
    wave1LiveTotalToday: 0,
    shadowEventsToday: 0,
    lastLiveOrderId: null,
    lastInstrument: null,
    lastSide: null,
    lastStrategyId: null,
    lastShadowAt: null,
    lastError: null,
    livePnlApprox: null,
    pnlSource: 'none',
    /** @type {Record<string, object>} cleared each UTC day in rollDaily */
    executedKeysToday: {},
    recentEvents: [],
    brokerSnapshot: null,
    lastReconciledAt: null,
    lastReconciledTransactionId: null,
    reconciliationErrors: defaultReconciliationErrors(),
    fillsLedger: [],
    reconciliation: defaultReconciliationBlock(),
    reconciliationDegraded: false,
    /** @type {object|null} UTC-day correlated realized PnL from ledger (Phase B) */
    pnlPeriod: null,
  };
}

function stateFilePath() {
  return path.join(dataRoot.getPath('governance'), 'execution_state.json');
}

function utcDayString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function rollDaily(state) {
  const today = utcDayString();
  if (state.dayUtc !== today) {
    state.dayUtc = today;
    state.liveTradesToday = 0;
    state.shadowEventsToday = 0;
    state.executedKeysToday = {};
    state.wave1LiveBySymbolToday = {};
    state.wave1LiveTotalToday = 0;
  }
}

function readState() {
  const p = stateFilePath();
  const base = defaultState();
  if (!fs.existsSync(p)) return { ...base };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    const recErrors = {
      ...defaultReconciliationErrors(),
      ...(j.reconciliationErrors && typeof j.reconciliationErrors === 'object' ? j.reconciliationErrors : {}),
    };
    const recBlock = {
      ...defaultReconciliationBlock(),
      ...(j.reconciliation && typeof j.reconciliation === 'object' ? j.reconciliation : {}),
    };
    recBlock.driftFlags = Array.isArray(recBlock.driftFlags) ? recBlock.driftFlags : [];
    recBlock.unknownPositions = Array.isArray(recBlock.unknownPositions) ? recBlock.unknownPositions : [];
    recBlock.missingLocalFills = Array.isArray(recBlock.missingLocalFills) ? recBlock.missingLocalFills : [];
    recBlock.pendingOrderMismatch = Boolean(recBlock.pendingOrderMismatch);

    const w1By =
      j.wave1LiveBySymbolToday && typeof j.wave1LiveBySymbolToday === 'object' && !Array.isArray(j.wave1LiveBySymbolToday)
        ? j.wave1LiveBySymbolToday
        : {};
    return {
      ...base,
      ...j,
      wave1LiveBySymbolToday: w1By,
      wave1LiveTotalToday: Number.isFinite(Number(j.wave1LiveTotalToday)) ? Math.floor(Number(j.wave1LiveTotalToday)) : 0,
      recentEvents: Array.isArray(j.recentEvents) ? j.recentEvents : [],
      executedKeysToday:
        j.executedKeysToday && typeof j.executedKeysToday === 'object' && !Array.isArray(j.executedKeysToday)
          ? j.executedKeysToday
          : {},
      fillsLedger: Array.isArray(j.fillsLedger) ? j.fillsLedger : [],
      brokerSnapshot: j.brokerSnapshot && typeof j.brokerSnapshot === 'object' ? j.brokerSnapshot : null,
      lastReconciledAt: j.lastReconciledAt != null ? j.lastReconciledAt : null,
      lastReconciledTransactionId:
        j.lastReconciledTransactionId != null ? String(j.lastReconciledTransactionId) : null,
      reconciliationErrors: recErrors,
      reconciliation: recBlock,
      reconciliationDegraded: j.reconciliationDegraded === true,
      pnlSource: j.pnlSource != null ? String(j.pnlSource) : 'none',
      pnlPeriod: j.pnlPeriod && typeof j.pnlPeriod === 'object' ? j.pnlPeriod : null,
    };
  } catch (_) {
    return { ...base };
  }
}

function writeState(state) {
  const p = stateFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function pushEvent(state, evt) {
  const next = [evt, ...(state.recentEvents || [])].slice(0, MAX_RECENT);
  state.recentEvents = next;
}

module.exports = {
  stateFilePath,
  readState,
  writeState,
  rollDaily,
  utcDayString,
  pushEvent,
  defaultState,
  defaultReconciliationErrors,
  defaultReconciliationBlock,
};
