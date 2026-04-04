'use strict';

/**
 * Patch 2/3 — deterministic renewal signal injection for the shadow lane only.
 * Reads promoted_manifest + shadow persistent store (never live seen_keys).
 * Emits signals with PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE for jq-safe filtering.
 */

const fs = require('fs');
const path = require('path');
const { readBinaryStoreSync } = require('../datasetBinaryStore');
const {
  PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE,
  RENEWAL_SHADOW_SIGNAL_SOURCE_VERSION,
  RENEWAL_SHADOW_INJECTION_BUILD_ID,
} = require('./renewalShadowConstants');

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function safeTrim(s) {
  return s != null ? String(s).trim() : '';
}

/** Same shape as paperExecBarThrottleKey / paperExecPersistentThrottleKey in runPaperExecutionV1. */
function paperExecBarThrottleKeyRenewal(sig) {
  const sid = String(sig.strategyId || sig.setupId || '').trim();
  const sym = String(sig.symbol || '').toUpperCase().trim();
  const tf = String(sig.timeframe || '').trim();
  const bi = Number(sig.barIndex);
  const barPart = Number.isFinite(bi) ? String(Math.floor(bi)) : 'na';
  return `${sid}|${sym}|${tf}|${barPart}`;
}

function paperExecPersistentThrottleKeyRenewal(sig) {
  const dk = sig.datasetKey != null ? String(sig.datasetKey).trim() : '';
  const base = paperExecBarThrottleKeyRenewal(sig);
  return `${dk || 'na'}|${base}`;
}

function resolveBinPath(root, signal) {
  if (signal.binPath) {
    const raw = String(signal.binPath).trim();
    return path.isAbsolute(raw) ? raw : path.join(root, raw);
  }
  const key = signal.datasetKey != null ? String(signal.datasetKey).trim() : '';
  if (!key) return null;
  const manifestPath = path.join(root, 'datasets_manifest.json');
  const man = readJsonSafe(manifestPath);
  const ds = man && man.datasets && man.datasets[key];
  const bp = ds && ds.paths && ds.paths.bin ? String(ds.paths.bin).trim() : '';
  if (!bp) return null;
  return path.isAbsolute(bp) ? bp : path.join(root, bp);
}

function loadShadowSeenKeysOnly(seenKeysStorePath) {
  const raw = readJsonSafe(seenKeysStorePath);
  if (!raw || typeof raw !== 'object') return {};
  const keys =
    raw.keys && typeof raw.keys === 'object' && !Array.isArray(raw.keys) ? raw.keys : {};
  return keys;
}

/**
 * @param {object} item - promoted_manifest.items[]
 * @returns {object|null} normalized manifest row or null
 */
function validatePromotedManifestItem(item) {
  if (!item || typeof item !== 'object') return null;
  const setupId = safeTrim(item.setupId);
  const strategyId = safeTrim(item.strategyId);
  if (!setupId || !strategyId || setupId !== strategyId) return null;
  const rules = item.rules;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).length === 0) {
    return null;
  }
  const datasetKey = safeTrim(item.datasetKey);
  if (!datasetKey) return null;
  const barIndex = Number(item.barIndex);
  if (!Number.isFinite(barIndex)) return null;
  const stopDistance = Number(item.stopDistance);
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) return null;
  const dir = safeTrim(item.direction).toLowerCase();
  if (dir !== 'long' && dir !== 'short') return null;
  const rMult = Number(item.rMultiple);
  if (!Number.isFinite(rMult) || rMult <= 0) return null;
  const maxBarsHeld = Number(item.maxBarsHeld);
  const maxBarsHeldOut =
    Number.isFinite(maxBarsHeld) && maxBarsHeld > 0 ? Math.floor(maxBarsHeld) : 500;
  const entryAtBarClose = item.entryAtBarClose === false ? false : true;
  return {
    strategyId,
    setupId,
    rules: { ...rules },
    datasetKey,
    symbol: item.symbol != null ? String(item.symbol) : '',
    timeframe: item.timeframe != null ? String(item.timeframe) : null,
    barIndex: Math.floor(barIndex),
    entryAtBarClose,
    stopDistance,
    direction: dir,
    rMultiple: Math.round(rMult * 100) / 100,
    maxBarsHeld: maxBarsHeldOut,
    forcedWave1: item.forcedWave1 === true,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} opts.shadowSeenKeysStorePath
 * @param {string} [opts.manifestPath]
 * @param {number} opts.maxSignalsPerRun
 * @param {number} opts.maxPerSetup
 * @param {number} opts.maxSetupsToScan
 * @returns {{
 *   signals: object[],
 *   candidateCount: number,
 *   signalsAdded: number,
 *   keysSkippedAlreadySeen: number,
 *   skippedNoValidBar: number,
 *   skippedInvalidManifest: number,
 * }}
 */
function buildRenewalShadowInjectedSignals(opts) {
  const root = opts.dataRoot;
  const shadowSeenPath = opts.shadowSeenKeysStorePath;
  const manifestPath =
    opts.manifestPath || path.join(root, 'discovery', 'promoted_manifest.json');
  const maxSignals = Math.max(0, Math.floor(Number(opts.maxSignalsPerRun) || 0));
  const maxPerSetup = Math.max(1, Math.floor(Number(opts.maxPerSetup) || 1));
  const maxSetups = Math.max(1, Math.floor(Number(opts.maxSetupsToScan) || 1));

  const storeKeys = loadShadowSeenKeysOnly(shadowSeenPath);
  const manifestDoc = readJsonSafe(manifestPath);
  const items = Array.isArray(manifestDoc && manifestDoc.items) ? manifestDoc.items : [];

  let candidateCount = 0;
  let signalsAdded = 0;
  let keysSkippedAlreadySeen = 0;
  let skippedNoValidBar = 0;
  let skippedInvalidManifest = 0;
  /** @type {object[]} */
  const signals = [];
  /** setupId -> count */
  const perSetupCount = Object.create(null);

  /** @type {{ setupId: string, norm: object }[]} */
  const candidates = [];
  for (const item of items) {
    const norm = validatePromotedManifestItem(item);
    if (!norm) {
      skippedInvalidManifest += 1;
      continue;
    }
    candidates.push({ setupId: norm.setupId, norm });
  }
  candidates.sort((a, b) => a.setupId.localeCompare(b.setupId));

  let setupsScanned = 0;
  for (const { norm } of candidates) {
    if (signalsAdded >= maxSignals) break;
    if (setupsScanned >= maxSetups) break;
    setupsScanned += 1;
    candidateCount += 1;

    const binPath = resolveBinPath(root, norm);
    if (!binPath || !fs.existsSync(binPath)) {
      skippedNoValidBar += 1;
      continue;
    }
    let candles;
    let loaded;
    try {
      loaded = readBinaryStoreSync(binPath);
      candles = loaded.candles;
    } catch {
      skippedNoValidBar += 1;
      continue;
    }
    const n = Array.isArray(candles) ? candles.length : 0;
    const maxEntryBar = n >= 2 ? n - 2 : -1;
    if (maxEntryBar < 0) {
      skippedNoValidBar += 1;
      continue;
    }

    let symbol = norm.symbol;
    let timeframe = norm.timeframe;
    if (symbol == null || symbol === '') symbol = loaded.symbol;
    if (timeframe == null || timeframe === '') timeframe = loaded.timeframe;

    let chosenBar = null;
    for (let bi = 0; bi <= maxEntryBar; bi += 1) {
      const probe = {
        ...norm,
        symbol,
        timeframe,
        barIndex: bi,
      };
      const pkey = paperExecPersistentThrottleKeyRenewal(probe);
      if (storeKeys[pkey]) {
        keysSkippedAlreadySeen += 1;
        continue;
      }
      chosenBar = bi;
      break;
    }
    if (chosenBar == null) {
      skippedNoValidBar += 1;
      continue;
    }

    const sid = norm.setupId;
    const used = Number(perSetupCount[sid]) || 0;
    if (used >= maxPerSetup) {
      continue;
    }

    const signal = {
      strategyId: norm.strategyId,
      setupId: norm.setupId,
      rules: norm.rules,
      datasetKey: norm.datasetKey,
      symbol,
      timeframe,
      barIndex: chosenBar,
      entryAtBarClose: norm.entryAtBarClose,
      stopDistance: norm.stopDistance,
      direction: norm.direction,
      rMultiple: norm.rMultiple,
      maxBarsHeld: norm.maxBarsHeld,
      forcedWave1: norm.forcedWave1,
      signalSource: PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE,
      shadowInjection: true,
      shadowInjectionType: 'renewal',
      shadowInjectionBuildId: RENEWAL_SHADOW_INJECTION_BUILD_ID,
      shadowInjectionReason: 'first_unseen_persistent_key',
      renewalSignalSourceVersion: RENEWAL_SHADOW_SIGNAL_SOURCE_VERSION,
    };
    signals.push(signal);
    perSetupCount[sid] = used + 1;
    signalsAdded += 1;
  }

  return {
    signals,
    candidateCount,
    signalsAdded,
    keysSkippedAlreadySeen,
    skippedNoValidBar,
    skippedInvalidManifest,
  };
}

module.exports = {
  buildRenewalShadowInjectedSignals,
  PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE,
};
