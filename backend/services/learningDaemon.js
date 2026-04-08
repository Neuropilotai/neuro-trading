'use strict';

/**
 * Minimal learning daemon facade for /learn/* HTTP routes.
 * Full worker lifecycle can be wired later; this matches server.js expectations.
 */

const fs = require('fs');
const path = require('path');
const tradingLearningService = require('./tradingLearningService');

function repoRootData(...segments) {
  return path.join(__dirname, '..', '..', 'data', ...segments);
}

function readHeartbeatSync() {
  const heartbeatPath = repoRootData('learning', 'heartbeat.json');
  try {
    const raw = fs.readFileSync(heartbeatPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readPidFileSync() {
  const pidFile = repoRootData('pids', 'learning.pid');
  try {
    const raw = fs.readFileSync(pidFile, 'utf8');
    const pid = parseInt(String(raw).trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class LearningDaemon {
  getStatus() {
    const enabled = tradingLearningService.enabled === true;
    const hb = readHeartbeatSync();
    let pid = hb && hb.pid != null ? Number(hb.pid) : null;
    if (!Number.isFinite(pid) || pid <= 0) {
      pid = readPidFileSync();
    }
    const isRunning = pidAlive(pid);
    const lastRun =
      (hb && hb.lastCycleAt) ||
      (hb && hb.timestamp) ||
      null;
    const lastError = hb && hb.lastError != null ? String(hb.lastError) : null;

    return {
      enabled,
      isRunning,
      lastRun,
      lastError,
      intervalMinutes: parseFloat(process.env.LEARNING_DAEMON_INTERVAL_MINUTES || '60') || 60,
      concurrency: Math.max(1, parseInt(process.env.LEARNING_DAEMON_CONCURRENCY || '1', 10) || 1),
      queueDepth: 0,
      processing: false,
    };
  }
}

module.exports = {
  LearningDaemon,
};
