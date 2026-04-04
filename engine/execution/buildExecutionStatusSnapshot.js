'use strict';

/**
 * Build ops-dashboard safe payload (no secrets) for execution layer status.
 */

const riskEngine = require('./executionRiskEngine');
const stateStore = require('./executionStateStore');
const executionDedupe = require('./executionDedupe');
const { enrichFillsLedgerLocalMatch } = require('./runBrokerReconciliation');
const { computePnlPeriodUtcDay } = require('./computeCorrelatedPeriodPnl');

function hasOandaCredentialsConfigured() {
  const t = process.env.NEUROPILOT_OANDA_API_KEY;
  const a = process.env.NEUROPILOT_OANDA_ACCOUNT_ID;
  return Boolean(t && String(t).trim() && a && String(a).trim());
}

const RECON_STALE_MS = 20 * 60 * 1000;

function reconciliationRecentOk(lastReconciledAt) {
  const t = lastReconciledAt ? Date.parse(lastReconciledAt) : NaN;
  return Number.isFinite(t) && Date.now() - t < RECON_STALE_MS;
}

function fillCorrelationStats(ledger) {
  const orderFills = (Array.isArray(ledger) ? ledger : []).filter((f) => f && f.type === 'ORDER_FILL');
  let fillsWithSignalKeyCount = 0;
  let matchedFillsCount = 0;
  let unmatchedFillsCount = 0;
  for (const f of orderFills) {
    const hasKey = f.signalExecutionKey && String(f.signalExecutionKey).trim();
    if (hasKey) fillsWithSignalKeyCount++;
    if (f.matchedLocalExecution === true) matchedFillsCount++;
    if (f.orderID && f.matchedLocalExecution !== true) unmatchedFillsCount++;
  }
  const fillsWithoutSignalKeyCount = orderFills.length - fillsWithSignalKeyCount;
  return {
    fillsWithSignalKeyCount,
    fillsWithoutSignalKeyCount,
    matchedFillsCount,
    unmatchedFillsCount,
  };
}

function buildExecutionStatusSnapshot() {
  const mode = riskEngine.getExecutionMode();
  const whitelist = Array.from(riskEngine.parseWhitelist());
  const state = stateStore.readState();
  stateStore.rollDaily(state);
  enrichFillsLedgerLocalMatch(state);

  let lastError = null;
  if (state.lastError && typeof state.lastError === 'object') {
    lastError = {
      at: state.lastError.at != null ? String(state.lastError.at) : null,
      message: state.lastError.message != null ? String(state.lastError.message) : null,
      statusCode:
        state.lastError.statusCode != null ? Number(state.lastError.statusCode) : null,
    };
  }

  const lastOrder =
    state.lastLiveOrderId || state.lastShadowAt
      ? {
          liveOrderId: state.lastLiveOrderId != null ? String(state.lastLiveOrderId) : null,
          instrument: state.lastInstrument != null ? String(state.lastInstrument) : null,
          side: state.lastSide != null ? String(state.lastSide) : null,
          strategyId: state.lastStrategyId != null ? String(state.lastStrategyId) : null,
          shadowAt: state.lastShadowAt != null ? String(state.lastShadowAt) : null,
        }
      : null;

  const snap = state.brokerSnapshot && typeof state.brokerSnapshot === 'object' ? state.brokerSnapshot : null;
  const recentOk = reconciliationRecentOk(state.lastReconciledAt);
  const degraded = state.reconciliationDegraded === true;
  const consecFail = Number(state.reconciliationErrors?.consecutiveFailures) || 0;

  const brokerConnected = snap != null && recentOk && !degraded;
  const reconciliationHealthy = snap != null && recentOk && !degraded && consecFail === 0;

  const pnlSource = state.pnlSource != null ? String(state.pnlSource) : 'none';
  const pnlOk = pnlSource === 'reconciled';
  const livePnlApprox =
    pnlOk && state.livePnlApprox != null && Number.isFinite(Number(state.livePnlApprox))
      ? Number(state.livePnlApprox)
      : null;

  const rec = state.reconciliation && typeof state.reconciliation === 'object' ? state.reconciliation : {};
  const driftFlags = Array.isArray(rec.driftFlags) ? rec.driftFlags : [];

  const openPositionsCount = snap
    ? Number(snap.summary?.openPositionCount) ||
      (Array.isArray(snap.positions) ? snap.positions.length : 0) ||
      0
    : 0;
  const openTradesCount = snap
    ? Number(snap.summary?.openTradeCount) ||
      (Array.isArray(snap.openTrades) ? snap.openTrades.length : 0) ||
      0
    : 0;
  const pendingOrdersCount = snap
    ? Number(snap.summary?.pendingOrderCount) ||
      (Array.isArray(snap.pendingOrders) ? snap.pendingOrders.length : 0) ||
      0
    : 0;

  const accountPlLifetime =
    snap && snap.summary && Number.isFinite(Number(snap.summary.pl)) ? Number(snap.summary.pl) : null;

  const fillStats = fillCorrelationStats(state.fillsLedger);

  const period = computePnlPeriodUtcDay(state);
  const periodPnlOk = period.source === 'correlated_fills';
  const periodPnlCorrelated =
    periodPnlOk && period.realizedPnl != null && Number.isFinite(Number(period.realizedPnl))
      ? Number(period.realizedPnl)
      : null;
  const periodPnlSource = period.source != null ? String(period.source) : 'none';
  const periodPnlNote =
    periodPnlOk
      ? 'realized from ORDER_FILL.pl (sum) in UTC day; correlated fills only (matched OR signalExecutionKey); financing summed separately; not unrealized; not accountPlLifetime'
      : 'no correlated fills in current UTC day window in ledger';

  return {
    schema: '1.4.0',
    generatedAt: new Date().toISOString(),
    mode,
    dedupeDisabled: executionDedupe.isDedupeDisabled(),
    executedKeysTodayCount: executionDedupe.executedKeysTodayCount(state),
    killSwitchOn: riskEngine.isKillSwitchOn(),
    whitelistStrategyIds: whitelist,
    maxTradesPerDay: riskEngine.maxTradesPerDay(),
    maxUnitsCap: riskEngine.maxUnitsCap(),
    riskFraction: riskEngine.riskFraction(),
    oandaEnv: String(process.env.NEUROPILOT_OANDA_ENV || 'practice').toLowerCase(),
    oandaCredentialsPresent: hasOandaCredentialsConfigured(),
    tradesTodayLive: Number(state.liveTradesToday) || 0,
    shadowEventsToday: Number(state.shadowEventsToday) || 0,
    livePnlApprox,
    pnlSource: pnlOk ? 'reconciled' : 'none',
    pnlNote: pnlOk
      ? 'unrealizedPL_from_account_summary (not full portfolio PnL)'
      : 'set only after successful broker reconciliation',
    accountPlLifetime,
    brokerConnected,
    lastReconciledAt: state.lastReconciledAt != null ? String(state.lastReconciledAt) : null,
    lastReconciledTransactionId:
      state.lastReconciledTransactionId != null ? String(state.lastReconciledTransactionId) : null,
    reconciliationHealthy,
    reconciliationDegraded: degraded,
    reconciliationConsecutiveFailures: consecFail,
    reconciliationLastFailureMessage:
      state.reconciliationErrors?.lastFailureMessage != null
        ? String(state.reconciliationErrors.lastFailureMessage).slice(0, 240)
        : null,
    driftFlagsCount: driftFlags.length,
    driftFlags,
    openPositionsCount,
    openTradesCount,
    pendingOrdersCount,
    unknownPositionsCount: Array.isArray(rec.unknownPositions) ? rec.unknownPositions.length : 0,
    missingLocalFillsCount: Array.isArray(rec.missingLocalFills) ? rec.missingLocalFills.length : 0,
    fillsLedgerCount: Array.isArray(state.fillsLedger) ? state.fillsLedger.length : 0,
    matchedFillsCount: fillStats.matchedFillsCount,
    unmatchedFillsCount: fillStats.unmatchedFillsCount,
    fillsWithSignalKeyCount: fillStats.fillsWithSignalKeyCount,
    fillsWithoutSignalKeyCount: fillStats.fillsWithoutSignalKeyCount,
    periodPnlCorrelated,
    periodPnlSource,
    periodPnlWindow: period.window != null ? String(period.window) : 'utc_day',
    periodPnlFillsCount: Number(period.fillsCount) || 0,
    periodPnlMatchedCount: Number(period.matchedFillsCount) || 0,
    periodPnlFees:
      periodPnlOk && period.realizedFeesPeriod != null && Number.isFinite(Number(period.realizedFeesPeriod))
        ? Number(period.realizedFeesPeriod)
        : null,
    periodStartUtc: period.periodStartUtc != null ? String(period.periodStartUtc) : null,
    periodEndUtc: period.periodEndUtc != null ? String(period.periodEndUtc) : null,
    periodPnlComputedAt: period.computedAt != null ? String(period.computedAt) : null,
    periodPnlNote,
    brokerSnapshotAgeMinutes:
      state.lastReconciledAt != null && Number.isFinite(Date.parse(state.lastReconciledAt))
        ? Math.round(((Date.now() - Date.parse(state.lastReconciledAt)) / 60000) * 100) / 100
        : null,
    lastOrder,
    lastError,
    statePath: stateStore.stateFilePath(),
    recentEvents: Array.isArray(state.recentEvents) ? state.recentEvents.slice(0, 10) : [],
  };
}

module.exports = {
  buildExecutionStatusSnapshot,
};
