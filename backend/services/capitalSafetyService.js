'use strict';

const fs = require('fs').promises;
const path = require('path');
const paperTradingService = require('./paperTradingService');
const securityAuditService = require('./securityAuditService');

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getStatePath() {
  return path.join(getDataDir(), 'security', 'capital_safety_state.json');
}

function isTruthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

function parseNum(v, def) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function loadState() {
  try {
    const raw = await fs.readFile(getStatePath(), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    return {};
  }
}

async function saveState(state) {
  try {
    const p = getStatePath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[capital-safety] saveState: ${e.message}`);
  }
}

async function ensureDay(state) {
  const d = todayKey();
  if (state.day !== d) {
    state.day = d;
    state.autonomousEntriesToday = 0;
    state.autonomousLossesToday = 0;
    state.dailyRealizedLossApprox = 0;
  }
  return state;
}

function sumOpenNotional(positions) {
  let total = 0;
  const bySym = {};
  for (const p of positions || []) {
    const q = Number(p.quantity) || 0;
    const px = Number(p.avgPrice) || Number(p.currentPrice) || 0;
    const n = Math.abs(q * px);
    total += n;
    const sym = String(p.symbol || '').toUpperCase();
    bySym[sym] = (bySym[sym] || 0) + n;
  }
  return { total, bySym };
}

/**
 * @param {object} context
 * @param {string} [context.source] 'autonomous' | 'webhook' | 'other'
 * @param {object} [context.orderIntent]
 * @param {object} [context.env]
 */
async function evaluateCapitalSafety(context = {}) {
  const env = context.env || process.env;
  const source = String(context.source || 'other');
  const orderIntent = context.orderIntent || {};

  const metrics = {
    openNotionalTotal: 0,
    openNotionalPerSymbol: {},
    dailyLossApprox: 0,
    autonomousEntriesToday: 0,
    consecutiveAutonomousLosses: 0,
  };

  const warnings = [];
  let blockingReason = null;
  let code = null;

  if (isTruthy(env.GLOBAL_TRADING_KILL_SWITCH)) {
    blockingReason = 'global_kill_switch_active';
    code = 'kill_switch_active';
    await securityAuditService.appendAudit({
      eventType: 'capital_safety_block',
      severity: 'critical',
      actorType: 'system',
      outcome: 'blocked',
      reason: blockingReason,
      metadata: { source },
    });
    return { allowed: false, blockingReason, warnings, metrics, code };
  }

  if (source === 'autonomous' && isTruthy(env.AUTONOMOUS_TRADING_KILL_SWITCH)) {
    blockingReason = 'autonomous_kill_switch_active';
    code = 'kill_switch_active';
    await securityAuditService.appendAudit({
      eventType: 'capital_safety_block',
      severity: 'critical',
      actorType: 'system',
      outcome: 'blocked',
      reason: blockingReason,
      metadata: { source },
    });
    return { allowed: false, blockingReason, warnings, metrics, code };
  }

  let summary;
  try {
    summary = paperTradingService.getAccountSummary();
  } catch (e) {
    warnings.push(`account_summary_unavailable:${e.message}`);
    summary = {};
  }

  const equity =
    Number(summary.equity) ||
    Number(summary.bookEquity) ||
    Number(summary.balance) ||
    0;

  const positions = Array.isArray(summary.positions) ? summary.positions : [];
  const { total, bySym } = sumOpenNotional(positions);
  metrics.openNotionalTotal = total;
  metrics.openNotionalPerSymbol = bySym;

  const maxOpenTotal = parseNum(env.MAX_OPEN_NOTIONAL_TOTAL, Infinity);
  const maxOpenSym = parseNum(env.MAX_OPEN_NOTIONAL_PER_SYMBOL, Infinity);

  if (Number.isFinite(maxOpenTotal) && total > maxOpenTotal) {
    blockingReason = 'max_open_notional_total_exceeded';
    code = 'capital_safety_block';
  }
  const sym = String(orderIntent.symbol || '').toUpperCase();
  if (!blockingReason && sym && Number.isFinite(maxOpenSym) && (bySym[sym] || 0) > maxOpenSym) {
    blockingReason = 'max_open_notional_per_symbol_exceeded';
    code = 'capital_safety_block';
  }

  const dailyLossCap = parseNum(env.MAX_DAILY_LOSS_DOLLARS, Infinity);
  const maxLossPct = parseNum(env.MAX_DAILY_LOSS_PCT, Infinity);
  const pnlApprox = Number(summary.dailyPnL) || Number(summary.dayPnL) || 0;
  metrics.dailyLossApprox = pnlApprox;

  if (!blockingReason && Number.isFinite(dailyLossCap) && pnlApprox < -Math.abs(dailyLossCap)) {
    blockingReason = 'max_daily_loss_dollars_exceeded';
    code = 'capital_safety_block';
  }
  if (!blockingReason && equity > 0 && Number.isFinite(maxLossPct) && pnlApprox < -equity * maxLossPct) {
    blockingReason = 'max_daily_loss_pct_exceeded';
    code = 'capital_safety_block';
  }

  const state = await ensureDay(await loadState());
  metrics.autonomousEntriesToday = state.autonomousEntriesToday || 0;
  metrics.consecutiveAutonomousLosses = state.consecutiveAutonomousLosses || 0;

  const maxEntries = parseInt(env.MAX_AUTONOMOUS_ENTRIES_PER_DAY || '999', 10);
  const maxLosses = parseInt(env.MAX_AUTONOMOUS_LOSSES_PER_DAY || '999', 10);
  const maxConsec = parseInt(env.MAX_CONSECUTIVE_AUTONOMOUS_LOSSES || '999', 10);

  if (source === 'autonomous' && !blockingReason) {
    if (Number.isFinite(maxEntries) && (state.autonomousEntriesToday || 0) >= maxEntries) {
      blockingReason = 'max_autonomous_entries_per_day';
      code = 'capital_safety_block';
    }
    if (!blockingReason && Number.isFinite(maxLosses) && (state.autonomousLossesToday || 0) >= maxLosses) {
      blockingReason = 'max_autonomous_losses_per_day';
      code = 'capital_safety_block';
    }
    if (!blockingReason && Number.isFinite(maxConsec) && (state.consecutiveAutonomousLosses || 0) >= maxConsec) {
      blockingReason = 'max_consecutive_autonomous_losses';
      code = 'capital_safety_block';
    }
  }

  const maxPos = parseInt(env.MAX_TOTAL_AUTONOMOUS_POSITIONS || '50', 10);
  if (source === 'autonomous' && !blockingReason && Number.isFinite(maxPos)) {
    const auto = positions.filter((p) => p.autonomousTag === true);
    if (auto.length >= maxPos) {
      blockingReason = 'max_total_autonomous_positions';
      code = 'capital_safety_block';
    }
  }

  if (blockingReason) {
    await securityAuditService.appendAudit({
      eventType: 'capital_safety_block',
      severity: 'high',
      actorType: 'system',
      outcome: 'blocked',
      reason: blockingReason,
      symbol: sym || null,
      metadata: { source, metrics },
    });
    await saveState(state);
    return { allowed: false, blockingReason, warnings, metrics, code };
  }

  await saveState(state);
  return { allowed: true, blockingReason: null, warnings, metrics, code: null };
}

/**
 * Record an autonomous entry (call after successful order).
 */
async function recordAutonomousEntryAttempt() {
  const state = await ensureDay(await loadState());
  state.autonomousEntriesToday = (state.autonomousEntriesToday || 0) + 1;
  await saveState(state);
}

module.exports = {
  evaluateCapitalSafety,
  recordAutonomousEntryAttempt,
  getStatePath,
};
