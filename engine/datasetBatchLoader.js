'use strict';

/**
 * NeuroPilot Quant Engine v1 — Dataset Batch Loader
 *
 * Loads multiple dataset files via datasetLoader.loadFromFile and returns an array
 * ready for multiAssetRunner, with loaded/failed counts and per-file errors.
 * Async; no database writes.
 *
 * Input: array of { filePath, symbol, timeframe, options? }
 * Output: { datasets: [...], loaded: number, failed: number, errors: [{ filePath, message }, ...] }
 */

const datasetLoader = require('./datasetLoader');
const fs = require('fs');
const path = require('path');
const datasetDegradedGuard = require('./data/datasetDegradedGuard');
const datasetManifest = require('./data/datasetManifest');
const DEFAULT_MIN_CANDLES = 60;
const XAU_DIAGNOSTIC_TFS = new Set(['5m', '15m', '1h']);

function expectedStepMsForTf(timeframe) {
  const tf = String(timeframe || '').toLowerCase();
  if (tf === '1m') return 60 * 1000;
  if (tf === '5m') return 5 * 60 * 1000;
  if (tf === '15m') return 15 * 60 * 1000;
  if (tf === '30m') return 30 * 60 * 1000;
  if (tf === '1h') return 60 * 60 * 1000;
  if (tf === '4h') return 4 * 60 * 60 * 1000;
  if (tf === '1d') return 24 * 60 * 60 * 1000;
  return 0;
}

function candleTs(c) {
  if (!c || typeof c !== 'object') return null;
  const t = Number(c.time ?? c.ts ?? c.timestamp ?? c.date ?? NaN);
  return Number.isFinite(t) ? t : null;
}

function buildDatasetHealthDiagnostics({
  candles,
  manifestKey,
  dataGroup,
  symbol,
  timeframe,
  verdict,
  reasonCodes,
}) {
  const arr = Array.isArray(candles) ? candles : [];
  const expectedStepMs = expectedStepMsForTf(timeframe);
  const now = Date.now();
  const barCount = arr.length;
  let firstTs = null;
  let lastTs = null;
  let gapCount = 0;
  let duplicateCount = 0;
  let nonMonotonicCount = 0;
  let badStepCount = 0;
  let maxGapMs = 0;

  let prev = null;
  for (let i = 0; i < arr.length; i += 1) {
    const ts = candleTs(arr[i]);
    if (ts == null) continue;
    if (firstTs == null) firstTs = ts;
    lastTs = ts;
    if (prev != null) {
      const delta = ts - prev;
      if (delta === 0) duplicateCount += 1;
      if (delta < 0) nonMonotonicCount += 1;
      if (delta > 0 && delta > maxGapMs) maxGapMs = delta;
      if (expectedStepMs > 0 && delta !== expectedStepMs) badStepCount += 1;
      if (expectedStepMs > 0 && delta > expectedStepMs) gapCount += 1;
    }
    prev = ts;
  }

  const coverageMs =
    firstTs != null && lastTs != null && lastTs >= firstTs ? lastTs - firstTs : 0;
  const coverageDays = Number((coverageMs / (24 * 60 * 60 * 1000)).toFixed(3));
  const ageMs = lastTs != null ? Math.max(0, now - lastTs) : null;
  const ageMin = ageMs != null ? Number((ageMs / (60 * 1000)).toFixed(3)) : null;
  const maxGapBars =
    expectedStepMs > 0 ? Math.floor(maxGapMs / expectedStepMs) : 0;

  return {
    event: 'dataset_health_diagnostics',
    manifestKey: String(manifestKey || '').toUpperCase(),
    dataGroup: dataGroup != null ? String(dataGroup) : null,
    symbol: String(symbol || '').toUpperCase(),
    timeframe: String(timeframe || '').toLowerCase(),
    barCount,
    expectedStepMs,
    firstTs,
    lastTs,
    ageMs,
    ageMin,
    gapCount,
    duplicateCount,
    nonMonotonicCount,
    badStepCount,
    maxGapMs,
    maxGapBars,
    coverageMs,
    coverageDays,
    verdict: String(verdict || 'unknown'),
    reasonCodes: Array.isArray(reasonCodes) ? reasonCodes.map((x) => String(x)) : [],
  };
}

function shouldEmitDiagnostics(symbol, timeframe, verdict) {
  const s = String(symbol || '').toUpperCase();
  const tf = String(timeframe || '').toLowerCase();
  if (s === 'XAUUSD' && XAU_DIAGNOSTIC_TFS.has(tf)) return true;
  return String(verdict || '').toLowerCase().includes('degraded') ||
    String(verdict || '').toLowerCase().includes('skip');
}

function emitDatasetDiagnostics(diag) {
  try {
    console.error(JSON.stringify(diag));
    persistXauDiagnostics(diag);
  } catch (_) {
    // no-op: diagnostics must never break pipeline
  }
}

function resolveOpsSnapshotDir() {
  const env = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR;
  if (env && String(env).trim()) {
    return path.resolve(process.cwd(), String(env).trim());
  }
  return path.join(process.cwd(), 'ops-snapshot');
}

function primaryReasonFromCodes(reasonCodes) {
  const arr = Array.isArray(reasonCodes) ? reasonCodes.map((x) => String(x)) : [];
  for (const c of arr) {
    if (c !== 'IN_DEGRADED_CRITICAL_SET') return c;
  }
  return null;
}

function persistXauDiagnostics(diag) {
  const d = diag && typeof diag === 'object' ? diag : null;
  if (!d) return;
  if (String(d.symbol || '').toUpperCase() !== 'XAUUSD') return;
  if (!XAU_DIAGNOSTIC_TFS.has(String(d.timeframe || '').toLowerCase())) return;

  const outPath = path.join(resolveOpsSnapshotDir(), 'xau_dataset_diagnostics.json');
  const tfOrder = ['5m', '15m', '1h'];
  const row = {
    manifestKey: String(d.manifestKey || '').toUpperCase(),
    symbol: 'XAUUSD',
    timeframe: String(d.timeframe || '').toLowerCase(),
    verdict: String(d.verdict || 'unknown'),
    reasonCodes: Array.isArray(d.reasonCodes) ? d.reasonCodes.map((x) => String(x)) : [],
    primaryReason: primaryReasonFromCodes(d.reasonCodes),
    ageMin: Number.isFinite(Number(d.ageMin)) ? Number(d.ageMin) : null,
    gapCount: Number.isFinite(Number(d.gapCount)) ? Number(d.gapCount) : 0,
    maxGapBars: Number.isFinite(Number(d.maxGapBars)) ? Number(d.maxGapBars) : 0,
    barCount: Number.isFinite(Number(d.barCount)) ? Number(d.barCount) : 0,
  };

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    let current = [];
    if (fs.existsSync(outPath)) {
      const j = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      current = Array.isArray(j && j.items) ? j.items : [];
    }
    const byTf = new Map(current.map((x) => [String(x && x.timeframe || '').toLowerCase(), x]));
    byTf.set(row.timeframe, row);
    const items = tfOrder
      .map((tf) => byTf.get(tf))
      .filter(Boolean);
    fs.writeFileSync(
      outPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2),
      'utf8'
    );
  } catch (_) {
    // no-op
  }
}

/**
 * Validate minimum candle requirements for a loaded dataset.
 *
 * @param {object} data - Loader output
 * @param {number} minCandles - Minimum required candles
 */
function validateDataset(data, minCandles) {
  const candles = Array.isArray(data && data.candles) ? data.candles : [];
  const count = candles.length;
  if (count === 0) {
    throw new Error('Dataset contains 0 candles');
  }
  if (count < minCandles) {
    throw new Error(`Dataset contains only ${count} candles; minimum is ${minCandles}`);
  }
}

/**
 * Load multiple datasets. Preserves order. Option failFast: stop on first failure.
 * Option mergeSameSymbolTimeframe: when true, group loaded datasets by (symbol, timeframe), merge candles (concat + sort by .time), emit one dataset per group.
 *
 * @param {Array<{ filePath: string, symbol?: string, timeframe?: string, options?: object }>} definitions - Dataset definitions
 * @param {object} [options] - { failFast: boolean, minCandles: number, mergeSameSymbolTimeframe: boolean }
 * @returns {Promise<{ datasets: Array<{ symbol, timeframe, candles }>, loaded: number, failed: number, errors: Array<{ filePath: string, message: string }> }>}
 */
async function loadBatch(definitions, options = {}) {
  const opts = { failFast: false, minCandles: DEFAULT_MIN_CANDLES, mergeSameSymbolTimeframe: false, ...options };
  const list = Array.isArray(definitions) ? definitions : [];
  const minCandles = Number.isFinite(Number(opts.minCandles)) ? Math.max(0, Number(opts.minCandles)) : DEFAULT_MIN_CANDLES;
  const datasets = [];
  const errors = [];
  let loaded = 0;
  let failed = 0;

  const loaderOptions = opts.loader && typeof opts.loader === 'object' ? opts.loader : {};

  for (const def of list) {
    const filePath = def && def.filePath != null ? String(def.filePath) : '';
    const symbol = def && def.symbol != null ? String(def.symbol) : '';
    const timeframe = def && def.timeframe != null ? String(def.timeframe) : '';
    const dataGroup = def && def.dataGroup != null ? String(def.dataGroup) : (
      def && def.group != null ? String(def.group) : null
    );
    const key = symbol && timeframe ? datasetManifest.manifestKey(symbol, timeframe) : '';
    const fileOptions = { ...loaderOptions, ...(def && def.options && typeof def.options === 'object' ? def.options : {}) };

    if (!filePath.trim()) {
      const msg = 'Missing or empty filePath';
      errors.push({ filePath: filePath || '<unknown>', message: msg });
      failed += 1;
      if (opts.failFast) {
        throw new Error(`[datasetBatchLoader] ${msg}`);
      }
      continue;
    }

    const skipCtx = symbol && timeframe && datasetDegradedGuard.getSkipContext
      ? datasetDegradedGuard.getSkipContext(symbol, timeframe)
      : null;
    if (skipCtx) {
      const skipKey = key || skipCtx.key;
      datasetDegradedGuard.logSkipDataset(skipKey, skipCtx.verdict || 'degraded_critical_dataset');
      if (shouldEmitDiagnostics(symbol, timeframe, skipCtx.verdict)) {
        let diagCandles = [];
        try {
          const loadedForDiag = await datasetLoader.loadFromFile(
            filePath,
            symbol,
            timeframe,
            fileOptions
          );
          diagCandles = Array.isArray(loadedForDiag && loadedForDiag.candles)
            ? loadedForDiag.candles
            : [];
        } catch (_) {
          diagCandles = [];
        }
        emitDatasetDiagnostics(
          buildDatasetHealthDiagnostics({
            candles: diagCandles,
            manifestKey: skipKey,
            dataGroup,
            symbol,
            timeframe,
            verdict: skipCtx.verdict || 'degraded_critical_dataset',
            reasonCodes: skipCtx.reasonCodes || ['IN_DEGRADED_CRITICAL_SET'],
          })
        );
      }
      errors.push({ filePath, message: 'skipped_data_guard_degraded' });
      failed += 1;
      if (opts.failFast) {
        throw new Error(`[datasetBatchLoader] skipped degraded dataset ${skipKey}`);
      }
      continue;
    }

    try {
      const data = await datasetLoader.loadFromFile(filePath, symbol, timeframe, fileOptions);
      validateDataset(data, minCandles);
      if (shouldEmitDiagnostics(data.symbol, data.timeframe, 'healthy')) {
        emitDatasetDiagnostics(
          buildDatasetHealthDiagnostics({
            candles: data.candles,
            manifestKey: key || datasetManifest.manifestKey(data.symbol, data.timeframe),
            dataGroup,
            symbol: data.symbol,
            timeframe: data.timeframe,
            verdict: 'healthy',
            reasonCodes: [],
          })
        );
      }
      datasets.push({ symbol: data.symbol, timeframe: data.timeframe, candles: data.candles });
      loaded += 1;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      errors.push({ filePath, message });
      failed += 1;
      if (opts.failFast) {
        throw err;
      }
    }
  }

  if (opts.mergeSameSymbolTimeframe && datasets.length > 0) {
    const byKey = new Map();
    const fileCountByKey = new Map();
    for (const ds of datasets) {
      const key = `${ds.symbol}|${ds.timeframe}`;
      if (!byKey.has(key)) {
        byKey.set(key, { symbol: ds.symbol, timeframe: ds.timeframe, candles: [] });
        fileCountByKey.set(key, 0);
      }
      const acc = byKey.get(key);
      const candles = Array.isArray(ds.candles) ? ds.candles : [];
      acc.candles.push(...candles);
      fileCountByKey.set(key, fileCountByKey.get(key) + 1);
    }
    const merged = [];
    for (const [key, { symbol, timeframe, candles }] of byKey) {
      const sorted = candles.slice().sort((a, b) => (a && b && Number.isFinite(a.time) && Number.isFinite(b.time) ? a.time - b.time : 0));
      const nFiles = fileCountByKey.get(key) || 0;
      if (sorted.length >= minCandles) {
        if (typeof console !== 'undefined' && console.log) {
          console.log('INFO Merge', symbol, timeframe, nFiles, 'files', sorted.length, 'candles');
        }
        merged.push({ symbol, timeframe, candles: sorted });
      }
    }
    return { datasets: merged, loaded: merged.length, failed, errors };
  }

  return { datasets, loaded, failed, errors };
}

module.exports = {
  DEFAULT_MIN_CANDLES,
  validateDataset,
  loadBatch,
};
