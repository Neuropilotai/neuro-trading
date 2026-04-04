#!/usr/bin/env node
'use strict';

/**
 * Example: run trade simulation on real research output.
 *
 * Prerequisite: run research with debug export so research/allowed_signals_debug.json exists:
 *   node engine/exampleRunResearchFromConfig.js us_indices_core
 *
 * Usage (from repo root or neuropilot_trading_v2):
 *   node engine/exampleTradeSimulationFromResearch.js <symbol> <timeframe>
 *
 * Examples:
 *   node engine/exampleTradeSimulationFromResearch.js QQQ 5m
 *   node engine/exampleTradeSimulationFromResearch.js SPY 5m
 *   node engine/exampleTradeSimulationFromResearch.js SPY 5m audit        # write research/trade_audit_SPY_5m.json (2R)
 *   node engine/exampleTradeSimulationFromResearch.js SPY 5m audit 1.5   # write research/trade_audit_SPY_5m_R1.5.json
 *
 * Loads data/<symbol>_<timeframe>.csv, loads allowed_signals_debug.json,
 * filters by symbol/timeframe, runs trade simulation, prints summary.
 * Prints by-period (by month) breakdown for stability. Optional 4th arg "audit" exports trades for audit.
 */

const path = require('path');
const fs = require('fs');
const datasetLoader = require('./datasetLoader');
const tradeSimulation = require('./tradeSimulation');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEBUG_FILE = path.join(__dirname, '..', 'research', 'allowed_signals_debug.json');

async function main() {
  const symbol = (process.argv[2] || '').trim().toUpperCase();
  const timeframe = (process.argv[3] || '').trim().toLowerCase();
  const auditRequested = (process.argv[4] || '').trim().toLowerCase() === 'audit';
  const rMultipleArg = Number(process.argv[5]);
  const rMultiple = Number.isFinite(rMultipleArg) && rMultipleArg > 0 ? rMultipleArg : 2;

  if (!symbol || !timeframe) {
    console.error('Usage: node engine/exampleTradeSimulationFromResearch.js <symbol> <timeframe> [audit] [rMultiple]');
    console.error('Examples: node engine/exampleTradeSimulationFromResearch.js QQQ 5m');
    console.error('          node engine/exampleTradeSimulationFromResearch.js SPY 5m audit');
    console.error('          node engine/exampleTradeSimulationFromResearch.js SPY 5m audit 1.5');
    process.exit(1);
  }

  const csvPath = path.join(DATA_DIR, `${symbol.toLowerCase()}_${timeframe}.csv`);

  let candles = [];
  try {
    const loadOpts = { synthesizeTimestampsFromIndex: true };
    const data = await datasetLoader.loadFromFile(csvPath, symbol, timeframe, loadOpts);
    candles = data.candles || [];
  } catch (err) {
    console.error('Load candles failed:', err.message);
    console.error('Ensure', csvPath, 'exists (e.g. run from neuropilot_trading_v2).');
    process.exit(1);
  }

  let allSignals = [];
  try {
    const raw = fs.readFileSync(DEBUG_FILE, 'utf8');
    allSignals = JSON.parse(raw);
    if (!Array.isArray(allSignals)) allSignals = [];
  } catch (err) {
    console.error('Load allowed_signals_debug.json failed:', err.message);
    console.error('Run: node neuropilot_trading_v2/engine/exampleRunResearchFromConfig.js us_indices_core');
    process.exit(1);
  }

  const signals = allSignals.filter(
    (s) => s && String(s.symbol) === symbol && String(s.timeframe) === timeframe
  );

  if (signals.length === 0) {
    console.log(`No allowed signals for ${symbol} ${timeframe} in debug file. Run research first.`);
    return;
  }

  const baseOpts = { rMultiple, maxBarsHeld: 50, defaultDirection: 'long' };
  const modes = [
    { label: 'All strategies', opts: { ...baseOpts } },
    { label: 'trend_breakout only', opts: { ...baseOpts, includeStrategies: ['trend_breakout'] } },
    { label: 'mean_reversion only', opts: { ...baseOpts, includeStrategies: ['mean_reversion'] } },
  ];

  console.log('=== Trade Simulation (real research signals) ===');
  console.log('Dataset:', symbol, timeframe, '| Candles:', candles.length, '| Signals (unfiltered):', signals.length, '| R multiple:', rMultiple);
  console.log('');

  for (const { label, opts } of modes) {
    const { trades, summary } = tradeSimulation.run(candles, signals, opts);
    console.log('---', label, '---');
    console.log('  Signals:', trades.length, '(after filter)');
    if (trades.length > 0) {
      trades.forEach((t, i) => {
        console.log(`    ${i + 1}. ${t.direction} @ ${t.entryPrice.toFixed(2)} -> ${t.outcome} R=${t.rMultiple} bars=${t.barsHeld}  [${t.strategy || '—'} / ${t.regime || '—'}]`);
      });
      console.log('  Summary: totalTrades=%d wins=%d losses=%d timeouts=%d winRate=%s%% avgR=%s expectancyR=%s',
        summary.totalTrades, summary.wins, summary.losses, summary.timeouts,
        summary.winRate, summary.avgR, summary.expectancyR);
    } else {
      console.log('  (no signals in this filter)');
    }
    console.log('');
  }

  console.log('--- Comparison (strategy filter) ---');
  for (const { label, opts } of modes) {
    const { trades, summary } = tradeSimulation.run(candles, signals, opts);
    if (summary.totalTrades > 0) {
      console.log(`  ${label}: n=${summary.totalTrades} winRate=${summary.winRate}% expectancyR=${summary.expectancyR}`);
    }
  }

  // Session (time-of-day) breakdown for baseline (trend_breakout, rMultiple)
  const baselineOpts = { ...baseOpts, includeStrategies: ['trend_breakout'] };
  const { trades: baselineTrades, summary: baselineSummary } = tradeSimulation.run(candles, signals, baselineOpts);
  if (baselineSummary.totalTrades > 0) {
    const sessionBreakdown = tradeSimulation.sessionPerformanceBreakdown(baselineTrades);
    console.log('');
    console.log('--- Session (time-of-day) breakdown (trend_breakout, ' + rMultiple + 'R) ---');
    console.log('  open = first 60 min of session, mid = middle, late = last 60 min (US 9:30–16:00 ET → UTC)');
    for (const bucket of tradeSimulation.SESSION_BUCKETS) {
      const s = sessionBreakdown.bySession[bucket];
      if (s.totalTrades > 0) {
        console.log(`  ${bucket}: totalTrades=${s.totalTrades} wins=${s.wins} losses=${s.losses} winRate=${s.winRate}% avgR=${s.avgR} expectancyR=${s.expectancyR}`);
      }
    }
    if (sessionBreakdown.unknown.totalTrades > 0) {
      console.log(`  unknown (no bar time): totalTrades=${sessionBreakdown.unknown.totalTrades} wins=${sessionBreakdown.unknown.wins} losses=${sessionBreakdown.unknown.losses} winRate=${sessionBreakdown.unknown.winRate}% expectancyR=${sessionBreakdown.unknown.expectancyR}`);
    }

    // Regime-level breakdown (baseline reference: expectancyR = -0.12)
    const regimeBreakdown = tradeSimulation.regimePerformanceBreakdown(baselineTrades);
    console.log('');
    console.log('--- Regime breakdown (trend_breakout, ' + rMultiple + 'R) — baseline comparison: expectancyR = -0.12 ---');
    for (const regime of tradeSimulation.REGIME_BUCKETS) {
      const s = regimeBreakdown.byRegime[regime];
      if (s.totalTrades > 0) {
        console.log(`  ${regime}: totalTrades=${s.totalTrades} wins=${s.wins} losses=${s.losses} timeouts=${s.timeouts} winRate=${s.winRate}% avgR=${s.avgR} expectancyR=${s.expectancyR}`);
      }
    }
    if (regimeBreakdown.other.totalTrades > 0) {
      const s = regimeBreakdown.other;
      console.log(`  other: totalTrades=${s.totalTrades} wins=${s.wins} losses=${s.losses} timeouts=${s.timeouts} winRate=${s.winRate}% avgR=${s.avgR} expectancyR=${s.expectancyR}`);
    }

    // By-period breakdown (stability: is expectancy driven by a few months only?)
    const byPeriod = tradeSimulation.performanceBreakdownByPeriod(baselineTrades, { periodFormat: 'month' });
    if (byPeriod.periodOrder.length > 0) {
      console.log('');
      console.log('--- By period (month) — stability check ---');
      for (const key of byPeriod.periodOrder) {
        const s = byPeriod.byPeriod[key];
        if (s.totalTrades > 0) {
          console.log(`  ${key}: totalTrades=${s.totalTrades} wins=${s.wins} losses=${s.losses} winRate=${s.winRate}% expectancyR=${s.expectancyR}`);
        }
      }
    }

    // Optional: export trades for audit (pattern in wins/losses, breakout subtypes)
    if (auditRequested) {
      const auditFileName = rMultiple === 2
        ? `trade_audit_${symbol}_${timeframe}.json`
        : `trade_audit_${symbol}_${timeframe}_R${rMultiple}.json`;
      const auditPath = path.join(__dirname, '..', 'research', auditFileName);
      const auditList = tradeSimulation.formatTradesForAudit(baselineTrades);
      try {
        fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        fs.writeFileSync(auditPath, JSON.stringify(auditList, null, 2), 'utf8');
        console.log('');
        console.log('Audit export:', auditPath);
      } catch (err) {
        console.error('Audit export failed:', err.message);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
