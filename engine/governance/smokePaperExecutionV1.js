#!/usr/bin/env node
'use strict';

/**
 * Smoke: Paper Execution V1 (deterministic simulator + runner wiring).
 * Run: node engine/governance/smokePaperExecutionV1.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  simulatePaperTradeV1,
  intrabarExitLowFirst,
  resolvePaperTradeIdentityFields,
} = require('./paperExecutionV1Simulator');
const { writeBinaryStore } = require('../datasetBinaryStore');
const {
  runPaperExecutionV1,
  envBoolOptIn,
  paperExecBarThrottleKey,
  computeAppendZeroPrimaryReason,
} = require('./runPaperExecutionV1');
const {
  buildRenewalShadowInjectedSignals,
  PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE,
} = require('./buildRenewalShadowSignals');
const { RENEWAL_SHADOW_SIGNAL_SOURCE_VERSION } = require('./renewalShadowConstants');

{
  const d = path.join(__dirname, '..', '..', `.tmp-smoke-pev1-shadow-guard-${Date.now()}`);
  fs.mkdirSync(path.join(d, 'governance'), { recursive: true });
  const g = path.join(d, 'governance');
  const prev = process.env.NEUROPILOT_PAPER_EXEC_V1;
  process.env.NEUROPILOT_PAPER_EXEC_V1 = '1';
  try {
    assert.throws(
      () =>
        runPaperExecutionV1({
          dataRoot: d,
          signalsPath: path.join(g, 'paper_execution_v1_signals.json'),
          outJsonl: path.join(g, 'paper_trades.jsonl'),
          lastRunPath: path.join(g, 'paper_exec_v1_last_run_shadow.json'),
          seenKeysStorePath: path.join(g, 'paper_exec_seen_keys_renewal_shadow.json'),
          shadowRenewalLane: true,
        }),
      /shadowRenewalLane: outJsonl must not be live/
    );
  } finally {
    if (prev === undefined) delete process.env.NEUROPILOT_PAPER_EXEC_V1;
    else process.env.NEUROPILOT_PAPER_EXEC_V1 = prev;
    fs.rmSync(d, { recursive: true, force: true });
  }
}

// --- Identity: legacy strategyId + canonical setupId on JSONL when both supplied ---
{
  const id = resolvePaperTradeIdentityFields({
    strategyId: 'ORB_breakout_v1',
    setupId: 'mut_smoke_canonical_open_abc',
  });
  assert.strictEqual(id.strategyId, 'ORB_breakout_v1');
  assert.strictEqual(id.setupId, 'mut_smoke_canonical_open_abc');
}
{
  const id = resolvePaperTradeIdentityFields({ setupId: 'mut_only_id' });
  assert.strictEqual(id.strategyId, 'mut_only_id');
  assert.strictEqual(id.setupId, undefined);
}
{
  const id = resolvePaperTradeIdentityFields({ strategyId: 'lab_only' });
  assert.strictEqual(id.strategyId, 'lab_only');
  assert.strictEqual(id.setupId, undefined);
}

// --- 1) Target hit (long, next bar) ---
{
  const candles = [
    { time: 1_700_000_000_000, open: 100, high: 100.5, low: 99.5, close: 100 },
    { time: 1_700_000_300_000, open: 100, high: 102.6, low: 100.2, close: 102 },
  ];
  const sig = {
    barIndex: 0,
    entryPrice: 100,
    stopDistance: 1,
    direction: 'long',
    rMultiple: 2,
    strategyId: 'smoke_target',
  };
  const r = simulatePaperTradeV1(candles, sig, { cycleId: 'c1', experimentId: 'e1' });
  assert.strictEqual(r.reason, 'target');
  assert.strictEqual(r.exit, 102);
  assert.strictEqual(r.barsHeld, 1);
  assert.ok(r.pnl > 0);
}

// --- Trade record carries setupId when signal has distinct canonical id ---
{
  const candles = [
    { time: 1_700_000_000_000, open: 100, high: 100.5, low: 99.5, close: 100 },
    { time: 1_700_000_300_000, open: 100, high: 102.6, low: 100.2, close: 102 },
  ];
  const sig = {
    barIndex: 0,
    entryPrice: 100,
    stopDistance: 1,
    direction: 'long',
    rMultiple: 2,
    strategyId: 'legacy_dashboard_label',
    setupId: 'mut_smoke_dual_identity',
  };
  const r = simulatePaperTradeV1(candles, sig, {});
  assert.strictEqual(r.strategyId, 'legacy_dashboard_label');
  assert.strictEqual(r.setupId, 'mut_smoke_dual_identity');
}

// --- 2) Stop hit (long) ---
{
  const candles = [
    { time: 1_700_000_000_000, open: 100, high: 100.5, low: 99.5, close: 100 },
    { time: 1_700_000_300_000, open: 100, high: 100.2, low: 97.5, close: 98 },
  ];
  const sig = {
    barIndex: 0,
    entryPrice: 100,
    stopDistance: 1,
    direction: 'long',
    rMultiple: 2,
    strategyId: 'smoke_stop',
  };
  const r = simulatePaperTradeV1(candles, sig, {});
  assert.strictEqual(r.reason, 'stop');
  assert.strictEqual(r.exit, 99);
  assert.ok(r.pnl < 0);
}

// --- 3) Tie-break: stop_intrabar_priority (long, same bar) ---
{
  const bar = { time: 1_700_000_300_000, open: 100, high: 104, low: 97.5, close: 101 };
  const hit = intrabarExitLowFirst(bar, 'long', 99, 102);
  assert.ok(hit);
  assert.strictEqual(hit.reason, 'stop_intrabar_priority');
  assert.strictEqual(hit.exitPrice, 99);
  const candles = [
    { time: 1_700_000_000_000, open: 100, high: 100.5, low: 99.5, close: 100 },
    bar,
  ];
  const sig = {
    barIndex: 0,
    entryPrice: 100,
    stopDistance: 1,
    direction: 'long',
    rMultiple: 2,
    strategyId: 'smoke_tie',
  };
  const r = simulatePaperTradeV1(candles, sig, {});
  assert.strictEqual(r.reason, 'stop_intrabar_priority');
}

// --- 4) No signals: enabled + empty array → 0 appends, flag off → no-op ---
{
  const dir = path.join(__dirname, '..', '..', `.tmp-smoke-pev1-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const sigPath = path.join(dir, 'signals.json');
  const outPath = path.join(dir, 'paper_trades.jsonl');
  fs.writeFileSync(sigPath, JSON.stringify({ signals: [] }), 'utf8');
  const prev = process.env.NEUROPILOT_PAPER_EXEC_V1;
  process.env.NEUROPILOT_PAPER_EXEC_V1 = '1';
  try {
    const r = runPaperExecutionV1({
      dataRoot: dir,
      signalsPath: sigPath,
      outJsonl: outPath,
    });
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.appended, 0);
    assert.strictEqual(fs.existsSync(outPath), false);
  } finally {
    if (prev === undefined) delete process.env.NEUROPILOT_PAPER_EXEC_V1;
    else process.env.NEUROPILOT_PAPER_EXEC_V1 = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  delete process.env.NEUROPILOT_PAPER_EXEC_V1;
  const r = runPaperExecutionV1({ dataRoot: path.join(__dirname, '..', '..', '.tmp-smoke-pev1-noop') });
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(envBoolOptIn('NEUROPILOT_PAPER_EXEC_V1'), false);
}

{
  const k1 = paperExecBarThrottleKey({
    strategyId: 'a',
    symbol: 'BTC',
    timeframe: '5m',
    barIndex: 3,
  });
  const k2 = paperExecBarThrottleKey({
    setupId: 'a',
    symbol: 'btc',
    timeframe: '5m',
    barIndex: 3,
  });
  assert.strictEqual(k1, k2);
  assert.notStrictEqual(
    k1,
    paperExecBarThrottleKey({
      strategyId: 'a',
      symbol: 'BTC',
      timeframe: '5m',
      barIndex: 4,
    })
  );
}

(async () => {
  const dir = path.join(__dirname, '..', '..', `.tmp-smoke-pev1-throttle-${Date.now()}`);
  fs.mkdirSync(path.join(dir, 'datasets', 'smk'), { recursive: true });
  const binPath = path.join(dir, 'datasets', 'smk', 'smk_5m.bin');
  await writeBinaryStore(binPath, {
    symbol: 'SMK',
    timeframe: '5m',
    candles: [
      { time: Date.parse('2026-01-01T00:00:00.000Z'), open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: Date.parse('2026-01-01T00:05:00.000Z'), open: 100, high: 103, low: 99.5, close: 102, volume: 1 },
    ],
  });
  fs.writeFileSync(
    path.join(dir, 'datasets_manifest.json'),
    JSON.stringify({
      datasets: {
        SMK_5m: { symbol: 'SMK', timeframe: '5m', rows: 2, paths: { bin: binPath } },
      },
    }),
    'utf8'
  );
  const sigPath = path.join(dir, 'signals.json');
  const outPath = path.join(dir, 'paper_trades.jsonl');
  const dupSig = {
    datasetKey: 'SMK_5m',
    symbol: 'SMK',
    timeframe: '5m',
    barIndex: 0,
    entryPrice: 100,
    stopDistance: 1,
    direction: 'long',
    rMultiple: 2,
    strategyId: 'smoke_bar_throttle_dup',
  };
  fs.writeFileSync(sigPath, JSON.stringify({ signals: [dupSig, dupSig] }), 'utf8');
  const prev = process.env.NEUROPILOT_PAPER_EXEC_V1;
  process.env.NEUROPILOT_PAPER_EXEC_V1 = '1';
  try {
    const r = runPaperExecutionV1({
      dataRoot: dir,
      signalsPath: sigPath,
      outJsonl: outPath,
    });
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.appended, 1, 'duplicate strategyId+symbol+tf+barIndex → one trade');
    const lines = fs.readFileSync(outPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
  } finally {
    if (prev === undefined) delete process.env.NEUROPILOT_PAPER_EXEC_V1;
    else process.env.NEUROPILOT_PAPER_EXEC_V1 = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const dir2 = path.join(__dirname, '..', '..', `.tmp-smoke-pev1-persist-${Date.now()}`);
  fs.mkdirSync(path.join(dir2, 'datasets', 'smk'), { recursive: true });
  fs.mkdirSync(path.join(dir2, 'governance'), { recursive: true });
  const binPath2 = path.join(dir2, 'datasets', 'smk', 'smk_5m.bin');
  await writeBinaryStore(binPath2, {
    symbol: 'SMK',
    timeframe: '5m',
    candles: [
      { time: Date.parse('2026-01-02T00:00:00.000Z'), open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: Date.parse('2026-01-02T00:05:00.000Z'), open: 100, high: 103, low: 99.5, close: 102, volume: 1 },
    ],
  });
  fs.writeFileSync(
    path.join(dir2, 'datasets_manifest.json'),
    JSON.stringify({
      datasets: {
        SMK_5m: { symbol: 'SMK', timeframe: '5m', rows: 2, paths: { bin: binPath2 } },
      },
    }),
    'utf8'
  );
  const sigPath2 = path.join(dir2, 'governance', 'paper_execution_v1_signals.json');
  const outPath2 = path.join(dir2, 'governance', 'paper_trades.jsonl');
  const oneSig = {
    datasetKey: 'SMK_5m',
    symbol: 'SMK',
    timeframe: '5m',
    barIndex: 0,
    entryPrice: 100,
    stopDistance: 1,
    direction: 'long',
    rMultiple: 2,
    strategyId: 'smoke_persistent_throttle',
  };
  fs.writeFileSync(sigPath2, JSON.stringify({ signals: [oneSig] }), 'utf8');
  const prev2 = process.env.NEUROPILOT_PAPER_EXEC_V1;
  process.env.NEUROPILOT_PAPER_EXEC_V1 = '1';
  try {
    const r1 = runPaperExecutionV1({
      dataRoot: dir2,
      signalsPath: sigPath2,
      outJsonl: outPath2,
    });
    assert.strictEqual(r1.appended, 1);
    assert.strictEqual(r1.duplicateSkippedPersistent, 0);
    const r2 = runPaperExecutionV1({
      dataRoot: dir2,
      signalsPath: sigPath2,
      outJsonl: outPath2,
    });
    assert.strictEqual(r2.appended, 0);
    assert.strictEqual(r2.duplicateSkippedPersistent, 1);
    const seenPath2 = path.join(dir2, 'governance', 'paper_exec_seen_keys.json');
    assert.strictEqual(fs.existsSync(seenPath2), true);
    const lines2 = fs.readFileSync(outPath2, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines2.length, 1);
  } finally {
    if (prev2 === undefined) delete process.env.NEUROPILOT_PAPER_EXEC_V1;
    else process.env.NEUROPILOT_PAPER_EXEC_V1 = prev2;
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  const dir3 = path.join(__dirname, '..', '..', `.tmp-smoke-pev1-shadow-lane-${Date.now()}`);
  fs.mkdirSync(path.join(dir3, 'governance'), { recursive: true });
  fs.mkdirSync(path.join(dir3, 'datasets', 'smk'), { recursive: true });
  const binPath3 = path.join(dir3, 'datasets', 'smk', 'smk_5m.bin');
  await writeBinaryStore(binPath3, {
    symbol: 'SMK',
    timeframe: '5m',
    candles: [
      { time: Date.parse('2026-01-03T00:00:00.000Z'), open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: Date.parse('2026-01-03T00:05:00.000Z'), open: 100, high: 103, low: 99.5, close: 102, volume: 1 },
    ],
  });
  fs.writeFileSync(
    path.join(dir3, 'datasets_manifest.json'),
    JSON.stringify({
      datasets: {
        SMK_5m: { symbol: 'SMK', timeframe: '5m', rows: 2, paths: { bin: binPath3 } },
      },
    }),
    'utf8'
  );
  const gov3 = path.join(dir3, 'governance');
  const liveJsonl = path.join(gov3, 'paper_trades.jsonl');
  fs.writeFileSync(liveJsonl, 'LIVE_SENTINEL\n', 'utf8');
  const sigPath3 = path.join(gov3, 'paper_execution_v1_signals.json');
  const shadowSig = {
    datasetKey: 'SMK_5m',
    symbol: 'SMK',
    timeframe: '5m',
    barIndex: 0,
    entryPrice: 100,
    stopDistance: 1,
    direction: 'long',
    rMultiple: 2,
    strategyId: 'smoke_shadow_renewal_lane',
    setupId: 'smoke_shadow_renewal_lane',
    signalSource: 'paper_execution_v1_signals_live_copy',
  };
  fs.writeFileSync(sigPath3, JSON.stringify({ signals: [shadowSig] }), 'utf8');
  const shadowOut = path.join(gov3, 'paper_trades_renewal_shadow.jsonl');
  const shadowLast = path.join(gov3, 'paper_exec_v1_last_run_shadow.json');
  const shadowSeen = path.join(gov3, 'paper_exec_seen_keys_renewal_shadow.json');
  const prev3 = process.env.NEUROPILOT_PAPER_EXEC_V1;
  process.env.NEUROPILOT_PAPER_EXEC_V1 = '1';
  try {
    const rs = runPaperExecutionV1({
      dataRoot: dir3,
      signalsPath: sigPath3,
      outJsonl: shadowOut,
      lastRunPath: shadowLast,
      seenKeysStorePath: shadowSeen,
      shadowRenewalLane: true,
      laneName: 'shadow_renewal',
    });
    assert.strictEqual(rs.enabled, true);
    assert.strictEqual(fs.readFileSync(liveJsonl, 'utf8'), 'LIVE_SENTINEL\n');
    assert.strictEqual(fs.existsSync(shadowOut), true);
    const shadowLines = fs.readFileSync(shadowOut, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(shadowLines.length, 1);
    const trade = JSON.parse(shadowLines[0]);
    assert.strictEqual(trade.lane, 'shadow_renewal');
    assert.strictEqual(trade.signalLane, 'shadow_renewal');
    assert.strictEqual(trade.signalSource, 'paper_execution_v1_signals_live_copy');
    assert.strictEqual(trade.barIndex, 0);
    assert.strictEqual(trade.datasetKey, 'SMK_5m');
    assert.strictEqual(trade.setupId, 'smoke_shadow_renewal_lane');
    assert.strictEqual(trade.shadowInjection, false);
    const lastShadow = JSON.parse(fs.readFileSync(shadowLast, 'utf8'));
    assert.strictEqual(lastShadow.shadowMode, true);
    assert.strictEqual(lastShadow.shadowRenewalLane, true);
    assert.strictEqual(lastShadow.laneName, 'shadow_renewal');
    assert.strictEqual(lastShadow.effectiveAppended, 1);
    assert.strictEqual(lastShadow.renewalShadowTradesWritten, 1);
    assert.strictEqual(lastShadow.renewalShadowInjectedTradesWritten, 0);
    assert.strictEqual(lastShadow.renewalShadowBaseTradesWritten, 1);
    assert.strictEqual(fs.existsSync(path.join(gov3, 'paper_exec_seen_keys.json')), false);
  } finally {
    if (prev3 === undefined) delete process.env.NEUROPILOT_PAPER_EXEC_V1;
    else process.env.NEUROPILOT_PAPER_EXEC_V1 = prev3;
    fs.rmSync(dir3, { recursive: true, force: true });
  }

  const dir4 = path.join(__dirname, '..', '..', `.tmp-smoke-pev1-shadow-inject-${Date.now()}`);
  fs.mkdirSync(path.join(dir4, 'discovery'), { recursive: true });
  fs.mkdirSync(path.join(dir4, 'governance'), { recursive: true });
  fs.mkdirSync(path.join(dir4, 'datasets', 'smk'), { recursive: true });
  const binPath4 = path.join(dir4, 'datasets', 'smk', 'smk_5m.bin');
  await writeBinaryStore(binPath4, {
    symbol: 'SMK',
    timeframe: '5m',
    candles: [
      { time: Date.parse('2026-01-04T00:00:00.000Z'), open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: Date.parse('2026-01-04T00:05:00.000Z'), open: 100, high: 103, low: 99.5, close: 102, volume: 1 },
    ],
  });
  fs.writeFileSync(
    path.join(dir4, 'datasets_manifest.json'),
    JSON.stringify({
      datasets: {
        SMK_5m: { symbol: 'SMK', timeframe: '5m', rows: 2, paths: { bin: binPath4 } },
      },
    }),
    'utf8'
  );
  const gov4 = path.join(dir4, 'governance');
  const liveSig4 = path.join(gov4, 'paper_execution_v1_signals.json');
  const sentinelLive = JSON.stringify({ signals: [], _sentinel: 'live_signals_untouched' }, null, 2);
  fs.writeFileSync(liveSig4, sentinelLive, 'utf8');
  fs.writeFileSync(
    path.join(dir4, 'discovery', 'promoted_manifest.json'),
    JSON.stringify(
      {
        items: [
          {
            setupId: 'smoke_renewal_inject_test',
            strategyId: 'smoke_renewal_inject_test',
            rules: { smoke_probe: true },
            datasetKey: 'SMK_5m',
            symbol: 'SMK',
            timeframe: '5m',
            barIndex: 0,
            entryAtBarClose: true,
            stopDistance: 1,
            direction: 'long',
            rMultiple: 2,
            maxBarsHeld: 500,
            forcedWave1: false,
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );
  const shadowSeen4 = path.join(gov4, 'paper_exec_seen_keys_renewal_shadow.json');
  const inj4 = buildRenewalShadowInjectedSignals({
    dataRoot: dir4,
    shadowSeenKeysStorePath: shadowSeen4,
    maxSignalsPerRun: 8,
    maxPerSetup: 1,
    maxSetupsToScan: 8,
  });
  assert.strictEqual(inj4.signalsAdded, 1);
  assert.strictEqual(inj4.signals[0].signalSource, PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE);
  assert.strictEqual(inj4.signals[0].barIndex, 0);
  assert.strictEqual(inj4.signals[0].shadowInjection, true);
  assert.strictEqual(inj4.signals[0].renewalSignalSourceVersion, RENEWAL_SHADOW_SIGNAL_SOURCE_VERSION);
  const baseShadowSig = {
    datasetKey: 'SMK_5m',
    symbol: 'SMK',
    timeframe: '5m',
    barIndex: 0,
    entryPrice: 100,
    stopDistance: 1,
    direction: 'long',
    rMultiple: 2,
    strategyId: 'smoke_shadow_base_lane',
    setupId: 'smoke_shadow_base_lane',
    signalSource: 'paper_execution_v1_signals_base_copy',
  };
  const shadowMix4 = path.join(gov4, 'paper_execution_v1_signals_renewal_shadow.json');
  fs.writeFileSync(
    shadowMix4,
    JSON.stringify({ signals: [baseShadowSig, ...inj4.signals] }, null, 2),
    'utf8'
  );
  assert.strictEqual(fs.readFileSync(liveSig4, 'utf8'), sentinelLive);
  const shadowOut4 = path.join(gov4, 'paper_trades_renewal_shadow.jsonl');
  const shadowLast4 = path.join(gov4, 'paper_exec_v1_last_run_shadow.json');
  const prev4 = process.env.NEUROPILOT_PAPER_EXEC_V1;
  process.env.NEUROPILOT_PAPER_EXEC_V1 = '1';
  try {
    const r4 = runPaperExecutionV1({
      dataRoot: dir4,
      signalsPath: shadowMix4,
      outJsonl: shadowOut4,
      lastRunPath: shadowLast4,
      seenKeysStorePath: shadowSeen4,
      shadowRenewalLane: true,
      laneName: 'shadow_renewal',
      renewalShadowInjectionReport: {
        candidateCount: inj4.candidateCount,
        signalsAdded: inj4.signalsAdded,
        keysSkippedAlreadySeen: inj4.keysSkippedAlreadySeen,
        skippedNoValidBar: inj4.skippedNoValidBar,
        skippedInvalidManifest: inj4.skippedInvalidManifest,
        shadowSignalsPath: shadowMix4,
      },
    });
    assert.strictEqual(r4.enabled, true);
    assert.strictEqual(fs.readFileSync(liveSig4, 'utf8'), sentinelLive);
    assert.strictEqual(r4.renewalInjectionEnabled, true);
    assert.strictEqual(r4.renewalInjectionSignalsAdded, 1);
    assert.strictEqual(r4.renewalShadowTradesWritten, 2);
    assert.strictEqual(r4.renewalShadowInjectedTradesWritten, 1);
    assert.strictEqual(r4.renewalShadowBaseTradesWritten, 1);
    const last4 = JSON.parse(fs.readFileSync(shadowLast4, 'utf8'));
    assert.strictEqual(last4.renewalInjectionEnabled, true);
    assert.strictEqual(last4.renewalInjectionSignalsAdded, 1);
    assert.strictEqual(last4.renewalShadowTradesWritten, 2);
    assert.strictEqual(last4.renewalShadowInjectedTradesWritten, 1);
    assert.strictEqual(last4.renewalShadowBaseTradesWritten, 1);
    const tlines = fs.readFileSync(shadowOut4, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(tlines.length, 2);
    assert.ok(fs.readFileSync(shadowMix4, 'utf8').includes(PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE));
    const trades4 = tlines.map((ln) => JSON.parse(ln));
    const injTrade = trades4.find((t) => t.shadowInjection === true);
    const baseTrade = trades4.find((t) => t.shadowInjection === false);
    assert.ok(injTrade);
    assert.ok(baseTrade);
    assert.strictEqual(injTrade.signalSource, PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE);
    assert.strictEqual(injTrade.barIndex, 0);
    assert.strictEqual(injTrade.renewalSignalSourceVersion, RENEWAL_SHADOW_SIGNAL_SOURCE_VERSION);
    assert.strictEqual(injTrade.shadowInjectionType, 'renewal');
    assert.strictEqual(baseTrade.signalSource, 'paper_execution_v1_signals_base_copy');
    assert.strictEqual(baseTrade.barIndex, 0);
    assert.strictEqual(baseTrade.shadowInjection, false);
    assert.strictEqual(injTrade.lane, 'shadow_renewal');
  } finally {
    if (prev4 === undefined) delete process.env.NEUROPILOT_PAPER_EXEC_V1;
    else process.env.NEUROPILOT_PAPER_EXEC_V1 = prev4;
    fs.rmSync(dir4, { recursive: true, force: true });
  }
})().then(() => {
  {
    assert.strictEqual(computeAppendZeroPrimaryReason({ appended: 1, signalsLen: 5 }), null);
    assert.strictEqual(
      computeAppendZeroPrimaryReason({ appended: 0, signalsLen: 0, skipped: 'signals array empty' }),
      'no_signals'
    );
    assert.strictEqual(
      computeAppendZeroPrimaryReason({
        appended: 0,
        signalsLen: 2,
        smartReplayV2Stats: { candidates: 0 },
        smartOnlyOn: true,
        promotedReplayBypassOn: true,
        smartReplayObservability: { smartReplayFrozenExcludedStrict: 3 },
      }),
      'v2_zero_candidates_frozen_strict'
    );
    assert.strictEqual(
      computeAppendZeroPrimaryReason({
        appended: 0,
        signalsLen: 2,
        persistentOn: true,
        promotedReplayBypassOn: true,
        promotedManifestPersistentDupAttempts: 2,
        promotedReplayBypassCount: 0,
        duplicateSkippedPersistent: 0,
        duplicateSkippedRun: 0,
        sourceSummary: { promotedNotSeen7dCount: 1, tier2Count: 0 },
      }),
      'persistent_dup_no_bypass'
    );
  }

  console.log('smokePaperExecutionV1: all passed');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
