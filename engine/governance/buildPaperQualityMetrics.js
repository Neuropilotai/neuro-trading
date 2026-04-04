#!/usr/bin/env node
'use strict';

/**
 * Paper quality / PnL metrics from governance/paper_trades.jsonl (read-only).
 * Outputs:
 *   <dataRoot>/governance/paper_quality_metrics.json — full audit blob
 *   <repo>/ops-snapshot/paper_quality_summary.json — compact ops view
 *
 * Scope defaults: ADAUSDT,XRPUSDT × ORB_breakout_v1,EMA_pullback_v2 (env overridable).
 * Windows:
 *   - rolling N days on exitTs (bar time) — “qualité marché simulé”
 *   - rolling N days on simulatedAt (wall clock) — “activité moteur récente”
 *   - optional since-patch on simulatedAt (one-shot from patch instant)
 *
 * Soft gates only (healthy | watch | degrade) — does not block execution.
 *
 * Env:
 *   NEUROPILOT_PAPER_QUALITY_SYMBOLS — CSV (default ADAUSDT,XRPUSDT)
 *   NEUROPILOT_PAPER_QUALITY_STRATEGIES — CSV (default ORB_breakout_v1,EMA_pullback_v2)
 *   NEUROPILOT_WAVE1_SYMBOLS — CSV for wave1 vs non-wave1 split (default ADAUSDT,XRPUSDT if unset)
 *   NEUROPILOT_PAPER_QUALITY_ROLLING_DAYS — default 7
 *   NEUROPILOT_PAPER_QUALITY_SINCE_PATCH_AT — ISO instant for simulatedAt window (optional)
 *
 * Also writes governance/paper_quality_actions.json (audit-only deprioritize hints; never blocks execution).
 *   NEUROPILOT_PAPER_QUALITY_SUGGEST_MIN_TRADES — default 4 (aggregate wave1 rolling simulatedAt)
 *   NEUROPILOT_PAPER_QUALITY_DEPRIORITIZE_MIN_TRADES — default 10
 *   NEUROPILOT_PAPER_QUALITY_DEPRIORITIZE_STRATEGIES — CSV, default EMA_pullback_v2
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const { parsePaperTradesJsonlContent } = require('./parsePaperTradesJsonl');
const riskEngine = require('../execution/executionRiskEngine');

const SCHEMA_VERSION = '1.1.0';
const PAPER_QUALITY_ACTIONS_SCHEMA_VERSION = '1.0.0';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function resolveOpsSnapshotDir() {
  const env = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR;
  if (env && String(env).trim()) return path.resolve(process.cwd(), String(env).trim());
  return path.join(PROJECT_ROOT, 'ops-snapshot');
}

function parseIsoMs(iso) {
  if (iso == null || iso === '') return null;
  const ms = new Date(String(iso)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function parseCsvUpper(raw, fallbackCsv) {
  const s = raw != null && String(raw).trim() ? String(raw).trim() : fallbackCsv;
  return new Set(
    String(s)
      .split(',')
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
  );
}

function parseCsvStrategy(raw, fallbackCsv) {
  const s = raw != null && String(raw).trim() ? String(raw).trim() : fallbackCsv;
  return new Set(
    String(s)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  );
}

function roundPnl(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 1e8) / 1e8;
}

/**
 * @param {object[]} trades
 * @returns {object}
 */
function computeCoreMetrics(trades) {
  const n = trades.length;
  if (n === 0) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRate: null,
      totalPnl: null,
      avgPnlPerTrade: null,
      grossProfit: null,
      grossLoss: null,
      profitFactor: null,
      expectancy: null,
      avgBarsHeld: null,
    };
  }

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let totalPnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let barsSum = 0;
  let barsN = 0;

  for (const t of trades) {
    const p = Number(t.pnl);
    if (!Number.isFinite(p)) continue;
    totalPnl += p;
    if (p > 0) {
      wins++;
      grossProfit += p;
    } else if (p < 0) {
      losses++;
      grossLoss += p;
    } else breakeven++;

    const bh = t.barsHeld;
    if (typeof bh === 'number' && Number.isFinite(bh)) {
      barsSum += bh;
      barsN++;
    }
  }

  const winRate = Math.round((wins / n) * 10000) / 100;
  const avgPnlPerTrade = roundPnl(totalPnl / n);
  const expectancy = avgPnlPerTrade;
  const glAbs = grossLoss < 0 ? -grossLoss : 0;
  let profitFactor = null;
  if (glAbs > 0) profitFactor = Math.round((grossProfit / glAbs) * 10000) / 10000;
  else if (grossProfit > 0) profitFactor = null;

  return {
    trades: n,
    wins,
    losses,
    breakeven,
    winRate,
    totalPnl: roundPnl(totalPnl),
    avgPnlPerTrade,
    grossProfit: roundPnl(grossProfit),
    grossLoss: grossLoss < 0 ? roundPnl(grossLoss) : 0,
    profitFactor,
    expectancy,
    avgBarsHeld: barsN > 0 ? Math.round((barsSum / barsN) * 100) / 100 : null,
  };
}

function groupBy(trades, keyOf) {
  const m = new Map();
  for (const t of trades) {
    const k = keyOf(t);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return m;
}

function breakdownMetrics(trades, keyOf) {
  const g = groupBy(trades, keyOf);
  const out = {};
  const keys = Array.from(g.keys()).sort();
  for (const k of keys) {
    out[k] = computeCoreMetrics(g.get(k));
  }
  return out;
}

/**
 * @param {ReturnType<computeCoreMetrics>} m
 * @returns {{ level: 'healthy'|'watch'|'degrade', reasons: string[] }}
 */
function softQualityStatus(m) {
  const reasons = [];
  if (m.trades === 0) return { level: 'healthy', reasons: [] };

  if (m.expectancy != null && m.expectancy < 0) reasons.push('expectancy_negative');
  if (m.profitFactor != null && m.profitFactor < 1.0) reasons.push('profit_factor_below_1');

  let level = 'healthy';
  if (reasons.length) level = 'watch';

  if (m.trades >= 20) {
    if (m.profitFactor != null && m.profitFactor < 0.9) {
      reasons.push('profit_factor_below_0_9_with_20plus_trades');
      level = 'degrade';
    }
    if (m.avgPnlPerTrade != null && m.avgPnlPerTrade < 0) {
      reasons.push('avg_pnl_per_trade_negative_with_20plus_trades');
      level = 'degrade';
    }
  }

  return { level, reasons: Array.from(new Set(reasons)) };
}

function attachSoftAndBreakdowns(trades) {
  const core = computeCoreMetrics(trades);
  return {
    ...core,
    bySymbol: breakdownMetrics(trades, (t) =>
      t.symbol != null && String(t.symbol).trim() ? String(t.symbol).trim().toUpperCase() : null
    ),
    byStrategy: breakdownMetrics(trades, (t) =>
      t.strategyId != null && String(t.strategyId).trim() ? String(t.strategyId).trim() : null
    ),
    byTimeframe: breakdownMetrics(trades, (t) =>
      t.timeframe != null && String(t.timeframe).trim() ? String(t.timeframe).trim().toLowerCase() : null
    ),
    softStatus: softQualityStatus(core),
  };
}

function filterPrimary(trades, qualitySymbols, qualityStrategies) {
  return trades.filter((t) => {
    const sym = t.symbol != null ? String(t.symbol).trim().toUpperCase() : '';
    const sid = t.strategyId != null ? String(t.strategyId).trim() : '';
    return qualitySymbols.has(sym) && qualityStrategies.has(sid);
  });
}

function filterWave1(trades, wave1Symbols, qualityStrategies) {
  return trades.filter((t) => {
    const sym = t.symbol != null ? String(t.symbol).trim().toUpperCase() : '';
    const sid = t.strategyId != null ? String(t.strategyId).trim() : '';
    return wave1Symbols.has(sym) && qualityStrategies.has(sid);
  });
}

function filterNonWave1AllowedStrategies(trades, wave1Symbols, qualityStrategies) {
  return trades.filter((t) => {
    const sym = t.symbol != null ? String(t.symbol).trim().toUpperCase() : '';
    const sid = t.strategyId != null ? String(t.strategyId).trim() : '';
    return !wave1Symbols.has(sym) && qualityStrategies.has(sid);
  });
}

function filterExitTsWindow(trades, startMs) {
  return trades.filter((t) => {
    const ms = parseIsoMs(t.exitTs || t.ts);
    return ms != null && ms >= startMs;
  });
}

function filterSimulatedAtWindow(trades, startMs) {
  return trades.filter((t) => {
    const ms = parseIsoMs(t.simulatedAt);
    return ms != null && ms >= startMs;
  });
}

// Module-level refs set in buildPaperQualityMetrics for window helpers
let wave1SymbolsEffective = new Set();
let qualityStrategiesEffective = new Set();

function buildWindowPack(allTrades, primaryTrades, startMs, timeLabel) {
  const primaryInWindow = filterExitTsWindow(primaryTrades, startMs);
  const wave1InWindow = filterExitTsWindow(
    filterWave1(allTrades, wave1SymbolsEffective, qualityStrategiesEffective),
    startMs
  );
  const nonWInWindow = filterExitTsWindow(
    filterNonWave1AllowedStrategies(allTrades, wave1SymbolsEffective, qualityStrategiesEffective),
    startMs
  );

  return {
    timeLabel,
    exitTsFromMsInclusive: new Date(startMs).toISOString(),
    primaryScope: attachSoftAndBreakdowns(primaryInWindow),
    wave1Only: attachSoftAndBreakdowns(wave1InWindow),
    nonWave1_sameStrategies: attachSoftAndBreakdowns(nonWInWindow),
  };
}

function buildRollingSimulatedAtPack(allTrades, primaryTrades, startMs, timeLabel) {
  const primaryInWindow = filterSimulatedAtWindow(primaryTrades, startMs);
  const wave1InWindow = filterSimulatedAtWindow(
    filterWave1(allTrades, wave1SymbolsEffective, qualityStrategiesEffective),
    startMs
  );
  const nonWInWindow = filterSimulatedAtWindow(
    filterNonWave1AllowedStrategies(allTrades, wave1SymbolsEffective, qualityStrategiesEffective),
    startMs
  );

  return {
    timeLabel,
    simulatedAtFromMsInclusive: new Date(startMs).toISOString(),
    primaryScope: attachSoftAndBreakdowns(primaryInWindow),
    wave1Only: attachSoftAndBreakdowns(wave1InWindow),
    nonWave1_sameStrategies: attachSoftAndBreakdowns(nonWInWindow),
    tradesMissingSimulatedAt: {
      primaryScopeAllHistory: primaryTrades.filter((t) => parseIsoMs(t.simulatedAt) == null).length,
    },
  };
}

function buildSincePatchPack(allTrades, primaryTrades, sinceMs) {
  const primarySp = filterSimulatedAtWindow(primaryTrades, sinceMs);
  const wave1Sp = filterSimulatedAtWindow(
    filterWave1(allTrades, wave1SymbolsEffective, qualityStrategiesEffective),
    sinceMs
  );
  const nonWSp = filterSimulatedAtWindow(
    filterNonWave1AllowedStrategies(allTrades, wave1SymbolsEffective, qualityStrategiesEffective),
    sinceMs
  );

  return {
    timeLabel: 'since_patch_simulatedAt',
    simulatedAtFromMsInclusive: new Date(sinceMs).toISOString(),
    primaryScope: attachSoftAndBreakdowns(primarySp),
    wave1Only: attachSoftAndBreakdowns(wave1Sp),
    nonWave1_sameStrategies: attachSoftAndBreakdowns(nonWSp),
    tradesExcludedMissingSimulatedAt: {
      primaryScope: primaryTrades.filter((t) => parseIsoMs(t.simulatedAt) == null).length,
    },
  };
}

function sortEntriesByTotalPnl(bySymbolObj, order) {
  const arr = Object.entries(bySymbolObj || {})
    .map(([k, v]) => ({ key: k, totalPnl: v.totalPnl, trades: v.trades }))
    .filter((x) => x.trades > 0);
  arr.sort((a, b) => (order === 'desc' ? b.totalPnl - a.totalPnl : a.totalPnl - b.totalPnl));
  return arr;
}

function sortStrategyEntries(byStrategyObj, order) {
  const arr = Object.entries(byStrategyObj || {})
    .map(([k, v]) => ({ strategyId: k, totalPnl: v.totalPnl, trades: v.trades }))
    .filter((x) => x.trades > 0);
  arr.sort((a, b) => (order === 'desc' ? b.totalPnl - a.totalPnl : a.totalPnl - b.totalPnl));
  return arr;
}

function parsePositiveIntEnv(name, defaultVal) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.floor(n);
}

/** Expectancy < 0 and finite profit factor < 1 (includes PF 0 = all losses). */
function isNegativeQualityMetrics(m) {
  if (!m || m.trades === 0) return false;
  const ex = m.expectancy;
  const pf = m.profitFactor;
  if (ex == null || ex >= 0) return false;
  if (pf == null || !Number.isFinite(pf)) return false;
  return pf < 1;
}

function groupTradesByStrategySymbol(trades) {
  const map = new Map();
  for (const t of trades) {
    const sid = t.strategyId != null ? String(t.strategyId).trim() : '';
    const sym = t.symbol != null ? String(t.symbol).trim().toUpperCase() : '';
    if (!sid || !sym) continue;
    const k = `${sid}|${sym}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return map;
}

/**
 * Soft audit artifact only — no execution side effects.
 * @param {object} p
 * @param {object[]} p.wave1RollingSimTrades
 * @param {object} p.aggWave1RollingSim — attachSoftAndBreakdowns wave1Only blob
 * @param {Set<string>} p.wave1Symbols
 * @param {string} p.generatedAt
 * @param {string} p.governanceMetricsPath
 * @param {number} p.rollingDays
 */
function buildPaperQualityActions(p) {
  const suggestMinRaw = parsePositiveIntEnv('NEUROPILOT_PAPER_QUALITY_SUGGEST_MIN_TRADES', 4);
  const hardMin = parsePositiveIntEnv('NEUROPILOT_PAPER_QUALITY_DEPRIORITIZE_MIN_TRADES', 10);
  const suggestMin = Math.min(suggestMinRaw, Math.max(1, hardMin - 1));

  const deprioritizeStrategies = parseCsvStrategy(
    process.env.NEUROPILOT_PAPER_QUALITY_DEPRIORITIZE_STRATEGIES,
    'EMA_pullback_v2'
  );

  const agg = p.aggWave1RollingSim;
  const aggTrades = agg && Number.isFinite(agg.trades) ? agg.trades : 0;
  const aggBad = isNegativeQualityMetrics(agg);

  const suggestions = [];
  const deprioritizeCandidates = [];
  const blockedActions = [];

  const byPair = groupTradesByStrategySymbol(p.wave1RollingSimTrades || []);

  const wave1List = Array.from(p.wave1Symbols || []).map((s) => String(s).toUpperCase()).sort();

  for (const strategyId of deprioritizeStrategies) {
    for (const symbol of wave1List) {
      const pairTrades = byPair.get(`${strategyId}|${symbol}`) || [];
      if (pairTrades.length === 0) continue;
      const pairCore = computeCoreMetrics(pairTrades);
      if (!isNegativeQualityMetrics(pairCore)) continue;

      const baseReasons = ['expectancy_negative', 'profit_factor_below_1'];

      if (aggTrades >= suggestMin && aggTrades < hardMin && aggBad) {
        suggestions.push({
          kind: 'suggest_deprioritize',
          strategyId,
          symbol,
          status: 'suggestion_only',
          reasons: [...baseReasons, 'sample_below_hard_threshold'],
          pairTrades: pairCore.trades,
          aggregateWave1Trades: aggTrades,
          pairExpectancy: pairCore.expectancy,
          pairProfitFactor: pairCore.profitFactor,
          executionImpact: 'none',
        });
      }

      if (aggTrades >= hardMin && aggBad) {
        deprioritizeCandidates.push({
          kind: 'deprioritize_soft',
          strategyId,
          symbol,
          deprioritize: true,
          pairTrades: pairCore.trades,
          aggregateWave1Trades: aggTrades,
          pairExpectancy: pairCore.expectancy,
          pairProfitFactor: pairCore.profitFactor,
          executionImpact: 'none',
          note: 'audit_only_no_auto_execution_consumer',
        });
      }
    }
  }

  if (suggestions.length > 0) {
    blockedActions.push({
      what: 'hard_deprioritize',
      outcome: 'blocked',
      blockedBecause: 'aggregate_trades_below_hard_threshold',
      aggregateWave1Trades: aggTrades,
      hardThreshold: hardMin,
      note: 'suggestions_emitted_instead',
    });
  }

  if (deprioritizeCandidates.length > 0) {
    blockedActions.push({
      what: 'execution_side_effect',
      outcome: 'not_applied',
      reason: 'no_automatic_execution_hook_by_design',
      deprioritizeCandidateCount: deprioritizeCandidates.length,
    });
  }

  return {
    paperQualityActionsSchemaVersion: PAPER_QUALITY_ACTIONS_SCHEMA_VERSION,
    generatedAt: p.generatedAt,
    sourceGovernanceMetrics: p.governanceMetricsPath,
    window: {
      id: 'rolling_simulatedAt.wave1Only',
      rollingDays: p.rollingDays,
    },
    thresholds: {
      suggestMinAggregateTrades: suggestMin,
      hardDeprioritizeMinAggregateTrades: hardMin,
      deprioritizeStrategies: Array.from(deprioritizeStrategies).sort(),
      wave1Symbols: wave1List,
    },
    aggregateWave1RollingSimulatedAt: {
      trades: aggTrades,
      expectancy: agg != null ? agg.expectancy : null,
      profitFactor: agg != null ? agg.profitFactor : null,
      qualifiesNegativeQuality: aggBad,
    },
    suggestions,
    deprioritizeCandidates,
    blockedActions,
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.jsonlPath]
 * @param {string} [opts.dataRootPath]
 * @param {number} [opts.rollingDays]
 * @param {string|null} [opts.sincePatchIso]
 * @param {boolean} [opts.writeOpsSummary]
 * @returns {object}
 */
function buildPaperQualityMetrics(opts = {}) {
  const root = opts.dataRootPath || dataRoot.getDataRoot();
  const jsonlPath =
    opts.jsonlPath || path.join(root, 'governance', 'paper_trades.jsonl');
  const rollingDays =
    opts.rollingDays != null && Number.isFinite(Number(opts.rollingDays))
      ? Math.max(1, Math.floor(Number(opts.rollingDays)))
      : Math.max(1, Math.floor(Number(process.env.NEUROPILOT_PAPER_QUALITY_ROLLING_DAYS || 7)) || 7);

  const qualitySymbols = parseCsvUpper(
    process.env.NEUROPILOT_PAPER_QUALITY_SYMBOLS,
    'ADAUSDT,XRPUSDT'
  );
  const qualityStrategies = parseCsvStrategy(
    process.env.NEUROPILOT_PAPER_QUALITY_STRATEGIES,
    'ORB_breakout_v1,EMA_pullback_v2'
  );

  const wave1FromEnv = riskEngine.parseWave1SymbolSet();
  const wave1Symbols =
    wave1FromEnv.size > 0
      ? wave1FromEnv
      : parseCsvUpper(null, 'ADAUSDT,XRPUSDT');

  wave1SymbolsEffective = wave1Symbols;
  qualityStrategiesEffective = qualityStrategies;

  let sincePatchIso = opts.sincePatchIso != null ? String(opts.sincePatchIso).trim() : '';
  if (!sincePatchIso && process.env.NEUROPILOT_PAPER_QUALITY_SINCE_PATCH_AT) {
    sincePatchIso = String(process.env.NEUROPILOT_PAPER_QUALITY_SINCE_PATCH_AT).trim();
  }
  const sincePatchMs = sincePatchIso ? parseIsoMs(sincePatchIso) : null;

  const generatedAt = new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  const rollingStartMs = nowMs - rollingDays * 86400000;

  let content = '';
  let sourceExists = false;
  if (fs.existsSync(jsonlPath)) {
    sourceExists = true;
    content = fs.readFileSync(jsonlPath, 'utf8');
  }

  const { trades, parseErrors, lineCount } = parsePaperTradesJsonlContent(content);
  const primaryAll = filterPrimary(trades, qualitySymbols, qualityStrategies);

  const wave1RollingSimTrades = filterSimulatedAtWindow(
    filterWave1(trades, wave1Symbols, qualityStrategies),
    rollingStartMs
  );

  const windows = {
    rolling_exitTs: buildWindowPack(trades, primaryAll, rollingStartMs, `rolling_${rollingDays}d_exitTs`),
    rolling_simulatedAt: buildRollingSimulatedAtPack(
      trades,
      primaryAll,
      rollingStartMs,
      `rolling_${rollingDays}d_simulatedAt`
    ),
    allTime_exitTs: {
      timeLabel: 'all_time_exitTs',
      primaryScope: attachSoftAndBreakdowns(primaryAll),
      wave1Only: attachSoftAndBreakdowns(
        filterWave1(trades, wave1Symbols, qualityStrategies)
      ),
      nonWave1_sameStrategies: attachSoftAndBreakdowns(
        filterNonWave1AllowedStrategies(trades, wave1Symbols, qualityStrategies)
      ),
    },
  };

  if (sincePatchMs != null) {
    windows.since_patch_simulatedAt = buildSincePatchPack(trades, primaryAll, sincePatchMs);
  } else {
    windows.since_patch_simulatedAt = {
      configured: false,
      note: 'Set NEUROPILOT_PAPER_QUALITY_SINCE_PATCH_AT or --since-patch ISO to enable simulatedAt window',
    };
  }

  const full = {
    paperQualityMetricsSchemaVersion: SCHEMA_VERSION,
    generatedAt,
    sourceJsonl: jsonlPath,
    sourceExists,
    lineCount,
    parseErrors,
    filters: {
      qualitySymbols: Array.from(qualitySymbols).sort(),
      qualityStrategies: Array.from(qualityStrategies).sort(),
      wave1Symbols: Array.from(wave1Symbols).sort(),
      rollingDaysExitTs: rollingDays,
      rollingDaysSimulatedAt: rollingDays,
      sincePatchSimulatedAt: sincePatchMs != null ? new Date(sincePatchMs).toISOString() : null,
    },
    windows,
  };

  const govOut = path.join(root, 'governance', 'paper_quality_metrics.json');
  fs.mkdirSync(path.dirname(govOut), { recursive: true });
  fs.writeFileSync(govOut, JSON.stringify(full, null, 2), 'utf8');

  const actionsOut = path.join(root, 'governance', 'paper_quality_actions.json');
  if (opts.writePaperQualityActions !== false) {
    const actionsBlob = buildPaperQualityActions({
      wave1RollingSimTrades,
      aggWave1RollingSim: windows.rolling_simulatedAt.wave1Only,
      wave1Symbols,
      generatedAt,
      governanceMetricsPath: govOut,
      rollingDays,
    });
    fs.writeFileSync(actionsOut, JSON.stringify(actionsBlob, null, 2), 'utf8');
    full._paperQualityActions = actionsBlob;
  }

  const writeOps = opts.writeOpsSummary !== false;
  if (writeOps) {
    const roll = windows.rolling_exitTs;
    const rollSim = windows.rolling_simulatedAt;
    const summary = {
      paperQualitySummarySchemaVersion: SCHEMA_VERSION,
      generatedAt,
      sourceJsonl: jsonlPath,
      rollingDaysExitTs: rollingDays,
      rollingDaysSimulatedAt: rollingDays,
      softStatusPrimaryRolling: roll.primaryScope.softStatus,
      softStatusWave1Rolling: roll.wave1Only.softStatus,
      wave1QualityRolling: {
        trades: roll.wave1Only.trades,
        winRate: roll.wave1Only.winRate,
        totalPnl: roll.wave1Only.totalPnl,
        profitFactor: roll.wave1Only.profitFactor,
        expectancy: roll.wave1Only.expectancy,
      },
      softStatusPrimaryRollingSimulated: rollSim.primaryScope.softStatus,
      softStatusWave1RollingSimulated: rollSim.wave1Only.softStatus,
      wave1QualityRollingSimulated: {
        trades: rollSim.wave1Only.trades,
        winRate: rollSim.wave1Only.winRate,
        totalPnl: rollSim.wave1Only.totalPnl,
        profitFactor: rollSim.wave1Only.profitFactor,
        expectancy: rollSim.wave1Only.expectancy,
      },
      bestSymbolsByPnl: sortEntriesByTotalPnl(roll.primaryScope.bySymbol, 'desc').slice(0, 8),
      worstSymbolsByPnl: sortEntriesByTotalPnl(roll.primaryScope.bySymbol, 'asc').slice(0, 8),
      bestStrategiesByPnl: sortStrategyEntries(roll.primaryScope.byStrategy, 'desc').slice(0, 8),
      worstStrategiesByPnl: sortStrategyEntries(roll.primaryScope.byStrategy, 'asc').slice(0, 8),
    };

    if (sincePatchMs != null && windows.since_patch_simulatedAt.primaryScope) {
      const sp = windows.since_patch_simulatedAt;
      summary.sincePatchSimulatedAt = sp.simulatedAtFromMsInclusive;
      summary.softStatusPrimarySincePatch = sp.primaryScope.softStatus;
      summary.wave1QualitySincePatch = {
        trades: sp.wave1Only.trades,
        winRate: sp.wave1Only.winRate,
        totalPnl: sp.wave1Only.totalPnl,
        profitFactor: sp.wave1Only.profitFactor,
        expectancy: sp.wave1Only.expectancy,
      };
    }

    const snapDir = resolveOpsSnapshotDir();
    const snapPath = path.join(snapDir, 'paper_quality_summary.json');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(snapPath, JSON.stringify(summary, null, 2), 'utf8');
    full._outputPaths = {
      governanceMetrics: govOut,
      opsSummary: snapPath,
      ...(opts.writePaperQualityActions !== false ? { paperQualityActions: actionsOut } : {}),
    };
  } else {
    full._outputPaths = {
      governanceMetrics: govOut,
      ...(opts.writePaperQualityActions !== false ? { paperQualityActions: actionsOut } : {}),
    };
  }

  return full;
}

function parseArgs(argv) {
  const out = { file: null, sincePatch: null, rollingDays: null, noOpsSummary: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' && argv[i + 1]) {
      out.file = argv[++i];
    } else if (a === '--since-patch' && argv[i + 1]) {
      out.sincePatch = argv[++i];
    } else if (a === '--rolling-days' && argv[i + 1]) {
      out.rollingDays = Number(argv[++i]);
    } else if (a === '--no-ops-summary') {
      out.noOpsSummary = true;
    }
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  const payload = buildPaperQualityMetrics({
    jsonlPath: args.file || undefined,
    sincePatchIso: args.sincePatch || undefined,
    rollingDays: args.rollingDays != null && Number.isFinite(args.rollingDays) ? args.rollingDays : undefined,
    writeOpsSummary: !args.noOpsSummary,
  });
  const paths = payload._outputPaths || {};
  console.log(
    JSON.stringify(
      {
        ok: true,
        wrote: paths,
        rollingPrimaryTrades: payload.windows.rolling_exitTs.primaryScope.trades,
        wave1RollingTrades: payload.windows.rolling_exitTs.wave1Only.trades,
        rollingPrimaryTradesSimulatedAt: payload.windows.rolling_simulatedAt.primaryScope.trades,
        wave1RollingTradesSimulatedAt: payload.windows.rolling_simulatedAt.wave1Only.trades,
        paperQualityActions: payload._outputPaths && payload._outputPaths.paperQualityActions,
        suggestDeprioritizeCount: payload._paperQualityActions
          ? payload._paperQualityActions.suggestions.length
          : 0,
        deprioritizeCandidatesCount: payload._paperQualityActions
          ? payload._paperQualityActions.deprioritizeCandidates.length
          : 0,
      },
      null,
      2
    )
  );
}

module.exports = {
  buildPaperQualityMetrics,
  buildPaperQualityActions,
  computeCoreMetrics,
  softQualityStatus,
  isNegativeQualityMetrics,
  SCHEMA_VERSION,
  PAPER_QUALITY_ACTIONS_SCHEMA_VERSION,
};
