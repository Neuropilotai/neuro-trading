#!/usr/bin/env node
'use strict';

/**
 * Supervision-only circuit breaker. Does not touch trading engines.
 * CLI: node circuitBreakerNeuropilotCore.js <status|evaluate|is-restart-allowed|set-state STATE REASON>
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const opsDir = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR
  ? path.resolve(process.env.NEUROPILOT_OPS_SNAPSHOT_DIR)
  : path.join(repoRoot, 'ops-snapshot');
const cbPath = path.join(opsDir, 'circuit_breaker_status.json');

const ENABLED = !['0', 'false', 'no'].includes(
  String(process.env.NP_CIRCUIT_BREAKER_ENABLED || '1').toLowerCase()
);
const OPEN_COOLDOWN_SEC = Math.max(
  60,
  parseInt(process.env.NP_CIRCUIT_BREAKER_OPEN_COOLDOWN_SEC || '900', 10) || 900
);
const CONSEC_CRIT = Math.max(
  1,
  parseInt(process.env.NP_CIRCUIT_BREAKER_CONSEC_CRITICAL_THRESHOLD || '3', 10) || 3
);

function readCb() {
  try {
    if (!fs.existsSync(cbPath)) return defaultCb();
    return { ...defaultCb(), ...JSON.parse(fs.readFileSync(cbPath, 'utf8')) };
  } catch {
    return defaultCb();
  }
}

function defaultCb() {
  return {
    schemaVersion: 1,
    state: 'CLOSED',
    updatedAt: null,
    openedAt: null,
    halfOpenAt: null,
    reason: null,
    consecutiveCritical: 0,
    lastEvaluateAt: null,
    halfOpenTestRestartUsed: false,
  };
}

function writeCb(o) {
  o.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(cbPath), { recursive: true });
  fs.writeFileSync(cbPath, JSON.stringify(o, null, 2), 'utf8');
}

function readHealth() {
  const p = path.join(opsDir, 'neuropilot_health.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function readWatchdog() {
  const p = path.join(opsDir, 'watchdog_status.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function parseMs(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
}

function cmdStatus() {
  const j = readCb();
  console.log(JSON.stringify(j, null, 2));
}

function cmdIsRestartAllowed() {
  if (!ENABLED) {
    process.exit(0);
  }
  const j = readCb();
  if (process.env.NP_FORCE_CIRCUIT_BREAKER_OPEN === '1') {
    process.exit(1);
  }
  if (j.state === 'CLOSED') process.exit(0);
  if (j.state === 'HALF_OPEN') {
    if (!j.halfOpenTestRestartUsed) process.exit(0);
    process.exit(1);
  }
  if (j.state === 'OPEN') process.exit(1);
  process.exit(1);
}

function cmdSetState(state, reason) {
  const j = readCb();
  j.state = state;
  j.reason = reason || j.reason;
  const now = new Date().toISOString();
  if (state === 'OPEN') {
    j.openedAt = now;
    j.halfOpenAt = null;
    j.halfOpenTestRestartUsed = false;
  } else if (state === 'HALF_OPEN') {
    j.halfOpenAt = now;
    j.halfOpenTestRestartUsed = false;
  } else if (state === 'CLOSED') {
    j.openedAt = null;
    j.halfOpenAt = null;
    j.halfOpenTestRestartUsed = false;
    j.consecutiveCritical = 0;
    j.reason = null;
  }
  writeCb(j);
  cmdStatus();
}

function cmdEvaluate() {
  if (!ENABLED) {
    const j = readCb();
    j.lastEvaluateAt = new Date().toISOString();
    writeCb(j);
    console.log(JSON.stringify({ ok: true, skipped: 'circuit_breaker_disabled' }));
    return;
  }

  const health = readHealth();
  const wd = readWatchdog();
  let j = readCb();
  const now = Date.now();
  j.lastEvaluateAt = new Date().toISOString();

  if (process.env.NP_FORCE_CIRCUIT_BREAKER_OPEN === '1') {
    if (j.state !== 'OPEN') {
      j.state = 'OPEN';
      j.reason = 'NP_FORCE_CIRCUIT_BREAKER_OPEN';
      j.openedAt = j.lastEvaluateAt;
    }
    writeCb(j);
    console.log(JSON.stringify({ ok: true, transition: 'forced_open' }));
    return;
  }

  const overall = health.overallStatus || '';
  const crit = overall === 'CRITICAL';
  const recoverOk = !crit;

  if (crit) {
    j.consecutiveCritical = (j.consecutiveCritical || 0) + 1;
  } else {
    j.consecutiveCritical = 0;
  }

  const restarts1h = toNum(health.restartPressure && health.restartPressure.restartsLastHour, 0);
  const maxRestarts = toNum(process.env.NP_WATCHDOG_MAX_RESTARTS_PER_HOUR, 6);
  const bothStale =
    health.staleFlags &&
    health.staleFlags.includes('paper_last_run_very_stale') &&
    health.staleFlags.includes('governance_dashboard_stale');

  const shouldOpen =
    j.consecutiveCritical >= CONSEC_CRIT ||
    restarts1h >= maxRestarts ||
    bothStale ||
    wd.circuitBreakerEscalation === true;

  if (j.state === 'OPEN') {
    const opened = parseMs(j.openedAt);
    const ageSec = opened ? (now - opened) / 1000 : 999999;
    if (ageSec >= OPEN_COOLDOWN_SEC && recoverOk) {
      j.state = 'HALF_OPEN';
      j.halfOpenAt = new Date().toISOString();
      j.halfOpenTestRestartUsed = false;
      j.reason = 'cooldown_elapsed_probe';
    }
    writeCb(j);
    console.log(JSON.stringify({ ok: true, state: j.state }));
    return;
  }

  if (j.state === 'HALF_OPEN') {
    const stableEnough = (overall === 'HEALTHY' || overall === 'WATCH') && !crit;
    if (stableEnough) {
      j.state = 'CLOSED';
      j.reason = null;
      j.consecutiveCritical = 0;
    } else if (crit || overall === 'DEGRADED' || overall === 'CRITICAL') {
      j.state = 'OPEN';
      j.openedAt = new Date().toISOString();
      j.reason = 'half_open_failed_health';
    }
    writeCb(j);
    console.log(JSON.stringify({ ok: true, state: j.state }));
    return;
  }

  if (j.state === 'CLOSED' && shouldOpen) {
    j.state = 'OPEN';
    j.openedAt = new Date().toISOString();
    j.reason =
      j.consecutiveCritical >= CONSEC_CRIT
        ? 'consecutive_critical_health'
        : restarts1h >= maxRestarts
          ? 'max_restarts_per_hour'
          : bothStale
            ? 'dual_heartbeat_stale'
            : 'watchdog_escalation';
  }

  writeCb(j);
  console.log(JSON.stringify({ ok: true, state: j.state, consecutiveCritical: j.consecutiveCritical }));
}

function toNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function cmdMarkHalfOpenRestartUsed() {
  const j = readCb();
  j.halfOpenTestRestartUsed = true;
  writeCb(j);
}

function cmdAfterWatchdogRestart() {
  const j = readCb();
  if (j.state === 'HALF_OPEN') {
    j.halfOpenTestRestartUsed = true;
    writeCb(j);
  }
}

const cmd = process.argv[2] || 'status';
if (cmd === 'status') cmdStatus();
else if (cmd === 'is-restart-allowed') cmdIsRestartAllowed();
else if (cmd === 'evaluate') cmdEvaluate();
else if (cmd === 'set-state') cmdSetState(process.argv[3] || 'CLOSED', process.argv[4] || '');
else if (cmd === 'mark-half-open-restart-used') cmdMarkHalfOpenRestartUsed();
else if (cmd === 'after-watchdog-restart') cmdAfterWatchdogRestart();
else {
  console.error('Unknown command:', cmd);
  process.exit(1);
}
