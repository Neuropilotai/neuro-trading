'use strict';

/**
 * Champion Performance Tracker — Persist live results and auto-kill degraded champions.
 * File: champion_setups/champion_performance.json
 *
 * Env thresholds:
 *   CHAMPION_MIN_TRADES_FOR_KILL=5
 *   CHAMPION_KILL_MAX_DRAWDOWN_R=-3
 *   CHAMPION_KILL_MIN_NET_PNL_R=-2
 *   CHAMPION_KILL_MIN_WINRATE=0.25
 *   CHAMPION_KILL_WINRATE_MIN_TRADES=8
 */

const fs = require('fs');
const path = require('path');

const DATA_ROOT = process.env.NEUROPILOT_DATA_ROOT || '';
const PERF_PATH = DATA_ROOT
  ? path.join(DATA_ROOT, 'champion_setups', 'champion_performance.json')
  : path.join(__dirname, '../../..', 'data_workspace', 'champion_setups', 'champion_performance.json');
const FALLBACK_PATH = '/Volumes/TradingDrive/NeuroPilotAI/champion_setups/champion_performance.json';


function getPerfPath() {
  if (fs.existsSync(PERF_PATH)) return PERF_PATH;
  if (fs.existsSync(FALLBACK_PATH)) return FALLBACK_PATH;
  return DATA_ROOT ? path.join(DATA_ROOT, 'champion_setups', 'champion_performance.json') : PERF_PATH;
}

function ensureChampionSetupsDir() {
  const dir = path.dirname(getPerfPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load performance data. Returns { bySetupId: { [setupId]: {...} } }.
 * @returns {{ bySetupId: Object }}
 */
function loadChampionPerformance() {
  const filePath = getPerfPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const j = JSON.parse(raw);
      return { bySetupId: j.bySetupId && typeof j.bySetupId === 'object' ? j.bySetupId : {} };
    }
  } catch (e) {
    console.error('championPerformance.loadChampionPerformance failed:', e && e.message);
  }
  return { bySetupId: {} };
}

/**
 * Save performance data.
 * @param {{ bySetupId: Object }} data
 */
function saveChampionPerformance(data) {
  ensureChampionSetupsDir();
  const filePath = getPerfPath();
  const out = {
    updatedAt: new Date().toISOString(),
    bySetupId: data.bySetupId || {},
  };
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2), 'utf8');
}

/**
 * Evaluate if a champion should be killed based on live stats.
 * Stable defaults: more trades before kill (bootstrap-friendly).
 * @param {object} entry - Performance entry (trades, wins, losses, netPnlR, maxDrawdownR, etc.)
 * @returns {{ kill: boolean, reason?: string }}
 */
function evaluateChampionKill(entry) {
  if (!entry || entry.active === false) return { kill: false };

  const trades = entry.trades || 0;
  const netPnlR = entry.netPnlR || 0;
  const maxDD = entry.maxDrawdownR || 0;
  const winRate = trades > 0 ? (entry.wins || 0) / trades : 0;

  const minTrades = Number(process.env.CHAMPION_MIN_TRADES_FOR_KILL || 10);
  const minWinrateTrades = Number(process.env.CHAMPION_KILL_WINRATE_MIN_TRADES || 12);

  // 1. Catastrophic drawdown (always kill)
  if (maxDD <= -4) {
    return { kill: true, reason: 'max_drawdown_exceeded' };
  }

  // 2. Performance kill (only after enough trades)
  if (trades >= minTrades && netPnlR < -3) {
    return { kill: true, reason: 'net_pnl_negative' };
  }

  // 3. Winrate kill (only after more trades)
  if (trades >= minWinrateTrades && winRate < 0.25) {
    return { kill: true, reason: 'low_winrate' };
  }

  return { kill: false };
}

/**
 * Record a closed trade result and optionally trigger kill.
 * @param {{ setupId: string, pnlR?: number, pnl?: number, riskDollars?: number, won: boolean, closedAt: string }} params
 */
function recordChampionTradeResult(params) {
  const { setupId, pnlR: pnlRIn, pnl, riskDollars, won, closedAt } = params;
  if (!setupId) return;

  const data = loadChampionPerformance();
  let entry = data.bySetupId[setupId];

  let pnlR = pnlRIn;
  if (pnlR == null && pnl != null && riskDollars != null && riskDollars > 0) {
    pnlR = pnl / riskDollars;
  }
  if (pnlR == null && pnl != null) {
    const accountBalance = parseFloat(process.env.ACCOUNT_BALANCE || '500');
    const oneR = accountBalance * 0.01;
    pnlR = oneR !== 0 ? pnl / oneR : 0;
  }
  if (!Number.isFinite(pnlR)) pnlR = 0;

  const pnlDollars = Number.isFinite(Number(pnl)) ? Number(pnl) : 0;

  if (!entry) {
    entry = {
      setupId,
      trades: 0,
      wins: 0,
      losses: 0,
      grossPnl: 0,
      netPnl: 0,
      netPnlR: 0,
      avgPnl: 0,
      maxDrawdownR: 0,
      runningDrawdownR: 0,
      lastTradeAt: null,
      lastResult: null,
      active: true,
      killReason: null,
      killTriggeredAt: null,
    };
    data.bySetupId[setupId] = entry;
  }

  if (entry.active === false) return;

  entry.trades = (entry.trades || 0) + 1;
  if (won) entry.wins = (entry.wins || 0) + 1;
  else entry.losses = (entry.losses || 0) + 1;
  entry.grossPnl = (entry.grossPnl || 0) + pnlDollars;
  entry.netPnl = entry.grossPnl;
  entry.netPnlR = (entry.netPnlR || 0) + pnlR;
  entry.avgPnl = entry.trades ? entry.grossPnl / entry.trades : 0;
  entry.lastTradeAt = closedAt || new Date().toISOString();
  entry.lastResult = pnlR;

  // Running drawdown (cumulative losses only)
  if (pnlR < 0) {
    entry.runningDrawdownR = (entry.runningDrawdownR || 0) + pnlR;
  } else {
    entry.runningDrawdownR = 0;
  }
  // Track worst drawdown
  entry.maxDrawdownR = Math.min(
    Number.isFinite(entry.maxDrawdownR) ? entry.maxDrawdownR : 0,
    entry.runningDrawdownR
  );

  const { kill, reason } = evaluateChampionKill(entry);
  if (kill) {
    entry.active = false;
    entry.killReason = reason;
    entry.killTriggeredAt = new Date().toISOString();
  }

  saveChampionPerformance(data);
}

/**
 * Whether a setup is allowed to trade (not killed).
 * No entry = allowed (no live data yet).
 * @param {string} setupId
 * @returns {boolean}
 */
function isChampionActive(setupId) {
  if (!setupId) return false;
  const data = loadChampionPerformance();
  const entry = data.bySetupId[String(setupId)];
  if (!entry) return true;
  return entry.active !== false;
}

/**
 * Get killed setupIds (for evolution sync).
 * @returns {Set<string>}
 */
function getKilledSetupIds() {
  const data = loadChampionPerformance();
  const set = new Set();
  for (const [id, entry] of Object.entries(data.bySetupId || {})) {
    if (entry && entry.active === false) set.add(id);
  }
  return set;
}

module.exports = {
  loadChampionPerformance,
  saveChampionPerformance,
  recordChampionTradeResult,
  evaluateChampionKill,
  isChampionActive,
  getKilledSetupIds,
  getPerfPath,
};
