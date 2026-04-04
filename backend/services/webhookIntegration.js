'use strict';

/**
 * Webhook Integration
 * Wraps the existing webhook handler and routes BUY/SELL/CLOSE through liveExecutionGate.
 * Provides health/status/emergency-stop endpoints.
 */

const liveExecutionGate = require('./liveExecutionGate');
const reconciliationService = require('./reconciliationService');
const alertManager = require('./alertManager');

/**
 * Create webhook handler that uses liveExecutionGate for execution.
 * Attaches req.liveExecutionGate so the existing handler can use it.
 * The existing handler should call: req.liveExecutionGate.executeOrder(orderIntent)
 * when available, instead of broker.placeOrder().
 *
 * @param {Function} existingHandler - (req, res) => ... Express handler
 * @returns {Function} - Express handler
 */
function createWebhookIntegration(existingHandler) {
  return async function webhookHandler(req, res) {
    req.liveExecutionGate = liveExecutionGate;
    return existingHandler(req, res);
  };
}

/**
 * Health check for execution subsystem
 */
function createHealthCheckEndpoint() {
  return async function healthCheck(req, res) {
    try {
      const equity = await liveExecutionGate.getCurrentEquity();
      const mode = liveExecutionGate.getTradingMode();
      const killSwitch = liveExecutionGate.getKillSwitchStatus();
      res.json({
        ok: true,
        execution: {
          mode,
          killSwitch,
          equity,
          tradingEnabled: liveExecutionGate.isTradingEnabled(),
        },
        ts: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e?.message || 'unknown',
        ts: new Date().toISOString(),
      });
    }
  };
}

/**
 * Status endpoint (reconciliation + risk stats)
 */
function createStatusEndpoint() {
  return async function status(req, res) {
    try {
      const recon = await reconciliationService.reconcile();
      res.json({
        ok: true,
        mode: liveExecutionGate.getTradingMode(),
        killSwitch: liveExecutionGate.getKillSwitchStatus(),
        dailyPnL: recon.dailyPnL,
        equity: recon.equity,
        openPositions: recon.brokerPositionCount,
        reconciliation: {
          ok: recon.ok,
          discrepancies: recon.discrepancies,
        },
        ts: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e?.message || 'unknown',
        ts: new Date().toISOString(),
      });
    }
  };
}

/**
 * Emergency stop - sets runtime kill switch (no restart needed)
 */
function createEmergencyStopEndpoint() {
  return async function emergencyStop(req, res) {
    try {
      liveExecutionGate.setEmergencyStop(true);
      await alertManager.recordEmergencyStop(req.body?.reason || 'manual');
      res.json({
        ok: true,
        message: 'Emergency stop activated. Trading is blocked until restart.',
        ts: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e?.message || 'unknown',
        ts: new Date().toISOString(),
      });
    }
  };
}

module.exports = {
  createWebhookIntegration,
  createHealthCheckEndpoint,
  createStatusEndpoint,
  createEmergencyStopEndpoint,
};
