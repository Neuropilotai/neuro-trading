#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const oanda = require('../data/providers/oanda');
const datasetManifest = require('../data/datasetManifest');
const datasetLoader = require('../datasetLoader');
const binaryStore = require('../datasetBinaryStore');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SYMBOLS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];
const DEFAULT_TIMEFRAMES = ['5m', '15m', '1h'];
const DEFAULT_DAYS = 90;
const FRESHNESS_BY_TF_MS = {
  '5m': 6 * 60 * 60 * 1000,
  '15m': 6 * 60 * 60 * 1000,
  '1h': 12 * 60 * 60 * 1000,
};

function parseArgs(argv) {
  const out = {
    symbols: [...DEFAULT_SYMBOLS],
    timeframes: [...DEFAULT_TIMEFRAMES],
    days: DEFAULT_DAYS,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] || '');
    if ((a === '--symbols' || a === '-s') && argv[i + 1]) {
      out.symbols = String(argv[i + 1]).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
      i += 1;
      continue;
    }
    if ((a === '--timeframes' || a === '-t') && argv[i + 1]) {
      out.timeframes = String(argv[i + 1]).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      i += 1;
      continue;
    }
    if ((a === '--days' || a === '-d') && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.days = Math.floor(n);
      i += 1;
    }
  }
  return out;
}

function minRowsFor(timeframe, days) {
  const barsPerDay = timeframe === '5m' ? 288 : timeframe === '15m' ? 96 : timeframe === '1h' ? 24 : 0;
  // Keep threshold conservative for market closures, but strict enough to catch broken ingestion.
  return Math.max(100, Math.floor(barsPerDay * days * 0.5));
}

function analyzeCsvRows(csvText) {
  const lines = String(csvText || '').split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) {
    return { rows: 0, firstTs: null, lastTs: null, monotonic: true };
  }
  let prev = -Infinity;
  let monotonic = true;
  let firstTs = null;
  let lastTs = null;
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',');
    const t = Date.parse(cols[0] || '');
    if (!Number.isFinite(t)) continue;
    if (firstTs == null) firstTs = t;
    lastTs = t;
    if (t < prev) monotonic = false;
    prev = t;
  }
  return { rows: Math.max(0, lines.length - 1), firstTs, lastTs, monotonic };
}

function validateDataset(csvPath, timeframe, days) {
  const now = Date.now();
  const raw = fs.readFileSync(csvPath, 'utf8');
  const analysis = analyzeCsvRows(raw);
  const minRows = minRowsFor(timeframe, days);
  const freshnessMaxAgeMs = FRESHNESS_BY_TF_MS[timeframe] || (24 * 60 * 60 * 1000);
  const reasons = [];
  if (analysis.rows < minRows) reasons.push(`rows_below_min:${analysis.rows}<${minRows}`);
  if (!analysis.monotonic) reasons.push('timestamps_not_monotonic');
  if (!Number.isFinite(analysis.lastTs)) reasons.push('last_timestamp_missing');
  else if (now - analysis.lastTs > freshnessMaxAgeMs) reasons.push(`stale_last_candle:${now - analysis.lastTs}ms`);

  return {
    ok: reasons.length === 0,
    rows: analysis.rows,
    minRows,
    firstTs: analysis.firstTs,
    lastTs: analysis.lastTs,
    freshnessMaxAgeMs,
    reasons,
  };
}

async function writeCsvAndBin(symbol, timeframe, candles, csvPath) {
  const csv = oanda.candlesToCSV(candles);
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  fs.writeFileSync(csvPath, csv, 'utf8');

  const parsed = datasetLoader.parseCSV(csv, symbol, timeframe);
  const binPath = csvPath.replace(/\.csv$/i, '.bin');
  await binaryStore.writeBinaryStore(binPath, parsed);

  const bars = parsed.candles || [];
  datasetManifest.setEntry(symbol, timeframe, {
    provider: 'oanda',
    firstTs: bars.length ? bars[0].time : null,
    lastTs: bars.length ? bars[bars.length - 1].time : null,
    rows: bars.length,
    paths: { csv: csvPath, bin: binPath },
    lastUpdateAt: new Date().toISOString(),
  });
  return { csvPath, binPath, rows: bars.length };
}

async function main() {
  const args = parseArgs(process.argv);
  const root = datasetManifest.getDataRoot();
  const endMs = Date.now();
  const startMs = endMs - args.days * DAY_MS;
  const report = {
    event: 'oanda_backfill_report',
    startedAt: new Date().toISOString(),
    dataRoot: root,
    symbols: args.symbols,
    timeframes: args.timeframes,
    days: args.days,
    fromMs: startMs,
    toMs: endMs,
    datasets: [],
    failed: 0,
  };

  for (const symbol of args.symbols) {
    for (const timeframe of args.timeframes) {
      const csvPath = path.join(root, 'datasets', symbol.toLowerCase(), `${symbol.toLowerCase()}_${timeframe}.csv`);
      try {
        const candles = await oanda.downloadCandles(symbol, timeframe, startMs - 1, endMs);
        const writeInfo = await writeCsvAndBin(symbol, timeframe, candles, csvPath);
        const validation = validateDataset(writeInfo.csvPath, timeframe, args.days);
        report.datasets.push({
          symbol,
          timeframe,
          status: validation.ok ? 'done' : 'error',
          rows: writeInfo.rows,
          csvPath: writeInfo.csvPath,
          binPath: writeInfo.binPath,
          validation,
        });
        if (!validation.ok) report.failed += 1;
      } catch (e) {
        report.datasets.push({
          symbol,
          timeframe,
          status: 'error',
          csvPath,
          message: e && e.message ? e.message : String(e),
        });
        report.failed += 1;
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  const outDir = path.join(root, 'loop_logs');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'oanda_backfill_report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ event: 'oanda_backfill_completed', reportPath: outPath, failed: report.failed }));
  if (report.failed > 0) process.exit(2);
}

main().catch((e) => {
  console.error(e && e.message ? e.message : String(e));
  process.exit(1);
});

