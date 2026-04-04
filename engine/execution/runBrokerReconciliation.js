'use strict';

/**
 * Pull read-only broker state into execution_state.json (positions, trades, fills ledger, drift flags).
 *
 * Does not touch decision engine, scoring, or paper pipeline.
 *
 * Usage (from neuropilot_trading_v2):
 *   node engine/execution/runBrokerReconciliation.js
 *
 * Rules:
 * - On any fetch failure: increment reconciliationErrors, set reconciliationDegraded, do NOT clear brokerSnapshot / PnL.
 * - On full success: update brokerSnapshot, lastReconciledTransactionId, fillsLedger, reconciliation.*, livePnlApprox + pnlSource=reconciled, pnlPeriod (UTC day correlated realized).
 */

const stateStore = require('./executionStateStore');
const { buildBrokerSnapshot, normalizeOrderFill } = require('./providers/oandaReconciliation');
const { computePnlPeriodUtcDay } = require('./computeCorrelatedPeriodPnl');

const MAX_LEDGER = 500;

const { defaultReconciliationErrors, defaultReconciliationBlock } = stateStore;

function ensureReconciliationErrors(state) {
  if (!state.reconciliationErrors || typeof state.reconciliationErrors !== 'object') {
    state.reconciliationErrors = defaultReconciliationErrors();
  }
  return state.reconciliationErrors;
}

function mergeFillsLedger(prev, rawTxs) {
  const byId = new Map();
  for (const e of prev || []) {
    if (e && e.id) byId.set(String(e.id), e);
  }
  for (const tx of rawTxs || []) {
    const f = normalizeOrderFill(tx);
    if (f) byId.set(f.id, f);
  }
  const out = Array.from(byId.values()).sort((a, b) => {
    const ta = a.time != null ? String(a.time) : '';
    const tb = b.time != null ? String(b.time) : '';
    return ta.localeCompare(tb);
  });
  return out.slice(-MAX_LEDGER);
}

const LEDGER_CORRELATION_WINDOW = 50;

/**
 * Match ORDER_FILL rows to local live events (orderID) or today's dedupe map (signalExecutionKey).
 */
function enrichFillsLedgerLocalMatch(state) {
  const recentOrderIds = new Set(
    (state.recentEvents || [])
      .filter((e) => e.kind === 'live' && e.orderId)
      .map((e) => String(e.orderId))
  );
  const keysToday =
    state.executedKeysToday && typeof state.executedKeysToday === 'object' && !Array.isArray(state.executedKeysToday)
      ? state.executedKeysToday
      : {};

  for (const fill of state.fillsLedger || []) {
    if (!fill || fill.type !== 'ORDER_FILL') continue;
    const sk = fill.signalExecutionKey != null ? String(fill.signalExecutionKey).trim() : '';
    const byOrder = fill.orderID && recentOrderIds.has(String(fill.orderID));
    const byKey = Boolean(sk && Object.prototype.hasOwnProperty.call(keysToday, sk));
    fill.matchedLocalExecution = Boolean(byOrder || byKey);
  }
}

function computeReconciliationBlock(state, snapshot) {
  const block = defaultReconciliationBlock();
  const driftFlags = [];

  block.unknownPositions = (snapshot.positions || []).filter(
    (p) => p && Number.isFinite(p.netUnits) && Math.abs(p.netUnits) > 1e-9
  );

  const orderIdsInLedger = new Set(
    (state.fillsLedger || []).map((f) => f.orderID).filter(Boolean).map(String)
  );
  const recent = (state.recentEvents || []).filter((e) => e.kind === 'live' && e.orderId).slice(0, 12);
  for (const ev of recent) {
    const oid = String(ev.orderId);
    if (!orderIdsInLedger.has(oid)) {
      block.missingLocalFills.push({
        orderId: oid,
        eventAt: ev.at != null ? String(ev.at) : null,
        strategyId: ev.strategyId != null ? String(ev.strategyId) : null,
      });
    }
  }
  if (block.missingLocalFills.length) {
    driftFlags.push('recent_live_order_missing_from_ledger');
    driftFlags.push('local_order_without_broker_fill');
  }

  const ledger = state.fillsLedger || [];
  const windowed = ledger.slice(-LEDGER_CORRELATION_WINDOW);
  for (const f of windowed) {
    if (!f || f.type !== 'ORDER_FILL' || !f.orderID) continue;
    const sk = f.signalExecutionKey != null ? String(f.signalExecutionKey).trim() : '';
    if (!sk) {
      driftFlags.push('missing_signal_execution_key_on_fill');
    }
    if (sk && !f.matchedLocalExecution) {
      driftFlags.push('unknown_fill_without_local_match');
    }
    if (!sk && !f.matchedLocalExecution) {
      driftFlags.push('broker_fill_without_local_order');
    }
  }

  const oc = snapshot.summary && Number(snapshot.summary.openPositionCount);
  const hasOpen = (Number.isFinite(oc) && oc > 0) || (snapshot.openTrades && snapshot.openTrades.length > 0);
  if (hasOpen || block.unknownPositions.length > 0) {
    driftFlags.push('broker_open_exposure');
  }

  block.driftFlags = [...new Set(driftFlags)];
  block.pendingOrderMismatch = false;
  return block;
}

/**
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function runBrokerReconciliation() {
  const state = stateStore.readState();
  stateStore.rollDaily(state);

  let res;
  try {
    res = await buildBrokerSnapshot({ lastTransactionId: state.lastReconciledTransactionId });
  } catch (e) {
    res = {
      ok: false,
      step: 'exception',
      error: e && e.message ? String(e.message) : 'exception',
    };
  }

  if (!res.ok) {
    const er = ensureReconciliationErrors(state);
    er.totalFailures = (er.totalFailures || 0) + 1;
    er.consecutiveFailures = (er.consecutiveFailures || 0) + 1;
    er.lastFailureAt = new Date().toISOString();
    er.lastFailureMessage = `${res.step || 'unknown'}: ${res.error || 'fail'}`;
    state.reconciliationDegraded = true;
    state.updatedAt = new Date().toISOString();
    stateStore.writeState(state);
    return { ok: false, error: er.lastFailureMessage };
  }

  const { snapshot, rawTransactions } = res;

  const er = ensureReconciliationErrors(state);
  er.consecutiveFailures = 0;
  er.lastSuccessAt = new Date().toISOString();

  state.brokerSnapshot = snapshot;
  state.lastReconciledAt = snapshot.fetchedAt;
  state.lastReconciledTransactionId = snapshot.lastTransactionID;
  state.reconciliationDegraded = false;

  state.fillsLedger = mergeFillsLedger(state.fillsLedger, rawTransactions);
  enrichFillsLedgerLocalMatch(state);
  state.reconciliation = computeReconciliationBlock(state, snapshot);
  state.pnlPeriod = computePnlPeriodUtcDay(state);

  if (snapshot.summary && Number.isFinite(snapshot.summary.unrealizedPL)) {
    state.livePnlApprox = snapshot.summary.unrealizedPL;
    state.pnlSource = 'reconciled';
  } else {
    state.livePnlApprox = null;
    state.pnlSource = 'none';
  }

  state.updatedAt = new Date().toISOString();
  stateStore.writeState(state);
  return { ok: true };
}

module.exports = {
  runBrokerReconciliation,
  mergeFillsLedger,
  computeReconciliationBlock,
  enrichFillsLedgerLocalMatch,
};

if (require.main === module) {
  runBrokerReconciliation()
    .then((r) => {
      if (r.ok) {
        console.log('Broker reconciliation OK');
        process.exit(0);
      }
      console.error('Broker reconciliation FAILED:', r.error || 'unknown');
      process.exit(1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
