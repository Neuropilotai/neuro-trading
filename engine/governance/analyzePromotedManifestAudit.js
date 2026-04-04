#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const { readBinaryStoreSync } = require('../datasetBinaryStore');
const {
  loadSetupIndexFromDir,
} = require('./buildPromotedManifest');
const {
  resolveMaxSignalsPerSymbol,
  resolveMaxSignalsTotal,
} = require('./buildPaperExecutionV1SignalsWave1');

function safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function canonicalRulesJson(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return '{}';
  const out = {};
  for (const k of Object.keys(rules).sort()) out[k] = rules[k];
  return JSON.stringify(out);
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

function inferWave1SymbolsFromManifestItems(items) {
  const set = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const s = it && it.symbol != null ? String(it.symbol).toUpperCase().trim() : '';
    if (s) set.add(s);
  }
  return Array.from(set).sort();
}

function listDatasetRowsForSymbol(manifest, symUpper) {
  const out = [];
  const ds = manifest && manifest.datasets ? manifest.datasets : {};
  const su = String(symUpper || '').toUpperCase();
  for (const [datasetKey, entry] of Object.entries(ds)) {
    if (!entry) continue;
    const s = entry.symbol != null ? String(entry.symbol).toUpperCase() : '';
    if (s === su && entry.paths && entry.paths.bin) {
      out.push({ datasetKey, entry });
    }
  }
  out.sort((a, b) => String(a.datasetKey).localeCompare(String(b.datasetKey)));
  return out;
}

function main() {
  const root = dataRoot.getDataRoot();
  const discoveryDir = path.join(root, 'discovery');
  const govDir = path.join(root, 'governance');
  const promotedChildrenPath = path.join(discoveryDir, 'promoted_children.json');
  const promotedManifestPath = path.join(discoveryDir, 'promoted_manifest.json');
  const paperSignalsPath = path.join(govDir, 'paper_execution_v1_signals.json');
  const datasetsManifestPath = path.join(root, 'datasets_manifest.json');
  const generatedDir = path.join(root, 'generated_strategies');
  const outPath = path.join(govDir, 'promoted_manifest_audit.json');

  const promotedChildren = safeReadJson(promotedChildrenPath) || {};
  const promotedManifest = safeReadJson(promotedManifestPath) || {};
  const paperSignals = safeReadJson(paperSignalsPath) || {};
  const datasetsManifest = safeReadJson(datasetsManifestPath) || {};

  const promotedRows = Array.isArray(promotedChildren.strategies) ? promotedChildren.strategies : [];
  const promotedSetups = promotedRows
    .map((r) => String((r && r.setupId) || (r && r.strategyId) || '').trim())
    .filter(Boolean);
  const promotedChildrenSet = new Set(promotedSetups);

  const manifestItems = Array.isArray(promotedManifest.items) ? promotedManifest.items : [];
  const manifestSetups = Array.from(
    new Set(
      manifestItems
        .map((it) => String((it && it.setupId) || (it && it.strategyId) || '').trim())
        .filter(Boolean)
    )
  );
  const promotedManifestSet = new Set(manifestSetups);

  const presentInManifest = promotedSetups.filter((k) => promotedManifestSet.has(k));
  const missingFromManifest = promotedSetups.filter((k) => !promotedManifestSet.has(k));

  console.log(JSON.stringify({
    tag: 'PROMOTED_MANIFEST_BUILD_INPUT',
    totalPromotedChildren: promotedRows.length,
  }));

  const { map: setupMap } = loadSetupIndexFromDir(generatedDir);
  const inferredWave1Symbols = inferWave1SymbolsFromManifestItems(manifestItems);
  const maxPerSym = resolveMaxSignalsPerSymbol();
  const maxTotal = resolveMaxSignalsTotal();
  const stopFrac = Number(process.env.NEUROPILOT_WAVE1_PAPER_STOP_FRAC) || 0.0025;

  const usedPerSym = {};
  for (const s of inferredWave1Symbols) usedPerSym[s] = 0;
  for (const it of manifestItems) {
    const s = it && it.symbol != null ? String(it.symbol).toUpperCase().trim() : '';
    if (!s) continue;
    usedPerSym[s] = (usedPerSym[s] || 0) + 1;
  }

  const missingAnalysis = [];
  let symbolFilterDetected = false;
  let datasetFilterDetected = false;
  let capLimitDetected = false;

  for (const row of promotedRows) {
    const setupKey = String((row && row.setupId) || (row && row.strategyId) || '').trim();
    if (!setupKey) continue;
    const included = promotedManifestSet.has(setupKey);
    if (included) {
      console.log(JSON.stringify({
        tag: 'PROMOTED_MANIFEST_EVAL',
        setupKey,
        included: true,
        reason: 'included_in_manifest',
      }));
      continue;
    }

    const setupDoc = setupMap.get(setupKey);
    if (!setupDoc) {
      missingAnalysis.push({
        setupKey,
        reason: 'setup_file_not_found',
        details: { generatedDir },
      });
      console.log(JSON.stringify({
        tag: 'PROMOTED_MANIFEST_EVAL',
        setupKey,
        included: false,
        reason: 'setup_file_not_found',
      }));
      continue;
    }

    const rulesEqual =
      canonicalRulesJson(row && row.rules) === canonicalRulesJson(setupDoc && setupDoc.rules);
    if (!rulesEqual) {
      missingAnalysis.push({
        setupKey,
        reason: 'rules_divergence',
        details: {},
      });
      console.log(JSON.stringify({
        tag: 'PROMOTED_MANIFEST_EVAL',
        setupKey,
        included: false,
        reason: 'rules_divergence',
      }));
      continue;
    }

    const symbolDiagnostics = [];
    let anyDataset = false;
    let anyBin = false;
    let anyCandleStop = false;
    for (const sym of inferredWave1Symbols) {
      const rowsForSym = listDatasetRowsForSymbol(datasetsManifest, sym);
      const symDiag = {
        symbol: sym,
        datasetExists: rowsForSym.length > 0,
        datasetKeys: rowsForSym.map((x) => x.datasetKey),
        candlesAvailable: false,
        inWave1Symbols: inferredWave1Symbols.includes(sym),
      };
      if (rowsForSym.length > 0) anyDataset = true;
      for (const r of rowsForSym) {
        const bp = String((r.entry && r.entry.paths && r.entry.paths.bin) || '').trim();
        if (!bp) continue;
        const abs = path.isAbsolute(bp) ? bp : path.join(root, bp);
        if (!fs.existsSync(abs)) continue;
        anyBin = true;
        const stopDistance = computeStopDistanceFromBin(abs, stopFrac);
        if (stopDistance != null) {
          symDiag.candlesAvailable = true;
          anyCandleStop = true;
          break;
        }
      }
      symbolDiagnostics.push(symDiag);
    }

    let reason = 'unknown';
    const totalItems = manifestItems.length;
    const perSymFull = inferredWave1Symbols.length > 0 && inferredWave1Symbols.every((s) => (usedPerSym[s] || 0) >= maxPerSym);
    if (totalItems >= maxTotal || perSymFull) {
      reason = 'cap_limit_reached';
      capLimitDetected = true;
    } else if (!anyDataset) {
      reason = 'no_dataset';
      datasetFilterDetected = true;
    } else if (!anyBin) {
      reason = 'dataset_bin_missing';
      datasetFilterDetected = true;
    } else if (!anyCandleStop) {
      reason = 'candles_unavailable';
      datasetFilterDetected = true;
    } else if (inferredWave1Symbols.length === 0) {
      reason = 'symbol_filter_no_wave1_symbols';
      symbolFilterDetected = true;
    }

    missingAnalysis.push({
      setupKey,
      reason,
      details: {
        totalItems,
        maxTotal,
        maxPerSym,
        usedPerSym,
        inferredWave1Symbols,
        symbolDiagnostics,
      },
    });

    console.log(JSON.stringify({
      tag: 'PROMOTED_MANIFEST_EVAL',
      setupKey,
      included: false,
      reason,
    }));
  }

  const sigDoc = paperSignals && typeof paperSignals === 'object' ? paperSignals : {};
  const merge = sigDoc.promotedManifestMerge && typeof sigDoc.promotedManifestMerge === 'object'
    ? sigDoc.promotedManifestMerge
    : {};
  const mergeRejected = Array.isArray(merge.mergeRejected) ? merge.mergeRejected : [];

  const output = {
    generatedAt: new Date().toISOString(),
    counts: {
      promotedChildren: promotedChildrenSet.size,
      promotedManifest: promotedManifestSet.size,
      missing: missingFromManifest.length,
    },
    presentInManifest,
    missingFromManifest,
    missingAnalysis,
    filtersDetected: {
      symbolFilter: symbolFilterDetected,
      datasetFilter: datasetFilterDetected,
      capLimit: capLimitDetected,
    },
    mergeDiagnostics: {
      collisions: mergeRejected.filter((x) => String(x.reasonCode || '').includes('COLLISION')).length,
      overwrites: Number(merge.staleRemovedCount || 0),
      mergeRejectedCount: mergeRejected.length,
      promotedManifestSignalsIn: Number(merge.promotedManifestSignalsIn || 0),
      promotedManifestSignalsOut: Number(merge.promotedManifestSignalsOut || 0),
    },
    artifacts: {
      promotedChildrenPath,
      promotedManifestPath,
      paperSignalsPath,
      datasetsManifestPath,
      generatedDir,
    },
    diff: {
      promotedChildrenCount: promotedChildrenSet.size,
      promotedManifestCount: promotedManifestSet.size,
      presentInManifest,
      missingFromManifest,
    },
  };

  fs.mkdirSync(govDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, outPath, counts: output.counts, filtersDetected: output.filtersDetected }, null, 2));
}

if (require.main === module) {
  main();
}
