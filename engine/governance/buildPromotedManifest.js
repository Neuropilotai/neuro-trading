#!/usr/bin/env node
'use strict';

/**
 * Build discovery/promoted_manifest.json from promoted_children.json + generated_strategies
 * (setup_*.json and setup_*.js at top level)
 * + datasets_manifest (same Wave1 geometry as buildPaperExecutionV1SignalsWave1).
 *
 * Requires NEUROPILOT_WAVE1_SYMBOLS (CSV) like the Wave1 signal builder.
 *
 * Run: node engine/governance/buildPromotedManifest.js
 * Or copy a hand-made file: cp engine/governance/fixtures/promoted_manifest.example.json <DATA_ROOT>/discovery/promoted_manifest.json
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const riskEngine = require('../execution/executionRiskEngine');
const { readBinaryStoreSync } = require('../datasetBinaryStore');
const {
  PROMOTED_MANIFEST_FILENAME,
  PROMOTED_MANIFEST_SCHEMA_VERSION,
  resolveMaxSignalsPerSymbol,
  resolveMaxSignalsTotal,
  toWave1PaperSignalFromGeneratedSetup,
  signalDedupeKey,
} = require('./buildPaperExecutionV1SignalsWave1');
const {
  analyzePromotedLifecycle,
  filterAndTagManifestItems,
  tagManifestItemsOnly,
  writePromotedLifecycleReport,
  rowsToMap,
  manifestLifecycleFeatureEnabled,
  manifestLifecycleSuspendBlocks,
  manifestLifecycleKillBlocks,
  manifestLifecycleWriteReportDefault,
  resolveLifecycleDataRoot,
} = require('./analyzePromotedLifecycle');

function safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function canonicalRulesJson(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return '{}';
  const o = {};
  for (const k of Object.keys(rules).sort()) o[k] = rules[k];
  return JSON.stringify(o);
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

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function envNum(name, fallback) {
  const raw = process.env[name];
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function resolveManifestPaperGateConfig() {
  return {
    enabled: envFlag('NEUROPILOT_MANIFEST_PAPER_GATE_ENABLE', false),
    minTrades: Math.max(0, Math.floor(envNum('NEUROPILOT_MANIFEST_PAPER_GATE_MIN_TRADES', 100))),
    minTotalPnl: envNum('NEUROPILOT_MANIFEST_PAPER_GATE_MIN_TOTAL_PNL', -1000),
    minAvgPnl: envNum('NEUROPILOT_MANIFEST_PAPER_GATE_MIN_AVG_PNL', -0.05),
    minWinRate: envNum('NEUROPILOT_MANIFEST_PAPER_GATE_MIN_WIN_RATE', 30),
  };
}

function loadPaperMetricsByStrategyMap(metricsPath) {
  const out = new Map();
  const j = safeReadJson(metricsPath);
  if (!j || j.aggregation !== 'by_strategy' || !Array.isArray(j.buckets)) return out;
  for (const b of j.buckets) {
    if (!b || typeof b !== 'object') continue;
    const sid = b.strategyId != null ? String(b.strategyId).trim() : '';
    if (!sid) continue;
    out.set(sid, b);
  }
  return out;
}

function evaluateManifestPaperGate(setupId, metricsMap, cfg) {
  const thresholdsApplied = {
    minTrades: cfg.minTrades,
    minTotalPnl: cfg.minTotalPnl,
    minAvgPnl: cfg.minAvgPnl,
    minWinRate: cfg.minWinRate,
  };
  const row = metricsMap.get(setupId);
  if (!row || typeof row !== 'object') {
    return { blocking: false, nonBlockingReason: 'NO_PAPER_METRICS_ROW', thresholdsApplied };
  }
  const trades = Number(row.trades);
  const totalPnl = Number(row.totalPnl);
  const avgPnl = Number(row.avgPnl);
  const winRate = Number(row.winRate);
  const observed = {
    trades: Number.isFinite(trades) ? trades : null,
    totalPnl: Number.isFinite(totalPnl) ? totalPnl : null,
    avgPnl: Number.isFinite(avgPnl) ? avgPnl : null,
    winRate: Number.isFinite(winRate) ? winRate : null,
  };
  if (!Number.isFinite(trades) || trades < cfg.minTrades) {
    return { blocking: false, nonBlockingReason: 'PAPER_GATE_TRADES_TOO_LOW', observed, thresholdsApplied };
  }
  if (Number.isFinite(totalPnl) && totalPnl < cfg.minTotalPnl) {
    return { blocking: true, reasonCode: 'PAPER_GATE_TOTAL_PNL_TOO_LOW', observed, thresholdsApplied };
  }
  if (Number.isFinite(avgPnl) && avgPnl < cfg.minAvgPnl) {
    return { blocking: true, reasonCode: 'PAPER_GATE_AVG_PNL_TOO_LOW', observed, thresholdsApplied };
  }
  if (Number.isFinite(winRate) && winRate < cfg.minWinRate) {
    return { blocking: true, reasonCode: 'PAPER_GATE_WIN_RATE_TOO_LOW', observed, thresholdsApplied };
  }
  return { blocking: false, observed, thresholdsApplied };
}

const SETUP_FILE_GLOB_DESC = 'setup_*.json | setup_*.js (top-level generated_strategies)';

/**
 * Index setupId -> setup document from top-level generated_strategies only.
 * Includes setup_*.json (JSON.setupId) and setup_*.js (module.exports.setupId || .name + .rules).
 * Newest mtime wins per setupId. Same manifest semantics once a setup is found.
 *
 * @returns {{ map: Map<string, object>, setupScanMeta: object }}
 */
function loadSetupIndexFromDir(generatedDir) {
  const map = new Map();
  const absRoot = generatedDir ? path.resolve(generatedDir) : '';
  const emptyMeta = () => ({
    searchedRoot: absRoot || String(generatedDir || ''),
    expectedPattern: SETUP_FILE_GLOB_DESC,
    setupFileBasenamesSample: [],
    indexedDistinctSetupIds: 0,
  });
  if (!absRoot || !fs.existsSync(absRoot)) {
    return { map, setupScanMeta: emptyMeta() };
  }
  let names;
  try {
    names = fs.readdirSync(absRoot);
  } catch {
    return { map, setupScanMeta: emptyMeta() };
  }
  const setupBasenames = [];
  const pairs = [];
  for (const f of names) {
    if (!f.startsWith('setup_')) continue;
    const isJson = f.endsWith('.json');
    const isJs = f.endsWith('.js');
    if (!isJson && !isJs) continue;
    const full = path.join(absRoot, f);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    setupBasenames.push(f);
    if (isJson) {
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        continue;
      }
      if (!doc || typeof doc !== 'object') continue;
      const sid = doc.setupId != null ? String(doc.setupId).trim() : '';
      if (!sid) continue;
      if (!doc.rules || typeof doc.rules !== 'object') continue;
      pairs.push({ mtimeMs: st.mtimeMs, doc });
    } else {
      let mod;
      try {
        mod = require(full);
      } catch {
        continue;
      }
      if (!mod || typeof mod !== 'object') continue;
      const sidRaw = mod.setupId != null ? String(mod.setupId).trim() : '';
      const nameRaw = mod.name != null ? String(mod.name).trim() : '';
      const sid = sidRaw || nameRaw;
      if (!sid) continue;
      if (!mod.rules || typeof mod.rules !== 'object') continue;
      const doc = { ...mod, setupId: sid, rules: mod.rules };
      pairs.push({ mtimeMs: st.mtimeMs, doc });
    }
  }
  setupBasenames.sort();
  const sampleCap = 12;
  const setupFileBasenamesSample = setupBasenames.slice(0, sampleCap);
  const mtimeBySid = new Map();
  for (const p of pairs) {
    const sid = String(p.doc.setupId).trim();
    const prevM = mtimeBySid.get(sid);
    if (prevM == null || p.mtimeMs >= prevM) {
      mtimeBySid.set(sid, p.mtimeMs);
      map.set(sid, p.doc);
    }
  }
  return {
    map,
    setupScanMeta: {
      searchedRoot: absRoot,
      expectedPattern: SETUP_FILE_GLOB_DESC,
      setupFileBasenamesSample,
      indexedDistinctSetupIds: map.size,
    },
  };
}

/**
 * @returns {Map<string, object>}
 */
function loadSetupBySetupIdMap(generatedDir) {
  return loadSetupIndexFromDir(generatedDir).map;
}

function manifestItemFromSetupAndCtx(setup, ctx) {
  const sig = toWave1PaperSignalFromGeneratedSetup(setup, ctx);
  const setupId = String(sig.setupId).trim();
  const item = {
    setupId,
    strategyId: setupId,
    rules: sig.rules,
    datasetKey: sig.datasetKey,
    symbol: sig.symbol,
    timeframe: sig.timeframe,
    barIndex: sig.barIndex,
    entryAtBarClose: sig.entryAtBarClose,
    stopDistance: sig.stopDistance,
    direction: sig.direction,
    rMultiple: sig.rMultiple,
    maxBarsHeld: sig.maxBarsHeld,
  };
  return item;
}

function pushUniqueCandidate(candidateMap, item) {
  if (!item || typeof item !== 'object') return;
  const dk = signalDedupeKey({
    datasetKey: item.datasetKey,
    barIndex: item.barIndex,
    strategyId: item.strategyId,
    setupId: item.setupId,
    forcedWave1: true,
  });
  if (!candidateMap.has(dk)) candidateMap.set(dk, item);
}

function allocateCandidatesUnderCaps(perSetupCandidates, promotedSetupOrder, maxPerSym, maxTotal) {
  const items = [];
  const perWave1SymbolCount = Object.create(null);
  const promotedIncludedSetupKeys = [];
  const promotedDroppedSetupKeysByCap = [];
  const allocationStats = {
    promotedEligibleCount: 0,
    promotedIncludedCount: 0,
    promotedDroppedByCapCount: 0,
    regularIncludedCount: 0,
    regularDroppedByCapCount: 0,
  };

  const setupOrder = Array.isArray(promotedSetupOrder) ? promotedSetupOrder : [];
  for (const setupId of setupOrder) {
    const m = perSetupCandidates.get(setupId);
    if (m && m.size > 0) allocationStats.promotedEligibleCount += 1;
  }

  // Phase 1: prioritize setup diversity (max one row per setup per round).
  let madeProgress = true;
  while (items.length < maxTotal && madeProgress) {
    madeProgress = false;
    for (const setupId of setupOrder) {
      if (items.length >= maxTotal) break;
      const candidateMap = perSetupCandidates.get(setupId);
      if (!candidateMap || candidateMap.size === 0) continue;
      let pickedKey = null;
      let pickedItem = null;
      for (const [k, cand] of candidateMap.entries()) {
        const sym = String(cand.symbol || '').toUpperCase().trim();
        if (!sym) continue;
        if ((perWave1SymbolCount[sym] || 0) >= maxPerSym) continue;
        pickedKey = k;
        pickedItem = cand;
        break;
      }
      if (!pickedItem) continue;
      candidateMap.delete(pickedKey);
      items.push(pickedItem);
      const sym = String(pickedItem.symbol || '').toUpperCase().trim();
      perWave1SymbolCount[sym] = (perWave1SymbolCount[sym] || 0) + 1;
      allocationStats.promotedIncludedCount += 1;
      promotedIncludedSetupKeys.push(setupId);
      madeProgress = true;
    }
  }

  // Phase 2: fill remaining capacity with remaining candidates.
  if (items.length < maxTotal) {
    for (const setupId of setupOrder) {
      if (items.length >= maxTotal) break;
      const candidateMap = perSetupCandidates.get(setupId);
      if (!candidateMap || candidateMap.size === 0) continue;
      for (const [k, cand] of candidateMap.entries()) {
        if (items.length >= maxTotal) break;
        const sym = String(cand.symbol || '').toUpperCase().trim();
        if (!sym) continue;
        if ((perWave1SymbolCount[sym] || 0) >= maxPerSym) continue;
        items.push(cand);
        perWave1SymbolCount[sym] = (perWave1SymbolCount[sym] || 0) + 1;
        candidateMap.delete(k);
        allocationStats.regularIncludedCount += 1;
      }
    }
  }

  for (const setupId of setupOrder) {
    const candidateMap = perSetupCandidates.get(setupId);
    if (!candidateMap || candidateMap.size === 0) continue;
    const hadPromotedInclusion = promotedIncludedSetupKeys.includes(setupId);
    if (!hadPromotedInclusion) promotedDroppedSetupKeysByCap.push(setupId);
    allocationStats.promotedDroppedByCapCount += candidateMap.size;
    allocationStats.regularDroppedByCapCount += Math.max(0, candidateMap.size - (hadPromotedInclusion ? 1 : 0));
  }

  return {
    items,
    perWave1SymbolCount,
    allocationStats,
    promotedIncludedSetupKeys: Array.from(new Set(promotedIncludedSetupKeys)),
    promotedDroppedSetupKeysByCap: Array.from(new Set(promotedDroppedSetupKeysByCap)),
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataRoot]
 * @param {string} [opts.discoveryDir]
 * @param {string} [opts.generatedDir]
 * @param {boolean} [opts.write=true]
 * @returns {{ outPath: string, doc: object, items: object[], skipped: object[] }}
 */
function buildPromotedManifest(opts = {}) {
  const root = resolveLifecycleDataRoot(opts);
  const discoveryDir = opts.discoveryDir || path.join(root, 'discovery');
  const generatedDir = opts.generatedDir || path.join(root, 'generated_strategies');
  const promotedPath = path.join(discoveryDir, 'promoted_children.json');
  const outPath = path.join(discoveryDir, PROMOTED_MANIFEST_FILENAME);
  const write = opts.write !== false;

  const skipped = [];
  const promotedDoc = safeReadJson(promotedPath);
  if (!promotedDoc) {
    skipped.push({ setupId: '', reasonCode: 'NO_PROMOTED_CHILDREN_FILE', detail: promotedPath });
    const doc = {
      manifestSchemaVersion: PROMOTED_MANIFEST_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      sourceArtifact: 'discovery/promoted_children.json',
      itemCount: 0,
      skippedCount: skipped.length,
      items: [],
      skipped,
    };
    if (write) {
      ensureDir(discoveryDir);
      fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf8');
    }
    return { outPath, doc, items: [], skipped };
  }

  const strategies = Array.isArray(promotedDoc.strategies) ? promotedDoc.strategies : [];
  if (strategies.length === 0) {
    skipped.push({ setupId: '', reasonCode: 'NO_PROMOTED_STRATEGIES', detail: promotedPath });
  }

  const { map: setupMap, setupScanMeta } = loadSetupIndexFromDir(generatedDir);
  const wave1 = riskEngine.parseWave1SymbolSet();
  const manifestPath = path.join(root, 'datasets_manifest.json');
  const datasetsManifest = safeReadJson(manifestPath) || {};
  const paperByStrategyPath = path.join(root, 'governance', 'paper_trades_metrics_by_strategy.json');
  const paperGateCfg = resolveManifestPaperGateConfig();
  const paperMetricsMap = paperGateCfg.enabled ? loadPaperMetricsByStrategyMap(paperByStrategyPath) : new Map();
  const paperGateSummary = {
    enabled: paperGateCfg.enabled,
    source: paperByStrategyPath,
    thresholdsApplied: {
      minTrades: paperGateCfg.minTrades,
      minTotalPnl: paperGateCfg.minTotalPnl,
      minAvgPnl: paperGateCfg.minAvgPnl,
      minWinRate: paperGateCfg.minWinRate,
    },
    evaluatedStrategies: 0,
    noPaperMetricsRowCount: 0,
    belowMinTradesCount: 0,
    skippedByReason: Object.create(null),
  };

  const maxPerSym = resolveMaxSignalsPerSymbol();
  const maxTotal = resolveMaxSignalsTotal();
  const stopFrac = Number(process.env.NEUROPILOT_WAVE1_PAPER_STOP_FRAC) || 0.0025;

  let items = [];
  let perWave1SymbolCount = Object.create(null);
  const allocationStats = {};

  if (wave1.size === 0) {
    skipped.push({
      setupId: '',
      reasonCode: 'NEUROPILOT_WAVE1_SYMBOLS_empty',
      detail: 'Set NEUROPILOT_WAVE1_SYMBOLS to emit manifest items',
    });
  }

  const perSetupCandidates = new Map();
  const promotedSetupOrder = [];
  for (const row of strategies) {
    if (!row || typeof row !== 'object') continue;
    const setupId = row.setupId != null ? String(row.setupId).trim() : '';
    if (!setupId) {
      skipped.push({ setupId: '', reasonCode: 'MISSING_SETUP_ID', detail: 'promoted row' });
      continue;
    }

    const setup = setupMap.get(setupId);
    if (!setup) {
      skipped.push({
        setupId,
        reasonCode: 'SETUP_FILE_NOT_FOUND',
        detail: {
          searchedRoot: setupScanMeta.searchedRoot,
          expectedPattern: setupScanMeta.expectedPattern,
          lookupSetupId: setupId,
          candidatePathsSample: setupScanMeta.setupFileBasenamesSample,
          indexedSetupCount: setupScanMeta.indexedDistinctSetupIds,
        },
      });
      continue;
    }

    if (canonicalRulesJson(row.rules) !== canonicalRulesJson(setup.rules)) {
      skipped.push({ setupId, reasonCode: 'PROMOTED_SETUP_RULES_DIVERGENCE' });
      continue;
    }
    if (paperGateCfg.enabled) {
      paperGateSummary.evaluatedStrategies += 1;
      const gate = evaluateManifestPaperGate(setupId, paperMetricsMap, paperGateCfg);
      if (gate.nonBlockingReason === 'NO_PAPER_METRICS_ROW') paperGateSummary.noPaperMetricsRowCount += 1;
      if (gate.nonBlockingReason === 'PAPER_GATE_TRADES_TOO_LOW') paperGateSummary.belowMinTradesCount += 1;
      if (gate.blocking) {
        paperGateSummary.skippedByReason[gate.reasonCode] =
          (paperGateSummary.skippedByReason[gate.reasonCode] || 0) + 1;
        skipped.push({
          setupId,
          reasonCode: gate.reasonCode,
          detail: {
            trades: gate.observed && gate.observed.trades != null ? gate.observed.trades : null,
            totalPnl: gate.observed && gate.observed.totalPnl != null ? gate.observed.totalPnl : null,
            avgPnl: gate.observed && gate.observed.avgPnl != null ? gate.observed.avgPnl : null,
            winRate: gate.observed && gate.observed.winRate != null ? gate.observed.winRate : null,
            thresholdsApplied: gate.thresholdsApplied,
            sourceMetricsPath: paperByStrategyPath,
          },
        });
        continue;
      }
    }
    promotedSetupOrder.push(setupId);
    perSetupCandidates.set(setupId, new Map());
  }

  for (const row of strategies) {
    if (!row || typeof row !== 'object') continue;
    const setupId = row.setupId != null ? String(row.setupId).trim() : '';
    if (!setupId || !perSetupCandidates.has(setupId)) continue;
    const setup = setupMap.get(setupId);
    if (!setup) continue;
    const setupCandidates = perSetupCandidates.get(setupId);
    for (const sym of [...wave1].sort()) {
      const keys = listDatasetKeysForSymbol(datasetsManifest, sym);
      if (!keys.length) continue;

      for (const { key: datasetKey, entry } of keys) {
        const binPath = entry.paths.bin;
        const absBin = path.isAbsolute(binPath) ? binPath : path.join(root, binPath);
        if (!fs.existsSync(absBin)) continue;

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

        const item = manifestItemFromSetupAndCtx(setup, {
          datasetKey,
          entry,
          sym,
          barIndex,
          stopDistance,
        });

        const wfPass =
          row.promotionGuard &&
          row.promotionGuard.metricsSnapshot &&
          row.promotionGuard.metricsSnapshot.walkForwardPass;
        if (wfPass === true || wfPass === false) item.walkForwardPass = wfPass;
        if (row.promotionReason != null && String(row.promotionReason).trim() !== '') {
          item.promotionSource = String(row.promotionReason).trim();
        }

        pushUniqueCandidate(setupCandidates, item);
      }
    }
  }

  const allocation = allocateCandidatesUnderCaps(
    perSetupCandidates,
    promotedSetupOrder,
    maxPerSym,
    maxTotal
  );
  items = allocation.items;
  perWave1SymbolCount = allocation.perWave1SymbolCount;
  Object.assign(allocationStats, allocation.allocationStats);

  let finalItems = items;
  let lifecycleBlock = null;
  if (manifestLifecycleFeatureEnabled()) {
    const analysis = analyzePromotedLifecycle({
      dataRoot: root,
      promotedStrategies: strategies,
    });
    const lifecycleByStrategyId = rowsToMap(analysis);
    const policy = {
      suspendBlocks: manifestLifecycleSuspendBlocks(),
      killBlocks: manifestLifecycleKillBlocks(),
    };
    const itemsBeforeLifecycle = items.slice();
    const { items: filtered, filteredOut } = filterAndTagManifestItems(
      items,
      lifecycleByStrategyId,
      policy
    );
    let fallbackApplied = false;
    if (filtered.length === 0 && itemsBeforeLifecycle.length > 0) {
      finalItems = tagManifestItemsOnly(itemsBeforeLifecycle, lifecycleByStrategyId);
      fallbackApplied = true;
      console.log(
        JSON.stringify({
          tag: '[buildPromotedManifest]',
          lifecycleManifestFallbackApplied: true,
          reason: 'all_manifest_rows_would_be_removed_by_lifecycle',
          restoredItemCount: finalItems.length,
          attemptedFilteredCount: filteredOut.length,
        })
      );
    } else {
      finalItems = filtered;
    }

    if (manifestLifecycleWriteReportDefault()) {
      const reportDoc = {
        generatedAt: analysis.generatedAt,
        dataRoot: analysis.dataRoot,
        sourceArtifact: promotedPath,
        manifestLifecycleEnabled: true,
        policy,
        summary: {
          ...analysis.summary,
          manifestItemCountBefore: itemsBeforeLifecycle.length,
          manifestItemCountAfter: finalItems.length,
          manifestFilteredOutCount: filteredOut.length,
          manifestFallbackApplied: fallbackApplied,
        },
        scoringNotes: analysis.scoringNotes,
        rows: analysis.rows,
        manifestFilteredSample: filteredOut.slice(0, 80),
      };
      writePromotedLifecycleReport(root, reportDoc);
    }

    lifecycleBlock = {
      enabled: true,
      suspendBlocks: policy.suspendBlocks,
      killBlocks: policy.killBlocks,
      fallbackApplied,
      summary: {
        keepCount: analysis.summary.keepCount,
        watchCount: analysis.summary.watchCount,
        downgradeCount: analysis.summary.downgradeCount,
        suspendCount: analysis.summary.suspendCount,
        killCount: analysis.summary.killCount,
        manifestItemCountBefore: itemsBeforeLifecycle.length,
        manifestItemCountAfter: finalItems.length,
        manifestFilteredOutCount: filteredOut.length,
      },
    };
  }

  const doc = {
    manifestSchemaVersion: PROMOTED_MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceArtifact: 'discovery/promoted_children.json',
    itemCount: finalItems.length,
    skippedCount: skipped.length,
    items: finalItems,
    skipped,
    paperGate: paperGateSummary,
    allocationStats,
    includedPromotedSetupKeys: allocation.promotedIncludedSetupKeys,
    droppedPromotedSetupKeysByCap: allocation.promotedDroppedSetupKeysByCap,
    perWave1SymbolCount,
    ...(lifecycleBlock ? { lifecycle: lifecycleBlock } : {}),
  };

  if (write) {
    ensureDir(discoveryDir);
    fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf8');
  }

  return { outPath, doc, items: finalItems, skipped };
}

module.exports = {
  buildPromotedManifest,
  loadSetupBySetupIdMap,
  loadSetupIndexFromDir,
  allocateCandidatesUnderCaps,
};

if (require.main === module) {
  try {
    const r = buildPromotedManifest();
    console.log('[buildPromotedManifest] wrote', r.outPath);
    console.log('[buildPromotedManifest] items', r.items.length, 'skipped records', r.skipped.length);
  } catch (e) {
    console.error('[buildPromotedManifest]', e && e.message ? e.message : e);
    process.exit(1);
  }
}
