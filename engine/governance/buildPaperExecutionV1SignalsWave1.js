#!/usr/bin/env node
'use strict';

/**
 * Build / merge governance/paper_execution_v1_signals.json with per-symbol Wave1 signals.
 *
 * Priority when NEUROPILOT_WAVE1_FORCE_SIGNALS=1:
 *   1) setup_*.json under <DATA_ROOT>/generated_strategies (e.g. setup_mut_*, setup_champion_*, …)
 *   2) meta_ranking.json strategies × Wave1 × manifest
 *   3) Fixture example signals (backward-compat only if 1+2 produce zero signals)
 *
 * NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED=1 alone also enables the script; it uses
 * only path (1), then (3) if (1) is empty — never meta_ranking.
 *
 * Generated signals: strategyId defaults to setup.strategyId if set, else setupId; rMultiple
 * from setup / rules when finite & positive, else deterministic derivedRMultiple(seed).
 *
 * When this run emits non-fallback signals, existing signals with example_* ids are dropped
 * before merge so stale examples do not mask AI rows.
 *
 * Opt-in: NEUROPILOT_WAVE1_FORCE_SIGNALS=1 (or true/yes/on)
 *         NEUROPILOT_WAVE1_SYMBOLS — CSV symbols present in <DATA_ROOT>/datasets_manifest.json
 *         (e.g. BTCUSDT,ETHUSDT,SPY). Optional DOCUMENTATION suffix SYMBOL:5m — :tf is ignored for matching.
 * Datasets manifest path: <DATA_ROOT>/datasets_manifest.json (not under governance/).
 *
 * Optional:
 *   NEUROPILOT_WAVE1_PAPER_STRATEGY_ID — used for meta_ranking path only (default EMA_pullback_v2)
 *   NEUROPILOT_WAVE1_GENERATED_MAX_SETUPS — cap setups scanned (default 80, newest mtime first)
 *   NEUROPILOT_WAVE1_PAPER_MAX_SIGNALS_PER_SYMBOL — default 2 (or 6 if scale mode)
 *   NEUROPILOT_WAVE1_PAPER_MAX_TOTAL — default 8 (or 30 if scale mode)
 *   NEUROPILOT_WAVE1_PAPER_MAX_SIGNALS_EMA_PULLBACK_V2 — optional hard cap on strategyId EMA_pullback_v2
 *     after merge (paper signals file only; unset = no cap). Reduces EMA dominance without touching live execution.
 *   NEUROPILOT_WAVE1_PAPER_SCALE_MODE=1 — larger caps + pipeline paper opt-in semantics
 *   NEUROPILOT_WAVE1_SIGNAL_ROTATION=1 — rotate meta strategy order
 *   NEUROPILOT_WAVE1_PAPER_STOP_FRAC — stopDistance ≈ lastClose * frac (default 0.0025)
 *
 * Run: node engine/governance/buildPaperExecutionV1SignalsWave1.js
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const { readBinaryStoreSync } = require('../datasetBinaryStore');
const { collectSymbolsFromMetaRow } = require('../evolution/wave1NextGenInjection');
const { derivedRMultiple, numericSeed } = require('../evolution/nextGenSignalRulePatches');
const riskEngine = require('../execution/executionRiskEngine');

const EXAMPLE_FALLBACK_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'paper_execution_v1_signals.example.json'
);

const PROMOTED_MANIFEST_SIGNAL_SOURCE = 'promoted_manifest';
const PROMOTED_MANIFEST_FILENAME = 'promoted_manifest.json';
const PROMOTED_MANIFEST_SCHEMA_VERSION = 1;
const PROMOTED_MANIFEST_INTERNAL_DEDUP_COLLISION = 'PROMOTED_MANIFEST_INTERNAL_DEDUP_COLLISION';
const PROMOTED_MANIFEST_IDENTITY_MISMATCH = 'PROMOTED_MANIFEST_IDENTITY_MISMATCH';
const PROMOTED_MANIFEST_ITEM_INVALID = 'PROMOTED_MANIFEST_ITEM_INVALID';

function envBool(name) {
  const v = (process.env[name] || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function safeTrimmedString(v) {
  if (v == null) return '';
  return String(v).trim();
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function buildPromotedManifestPath(root) {
  return path.join(root, 'discovery', PROMOTED_MANIFEST_FILENAME);
}

function cloneJsonValue(v) {
  if (v === null || typeof v !== 'object') return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

function safeReadPromotedManifest(manifestPath) {
  const doc = safeReadJson(manifestPath);
  if (!doc || typeof doc !== 'object') return null;
  return doc;
}

function metaRowScore(row) {
  const stab = Number(row.stability);
  const val = Number(row.validation_score);
  return Number.isFinite(stab) ? stab : Number.isFinite(val) ? val : -Infinity;
}

function listDatasetKeysForSymbol(manifest, symUpper) {
  const out = [];
  const ds = manifest && manifest.datasets;
  if (!ds || typeof ds !== 'object') return out;
  const su = String(symUpper).toUpperCase();
  for (const [key, entry] of Object.entries(ds)) {
    if (!entry) continue;
    const s = entry.symbol != null ? String(entry.symbol).toUpperCase() : '';
    if (s === su && entry.paths && entry.paths.bin) out.push({ key, entry });
  }
  const order = { '5m': 1, '15m': 2, '1h': 3, '30m': 4, '1d': 5 };
  out.sort((a, b) => (order[String(a.entry.timeframe)] || 99) - (order[String(b.entry.timeframe)] || 99));
  return out;
}

function computeStopDistanceFromBin(binPath, frac) {
  const f = Number.isFinite(Number(frac)) ? Number(frac) : 0.0025;
  try {
    const { candles } = readBinaryStoreSync(binPath);
    if (!candles.length) return null;
    const c = candles[candles.length - 1];
    const cl = Number(c.close);
    if (!Number.isFinite(cl) || cl <= 0) return null;
    const d = Math.max(cl * f, 1e-8);
    return Math.round(d * 1e8) / 1e8;
  } catch {
    return null;
  }
}

function computeBarIndex(rowCount) {
  const rc = Math.max(1, Math.floor(Number(rowCount) || 0));
  const idx = Math.max(0, Math.floor(rc * 0.88) - 1);
  return idx;
}

function signalDedupeKey(s) {
  return `${s.datasetKey || ''}|${s.barIndex}|${s.strategyId || ''}|${s.setupId || ''}|${s.forcedWave1 ? 'w1' : ''}`;
}

function resolveMaxSignalsPerSymbol() {
  const raw = process.env.NEUROPILOT_WAVE1_PAPER_MAX_SIGNALS_PER_SYMBOL;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n > 0 ? n : 1;
  }
  if (envBool('NEUROPILOT_WAVE1_PAPER_SCALE_MODE')) return 6;
  return 2;
}

function resolveMaxSignalsTotal() {
  const raw = process.env.NEUROPILOT_WAVE1_PAPER_MAX_TOTAL;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n > 0 ? n : 1;
  }
  if (envBool('NEUROPILOT_WAVE1_PAPER_SCALE_MODE')) return 30;
  return 8;
}

/**
 * Per-strategyId caps on merged paper signals (order-preserving: drops excess rows for capped ids only).
 * @param {object[]} signals
 * @param {Record<string, number>} capsByStrategyId — max rows per strategyId; omitted ids uncapped
 * @returns {object[]}
 */
function applyMaxSignalsPerStrategyId(signals, capsByStrategyId) {
  const caps =
    capsByStrategyId && typeof capsByStrategyId === 'object' && !Array.isArray(capsByStrategyId)
      ? capsByStrategyId
      : {};
  const keys = Object.keys(caps);
  if (keys.length === 0) return Array.isArray(signals) ? signals.slice() : [];
  const counts = Object.create(null);
  const out = [];
  for (const s of Array.isArray(signals) ? signals : []) {
    if (!s || typeof s !== 'object') continue;
    const sid = String(s.strategyId || '').trim();
    const capRaw = caps[sid];
    if (capRaw == null || capRaw === '') {
      out.push(s);
      continue;
    }
    const maxN = Math.floor(Number(capRaw));
    if (!Number.isFinite(maxN) || maxN < 0) {
      out.push(s);
      continue;
    }
    counts[sid] = (counts[sid] || 0) + 1;
    if (counts[sid] <= maxN) out.push(s);
  }
  return out;
}

/** @returns {number|null} null = no cap (default, backward compatible) */
function resolveEmaPullbackV2PaperSignalCap() {
  const raw = process.env.NEUROPILOT_WAVE1_PAPER_MAX_SIGNALS_EMA_PULLBACK_V2;
  if (raw === undefined || String(raw).trim() === '') return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function stableHash32(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function applySignalRotation(scored, audit) {
  if (!envBool('NEUROPILOT_WAVE1_SIGNAL_ROTATION')) {
    audit.signalRotation = { enabled: false };
    return scored;
  }
  const n = scored.length;
  if (n <= 1) {
    audit.signalRotation = { enabled: true, offset: 0, totalStrategies: n };
    return scored;
  }
  const seedStr =
    process.env.NEUROPILOT_SIGNAL_ROTATION_SEED ||
    process.env.NEUROPILOT_CYCLE_ID ||
    process.env.EXPERIMENT_ID ||
    new Date().toISOString().slice(0, 16);
  const offset = stableHash32(seedStr) % n;
  audit.signalRotation = {
    enabled: true,
    seedKey: seedStr.length > 120 ? `${seedStr.slice(0, 117)}...` : seedStr,
    offset,
    totalStrategies: n,
  };
  return [...scored.slice(offset), ...scored.slice(0, offset)];
}

function resolveGeneratedMaxSetups() {
  const raw = process.env.NEUROPILOT_WAVE1_GENERATED_MAX_SETUPS;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n > 0 ? n : 80;
  }
  return 80;
}

/**
 * Newest first; only JSON with setupId + rules object. Fail-soft per file.
 * mutFilesSeen counts matching filenames (backward-compat property name).
 * @returns {{ setups: object[], skippedInvalid: number, mutFilesSeen: number }}
 */
function loadMutationSetupsFromGeneratedDir(generatedDir, maxSetups) {
  const cap = Math.max(1, Math.floor(maxSetups || 80));
  const stats = { skippedInvalid: 0, mutFilesSeen: 0 };
  if (!generatedDir || !fs.existsSync(generatedDir)) {
    return { setups: [], ...stats };
  }
  let names;
  try {
    names = fs.readdirSync(generatedDir);
  } catch {
    return { setups: [], ...stats };
  }
  // All generated setup JSON: setup_mut_*, setup_champion_*, etc. (not only mutations).
  const jsonSetup = names.filter((f) => f.startsWith('setup_') && f.endsWith('.json'));
  stats.mutFilesSeen = jsonSetup.length;
  const pairs = [];
  for (const f of jsonSetup) {
    const full = path.join(generatedDir, f);
    let st;
    let doc;
    try {
      st = fs.statSync(full);
      doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      stats.skippedInvalid += 1;
      continue;
    }
    if (!doc || typeof doc !== 'object') {
      stats.skippedInvalid += 1;
      continue;
    }
    const sid = doc.setupId != null ? String(doc.setupId).trim() : '';
    if (!sid) {
      stats.skippedInvalid += 1;
      continue;
    }
    if (!doc.rules || typeof doc.rules !== 'object') {
      stats.skippedInvalid += 1;
      continue;
    }
    pairs.push({ mtimeMs: st.mtimeMs, doc });
  }
  pairs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    setups: pairs.slice(0, cap).map((p) => p.doc),
    skippedInvalid: stats.skippedInvalid,
    mutFilesSeen: stats.mutFilesSeen,
  };
}

function resolveRMultipleFromSetup(setup, seedStr) {
  const rTop = Number(setup && setup.rMultiple);
  if (Number.isFinite(rTop) && rTop > 0) return Math.round(rTop * 100) / 100;
  const rules = setup && setup.rules;
  const rR = rules && Number(rules.rMultiple);
  if (Number.isFinite(rR) && rR > 0) return Math.round(rR * 100) / 100;
  return derivedRMultiple(numericSeed(seedStr));
}

function resolveStrategyIdFromSetup(setup) {
  const sid = setup && setup.setupId != null ? String(setup.setupId).trim() : '';
  const strat = setup && setup.strategyId != null ? String(setup.strategyId).trim() : '';
  return strat || sid;
}

function resolveDirectionFromSetup(setup) {
  const raw =
    setup && (setup.direction != null ? setup.direction : setup.rules && setup.rules.direction);
  const d = String(raw || 'long').trim().toLowerCase();
  if (d === 'short' || d === 'sell') return 'short';
  return 'long';
}

/** Map meta_ranking strategy row → shape expected by resolveRMultipleFromSetup / resolveStrategyIdFromSetup. */
function metaRowAsSetupLike(r) {
  if (!r || typeof r !== 'object') return { setupId: '', rules: {} };
  const rules =
    r.rules && typeof r.rules === 'object' && !Array.isArray(r.rules) ? { ...r.rules } : {};
  return {
    setupId: r.setupId,
    strategyId: r.strategyId,
    rMultiple: r.rMultiple,
    direction: r.direction,
    rules,
  };
}

/**
 * One Wave1 paper signal row from a generated mutation setup + resolved dataset context.
 */
function toWave1PaperSignalFromGeneratedSetup(setup, ctx) {
  const { datasetKey, entry, sym, barIndex, stopDistance } = ctx;
  const setupId = String(setup.setupId);
  const rules = { ...setup.rules };
  const seedStr = `${setupId}|${datasetKey}|${sym}|${entry.timeframe || ''}`;
  return {
    strategyId: resolveStrategyIdFromSetup(setup),
    setupId,
    rules,
    datasetKey,
    symbol: sym,
    timeframe: entry.timeframe || null,
    barIndex,
    entryAtBarClose: true,
    stopDistance,
    direction: resolveDirectionFromSetup(setup),
    rMultiple: resolveRMultipleFromSetup(setup, seedStr),
    maxBarsHeld: 500,
    forcedWave1: true,
    signalSource: 'generated_strategies',
  };
}

/**
 * @param {object} item - promoted_manifest.items[] entry
 * @returns {{ ok: true, signal: object } | { ok: false, reasonCode: string }}
 */
function toWave1PaperSignalFromPromotedManifestItem(item) {
  if (!item || typeof item !== 'object') {
    return { ok: false, reasonCode: PROMOTED_MANIFEST_ITEM_INVALID };
  }
  const setupId = safeTrimmedString(item.setupId);
  const strategyId = safeTrimmedString(item.strategyId);
  if (!setupId || !strategyId || setupId !== strategyId) {
    return { ok: false, reasonCode: PROMOTED_MANIFEST_IDENTITY_MISMATCH };
  }
  const rulesRaw = cloneJsonValue(item.rules);
  if (
    !rulesRaw ||
    typeof rulesRaw !== 'object' ||
    Array.isArray(rulesRaw) ||
    Object.keys(rulesRaw).length === 0
  ) {
    return { ok: false, reasonCode: PROMOTED_MANIFEST_ITEM_INVALID };
  }
  const datasetKey = safeTrimmedString(item.datasetKey);
  if (!datasetKey) {
    return { ok: false, reasonCode: PROMOTED_MANIFEST_ITEM_INVALID };
  }
  const barIndex = Number(item.barIndex);
  if (!Number.isFinite(barIndex)) {
    return { ok: false, reasonCode: PROMOTED_MANIFEST_ITEM_INVALID };
  }
  const stopDistance = Number(item.stopDistance);
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return { ok: false, reasonCode: PROMOTED_MANIFEST_ITEM_INVALID };
  }
  const dir = safeTrimmedString(item.direction).toLowerCase();
  if (dir !== 'long' && dir !== 'short') {
    return { ok: false, reasonCode: PROMOTED_MANIFEST_ITEM_INVALID };
  }
  const rMult = Number(item.rMultiple);
  if (!Number.isFinite(rMult) || rMult <= 0) {
    return { ok: false, reasonCode: PROMOTED_MANIFEST_ITEM_INVALID };
  }
  const maxBarsHeld = Number(item.maxBarsHeld);
  const maxBarsHeldOut =
    Number.isFinite(maxBarsHeld) && maxBarsHeld > 0 ? Math.floor(maxBarsHeld) : 500;
  const entryAtBarClose = item.entryAtBarClose === false ? false : true;
  const symbol = item.symbol != null ? String(item.symbol) : '';
  const timeframe = item.timeframe != null ? String(item.timeframe) : null;
  const signal = {
    strategyId,
    setupId,
    rules: rulesRaw,
    datasetKey,
    symbol,
    timeframe,
    barIndex,
    entryAtBarClose,
    stopDistance,
    direction: dir,
    rMultiple: Math.round(rMult * 100) / 100,
    maxBarsHeld: maxBarsHeldOut,
    forcedWave1: true,
    signalSource: PROMOTED_MANIFEST_SIGNAL_SOURCE,
  };
  return { ok: true, signal };
}

/** True if strategyId or setupId looks like the legacy example_* fixture ids. */
function isExamplePaperSignal(s) {
  if (!s || typeof s !== 'object') return false;
  const sid = String(s.strategyId || '');
  const st = String(s.setupId || '');
  return /^example_/i.test(sid) || /^example_/i.test(st);
}

function wave1PaperStrategyIdDefault() {
  return (
    String(process.env.NEUROPILOT_WAVE1_PAPER_STRATEGY_ID || 'EMA_pullback_v2').trim() ||
    'EMA_pullback_v2'
  );
}

function hasNonEmptyRulesObject(rules) {
  return (
    rules &&
    typeof rules === 'object' &&
    !Array.isArray(rules) &&
    Object.keys(rules).length > 0
  );
}

/**
 * Conservative inference for legacy rows missing signalSource. If unclear → do not guess.
 */
function inferLegacySignalSource(signal) {
  if (!signal || typeof signal !== 'object') return null;
  if (isExamplePaperSignal(signal)) return null;
  const su = String(signal.setupId || '').trim();
  const st = String(signal.strategyId || '').trim();
  if (/^(mut_|familyexp_)/i.test(su)) return 'generated_strategies';
  if (/^(mut_|familyexp_)/i.test(st)) return 'generated_strategies';
  if (su && st && su === st) return 'generated_strategies';
  if (hasNonEmptyRulesObject(signal.rules)) return 'generated_strategies';
  const def = wave1PaperStrategyIdDefault();
  if (su && st && st === def && !hasNonEmptyRulesObject(signal.rules)) return 'meta_ranking';
  return null;
}

/** Required for traceability (aligns with jq checks on merged file). */
function historySignalHasRequiredTraceFields(s) {
  if (!s || typeof s !== 'object') return false;
  const su = String(s.setupId || '').trim();
  const st = String(s.strategyId || '').trim();
  if (!su || !st) return false;
  const dir = String(s.direction || '').trim().toLowerCase();
  if (dir !== 'long' && dir !== 'short') return false;
  const r = Number(s.rMultiple);
  if (!Number.isFinite(r) || r <= 0) return false;
  return true;
}

/**
 * Legacy history row → copy with signalSource, or null to drop (untraceable / invalid).
 * @returns {{ signal: object, sourceInferred: boolean } | null}
 */
function normalizeHistorySignalForMerge(signal) {
  if (!signal || typeof signal !== 'object') return null;
  const rawSrc = signal.signalSource;
  const existing =
    typeof rawSrc === 'string' && rawSrc.trim() !== '' ? rawSrc.trim() : '';
  let sourceInferred = false;
  let src;
  if (existing) {
    src = existing;
  } else {
    const g = inferLegacySignalSource(signal);
    if (!g) return null;
    src = g;
    sourceInferred = true;
  }
  if (!historySignalHasRequiredTraceFields(signal)) return null;
  return { signal: { ...signal, signalSource: src }, sourceInferred };
}

/**
 * @returns {{ cleaned: object[], legacy_signals_loaded: number, legacy_signals_normalized: number, legacy_signals_dropped_missing_source: number, legacy_signals_source_inferred: number, merged_signals_retained_from_history: number }}
 */
function filterNormalizeHistorySignalsForMerge(signals) {
  const legacy_signals_loaded = Array.isArray(signals) ? signals.length : 0;
  let legacy_signals_source_inferred = 0;
  const cleaned = [];
  const arr = Array.isArray(signals) ? signals : [];
  for (const s of arr) {
    const n = normalizeHistorySignalForMerge(s);
    if (!n) continue;
    cleaned.push(n.signal);
    if (n.sourceInferred) legacy_signals_source_inferred += 1;
  }
  const legacy_signals_normalized = cleaned.length;
  const legacy_signals_dropped_missing_source = legacy_signals_loaded - legacy_signals_normalized;
  return {
    cleaned,
    legacy_signals_loaded,
    legacy_signals_normalized,
    legacy_signals_dropped_missing_source,
    legacy_signals_source_inferred,
    merged_signals_retained_from_history: legacy_signals_normalized,
  };
}

function loadExampleFallbackSignals() {
  const doc = safeReadJson(EXAMPLE_FALLBACK_FIXTURE);
  const arr = doc && Array.isArray(doc.signals) ? doc.signals : [];
  return arr
    .filter((x) => x && typeof x === 'object')
    .map((x) => {
      const strat = String(x.strategyId || '').trim() || 'example_fallback_signal';
      const sup = String(x.setupId || '').trim() || strat;
      return {
        ...x,
        setupId: sup,
        strategyId: strat,
        forcedWave1: true,
        signalSource: 'example_fallback',
      };
    });
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataRoot]
 * @returns {{ signals: object[], audit: object }}
 */
function buildWave1PaperSignalsFromGenerated(opts = {}) {
  const audit = {
    enabled: true,
    signalSource: 'generated_strategies',
    wave1Symbols: [],
    setupsLoaded: 0,
    generated_setups_loaded: 0,
    generated_setups_eligible: 0,
    generated_setups_skipped_invalid: 0,
    generated_setups_mut_files_seen: 0,
    signalsBuilt: 0,
    skippedNoManifestBin: [],
    skippedMissingBinFile: [],
    perWave1SymbolCount: {},
    note: null,
  };

  const root = opts.dataRoot || dataRoot.getDataRoot();
  const wave1 = riskEngine.parseWave1SymbolSet();
  if (wave1.size === 0) {
    audit.note = 'NEUROPILOT_WAVE1_SYMBOLS_empty';
    audit.enabled = false;
    return { signals: [], audit };
  }

  const generatedDir =
    opts.generatedDir || path.join(root, 'generated_strategies');
  const maxSetups = resolveGeneratedMaxSetups();
  const { setups, skippedInvalid, mutFilesSeen } = loadMutationSetupsFromGeneratedDir(
    generatedDir,
    maxSetups
  );
  audit.setupsLoaded = setups.length;
  audit.generated_setups_loaded = setups.length;
  audit.generated_setups_skipped_invalid = skippedInvalid;
  audit.generated_setups_mut_files_seen = mutFilesSeen;
  audit.generatedDir = generatedDir;
  audit.generatedMaxSetups = maxSetups;

  if (setups.length === 0) {
    audit.note = 'no_setup_mut_json_under_generated_strategies';
    audit.generated_setups_eligible = 0;
    return { signals: [], audit };
  }

  const manifestPath = path.join(root, 'datasets_manifest.json');
  const manifest = safeReadJson(manifestPath) || {};

  const scaleMode = envBool('NEUROPILOT_WAVE1_PAPER_SCALE_MODE');
  const maxPerSym = resolveMaxSignalsPerSymbol();
  const maxTotal = resolveMaxSignalsTotal();
  const stopFrac = Number(process.env.NEUROPILOT_WAVE1_PAPER_STOP_FRAC) || 0.0025;

  const perWave1SymbolCount = Object.create(null);
  for (const s of wave1) perWave1SymbolCount[s] = 0;

  const out = [];
  const seenKey = new Set();
  const setupsWithSignal = new Set();
  let skippedStopDistanceNull = 0;

  outer: for (const setup of setups) {
    if (out.length >= maxTotal) break;
    const setupId = String(setup.setupId);

    for (const sym of [...wave1].sort()) {
      if (out.length >= maxTotal) break outer;
      if (perWave1SymbolCount[sym] >= maxPerSym) continue;

      const keys = listDatasetKeysForSymbol(manifest, sym);
      if (!keys.length) {
        if (!audit.skippedNoManifestBin.includes(sym)) audit.skippedNoManifestBin.push(sym);
        continue;
      }

      for (const { key: datasetKey, entry } of keys) {
        if (out.length >= maxTotal) break outer;
        if (perWave1SymbolCount[sym] >= maxPerSym) break;

        const binPath = entry.paths.bin;
        const absBin = path.isAbsolute(binPath) ? binPath : path.join(root, binPath);
        if (!fs.existsSync(absBin)) {
          if (!audit.skippedMissingBinFile.includes(datasetKey)) audit.skippedMissingBinFile.push(datasetKey);
          continue;
        }

        const stopDistance = computeStopDistanceFromBin(absBin, stopFrac);
        if (stopDistance == null) {
          skippedStopDistanceNull += 1;
          continue;
        }

        let rows = Number(entry.rows);
        if (!Number.isFinite(rows)) {
          try {
            rows = readBinaryStoreSync(absBin).candles.length;
          } catch {
            continue;
          }
        }
        const barIndex = computeBarIndex(rows);

        const candidate = toWave1PaperSignalFromGeneratedSetup(setup, {
          datasetKey,
          entry,
          sym,
          barIndex,
          stopDistance,
        });
        const dk = signalDedupeKey(candidate);
        if (seenKey.has(dk)) continue;
        seenKey.add(dk);

        out.push(candidate);
        setupsWithSignal.add(setupId);
        perWave1SymbolCount[sym] += 1;
      }
    }
  }

  audit.wave1Symbols = Array.from(wave1).sort();
  audit.signalsBuilt = out.length;
  audit.generated_setups_eligible = setupsWithSignal.size;
  audit.perWave1SymbolCount = perWave1SymbolCount;
  audit.skippedStopDistanceNull = skippedStopDistanceNull;
  audit.datasetsManifestPath = manifestPath;
  audit.scaleMode = scaleMode;
  audit.maxSignalsPerSymbol = maxPerSym;
  audit.maxSignalsTotal = maxTotal;
  if (out.length === 0) {
    audit.note =
      'No signals from generated setups: check <DATA_ROOT>/datasets_manifest.json bins exist for NEUROPILOT_WAVE1_SYMBOLS, files on disk, and stopDistance (see skippedStopDistanceNull / skippedNoManifestBin / skippedMissingBinFile).';
  }
  return { signals: out, audit };
}

/**
 * Wave1 signals from meta_ranking strategies × Wave1 symbols × manifest datasets.
 * @param {object} [opts]
 * @param {string} [opts.dataRoot]
 * @returns {{ signals: object[], audit: object }}
 */
function buildWave1PaperSignals(opts = {}) {
  const audit = {
    enabled: true,
    signalSource: 'meta_ranking',
    wave1Symbols: [],
    strategiesTouched: 0,
    signalsBuilt: 0,
    skippedNoManifestBin: [],
    skippedMissingBinFile: [],
    perWave1SymbolCount: {},
    note: null,
  };

  const root = opts.dataRoot || dataRoot.getDataRoot();
  const wave1 = riskEngine.parseWave1SymbolSet();
  if (wave1.size === 0) {
    audit.note = 'NEUROPILOT_WAVE1_SYMBOLS_empty';
    audit.enabled = false;
    return { signals: [], audit };
  }

  const metaPath = path.join(root, 'discovery', 'meta_ranking.json');
  const meta = safeReadJson(metaPath);
  const strategies = Array.isArray(meta && meta.strategies) ? meta.strategies : [];

  const manifestPath = path.join(root, 'datasets_manifest.json');
  const manifest = safeReadJson(manifestPath) || {};

  const strategyIdDefault =
    String(process.env.NEUROPILOT_WAVE1_PAPER_STRATEGY_ID || 'EMA_pullback_v2').trim() ||
    'EMA_pullback_v2';

  const scaleMode = envBool('NEUROPILOT_WAVE1_PAPER_SCALE_MODE');
  const maxPerSym = resolveMaxSignalsPerSymbol();
  const maxTotal = resolveMaxSignalsTotal();
  const stopFrac = Number(process.env.NEUROPILOT_WAVE1_PAPER_STOP_FRAC) || 0.0025;

  const perWave1SymbolCount = Object.create(null);
  for (const s of wave1) perWave1SymbolCount[s] = 0;

  let scored = strategies
    .filter((r) => r && r.setupId)
    .map((r) => ({ r, sc: metaRowScore(r) }))
    .sort((a, b) => b.sc - a.sc);

  scored = applySignalRotation(scored, audit);

  const out = [];
  const seenKey = new Set();

  outer: for (const { r } of scored) {
    if (out.length >= maxTotal) break;

    const rowSyms = collectSymbolsFromMetaRow(r);
    const hit = [...wave1].filter((w) => rowSyms.has(w)).sort();
    if (hit.length === 0) continue;
    audit.strategiesTouched += 1;

    for (const sym of hit) {
      if (out.length >= maxTotal) break outer;
      if (perWave1SymbolCount[sym] >= maxPerSym) continue;

      const keys = listDatasetKeysForSymbol(manifest, sym);
      if (!keys.length) {
        if (!audit.skippedNoManifestBin.includes(sym)) audit.skippedNoManifestBin.push(sym);
        continue;
      }

      for (const { key: datasetKey, entry } of keys) {
        if (out.length >= maxTotal) break outer;
        if (perWave1SymbolCount[sym] >= maxPerSym) break;

        const binPath = entry.paths.bin;
        const absBin = path.isAbsolute(binPath) ? binPath : path.join(root, binPath);
        if (!fs.existsSync(absBin)) {
          if (!audit.skippedMissingBinFile.includes(datasetKey)) audit.skippedMissingBinFile.push(datasetKey);
          continue;
        }

        const stopDistance = computeStopDistanceFromBin(absBin, stopFrac);
        if (stopDistance == null) continue;

        let rows = Number(entry.rows);
        if (!Number.isFinite(rows)) {
          try {
            rows = readBinaryStoreSync(absBin).candles.length;
          } catch {
            continue;
          }
        }
        const barIndex = computeBarIndex(rows);
        const setupLike = metaRowAsSetupLike(r);
        const seedStr = `${String(r.setupId)}|${datasetKey}|${sym}|${entry.timeframe || ''}`;
        const resolvedRMultiple = resolveRMultipleFromSetup(setupLike, seedStr);
        const candidate = {
          strategyId: strategyIdDefault,
          setupId: String(r.setupId),
          datasetKey,
          symbol: sym,
          timeframe: entry.timeframe || null,
          barIndex,
          entryAtBarClose: true,
          stopDistance,
          direction: resolveDirectionFromSetup(setupLike),
          rMultiple: resolvedRMultiple,
          maxBarsHeld: 500,
          forcedWave1: true,
          signalSource: 'meta_ranking',
        };
        if (setupLike.rules && Object.keys(setupLike.rules).length > 0) {
          candidate.rules = setupLike.rules;
        }
        const dk = signalDedupeKey(candidate);
        if (seenKey.has(dk)) continue;
        seenKey.add(dk);

        out.push(candidate);
        perWave1SymbolCount[sym] += 1;
      }
    }
  }

  audit.wave1Symbols = Array.from(wave1).sort();
  audit.signalsBuilt = out.length;
  audit.perWave1SymbolCount = perWave1SymbolCount;
  audit.scaleMode = scaleMode;
  audit.maxSignalsPerSymbol = maxPerSym;
  audit.maxSignalsTotal = maxTotal;
  if (out.length === 0) {
    audit.note =
      'No signals: meta rows may not list Wave1 symbols in variants/byAsset, or datasets_manifest has no bins for those symbols.';
  }
  return { signals: out, audit };
}

function mergeWithExisting(existingSignals, newSignals) {
  const map = new Map();
  for (const s of existingSignals) {
    if (s && typeof s === 'object') map.set(signalDedupeKey(s), s);
  }
  for (const s of newSignals) {
    map.set(signalDedupeKey(s), s);
  }
  return Array.from(map.values());
}

/**
 * @param {object[]} signals
 * @param {object|null} promotedManifestDoc
 * @returns {{ signals: object[], audit: object }}
 */
function mergePromotedManifestSignals(signals, promotedManifestDoc) {
  const mergeRejected = [];
  const auditBase = {
    manifestPresent: false,
    manifestPath: null,
    promotedManifestSignalsIn: 0,
    promotedManifestSignalsOut: 0,
    mergeRejected,
    mergeRejectedCount: 0,
    staleRemovedCount: 0,
  };

  if (!Array.isArray(signals)) {
    return { signals: [], audit: auditBase };
  }

  if (!promotedManifestDoc) {
    return { signals: signals.slice(), audit: auditBase };
  }

  auditBase.manifestPresent = true;
  const items = safeArray(promotedManifestDoc.items);
  auditBase.promotedManifestSignalsIn = items.length;
  const allowedSetupIds = new Set();
  for (const it of items) {
    const su = it && typeof it === 'object' ? safeTrimmedString(it.setupId) : '';
    if (su) allowedSetupIds.add(su);
  }

  let staleRemovedCount = 0;
  const base = [];
  for (const s of signals) {
    if (!s || typeof s !== 'object') {
      base.push(s);
      continue;
    }
    if (s.signalSource !== PROMOTED_MANIFEST_SIGNAL_SOURCE) {
      base.push(s);
      continue;
    }
    const su = safeTrimmedString(s.setupId);
    if (!su || !allowedSetupIds.has(su)) {
      staleRemovedCount += 1;
      continue;
    }
    base.push(s);
  }
  auditBase.staleRemovedCount = staleRemovedCount;

  const transformed = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const tr = toWave1PaperSignalFromPromotedManifestItem(item);
    if (!tr.ok) {
      mergeRejected.push({
        index: i,
        setupId: item && typeof item === 'object' ? safeTrimmedString(item.setupId) : '',
        reasonCode: tr.reasonCode,
      });
      continue;
    }
    transformed.push(tr.signal);
  }

  const byKey = new Map();
  for (const sig of transformed) {
    const k = signalDedupeKey(sig);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(sig);
  }

  const manifestSignals = [];
  for (const [, group] of byKey) {
    if (group.length > 1) {
      for (const sig of group) {
        mergeRejected.push({
          setupId: safeTrimmedString(sig.setupId),
          reasonCode: PROMOTED_MANIFEST_INTERNAL_DEDUP_COLLISION,
        });
      }
      continue;
    }
    manifestSignals.push(group[0]);
  }

  auditBase.promotedManifestSignalsOut = manifestSignals.length;
  auditBase.mergeRejectedCount = mergeRejected.length;

  const map = new Map();
  for (const s of base) {
    if (s && typeof s === 'object') map.set(signalDedupeKey(s), s);
  }
  for (const s of manifestSignals) {
    map.set(signalDedupeKey(s), s);
  }

  return { signals: Array.from(map.values()), audit: auditBase };
}

/**
 * @returns {{ ok: boolean, skipped?: string, outPath?: string, audit?: object, built?: number, merged?: number }}
 */
function runBuildWave1PaperSignalsFile(opts = {}) {
  const fromGeneratedOnly = envBool('NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED');
  if (!envBool('NEUROPILOT_WAVE1_FORCE_SIGNALS') && !fromGeneratedOnly) {
    return {
      ok: false,
      skipped:
        'NEUROPILOT_WAVE1_FORCE_SIGNALS or NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED not set',
      outPath: null,
      audit: null,
    };
  }

  const root = opts.dataRoot || dataRoot.getDataRoot();
  // Always write under `root/governance` so opts.dataRoot (tests / alt roots) is respected.
  const outPath = path.join(root, 'governance', 'paper_execution_v1_signals.json');

  let built = [];
  let audit = {};
  let fallbackExamplesUsed = false;
  /** @type {'generated_strategies'|'meta_ranking'|'example_fallback'|null} */
  let primarySource = null;
  let stripExamplesFromExisting = false;

  if (fromGeneratedOnly) {
    const gen = buildWave1PaperSignalsFromGenerated(opts);
    if (gen.signals.length > 0) {
      built = gen.signals;
      audit = gen.audit;
      primarySource = 'generated_strategies';
      stripExamplesFromExisting = true;
    } else {
      built = loadExampleFallbackSignals();
      fallbackExamplesUsed = true;
      primarySource = 'example_fallback';
      audit = {
        ...gen.audit,
        signalSource: 'example_fallback',
        fallbackExamplesUsed: true,
        note: gen.audit.note
          ? `${gen.audit.note}; using_fixture_example_signals`
          : 'using_fixture_example_signals',
      };
    }
  } else {
    const gen = buildWave1PaperSignalsFromGenerated(opts);
    if (gen.signals.length > 0) {
      built = gen.signals;
      audit = gen.audit;
      primarySource = 'generated_strategies';
      stripExamplesFromExisting = true;
    } else {
      const meta = buildWave1PaperSignals(opts);
      if (meta.signals.length > 0) {
        built = meta.signals;
        audit = meta.audit;
        primarySource = 'meta_ranking';
      } else {
        built = loadExampleFallbackSignals();
        fallbackExamplesUsed = true;
        primarySource = 'example_fallback';
        audit = {
          enabled: true,
          signalSource: 'example_fallback',
          fallbackExamplesUsed: true,
          note: 'no_generated_no_meta_using_fixture_example',
          mergedHints: {
            generatedEmpty: gen.audit.note || true,
            metaEmpty: meta.audit.note || true,
          },
        };
      }
    }
  }

  audit.fallbackExamplesUsed = fallbackExamplesUsed;
  audit.primarySource = primarySource;

  const prev = safeReadJson(outPath);
  const existing = prev && Array.isArray(prev.signals) ? prev.signals : [];
  let afterExampleStrip = existing;
  if (stripExamplesFromExisting && built.length > 0) {
    afterExampleStrip = existing.filter((s) => !isExamplePaperSignal(s));
  }
  const examplesStripped = existing.length - afterExampleStrip.length;
  const legacyCleanup = filterNormalizeHistorySignalsForMerge(afterExampleStrip);
  const existingForMerge = legacyCleanup.cleaned;
  Object.assign(audit, {
    legacy_signals_loaded: legacyCleanup.legacy_signals_loaded,
    legacy_signals_normalized: legacyCleanup.legacy_signals_normalized,
    legacy_signals_dropped_missing_source: legacyCleanup.legacy_signals_dropped_missing_source,
    legacy_signals_source_inferred: legacyCleanup.legacy_signals_source_inferred,
    merged_signals_retained_from_history: legacyCleanup.merged_signals_retained_from_history,
  });

  let merged = mergeWithExisting(existingForMerge, built);

  const emaCap = resolveEmaPullbackV2PaperSignalCap();
  let emaPullbackSignalCapAudit = null;
  if (emaCap != null) {
    const before = merged.length;
    merged = applyMaxSignalsPerStrategyId(merged, { EMA_pullback_v2: emaCap });
    emaPullbackSignalCapAudit = {
      enabled: true,
      strategyId: 'EMA_pullback_v2',
      maxSignals: emaCap,
      signalsBefore: before,
      signalsAfter: merged.length,
      dropped: before - merged.length,
    };
    Object.assign(audit, { emaPullbackSignalCap: emaPullbackSignalCapAudit });
  }

  const manifestPath = buildPromotedManifestPath(root);
  const promotedManifestDoc = safeReadPromotedManifest(manifestPath);
  const promotedManifestMerge = mergePromotedManifestSignals(merged, promotedManifestDoc);
  promotedManifestMerge.audit.manifestPath = manifestPath;
  merged = promotedManifestMerge.signals;

  const doc = {
    _comment:
      'Paper Execution V1 signals. Wave1 entries include forcedWave1:true (from buildPaperExecutionV1SignalsWave1.js). Each datasetKey must exist in datasets_manifest.json.',
    signals: merged,
    wave1PaperSignalsAudit: {
      generatedAt: new Date().toISOString(),
      ...audit,
      existingCountBefore: existing.length,
      existingExampleSignalsStripped: examplesStripped,
      wave1BuiltThisRun: built.length,
      totalSignalsAfterMerge: merged.length,
      emaPullbackSignalCap: emaPullbackSignalCapAudit,
    },
    promotedManifestMerge: promotedManifestMerge.audit,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf8');

  return {
    ok: true,
    outPath,
    audit,
    built: built.length,
    merged: merged.length,
  };
}

module.exports = {
  PROMOTED_MANIFEST_SIGNAL_SOURCE,
  PROMOTED_MANIFEST_FILENAME,
  PROMOTED_MANIFEST_SCHEMA_VERSION,
  PROMOTED_MANIFEST_INTERNAL_DEDUP_COLLISION,
  PROMOTED_MANIFEST_IDENTITY_MISMATCH,
  PROMOTED_MANIFEST_ITEM_INVALID,
  buildPromotedManifestPath,
  mergePromotedManifestSignals,
  toWave1PaperSignalFromPromotedManifestItem,
  buildWave1PaperSignals,
  buildWave1PaperSignalsFromGenerated,
  loadMutationSetupsFromGeneratedDir,
  mergeWithExisting,
  runBuildWave1PaperSignalsFile,
  signalDedupeKey,
  resolveMaxSignalsPerSymbol,
  resolveMaxSignalsTotal,
  applyMaxSignalsPerStrategyId,
  resolveEmaPullbackV2PaperSignalCap,
  applySignalRotation,
  stableHash32,
  isExamplePaperSignal,
  loadExampleFallbackSignals,
  resolveRMultipleFromSetup,
  resolveStrategyIdFromSetup,
  toWave1PaperSignalFromGeneratedSetup,
  normalizeHistorySignalForMerge,
  filterNormalizeHistorySignalsForMerge,
  inferLegacySignalSource,
};

function main() {
  const r = runBuildWave1PaperSignalsFile();
  if (!r.ok) {
    console.error(`[wave1_paper_signals] ${r.skipped}`);
    process.exit(0);
  }
  const a = r.audit || {};
  console.log('[wave1_paper_signals] wrote', r.outPath);
  console.log('[wave1_paper_signals] built', r.built, 'merged total', r.merged);
  console.log('[wave1_paper_signals] primarySource:', a.primarySource || a.signalSource || '—');
  console.log(
    '[wave1_paper_signals] fallback_examples_used:',
    a.fallbackExamplesUsed ? 'yes' : 'no'
  );
  if (a.generated_setups_loaded != null) {
    console.log('[wave1_paper_signals] generated_setups_loaded:', a.generated_setups_loaded);
  }
  if (a.generated_setups_eligible != null) {
    console.log('[wave1_paper_signals] generated_setups_eligible:', a.generated_setups_eligible);
  }
  if (a.generated_setups_skipped_invalid != null) {
    console.log(
      '[wave1_paper_signals] generated_setups_skipped_invalid:',
      a.generated_setups_skipped_invalid
    );
  }
  if (a.generated_setups_mut_files_seen != null) {
    console.log(
      '[wave1_paper_signals] generated_setups_setup_files_seen:',
      a.generated_setups_mut_files_seen
    );
    console.log(
      '[wave1_paper_signals] generated_setups_mut_files_seen:',
      a.generated_setups_mut_files_seen
    );
  }
  if (a.signalsBuilt != null) {
    console.log('[wave1_paper_signals] ai_signals_built:', a.signalsBuilt);
  }
  if (a.legacy_signals_loaded != null) {
    console.log('[wave1_paper_signals] legacy_signals_loaded:', a.legacy_signals_loaded);
  }
  if (a.legacy_signals_normalized != null) {
    console.log('[wave1_paper_signals] legacy_signals_normalized:', a.legacy_signals_normalized);
  }
  if (a.legacy_signals_dropped_missing_source != null) {
    console.log(
      '[wave1_paper_signals] legacy_signals_dropped_missing_source:',
      a.legacy_signals_dropped_missing_source
    );
  }
  if (a.legacy_signals_source_inferred != null) {
    console.log(
      '[wave1_paper_signals] legacy_signals_source_inferred:',
      a.legacy_signals_source_inferred
    );
  }
  if (a.merged_signals_retained_from_history != null) {
    console.log(
      '[wave1_paper_signals] merged_signals_retained_from_history:',
      a.merged_signals_retained_from_history
    );
  }
  if (a.note) console.log('[wave1_paper_signals] note:', a.note);
  process.exit(0);
}

if (require.main === module) {
  main();
}
