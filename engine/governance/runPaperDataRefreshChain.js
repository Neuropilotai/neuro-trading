#!/usr/bin/env node
'use strict';

/**
 * Paper data refresh chain (minimal orchestration):
 * 1) engine/data/runDataEngine.js — download/ensure default seeds + updateAll() on full manifest (see runDataEngine + datasetUpdater).
 * 2) engine/governance/buildPaperExecutionV1SignalsWave1.js — rebuild barIndex from current row counts (requires Wave1 env).
 * 3) engine/governance/runPaperExecutionV1.js — append paper_trades.jsonl.
 *
 * Usage (from repo root):
 *   export NEUROPILOT_DATA_ROOT=/path/to/data
 *   export NEUROPILOT_WAVE1_SYMBOLS=BTCUSDT,SPY,XRPUSDT   # or omit to derive from existing paper_execution_v1_signals.json
 *   node engine/governance/runPaperDataRefreshChain.js
 *
 * Flags:
 *   --skip-data-engine     Skip runDataEngine (offline / CI); signals+paper still run.
 *   --data-root=PATH       Set NEUROPILOT_DATA_ROOT for this process only.
 *
 * Optional env (passed through): NEUROPILOT_WAVE1_PAPER_SCALE_MODE, NEUROPILOT_CYCLE_ID, EXPERIMENT_ID, etc.
 * If neither NEUROPILOT_CYCLE_ID nor EXPERIMENT_ID is set, this wrapper assigns both once to paperchain_<UTCcompact>Z
 * so appended paper lines get a V2 cycle bucket (runPaperExecutionV1.resolvePaperExecCycleIds).
 */

const fs = require('fs');
const path = require('path');

function ensurePaperChainCycleEnv() {
  const c = String(process.env.NEUROPILOT_CYCLE_ID || '').trim();
  const e = String(process.env.EXPERIMENT_ID || '').trim();
  if (c || e) return;
  const compact = new Date().toISOString().slice(0, 19).replace(/-/g, '').replace(/:/g, '');
  const id = `paperchain_${compact}Z`;
  process.env.NEUROPILOT_CYCLE_ID = id;
  process.env.EXPERIMENT_ID = id;
  console.log('[paper_data_chain] NEUROPILOT_CYCLE_ID/EXPERIMENT_ID unset → using single run id:', id);
}

function parseArgs(argv) {
  let skipDataEngine = false;
  let dataRootOverride = null;
  for (const a of argv) {
    if (a === '--skip-data-engine') skipDataEngine = true;
    else if (a.startsWith('--data-root=')) dataRootOverride = a.slice('--data-root='.length).trim();
  }
  return { skipDataEngine, dataRootOverride };
}

function safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function resolveRoot(dataRootOverride) {
  if (dataRootOverride) process.env.NEUROPILOT_DATA_ROOT = dataRootOverride;
  const dr = require('../dataRoot');
  dr.resetDataRoot();
  const root = dr.getDataRoot();
  if (!root || !fs.existsSync(root)) {
    throw new Error(
      'NEUROPILOT_DATA_ROOT must be set to an existing directory (use export or --data-root=).'
    );
  }
  return root;
}

/** Unique symbols from governance/paper_execution_v1_signals.json (uppercase), or []. */
function symbolsFromExistingSignalsFile(root) {
  const p = path.join(root, 'governance', 'paper_execution_v1_signals.json');
  const j = safeReadJson(p);
  const sigs = j && Array.isArray(j.signals) ? j.signals : [];
  const set = new Set();
  for (const s of sigs) {
    const sym = s && s.symbol != null ? String(s.symbol).toUpperCase().trim() : '';
    if (sym) set.add(sym);
  }
  return Array.from(set).sort();
}

/** CSV for NEUROPILOT_WAVE1_SYMBOLS: env wins; else derive from signals file; else fail. */
function resolveWave1SymbolsCsv(root) {
  const envCsv = String(process.env.NEUROPILOT_WAVE1_SYMBOLS || '').trim();
  if (envCsv) return envCsv;
  const derived = symbolsFromExistingSignalsFile(root);
  if (derived.length === 0) {
    throw new Error(
      'Set NEUROPILOT_WAVE1_SYMBOLS (CSV) or provide governance/paper_execution_v1_signals.json with symbols to derive from.'
    );
  }
  return derived.join(',');
}

function manifestDatasetKeysForSymbols(root, symbolsUpper) {
  const man = safeReadJson(path.join(root, 'datasets_manifest.json')) || { datasets: {} };
  const ds = man.datasets || {};
  const want = new Set(symbolsUpper.map((s) => String(s).toUpperCase()));
  const keys = [];
  for (const [key, entry] of Object.entries(ds)) {
    const sym = entry && entry.symbol != null ? String(entry.symbol).toUpperCase() : '';
    if (sym && want.has(sym)) keys.push(key);
  }
  return keys.sort();
}

function snapshotChainState(root, symbolKeys) {
  const { readBinaryStoreSync } = require('../datasetBinaryStore');
  const man = safeReadJson(path.join(root, 'datasets_manifest.json')) || { datasets: {} };
  const ds = man.datasets || {};
  let manifestMaxLastTs = null;
  const bins = {};
  const keysToScan = symbolKeys.length ? symbolKeys : Object.keys(ds).sort();

  for (const key of keysToScan) {
    const entry = ds[key];
    if (!entry) continue;
    const lt = entry.lastTs != null ? Number(entry.lastTs) : NaN;
    if (Number.isFinite(lt) && (manifestMaxLastTs == null || lt > manifestMaxLastTs)) manifestMaxLastTs = lt;

    let binRel = null;
    let lastBarIso = null;
    let rows = entry.rows != null ? Number(entry.rows) : null;
    const bp = entry.paths && entry.paths.bin ? String(entry.paths.bin).trim() : '';
    if (bp) {
      const abs = path.isAbsolute(bp) ? bp : path.join(root, bp);
      binRel = path.relative(root, abs);
      try {
        const { candles } = readBinaryStoreSync(abs);
        if (candles && candles.length) {
          const t = candles[candles.length - 1].time;
          if (Number.isFinite(t)) lastBarIso = new Date(t).toISOString();
          rows = candles.length;
        }
      } catch {
        lastBarIso = 'read_error';
      }
    }
    bins[key] = { manifestLastTs: Number.isFinite(lt) ? new Date(lt).toISOString() : null, lastBarIso, rows };
  }

  const sigPath = path.join(root, 'governance', 'paper_execution_v1_signals.json');
  const signalsMtimeMs = fs.existsSync(sigPath) ? fs.statSync(sigPath).mtimeMs : null;
  let signalsCount = null;
  let maxBarIndex = null;
  const sj = safeReadJson(sigPath);
  if (sj && Array.isArray(sj.signals)) {
    signalsCount = sj.signals.length;
    for (const s of sj.signals) {
      const bi = typeof s.barIndex === 'number' ? s.barIndex : null;
      if (bi != null && (maxBarIndex == null || bi > maxBarIndex)) maxBarIndex = bi;
    }
  }

  const jsonlPath = path.join(root, 'governance', 'paper_trades.jsonl');
  let jsonlLines = 0;
  let maxExitTsMs = null;
  if (fs.existsSync(jsonlPath)) {
    const raw = fs.readFileSync(jsonlPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
    jsonlLines = lines.length;
    const tail = lines.slice(-80);
    for (const line of tail) {
      try {
        const o = JSON.parse(line);
        const ex = o.exitTs || o.ts;
        if (ex) {
          const ms = Date.parse(ex);
          if (Number.isFinite(ms) && (maxExitTsMs == null || ms > maxExitTsMs)) maxExitTsMs = ms;
        }
      } catch {
        /* ignore */
      }
    }
  }

  return {
    manifestMaxLastTs,
    manifestMaxLastIso:
      manifestMaxLastTs != null && Number.isFinite(manifestMaxLastTs)
        ? new Date(manifestMaxLastTs).toISOString()
        : null,
    bins,
    signalsMtimeMs,
    signalsCount,
    maxBarIndex,
    jsonlLines,
    maxExitTsIso: maxExitTsMs != null ? new Date(maxExitTsMs).toISOString() : null,
  };
}

function printSnapshot(label, s) {
  console.log(`[paper_data_chain] ${label} manifestMaxLastIso=${s.manifestMaxLastIso || 'n/a'}`);
  console.log(`[paper_data_chain] ${label} signalsCount=${s.signalsCount ?? 'n/a'} maxBarIndex=${s.maxBarIndex ?? 'n/a'}`);
  console.log(`[paper_data_chain] ${label} jsonlLines=${s.jsonlLines} maxExitTsTail=${s.maxExitTsIso || 'n/a'}`);
  const binKeys = Object.keys(s.bins).slice(0, 12);
  for (const k of binKeys) {
    const b = s.bins[k];
    console.log(
      `[paper_data_chain] ${label} bin[${k}] lastBar=${b.lastBarIso || 'n/a'} rows=${b.rows ?? 'n/a'}`
    );
  }
  if (Object.keys(s.bins).length > 12) {
    console.log(`[paper_data_chain] ${label} ... (${Object.keys(s.bins).length} dataset keys total)`);
  }
}

async function main() {
  const { skipDataEngine, dataRootOverride } = parseArgs(process.argv.slice(2));
  const root = resolveRoot(dataRootOverride);
  ensurePaperChainCycleEnv();

  const wave1Csv = resolveWave1SymbolsCsv(root);
  const symbolList = wave1Csv
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  const datasetKeysForSnap = manifestDatasetKeysForSymbols(root, symbolList);

  console.log('[paper_data_chain] NEUROPILOT_DATA_ROOT=', root);
  console.log('[paper_data_chain] NEUROPILOT_WAVE1_SYMBOLS=', wave1Csv);

  const before = snapshotChainState(root, datasetKeysForSnap);
  printSnapshot('BEFORE', before);

  if (!skipDataEngine) {
    console.log('[paper_data_chain] Step 1/3: runDataEngine.js (network/providers may be required)');
    const { run } = require('../data/runDataEngine');
    await run();
  } else {
    console.log('[paper_data_chain] Step 1/3: SKIPPED (--skip-data-engine)');
  }

  process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS = '1';
  process.env.NEUROPILOT_WAVE1_SYMBOLS = wave1Csv;

  console.log('[paper_data_chain] Step 2/3: buildPaperExecutionV1SignalsWave1');
  const { runBuildWave1PaperSignalsFile } = require('./buildPaperExecutionV1SignalsWave1');
  const sigRes = runBuildWave1PaperSignalsFile({ dataRoot: root });
  if (!sigRes.ok) {
    console.error('[paper_data_chain] FATAL signals:', sigRes.skipped || 'unknown');
    process.exit(1);
  }
  console.log(
    '[paper_data_chain] signals built merged total',
    sigRes.merged,
    'primarySource',
    (sigRes.audit && sigRes.audit.primarySource) || '—'
  );

  process.env.NEUROPILOT_PAPER_EXEC_V1 = '1';
  console.log('[paper_data_chain] Step 3/3: runPaperExecutionV1');
  const { runPaperExecutionV1 } = require('./runPaperExecutionV1');
  const pe = runPaperExecutionV1({ dataRoot: root });
  if (!pe.enabled) {
    console.error('[paper_data_chain] FATAL paper exec disabled:', pe.skipped);
    process.exit(1);
  }
  if (pe.skipped) {
    console.error('[paper_data_chain] FATAL paper exec skipped:', pe.skipped);
    process.exit(1);
  }
  console.log('[paper_data_chain] paper_exec appended', pe.appended, '→', pe.outPath);
  if (!Number.isFinite(Number(pe.appended)) || Number(pe.appended) <= 0) {
    console.error(
      '[paper_data_chain] FATAL zero trades appended (bins missing, all signals skipped, or simulate skip)'
    );
    process.exit(1);
  }

  const after = snapshotChainState(root, datasetKeysForSnap);
  printSnapshot('AFTER', after);

  const lineDelta = after.jsonlLines - before.jsonlLines;
  const tsAfter = after.manifestMaxLastTs != null ? after.manifestMaxLastTs : -Infinity;
  const tsBefore = before.manifestMaxLastTs != null ? before.manifestMaxLastTs : -Infinity;
  const manifestAdvanced = tsAfter > tsBefore;
  const exitAdvanced =
    after.maxExitTsIso &&
    before.maxExitTsIso &&
    Date.parse(after.maxExitTsIso) > Date.parse(before.maxExitTsIso);

  console.log('[paper_data_chain] SUMMARY lineDelta=', lineDelta, 'appended=', pe.appended);
  console.log(
    '[paper_data_chain] SUMMARY manifest_last_candle_advanced=',
    manifestAdvanced,
    'exitTs_tail_advanced=',
    !!exitAdvanced
  );

  if (!skipDataEngine && !manifestAdvanced && lineDelta <= 0) {
    console.error(
      '[paper_data_chain] WARN: no manifest lastTs advance and no new jsonl lines — providers may have returned no new bars, or datasets missing.'
    );
  }
  if (skipDataEngine && !exitAdvanced && lineDelta <= 0) {
    console.error(
      '[paper_data_chain] WARN: --skip-data-engine and no exitTs/jsonl advance — inconclusive freshness (expected if bins unchanged).'
    );
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[paper_data_chain] FATAL', e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = {
  resolveWave1SymbolsCsv,
  symbolsFromExistingSignalsFile,
  snapshotChainState,
};
