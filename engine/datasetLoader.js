'use strict';

/**
 * NeuroPilot Quant Engine v1 — Dataset Loader / Research Input Layer
 *
 * Loads OHLCV datasets from JSON or CSV files and normalizes them into the format
 * expected by the quant engine. Pure normalizer functions + one file loader (read only).
 * No database writes.
 *
 * Input: file path, symbol, timeframe, optional format hints.
 * Output: { symbol, timeframe, candles: [{ time, open, high, low, close, volume }] }
 *
 * Supported: JSON array of candles; CSV with header (timestamp/time/date, open/high/low/close/volume or o,h,l,c,v).
 */

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

/** Normalized candle shape for engine consumption. */
const CANDLE_KEYS = ['time', 'open', 'high', 'low', 'close', 'volume'];

/**
 * Normalize a single candle object: map aliases (o/h/l/c/v, time/timestamp/date) to canonical shape.
 * Returns { time, open, high, low, close, volume }. time as number (ms); OHLCV as numbers.
 * Invalid or missing numeric fields become NaN/0; caller can filter.
 *
 * @param {object} c - Raw candle (any alias set)
 * @returns {object} { time: number, open, high, low, close, volume }
 */
function normalizeCandle(c) {
  if (!c || typeof c !== 'object') {
    return { time: NaN, open: NaN, high: NaN, low: NaN, close: NaN, volume: 0 };
  }
  const open = Number(c.open ?? c.o ?? NaN);
  const high = Number(c.high ?? c.h ?? NaN);
  const low = Number(c.low ?? c.l ?? NaN);
  const close = Number(c.close ?? c.c ?? NaN);
  const volume = Number(c.volume ?? c.v ?? 0);
  let time = c.time ?? c.timestamp ?? c.t ?? c.date ?? NaN;
  if (typeof time === 'string') {
    const num = Number(time);
    if (Number.isFinite(num)) {
      time = num;
    } else {
      const ms = Date.parse(time);
      time = Number.isFinite(ms) ? ms : NaN;
    }
  } else {
    time = Number(time);
  }
  if (Number.isFinite(time) && time > 0 && time < 1e12) time = time * 1000;
  return { time, open, high, low, close, volume };
}

/**
 * Parse CSV string into array of normalized candles. First line treated as header if it looks like column names.
 *
 * @param {string} content - Raw CSV string
 * @param {string} [symbol] - Pass-through for result
 * @param {string} [timeframe] - Pass-through for result
 * @param {object} [options] - { delimiter: ',', hasHeader: true }
 * @returns {{ symbol: string, timeframe: string, candles: Array }}
 */
function parseCSV(content, symbol = '', timeframe = '', options = {}) {
  const opts = { delimiter: ',', hasHeader: true, ...(typeof options === 'object' ? options : {}) };
  const delimiter = opts.delimiter || ',';
  const lines = (content || '').trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) {
    return { symbol: String(symbol), timeframe: String(timeframe), candles: [] };
  }
  const headerLine = lines[0].toLowerCase();
  const hasHeader = opts.hasHeader !== false && (
    /open|high|low|close|volume|timestamp|time|date|\bo\b|\bh\b|\bl\b|\bc\b|\bv\b/.test(headerLine)
  );
  const start = hasHeader ? 1 : 0;
  const headers = hasHeader ? lines[0].split(delimiter).map((h) => h.trim().toLowerCase()) : null;

  const candles = [];
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i].split(delimiter).map((p) => p.trim());
    const raw = {};
    if (headers && headers.length > 0) {
      for (let j = 0; j < headers.length; j++) {
        const key = headers[j].replace(/^["']|["']$/g, '');
        if (key) raw[key] = parts[j];
      }
    } else {
      raw.timestamp = parts[0];
      raw.open = parts[1];
      raw.high = parts[2];
      raw.low = parts[3];
      raw.close = parts[4];
      raw.volume = parts[5] ?? 0;
    }
    const norm = normalizeCandle(raw);
    if (Number.isFinite(norm.time) && Number.isFinite(norm.close)) {
      candles.push(norm);
    }
  }
  return { symbol: String(symbol), timeframe: String(timeframe), candles };
}

/**
 * Parse JSON content into normalized dataset. Expects array of candles or object with candles key.
 *
 * @param {string} content - Raw JSON string
 * @param {string} [symbol] - Pass-through for result
 * @param {string} [timeframe] - Pass-through for result
 * @returns {{ symbol: string, timeframe: string, candles: Array }}
 */
function parseJSON(content, symbol = '', timeframe = '') {
  let data;
  try {
    data = JSON.parse(content || '[]');
  } catch {
    return { symbol: String(symbol), timeframe: String(timeframe), candles: [] };
  }
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.candles) ? data.candles : []);
  const candles = arr.map(normalizeCandle).filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close));
  return { symbol: String(symbol), timeframe: String(timeframe), candles };
}

/**
 * Parse timeframe string to interval in milliseconds.
 * Examples: "1m" -> 60000, "5m" -> 300000, "15m" -> 900000, "1h" -> 3600000.
 *
 * @param {string} timeframe - e.g. "1m", "5m", "15m", "1h"
 * @returns {number} Interval in ms, or 300000 (5m) if unparseable
 */
function timeframeToIntervalMs(timeframe) {
  if (!timeframe || typeof timeframe !== 'string') return 5 * 60 * 1000;
  const s = timeframe.trim().toLowerCase();
  const match = s.match(/^(\d+)\s*(m|h|d)$/);
  if (!match) return 5 * 60 * 1000;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'm') return num * 60 * 1000;
  if (unit === 'h') return num * 60 * 60 * 1000;
  if (unit === 'd') return num * 24 * 60 * 60 * 1000;
  return 5 * 60 * 1000;
}

/** US session length in minutes (14:30–21:00 UTC) for spreadAcrossSessionDays. */
const SESSION_LENGTH_MINUTES = 6 * 60 + 30;

/** Default start for synthesized timestamps: 2024-01-02 14:30 UTC (US session open in UTC). */
function defaultSynthesizeStartMs() {
  return Date.UTC(2024, 0, 2, 14, 30, 0, 0);
}

/**
 * Number of bars that fit in one session day (14:30–21:00 UTC) for a given interval.
 * Used when spreadAcrossSessionDays so every bar falls inside the session window.
 */
function sessionBarsPerDay(timeframe) {
  const intervalMs = timeframeToIntervalMs(timeframe);
  const intervalMinutes = intervalMs / (60 * 1000);
  return Math.max(1, Math.floor(SESSION_LENGTH_MINUTES / intervalMinutes));
}

/**
 * Overwrite candle times with synthesized UTC ms.
 * Use when source data has bar-index-like or invalid timestamps (e.g. SPY/QQQ CSV).
 * Mutates candles in place.
 *
 * @param {Array<object>} candles - Normalized candles (will get .time set)
 * @param {string} timeframe - e.g. "5m" for interval
 * @param {number} [startMs] - First bar time (UTC ms); default 2024-01-02 14:30 UTC
 * @param {object} [opts] - { spreadAcrossSessionDays: boolean } — when true, place each bar within 14:30–21:00 UTC on successive days so sessionPerformanceBreakdown gets open/mid/late
 */
function synthesizeCandleTimes(candles, timeframe, startMs, opts) {
  if (!Array.isArray(candles)) return;
  const base = Number.isFinite(startMs) ? startMs : defaultSynthesizeStartMs();
  const intervalMs = timeframeToIntervalMs(timeframe);
  const spread = opts && opts.spreadAcrossSessionDays === true;
  const barsPerDay = spread ? sessionBarsPerDay(timeframe) : 0;
  const oneDayMs = 24 * 60 * 60 * 1000;

  for (let i = 0; i < candles.length; i++) {
    if (!candles[i] || typeof candles[i] !== 'object') continue;
    if (spread && barsPerDay > 0) {
      const dayIndex = Math.floor(i / barsPerDay);
      const barInDay = i % barsPerDay;
      candles[i].time = base + dayIndex * oneDayMs + barInDay * intervalMs;
    } else {
      candles[i].time = base + i * intervalMs;
    }
  }
}

/**
 * Resolve dataset path: try repo data dir first, then $NEUROPILOT_DATA_ROOT/datasets/<symbol>/ if 5TB is in use.
 * Lets heavy CSV live on 5TB while code stays on Mac.
 *
 * @param {string} filePath - Original path (e.g. ./data/spy_5m_2022.csv)
 * @param {string} [symbol] - Symbol (e.g. "SPY") for 5TB lookup
 * @returns {string} Path to use for reading
 */
function resolveDatasetPath(filePath, symbol) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  const full = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (fs.existsSync(full)) return full;
  try {
    const dataRoot = require('./dataRoot');
    if (dataRoot.isUsingExternalDrive() && symbol) {
      const base = path.basename(filePath);
      const datasetsDir = dataRoot.getPath('datasets', false);
      const alt = path.join(datasetsDir, String(symbol).toLowerCase(), base);
      if (fs.existsSync(alt)) return alt;
    }
  } catch (_) {}
  return full;
}

/**
 * If a .bin exists next to the requested CSV path, return the .bin path for fast load. Otherwise null.
 */
function resolveBinaryPath(resolvedCsvPath) {
  if (!resolvedCsvPath || path.extname(resolvedCsvPath).toLowerCase() !== '.csv') return null;
  const binPath = path.join(path.dirname(resolvedCsvPath), path.basename(resolvedCsvPath, '.csv') + '.bin');
  return fs.existsSync(binPath) ? binPath : null;
}

/**
 * Load a file and return normalized dataset. Format inferred from extension (.json, .csv, .bin) or options.format.
 * When loading a CSV path, if a same-named .bin exists (e.g. spy_5m.bin next to spy_5m.csv), the binary store
 * is loaded instead (~5×–20× faster). Use csvToBinary script to generate .bin from CSV.
 * If file is not in repo, tries $NEUROPILOT_DATA_ROOT/datasets/<symbol>/<basename> when 5TB is set.
 *
 * @param {string} filePath - Path to JSON, CSV, or .bin file
 * @param {string} [symbol] - Symbol label (e.g. "QQQ")
 * @param {string} [timeframe] - Timeframe label (e.g. "1m")
 * @param {object} [options] - { format, encoding, preferBinary: boolean, synthesizeTimestampsFromIndex, startMs }
 *   - preferBinary: when true (default), load .bin instead of .csv when .bin exists
 *   - synthesizeTimestampsFromIndex: when true, overwrite candle .time with startMs + index * intervalMs
 *   - startMs: optional start for synthesis (default 2024-01-02 14:30 UTC)
 * @returns {Promise<{ symbol: string, timeframe: string, candles: Array }>}
 */
async function loadFromFile(filePath, symbol = '', timeframe = '', options = {}) {
  const opts = options || {};
  const resolved = resolveDatasetPath(filePath, symbol);
  const encoding = opts.encoding || 'utf8';
  let format = opts.format || 'auto';
  const ext = path.extname(resolved || '').toLowerCase();

  // Prefer binary store when available (CSV path → same path with .bin)
  const preferBinary = opts.preferBinary !== false;
  if (format === 'auto' && ext === '.csv' && preferBinary) {
    const binPath = resolveBinaryPath(resolved);
    if (binPath) {
      const binaryStore = require('./datasetBinaryStore');
      const result = await binaryStore.readBinaryStore(binPath);
      if (opts.synthesizeTimestampsFromIndex === true && Array.isArray(result.candles) && result.candles.length > 0) {
        const startMs = opts.startMs != null && Number.isFinite(opts.startMs) ? opts.startMs : defaultSynthesizeStartMs();
        const synthOpts = { spreadAcrossSessionDays: opts.spreadAcrossSessionDays !== false };
        synthesizeCandleTimes(result.candles, result.timeframe, startMs, synthOpts);
      }
      return result;
    }
  }
  if (format === 'auto') {
    format = ext === '.json' ? 'json' : ext === '.bin' ? 'bin' : ext === '.csv' ? 'csv' : 'json';
  }
  if (format === 'bin') {
    const binaryStore = require('./datasetBinaryStore');
    const result = await binaryStore.readBinaryStore(resolved);
    if (opts.synthesizeTimestampsFromIndex === true && Array.isArray(result.candles) && result.candles.length > 0) {
      const startMs = opts.startMs != null && Number.isFinite(opts.startMs) ? opts.startMs : defaultSynthesizeStartMs();
      const synthOpts = { spreadAcrossSessionDays: opts.spreadAcrossSessionDays !== false };
      synthesizeCandleTimes(result.candles, result.timeframe, startMs, synthOpts);
    }
    return result;
  }

  const content = await fsPromises.readFile(resolved, encoding);
  if (typeof content === 'string' && content.trim().length === 0) {
    throw new Error('Dataset file is empty');
  }
  let result;
  if (format === 'csv') {
    result = parseCSV(content, symbol, timeframe, opts);
  } else {
    result = parseJSON(content, symbol, timeframe);
  }
  if (opts.synthesizeTimestampsFromIndex === true && Array.isArray(result.candles) && result.candles.length > 0) {
    const startMs = opts.startMs != null && Number.isFinite(opts.startMs) ? opts.startMs : defaultSynthesizeStartMs();
    const synthOpts = { spreadAcrossSessionDays: opts.spreadAcrossSessionDays !== false };
    synthesizeCandleTimes(result.candles, result.timeframe, startMs, synthOpts);
  }
  return result;
}

module.exports = {
  loadFromFile,
  resolveDatasetPath,
  resolveBinaryPath,
  parseJSON,
  parseCSV,
  normalizeCandle,
  synthesizeCandleTimes,
  timeframeToIntervalMs,
  sessionBarsPerDay,
  defaultSynthesizeStartMs,
  CANDLE_KEYS,
};
