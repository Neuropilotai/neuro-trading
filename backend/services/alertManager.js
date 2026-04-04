'use strict';

/**
 * Alert Manager
 * Centralizes alert logging and optional notifications (Discord, email, etc.)
 * No external API calls by default; extend for notifications.
 */

const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const ALERT_LOG_DIR = path.join(DATA_DIR, 'alerts');

async function ensureLogDir() {
  try {
    await fs.mkdir(ALERT_LOG_DIR, { recursive: true });
  } catch (e) {
    console.warn('⚠️  alertManager: could not create log dir:', e?.message);
  }
}

/**
 * Log an alert (file-based, no external calls)
 */
async function logAlert(alert) {
  await ensureLogDir();
  const file = path.join(ALERT_LOG_DIR, 'alerts.json');
  let alerts = [];
  try {
    const raw = await fs.readFile(file, 'utf8');
    alerts = JSON.parse(raw);
  } catch (_) {}

  alerts.push({
    ...alert,
    ts: new Date().toISOString(),
  });

  try {
    await fs.writeFile(file, JSON.stringify(alerts, null, 2));
  } catch (e) {
    console.warn('⚠️  alertManager: could not write log:', e?.message);
  }
}

/**
 * Record an execution alert (BUY/SELL/CLOSE)
 */
async function recordExecution(alert) {
  await logAlert({ type: 'execution', ...alert });
}

/**
 * Record a risk rejection
 */
async function recordRejection(alert) {
  await logAlert({ type: 'rejection', ...alert });
}

/**
 * Record emergency stop
 */
async function recordEmergencyStop(reason) {
  await logAlert({ type: 'emergency_stop', reason });
}

module.exports = {
  logAlert,
  recordExecution,
  recordRejection,
  recordEmergencyStop,
};
