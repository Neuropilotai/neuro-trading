#!/usr/bin/env node
'use strict';

/**
 * Backfill lineage metadata into historical nightly discovered_setups_*.json files.
 *
 * Enriches each row with familyKey (from rules), parentFamilyId (when derivable),
 * and lineageKey so strategyEvolution.js can aggregate multi-night history per lineage.
 *
 * Writes enriched files as discovered_setups_YYYYMMDD_HHMMSS_enriched.json;
 * originals are never modified. loadNightlyHistory() prefers enriched when present.
 *
 * Usage:
 *   node engine/evolution/backfillLineageHistory.js
 *   NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI node engine/evolution/backfillLineageHistory.js
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');

const SNAPSHOT_PREFIX = 'discovered_setups_';
const SNAPSHOT_SUFFIX = '.json';
const RE_ORIGINAL = /^discovered_setups_(\d{8})_(\d{6})\.json$/;
const ENRICHED_SUFFIX = '_enriched.json';

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeWriteJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function extractRootFamily(setupId) {
  if (!setupId) return null;
  const parts = String(setupId).split('familyexp_');
  return parts[parts.length - 1] || String(setupId);
}

function extractStableLineageRoot(setupId) {
  const root = extractRootFamily(setupId);
  if (!root) return null;
  // retire un suffixe hash final seulement
  // ex: pattern_001_open_4279c8 -> pattern_001_open
  // ex: familyexp_pattern_001_open_4279c8 -> pattern_001_open
  return String(root).replace(/_[a-z0-9]{2,12}$/i, '');
}

function getEffectiveFamilyKey(row, setupId) {
  if (!row || typeof row !== 'object') return null;
  const fk = row.familyKey != null ? String(row.familyKey) : null;
  if (!fk) return null;
  if (fk === String(setupId)) return null; // legacy useless familyKey
  return fk;
}

/** Normalize rules for family key derivation (same shape as buildPromotedChildren). */
function normalizeRules(rules) {
  const r = rules && typeof rules === 'object' ? { ...rules } : {};
  return {
    session_phase: r.session_phase || null,
    regime: r.regime || null,
    body_pct_min: Number.isFinite(Number(r.body_pct_min)) ? Number(r.body_pct_min) : null,
    close_strength_min: Number.isFinite(Number(r.close_strength_min)) ? Number(r.close_strength_min) : null,
    volume_ratio: Number.isFinite(Number(r.volume_ratio)) ? Number(r.volume_ratio) : null,
  };
}

/** Derive familyKey from rules (same logic as buildPromotedChildren.buildFamilyKey). */
function deriveFamilyKeyFromRules(rules) {
  const r = normalizeRules(rules);
  const body =
    Number.isFinite(r.body_pct_min)
      ? r.body_pct_min < 0.45
        ? 'body_low'
        : r.body_pct_min < 0.6
          ? 'body_mid'
          : 'body_high'
      : 'body_na';
  const close =
    Number.isFinite(r.close_strength_min)
      ? r.close_strength_min < 0.68
        ? 'cs_low'
        : r.close_strength_min < 0.8
          ? 'cs_mid'
          : 'cs_high'
      : 'cs_na';
  const vol =
    Number.isFinite(r.volume_ratio)
      ? r.volume_ratio < 1.0
        ? 'vol_low'
        : r.volume_ratio < 1.35
          ? 'vol_mid'
          : 'vol_high'
      : 'vol_na';
  return [
    r.regime || 'regime_na',
    r.session_phase || 'session_na',
    body,
    vol,
    close,
  ].join('|');
}

function enrichRow(raw) {
  const out = { ...raw };
  const setupId = out.setupId || out.setup_id || out.id || null;

  if (!setupId) return out;

  if (!out.familyKey) {
    const derivedFamilyKey = deriveFamilyKeyFromRules(out.rules || null);
    if (derivedFamilyKey) out.familyKey = derivedFamilyKey;
  }

  if (out.parentFamilyId == null && out.parentSetupId != null) {
    out.parentFamilyId = String(out.parentSetupId);
  }

  const effectiveFamilyKey =
    getEffectiveFamilyKey(out, setupId) ||
    getEffectiveFamilyKey(raw, setupId);

  out.lineageKey = String(
    out.lineageKey ||
      out.parentFamilyId ||
      effectiveFamilyKey ||
      extractStableLineageRoot(setupId) ||
      extractRootFamily(setupId) ||
      setupId
  );

  return out;
}

/**
 * Run backfill: discover nightly files, enrich rows, write _enriched.json.
 * Only processes files matching RE_ORIGINAL; skips already-enriched and missing dir.
 */
/**
 * Default directories to scan for discovered_setups*.json (multi-source backfill).
 * Uses brain_snapshots, discovery, batch_results so pipeline intermediates are included.
 */
function getSnapshotDirs() {
  return [
    dataRoot.getPath('brain_snapshots'),
    dataRoot.getPath('discovery'),
    dataRoot.getPath('batch_results'),
  ];
}

function runBackfill(snapshotsDirOrDirs) {
  const stats = {
    filesSeen: 0,
    filesWritten: 0,
    rowsSeen: 0,
    rowsEnrichedWithFamilyKey: 0,
    rowsEnrichedWithParentFamilyId: 0,
    rowsEnrichedWithLineageKey: 0,
    rowsUnchanged: 0,
    byDir: {},
  };

  const dirs = snapshotsDirOrDirs != null
    ? (Array.isArray(snapshotsDirOrDirs) ? snapshotsDirOrDirs : [snapshotsDirOrDirs])
    : getSnapshotDirs();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir)
      .filter((f) => f.includes('discovered_setups') && f.endsWith('.json') && !f.includes('_enriched'));

    const dirLabel = path.basename(dir);
    stats.byDir[dirLabel] = { filesSeen: 0, filesWritten: 0, rowsSeen: 0 };

    for (const filename of files) {
      const base = filename.replace(/\.json$/i, '');
      const enrichedFilename = base + ENRICHED_SUFFIX;
      const enrichedPath = path.join(dir, enrichedFilename);
      if (fs.existsSync(enrichedPath)) continue;

      stats.filesSeen += 1;
      stats.byDir[dirLabel].filesSeen += 1;

      const filePath = path.join(dir, filename);
      const data = safeReadJson(filePath);
      if (!data || !Array.isArray(data.results)) continue;

      const results = [];
      for (const row of data.results) {
        const out = enrichRow(row);
        if (out) {
          results.push(out);
          stats.rowsSeen += 1;
          stats.byDir[dirLabel].rowsSeen += 1;
        }
      }

      const out = { ...data, results };
      safeWriteJson(enrichedPath, out);
      stats.filesWritten += 1;
      stats.byDir[dirLabel].filesWritten += 1;
    }
  }

  return stats;
}

function main() {
  const stats = runBackfill();
  console.log('BACKFILL_LINEAGE', JSON.stringify(stats, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runBackfill,
  enrichRow,
  deriveFamilyKeyFromRules,
  extractRootFamily,
  extractStableLineageRoot,
  getEffectiveFamilyKey,
  getSnapshotDirs,
  RE_ORIGINAL,
  ENRICHED_SUFFIX,
};
