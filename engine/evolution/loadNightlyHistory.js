'use strict';

/**
 * Strategy Evolution Engine — Load nightly history from brain_snapshots.
 *
 * Reads:
 * - discovered_setups_YYYYMMDD_HHMMSS.json (discovery snapshots; often lack performance metrics),
 * - meta_ranking_YYYYMMDD_HHMMSS.json (performance snapshots: expectancy, trades, meta_score, etc.).
 * Evolution uses both; rows from meta_ranking have the metrics needed for isPositiveNight / nightsSurvived.
 *
 * Usage:
 *   const { loadNightlyHistory } = require('./engine/evolution/loadNightlyHistory');
 *   const { nights, bySetupId } = await loadNightlyHistory();
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');

const SNAPSHOT_PREFIX = 'discovered_setups_';
const SNAPSHOT_SUFFIX = '.json';
const RE_TIMESTAMP = /^discovered_setups_(\d{8})_(\d{6})\.json$/i;
const RE_TIMESTAMP_ENRICHED = /^discovered_setups_(\d{8})_(\d{6})_enriched\.json$/i;
const RE_META_TIMESTAMP = /^meta_ranking_(\d{8})_(\d{6})\.json$/i;
const PLAIN_NAME = 'discovered_setups.json';
const PLAIN_NAME_ENRICHED = 'discovered_setups_enriched.json';

/**
 * Parse timestamp from snapshot filename (timestamped or plain).
 * Returns dateKey (YYYYMMDD), hms (HHMMSS for unique per-snapshot key), date (YYYY-MM-DD).
 * @param {string} filename - e.g. discovered_setups_20260308_200015.json, *_enriched.json, or discovered_setups.json
 * @returns {{ dateKey: string, hms: string, date: string } | null}
 */
function parseSnapshotFilename(filename) {
  const m = filename.match(RE_TIMESTAMP) || filename.match(RE_TIMESTAMP_ENRICHED);
  if (m) {
    const [, ymd, hms] = m;
    const dateKey = ymd;
    const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    return { dateKey, hms, date };
  }
  const metaM = (filename || '').match(RE_META_TIMESTAMP);
  if (metaM) {
    const [, ymd, hms] = metaM;
    const dateKey = ymd;
    const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    return { dateKey, hms, date };
  }
  const lower = (filename || '').toLowerCase();
  if (lower === PLAIN_NAME_ENRICHED || lower === PLAIN_NAME) {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10).replace(/-/g, '');
    const hms = now.toISOString().slice(11, 19).replace(/:/g, '');
    const date = now.toISOString().slice(0, 10);
    return { dateKey, hms, date };
  }
  return null;
}

/**
 * Load one snapshot file and return results array.
 * @param {string} filePath - Full path to discovered_setups_*.json
 * @returns {{ dateKey: string, date: string, results: Array } | null}
 */
function loadOneSnapshot(filePath) {
  const filename = path.basename(filePath);
  const parsed = parseSnapshotFilename(filename);
  if (!parsed) return null;
  if (!fs.existsSync(filePath)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  const results = Array.isArray(data.results)
    ? data.results
    : Array.isArray(data.strategies)
      ? data.strategies
      : [];
  if (results.length === 0) return null;
  return { ...parsed, results };
}

/**
 * Resolve which file to load per snapshot: prefer _enriched.json if present, else original.
 * Accepts: discovered_setups_YYYYMMDD_HHMMSS.json, *_enriched.json, discovered_setups.json,
 * discovered_setups_enriched.json, meta_ranking_YYYYMMDD_HHMMSS.json.
 * @param {string} dir - brain_snapshots or discovery dir
 * @returns {string[]} paths to load
 */
function resolveNightlyFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  const names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));

  const byKey = new Map();

  for (const name of names) {
    const lower = name.toLowerCase();

    let key = null;
    let enriched = false;

    const m1 = name.match(RE_TIMESTAMP);
    const m2 = name.match(RE_TIMESTAMP_ENRICHED);

    const metaM = name.match(RE_META_TIMESTAMP);
    if (m2) {
      key = `${m2[1]}_${m2[2]}`;
      enriched = true;
    } else if (m1) {
      key = `${m1[1]}_${m1[2]}`;
      enriched = false;
    } else if (metaM) {
      key = `meta_${metaM[1]}_${metaM[2]}`;
      enriched = false;
    } else if (lower === PLAIN_NAME_ENRICHED) {
      key = 'plain_discovered_setups';
      enriched = true;
    } else if (lower === PLAIN_NAME) {
      key = 'plain_discovered_setups';
      enriched = false;
    } else {
      continue;
    }

    const prev = byKey.get(key);
    const filePath = path.join(dir, name);

    if (!prev) {
      byKey.set(key, { filePath, enriched });
      continue;
    }

    // prefer enriched over original
    if (enriched && !prev.enriched) {
      byKey.set(key, { filePath, enriched });
    }
  }

  return Array.from(byKey.values()).map((x) => x.filePath).sort();
}

/**
 * Load all nightly snapshots and aggregate by setupId.
 * Prefers enriched files (discovered_setups_*_enriched.json) when present for lineage metadata.
 * @param {string} [snapshotsDir] - Override brain_snapshots path
 * @returns {Promise<{ nights: Array<{ dateKey: string, date: string, results: Array }>, bySetupId: Object }>}
 */
async function loadNightlyHistory(snapshotsDir) {
  const dirs = snapshotsDir
    ? (Array.isArray(snapshotsDir) ? snapshotsDir : [snapshotsDir])
    : [
        dataRoot.getPath('brain_snapshots'),
        dataRoot.getPath('discovery'),
      ];

  const nights = [];
  const bySetupId = Object.create(null);

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    const filesToLoad = resolveNightlyFiles(dir);

    for (const filePath of filesToLoad) {
      const entry = loadOneSnapshot(filePath);
      if (!entry || entry.results.length === 0) continue;

      nights.push(entry);

      const uniqueDateKey =
        (entry.dateKey && entry.hms)
          ? `${entry.dateKey}_${entry.hms}`
          : entry.dateKey;

      for (const row of entry.results) {
        const setupId = row.setupId || row.setup_id || row.id;
        if (!setupId) continue;

        let rules = null;
        if (row.rules && typeof row.rules === 'object' && Object.keys(row.rules).length) {
          rules = { ...row.rules };
        } else if (row.raw && row.raw.rules && typeof row.raw.rules === 'object' && Object.keys(row.raw.rules).length) {
          rules = { ...row.raw.rules };
        }
        const hasRules = !!(rules && Object.keys(rules).length);

        const record = {
          date: entry.date,
          dateKey: uniqueDateKey,
          setupId: row.setupId || row.setup_id || row.id,
          ts: row.generatedAt || row.ts || '',
          expectancy: typeof row.expectancy === 'number' ? row.expectancy : null,
          trades: typeof row.trades === 'number' ? row.trades : 0,
          bootstrap_risk: typeof row.bootstrap_risk === 'number' ? row.bootstrap_risk : null,
          winRate: typeof row.winRate === 'number' ? row.winRate : null,
          maxDrawdown: typeof row.maxDrawdown === 'number' ? row.maxDrawdown : null,
          meta_score: typeof row.meta_score === 'number' ? row.meta_score : null,
          parentSetupId: row.parentSetupId != null ? String(row.parentSetupId) : null,
          parentFamilyId: row.parentFamilyId != null ? String(row.parentFamilyId) : null,
          familyKey: row.familyKey != null ? String(row.familyKey) : null,
          lineageKey: row.lineageKey != null ? String(row.lineageKey) : null,
          mutationType: row.mutationType != null ? String(row.mutationType) : null,
          source: typeof row.source === 'string' ? row.source : null,
          generation: Number.isFinite(Number(row.generation)) ? Number(row.generation) : 0,
          rules: hasRules ? rules : null,
          hasRules,
        };

        if (!bySetupId[setupId]) bySetupId[setupId] = [];
        bySetupId[setupId].push(record);
      }
    }
  }

  // 🔥 IMPORTANT: trier globalement après merge multi-source (dateKey can be YYYYMMDD or YYYYMMDD_HHMMSS)
  nights.sort((a, b) => (a.dateKey || '').localeCompare(b.dateKey || ''));

  return { nights, bySetupId };
}

module.exports = { loadNightlyHistory, loadOneSnapshot, parseSnapshotFilename, resolveNightlyFiles };
