#!/usr/bin/env node
'use strict';

/**
 * Append deterministic synthetic Paper Execution V1 lines to governance/paper_trades.jsonl.
 * For operator dashboard / learning UX when live paper feed is stale — NOT real execution.
 *
 * Schema matches paperExecutionV1Simulator output (parsePaperTradesJsonl.js).
 *
 * Usage (from neuropilot_trading_v2):
 *   node engine/governance/injectSyntheticPaperTradesV1.js
 *   node engine/governance/injectSyntheticPaperTradesV1.js 96
 *   NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI node engine/governance/injectSyntheticPaperTradesV1.js 80
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

const PAPER_EXECUTION_SCHEMA_VERSION = '1.0.0';
const INTRABAR_MODEL = 'OHLC_LOW_FIRST';

const DEFAULT_STRATEGIES = [
  'ORB_breakout_v1',
  'EMA_pullback_v2',
  'FVG_scalp_v1',
  'ICT_liquidity_sweep_v1',
  'BOS_mitigation_v2',
];

function usage() {
  console.error(
    'Usage: node injectSyntheticPaperTradesV1.js [count]\n' +
      '       node injectSyntheticPaperTradesV1.js --strip-batch <cycleId>\n' +
      '  count  Number of trades to append (default 80, min 15).\n' +
      '  --strip-batch  Remove JSONL lines where cycleId or experimentId matches (fix bad append).\n' +
      '  Uses NEUROPILOT_DATA_ROOT when set and directory exists; else <repo>/data_workspace.'
  );
  process.exit(1);
}

/**
 * @returns {{ removed: number, kept: number }}
 */
function stripBatchByCycleId(outPath, batchId) {
  if (!fs.existsSync(outPath)) {
    return { removed: 0, kept: 0 };
  }
  const raw = fs.readFileSync(outPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  const keptLines = [];
  let removed = 0;
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      keptLines.push(line);
      continue;
    }
    const c = o && o.cycleId != null ? String(o.cycleId) : '';
    const e = o && o.experimentId != null ? String(o.experimentId) : '';
    if (c === batchId || e === batchId) {
      removed++;
      continue;
    }
    keptLines.push(line);
  }
  const body = keptLines.length ? `${keptLines.join('\n')}\n` : '';
  fs.writeFileSync(outPath, body, 'utf8');
  return { removed, kept: keptLines.length };
}

function msToIso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Deterministic win ~58% + mixed exit reasons (no 100% win rate).
 */
function buildTrade(i, strategies, batchId, baseExitMs) {
  const n = strategies.length;
  const si = i % n;
  const strategyId = strategies[si];
  const long = i % 3 !== 2;
  const entryOffsetMin = 3 + (i % 6);
  const exitMs = baseExitMs + i * 5 * 60 * 1000;
  const entryMs = exitMs - entryOffsetMin * 60 * 1000;

  const entry = Math.round((2650 + (i % 120) * 0.05 + (i % 7) * 0.02) * 1e6) / 1e6;
  const stopDistance = 1.2 + (i % 5) * 0.15;
  const rMultiple = 2;

  const stopPrice = long ? entry - stopDistance : entry + stopDistance;
  const targetPrice = long ? entry + stopDistance * rMultiple : entry - stopDistance * rMultiple;

  // Avoid degenerate mod patterns (e.g. i*17+(i%5)*13 ≡ 0|5 (mod 10) → false 100% win rate).
  const isWin = (i * 11 + si * 7 + 3) % 10 < 6;
  let reason;
  let exit;
  if (isWin) {
    const mode = i % 11;
    if (mode === 0) {
      reason = 'time';
      exit = long ? entry + stopDistance * 0.35 : entry - stopDistance * 0.35;
    } else if (mode === 1) {
      reason = 'max_bars';
      exit = long ? entry + stopDistance * 0.8 : entry - stopDistance * 0.8;
    } else {
      reason = 'target';
      exit = targetPrice;
    }
  } else {
    reason = i % 4 === 0 ? 'stop_intrabar_priority' : 'stop';
    exit = stopPrice;
  }

  const pnlRaw = long ? exit - entry : entry - exit;
  const pnl = Math.round(pnlRaw * 1e8) / 1e8;
  const barsHeld = 1 + ((i * 5) % 12);

  return {
    paperExecutionSchemaVersion: PAPER_EXECUTION_SCHEMA_VERSION,
    intrabarModel: INTRABAR_MODEL,
    cycleId: batchId,
    experimentId: batchId,
    strategyId,
    symbol: i % 2 === 0 ? 'XAUUSD' : 'BTCUSDT',
    timeframe: i % 3 === 0 ? '15m' : '5m',
    direction: long ? 'long' : 'short',
    governorDecision: null,
    policyRef: null,
    ts: msToIso(exitMs),
    entryTs: msToIso(entryMs),
    exitTs: msToIso(exitMs),
    entry,
    exit: Math.round(exit * 1e8) / 1e8,
    stopPrice: Math.round(stopPrice * 1e8) / 1e8,
    targetPrice: Math.round(targetPrice * 1e8) / 1e8,
    rMultiple,
    reason,
    pnl,
    barsHeld,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) usage();

  const govDir = dataRoot.getPath('governance', true);
  const outPath = path.join(govDir, 'paper_trades.jsonl');

  const stripIdx = argv.indexOf('--strip-batch');
  if (stripIdx !== -1) {
    const batchId = argv[stripIdx + 1];
    if (!batchId || batchId.startsWith('-')) usage();
    const { removed, kept } = stripBatchByCycleId(outPath, batchId);
    console.log(
      `[injectSyntheticPaperTradesV1] --strip-batch "${batchId}": removed ${removed} line(s), ${kept} kept → ${outPath}`
    );
    return;
  }

  let count = 80;
  if (argv[0] != null && argv[0] !== '' && !argv[0].startsWith('-')) {
    const n = parseInt(argv[0], 10);
    if (!Number.isFinite(n) || n < 15) usage();
    count = Math.min(500, n);
  }

  const batchId =
    process.env.NEUROPILOT_SYNTHETIC_BATCH_ID || 'synthetic_dashboard_refresh_20260323_v2';

  const baseExitMs = Date.parse('2026-03-23T08:30:00.000Z');
  if (!Number.isFinite(baseExitMs)) {
    console.error('injectSyntheticPaperTradesV1: invalid base date');
    process.exit(1);
  }

  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify(buildTrade(i, DEFAULT_STRATEGIES, batchId, baseExitMs)));
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, lines.join('\n') + '\n', 'utf8');

  console.log(
    `[injectSyntheticPaperTradesV1] appended ${count} trade(s) → ${outPath}\n` +
      `  batch: ${batchId}\n` +
      `  strategies: ${DEFAULT_STRATEGIES.join(', ')}\n` +
      `  Next: node engine/evolution/scripts/exportOpsSnapshot.js`
  );
}

main();
