#!/usr/bin/env node
'use strict';

/**
 * Wave 1 impact report
 *
 * Compare "before" vs "after" windows on paper_trades.jsonl.
 *
 * Usage examples:
 *   node engine/scripts/reportWave1Impact.js --split-at 2026-03-24T00:00:00Z
 *   node engine/scripts/reportWave1Impact.js --before-hours 24 --after-hours 24 --split-at 2026-03-24T00:00:00Z
 *   node engine/scripts/reportWave1Impact.js --file /Volumes/TradingDrive/NeuroPilotAI/governance/paper_trades.jsonl --split-at 2026-03-24T00:00:00Z --json
 *
 * Defaults:
 *   file        = $NEUROPILOT_DATA_ROOT/governance/paper_trades.jsonl
 *   beforeHours = 24
 *   afterHours  = 24
 *   newSymbols  = EURUSD,GBPUSD,USDJPY,ADAUSDT,XRPUSDT
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_NEW_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'ADAUSDT', 'XRPUSDT'];

function getDefaultDataRoot() {
  return process.env.NEUROPILOT_DATA_ROOT || path.resolve(process.cwd(), 'data_workspace');
}

function getDefaultFile() {
  return path.join(getDefaultDataRoot(), 'governance', 'paper_trades.jsonl');
}

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function round(x, d = 4) {
  if (!Number.isFinite(x)) return null;
  const p = 10 ** d;
  return Math.round(x * p) / p;
}

function parseArgs(argv) {
  const out = {
    file: getDefaultFile(),
    splitAt: null,
    beforeHours: 24,
    afterHours: 24,
    json: false,
    newSymbols: DEFAULT_NEW_SYMBOLS.slice(),
    includeNonProduction: false,
    includeInvalid: false,
    sevenDay: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' && argv[i + 1]) {
      out.file = path.resolve(String(argv[++i]));
    } else if (a === '--split-at' && argv[i + 1]) {
      out.splitAt = String(argv[++i]);
    } else if (a === '--before-hours' && argv[i + 1]) {
      out.beforeHours = Math.max(1, Number(argv[++i]) || 24);
    } else if (a === '--after-hours' && argv[i + 1]) {
      out.afterHours = Math.max(1, Number(argv[++i]) || 24);
    } else if (a === '--before-days' && argv[i + 1]) {
      out.beforeHours = Math.max(1, Number(argv[++i]) || 1) * 24;
    } else if (a === '--after-days' && argv[i + 1]) {
      out.afterHours = Math.max(1, Number(argv[++i]) || 1) * 24;
    } else if (a === '--new-symbols' && argv[i + 1]) {
      out.newSymbols = String(argv[++i])
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--include-non-production') {
      out.includeNonProduction = true;
    } else if (a === '--include-invalid') {
      out.includeInvalid = true;
    } else if (a === '--seven-day') {
      out.sevenDay = true;
    }
  }

  if (out.sevenDay) {
    out.beforeHours = 24 * 7;
    out.afterHours = 24 * 7;
  }

  if (!out.splitAt) {
    throw new Error('--split-at is required, e.g. --split-at 2026-03-24T00:00:00Z');
  }

  const splitMs = Date.parse(out.splitAt);
  if (!Number.isFinite(splitMs)) {
    throw new Error(`invalid --split-at value: ${out.splitAt}`);
  }

  out.splitMs = splitMs;
  out.beforeStartMs = splitMs - out.beforeHours * 60 * 60 * 1000;
  out.afterEndMs = splitMs + out.afterHours * 60 * 60 * 1000;

  return out;
}

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read file: ${file} (${err.code || err.message})`);
  }

  const rows = [];
  let invalidLines = 0;

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch (_) {
      invalidLines += 1;
    }
  }

  return { rows, invalidLines };
}

function extractTs(row) {
  const raw = row && (row.exitTs || row.ts || row.closedAt || row.createdAt);
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function extractSymbol(row) {
  const raw =
    row.symbol ||
    row.asset ||
    row.market ||
    row.instrument ||
    row.ticker ||
    (row.meta && row.meta.symbol) ||
    '';
  return String(raw).trim().toUpperCase();
}

function extractPnl(row) {
  return safeNumber(row.pnl) ?? safeNumber(row.netPnl) ?? safeNumber(row.realizedPnl) ?? 0;
}

function inferProductionValidity(row) {
  const excludedNonProduction =
    row.nonProduction === true ||
    row.isNonProduction === true ||
    row.excludedNonProduction === true ||
    row.excludeReason === 'non_production' ||
    row.production === false;

  const excludedInvalid =
    row.strictInvalid === true ||
    row.invalid === true ||
    row.excludedStrict === true ||
    row.excludeReason === 'strict_validation';

  return { excludedNonProduction, excludedInvalid };
}

function filterRows(rows, opts) {
  const out = [];
  for (const r of rows) {
    const ts = extractTs(r);
    if (ts == null) continue;

    const validity = inferProductionValidity(r);
    if (!opts.includeNonProduction && validity.excludedNonProduction) continue;
    if (!opts.includeInvalid && validity.excludedInvalid) continue;

    out.push({ row: r, ts });
  }
  return out;
}

function sliceWindow(rowsWithTs, fromMs, toMsExclusive) {
  return rowsWithTs.filter((x) => x.ts >= fromMs && x.ts < toMsExclusive).map((x) => x.row);
}

function computeStats(rows, newSymbolsSet) {
  const trades = rows.length;
  let wins = 0;
  let losses = 0;
  let flat = 0;
  let totalPnl = 0;

  const bySymbol = {};

  for (const r of rows) {
    const pnl = extractPnl(r);
    const symbol = extractSymbol(r) || 'UNKNOWN';

    totalPnl += pnl;
    if (pnl > 0) wins += 1;
    else if (pnl < 0) losses += 1;
    else flat += 1;

    if (!bySymbol[symbol]) {
      bySymbol[symbol] = { trades: 0, wins: 0, losses: 0, flat: 0, pnl: 0 };
    }
    bySymbol[symbol].trades += 1;
    bySymbol[symbol].pnl += pnl;
    if (pnl > 0) bySymbol[symbol].wins += 1;
    else if (pnl < 0) bySymbol[symbol].losses += 1;
    else bySymbol[symbol].flat += 1;
  }

  const symbolRows = Object.entries(bySymbol)
    .map(([symbol, s]) => ({
      symbol,
      trades: s.trades,
      wins: s.wins,
      losses: s.losses,
      flat: s.flat,
      winRate: s.trades ? round((s.wins / s.trades) * 100, 2) : null,
      totalPnl: round(s.pnl, 6),
      avgPnl: s.trades ? round(s.pnl / s.trades, 6) : null,
      isWave1Symbol: newSymbolsSet.has(symbol),
    }))
    .sort((a, b) => b.trades - a.trades || b.totalPnl - a.totalPnl);

  const wave1Only = symbolRows.filter((x) => x.isWave1Symbol);
  const wave1Trades = wave1Only.reduce((a, b) => a + b.trades, 0);
  const wave1Pnl = wave1Only.reduce((a, b) => a + (b.totalPnl || 0), 0);

  return {
    trades,
    wins,
    losses,
    flat,
    winRate: trades ? round((wins / trades) * 100, 2) : null,
    totalPnl: round(totalPnl, 6),
    avgPnlPerTrade: trades ? round(totalPnl / trades, 6) : null,
    wave1Trades,
    wave1TradeSharePct: trades ? round((wave1Trades / trades) * 100, 2) : null,
    wave1Pnl: round(wave1Pnl, 6),
    bySymbol: symbolRows,
    wave1Symbols: wave1Only,
  };
}

function detectStrategyField(rows) {
  const candidates = ['strategyId', 'strategy', 'setupId'];
  for (const key of candidates) {
    for (const r of rows) {
      const v = r && r[key];
      if (typeof v === 'string' && v.trim()) return key;
    }
  }
  return null;
}

function computeByStrategy(rows, strategyField) {
  if (!strategyField) return [];
  const agg = {};
  for (const r of rows) {
    const id = String((r && r[strategyField]) || '').trim();
    if (!id) continue;
    const pnl = extractPnl(r);
    if (!agg[id]) agg[id] = { trades: 0, wins: 0, losses: 0, flat: 0, pnl: 0 };
    agg[id].trades += 1;
    agg[id].pnl += pnl;
    if (pnl > 0) agg[id].wins += 1;
    else if (pnl < 0) agg[id].losses += 1;
    else agg[id].flat += 1;
  }

  return Object.entries(agg)
    .map(([strategy, s]) => ({
      strategy,
      trades: s.trades,
      wins: s.wins,
      losses: s.losses,
      flat: s.flat,
      winRate: s.trades ? round((s.wins / s.trades) * 100, 2) : null,
      totalPnl: round(s.pnl, 6),
      avgPnl: s.trades ? round(s.pnl / s.trades, 6) : null,
    }))
    .sort((a, b) => b.trades - a.trades || b.totalPnl - a.totalPnl)
    .slice(0, 10);
}

function delta(before, after, key) {
  const a = safeNumber(before[key]);
  const b = safeNumber(after[key]);
  if (a == null || b == null) return null;
  return round(b - a, 6);
}

function buildReport(opts, parsed) {
  const filtered = filterRows(parsed.rows, opts);

  const beforeRows = sliceWindow(filtered, opts.beforeStartMs, opts.splitMs);
  const afterRows = sliceWindow(filtered, opts.splitMs, opts.afterEndMs);
  const newSymbolsSet = new Set(opts.newSymbols);
  const strategyField = detectStrategyField(parsed.rows);
  const strategyBreakdownAvailable = Boolean(strategyField);

  const before = computeStats(beforeRows, newSymbolsSet);
  const after = computeStats(afterRows, newSymbolsSet);
  if (strategyBreakdownAvailable) {
    after.byStrategy = computeByStrategy(afterRows, strategyField);
  }
  const verdict = computeVerdict(before, after);

  return {
    generatedAt: new Date().toISOString(),
    file: opts.file,
    splitAt: opts.splitAt,
    beforeWindow: {
      from: new Date(opts.beforeStartMs).toISOString(),
      toExclusive: new Date(opts.splitMs).toISOString(),
      hours: opts.beforeHours,
    },
    afterWindow: {
      from: new Date(opts.splitMs).toISOString(),
      toExclusive: new Date(opts.afterEndMs).toISOString(),
      hours: opts.afterHours,
    },
    filters: {
      includeNonProduction: opts.includeNonProduction,
      includeInvalid: opts.includeInvalid,
      newSymbols: opts.newSymbols,
    },
    source: {
      parsedRows: parsed.rows.length,
      invalidJsonLines: parsed.invalidLines,
      usableRows: filtered.length,
    },
    strategyBreakdownAvailable,
    strategyBreakdownField: strategyField || null,
    before,
    after,
    verdict,
    delta: {
      trades: delta(before, after, 'trades'),
      winRate: delta(before, after, 'winRate'),
      totalPnl: delta(before, after, 'totalPnl'),
      avgPnlPerTrade: delta(before, after, 'avgPnlPerTrade'),
      wave1Trades: delta(before, after, 'wave1Trades'),
      wave1TradeSharePct: delta(before, after, 'wave1TradeSharePct'),
      wave1Pnl: delta(before, after, 'wave1Pnl'),
    },
  };
}

function computeVerdict(before, after) {
  const reasons = [];
  const beforeTotalPnl = safeNumber(before.totalPnl) ?? 0;
  const afterTotalPnl = safeNumber(after.totalPnl) ?? 0;
  const deltaTrades = (safeNumber(after.trades) ?? 0) - (safeNumber(before.trades) ?? 0);
  const deltaTotalPnl = afterTotalPnl - beforeTotalPnl;
  const afterWave1Trades = safeNumber(after.wave1Trades) ?? 0;
  const afterWave1Share = safeNumber(after.wave1TradeSharePct);
  const beforeAvg = safeNumber(before.avgPnlPerTrade);
  const afterAvg = safeNumber(after.avgPnlPerTrade);
  let avgDropPct = null;
  if (Number.isFinite(beforeAvg) && Number.isFinite(afterAvg) && beforeAvg !== 0) {
    avgDropPct = ((beforeAvg - afterAvg) / Math.abs(beforeAvg)) * 100;
  }

  if (deltaTrades > 0) reasons.push('trades increased after Wave 1');
  else reasons.push('trades did not increase after Wave 1');

  if (afterWave1Trades > 0) {
    reasons.push(
      `wave1 symbols contributed ${round(afterWave1Share, 2) == null ? 'n/a' : round(afterWave1Share, 2) + '%'} of trades`
    );
  } else {
    reasons.push('no trades observed on Wave 1 symbols');
  }

  if (afterTotalPnl >= 0) reasons.push('after window totalPnl is non-negative');
  else reasons.push('after window totalPnl is negative');

  if (Number.isFinite(avgDropPct) && avgDropPct > 35) {
    reasons.push('avgPnlPerTrade dropped more than 35%');
  } else if (Number.isFinite(avgDropPct) && avgDropPct > 20) {
    reasons.push('avgPnlPerTrade dropped more than 20%');
  } else {
    reasons.push('avgPnlPerTrade degradation is within tolerance');
  }

  if (Number.isFinite(afterWave1Share) && afterWave1Share < 5) {
    reasons.push('wave1 trade share is below 5%');
  }

  if (afterWave1Trades === 0) {
    return {
      status: 'ROLLBACK_CANDIDATE',
      reasons,
      metrics: {
        deltaTrades: round(deltaTrades, 6),
        deltaTotalPnl: round(deltaTotalPnl, 6),
        avgPnlPerTradeDropPct: round(avgDropPct, 2),
      },
    };
  }
  if (deltaTrades <= 0) {
    return {
      status: 'ROLLBACK_CANDIDATE',
      reasons,
      metrics: {
        deltaTrades: round(deltaTrades, 6),
        deltaTotalPnl: round(deltaTotalPnl, 6),
        avgPnlPerTradeDropPct: round(avgDropPct, 2),
      },
    };
  }
  if (afterTotalPnl < 0 && beforeTotalPnl >= 0) {
    reasons.push('after window totalPnl turned negative');
    return {
      status: 'ROLLBACK_CANDIDATE',
      reasons,
      metrics: {
        deltaTrades: round(deltaTrades, 6),
        deltaTotalPnl: round(deltaTotalPnl, 6),
        avgPnlPerTradeDropPct: round(avgDropPct, 2),
      },
    };
  }
  if (Number.isFinite(avgDropPct) && avgDropPct > 35) {
    return {
      status: 'ROLLBACK_CANDIDATE',
      reasons,
      metrics: {
        deltaTrades: round(deltaTrades, 6),
        deltaTotalPnl: round(deltaTotalPnl, 6),
        avgPnlPerTradeDropPct: round(avgDropPct, 2),
      },
    };
  }

  const pass =
    deltaTrades > 0 &&
    afterWave1Trades > 0 &&
    afterTotalPnl >= 0 &&
    (!Number.isFinite(avgDropPct) || avgDropPct <= 20);
  if (pass) {
    return {
      status: 'PASS',
      reasons,
      metrics: {
        deltaTrades: round(deltaTrades, 6),
        deltaTotalPnl: round(deltaTotalPnl, 6),
        avgPnlPerTradeDropPct: round(avgDropPct, 2),
      },
    };
  }

  return {
    status: 'WATCH',
    reasons,
    metrics: {
      deltaTrades: round(deltaTrades, 6),
      deltaTotalPnl: round(deltaTotalPnl, 6),
      avgPnlPerTradeDropPct: round(avgDropPct, 2),
    },
  };
}

function fmtPct(x) {
  return x == null ? 'n/a' : `${x}%`;
}

function fmtNum(x) {
  return x == null ? 'n/a' : String(x);
}

function printHuman(report) {
  console.log('Wave 1 impact report');
  console.log(`file: ${report.file}`);
  console.log(`splitAt: ${report.splitAt}`);
  console.log('');

  console.log(`Before (${report.beforeWindow.hours}h): ${report.beforeWindow.from} -> ${report.beforeWindow.toExclusive}`);
  console.log(`  trades=${fmtNum(report.before.trades)} wins=${fmtNum(report.before.wins)} losses=${fmtNum(report.before.losses)} flat=${fmtNum(report.before.flat)}`);
  console.log(`  winRate=${fmtPct(report.before.winRate)} totalPnl=${fmtNum(report.before.totalPnl)} avgPnl/trade=${fmtNum(report.before.avgPnlPerTrade)}`);
  console.log(`  wave1Trades=${fmtNum(report.before.wave1Trades)} share=${fmtPct(report.before.wave1TradeSharePct)} wave1Pnl=${fmtNum(report.before.wave1Pnl)}`);
  console.log('');

  console.log(`After (${report.afterWindow.hours}h): ${report.afterWindow.from} -> ${report.afterWindow.toExclusive}`);
  console.log(`  trades=${fmtNum(report.after.trades)} wins=${fmtNum(report.after.wins)} losses=${fmtNum(report.after.losses)} flat=${fmtNum(report.after.flat)}`);
  console.log(`  winRate=${fmtPct(report.after.winRate)} totalPnl=${fmtNum(report.after.totalPnl)} avgPnl/trade=${fmtNum(report.after.avgPnlPerTrade)}`);
  console.log(`  wave1Trades=${fmtNum(report.after.wave1Trades)} share=${fmtPct(report.after.wave1TradeSharePct)} wave1Pnl=${fmtNum(report.after.wave1Pnl)}`);
  console.log('');

  console.log('Delta (after - before)');
  console.log(`  trades=${fmtNum(report.delta.trades)}`);
  console.log(`  winRate=${fmtNum(report.delta.winRate)}`);
  console.log(`  totalPnl=${fmtNum(report.delta.totalPnl)}`);
  console.log(`  avgPnl/trade=${fmtNum(report.delta.avgPnlPerTrade)}`);
  console.log(`  wave1Trades=${fmtNum(report.delta.wave1Trades)}`);
  console.log(`  wave1TradeSharePct=${fmtNum(report.delta.wave1TradeSharePct)}`);
  console.log(`  wave1Pnl=${fmtNum(report.delta.wave1Pnl)}`);
  console.log('');

  console.log('Verdict');
  console.log(`  status=${report.verdict.status}`);
  console.log(`  reasons=${(report.verdict.reasons || []).join(',') || 'n/a'}`);
  if (report.verdict.metrics) {
    console.log(`  avgPnlPerTradeDropPct=${fmtNum(report.verdict.metrics.avgPnlPerTradeDropPct)}`);
  }
  console.log('');

  console.log(`Strategy breakdown available: ${report.strategyBreakdownAvailable ? 'true' : 'false'}`);
  if (report.strategyBreakdownAvailable && report.strategyBreakdownField) {
    console.log(`Strategy field: ${report.strategyBreakdownField}`);
  }
  if (report.strategyBreakdownAvailable && report.after.byStrategy && report.after.byStrategy.length) {
    console.log('After window — top strategies');
    for (const row of report.after.byStrategy.slice(0, 10)) {
      console.log(
        `  ${row.strategy} | trades=${row.trades} winRate=${fmtPct(row.winRate)} pnl=${fmtNum(row.totalPnl)} avg=${fmtNum(row.avgPnl)}`
      );
    }
    console.log('');
  }

  console.log('After window — top symbols');
  for (const row of report.after.bySymbol.slice(0, 12)) {
    const tag = row.isWave1Symbol ? ' [W1]' : '';
    console.log(
      `  ${row.symbol}${tag} | trades=${row.trades} winRate=${fmtPct(row.winRate)} pnl=${fmtNum(row.totalPnl)} avg=${fmtNum(row.avgPnl)}`
    );
  }

  if (report.after.wave1Symbols.length) {
    console.log('');
    console.log('After window — Wave 1 symbols only');
    for (const row of report.after.wave1Symbols) {
      console.log(
        `  ${row.symbol} | trades=${row.trades} winRate=${fmtPct(row.winRate)} pnl=${fmtNum(row.totalPnl)} avg=${fmtNum(row.avgPnl)}`
      );
    }
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`reportWave1Impact: ${err.message}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = readJsonl(opts.file);
  } catch (err) {
    console.error(`reportWave1Impact: ${err.message}`);
    process.exit(1);
  }

  const report = buildReport(opts, parsed);

  if (!opts.json) {
    printHuman(report);
    console.log('');
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  readJsonl,
  buildReport,
  computeStats,
  computeVerdict,
};
