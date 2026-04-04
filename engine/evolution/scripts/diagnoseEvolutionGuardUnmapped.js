#!/usr/bin/env node
'use strict';

/**
 * Classify evolution input setups that produce zero dataset keys for the degraded guard
 * (same logic as collectDatasetKeysFromEvolutionRow / filterEvolutionInputByDegradedDatasets).
 *
 * Usage (from neuropilot_trading_v2):
 *   node engine/evolution/scripts/diagnoseEvolutionGuardUnmapped.js
 *   node engine/evolution/scripts/diagnoseEvolutionGuardUnmapped.js --json
 */

const {
  loadPreferredEvolutionInput,
  collectDatasetKeysFromEvolutionRow,
} = require('../strategyEvolution');

const SAMPLE_IDS_PER_BUCKET = 8;

/** @param {unknown} rows */
function unionKeysForSetup(rows) {
  const u = new Set();
  const arr = Array.isArray(rows) ? rows : [];
  for (const r of arr) {
    for (const k of collectDatasetKeysFromEvolutionRow(r)) {
      u.add(k);
    }
  }
  return u;
}

/**
 * @param {string} setupId
 * @param {unknown} rows
 * @returns {{ bucket: string, detail?: string[] }}
 */
function classifyUnmappedSetup(setupId, rows) {
  const arr = Array.isArray(rows) ? rows : [];
  if (arr.length === 0) return { bucket: 'no_rows' };

  if (unionKeysForSetup(rows).size > 0) return { bucket: 'mapped' };

  const raws = arr
    .map((r) =>
      r && typeof r === 'object' && r.raw && typeof r.raw === 'object' ? r.raw : null
    )
    .filter(Boolean);
  if (raws.length === 0) return { bucket: 'no_raw' };

  const raw = raws[0];
  const sym = raw.symbol != null ? String(raw.symbol).trim() : '';
  const tf = raw.timeframe != null ? String(raw.timeframe).trim() : '';
  if ((sym && !tf) || (!sym && tf)) {
    return { bucket: 'partial_symbol_or_timeframe' };
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'variants')) {
    const vk = raw.variants;
    if (!Array.isArray(vk)) return { bucket: 'variants_non_array' };
    if (vk.length === 0) return { bucket: 'variants_empty' };
    return { bucket: 'variants_nonempty_unmapped' };
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'byAsset')) {
    const ba = raw.byAsset;
    if (!Array.isArray(ba)) return { bucket: 'byAsset_non_array' };
    if (ba.length === 0) return { bucket: 'byAsset_empty' };
    return { bucket: 'byAsset_nonempty_unmapped' };
  }

  const keys = Object.keys(raw);
  if (keys.length === 0) return { bucket: 'raw_empty_object' };

  const known = new Set(['symbol', 'timeframe', 'variants', 'byAsset']);
  const other = keys.filter((k) => !known.has(k));
  if (other.length > 0) {
    return { bucket: 'other_raw_shape', detail: other.slice(0, 12) };
  }

  return { bucket: 'raw_known_keys_only_no_usable_values' };
}

function parseArgs(argv) {
  return { jsonOnly: argv.includes('--json') };
}

async function main() {
  const { jsonOnly } = parseArgs(process.argv.slice(2));
  const loaded = await loadPreferredEvolutionInput();
  const bySetupId =
    loaded && loaded.bySetupId && typeof loaded.bySetupId === 'object'
      ? loaded.bySetupId
      : {};

  const buckets = {};
  /** @type {Record<string, string[]>} */
  const samples = {};
  let total = 0;
  let mapped = 0;
  let unmapped = 0;
  /** @type {string[]|null} */
  let exampleOtherRawKeys = null;

  for (const [setupId, rows] of Object.entries(bySetupId)) {
    total += 1;
    const { bucket, detail } = classifyUnmappedSetup(setupId, rows);
    if (bucket === 'mapped') {
      mapped += 1;
      continue;
    }
    unmapped += 1;
    buckets[bucket] = (buckets[bucket] || 0) + 1;
    if (!samples[bucket]) samples[bucket] = [];
    if (samples[bucket].length < SAMPLE_IDS_PER_BUCKET) {
      samples[bucket].push(setupId);
    }
    if (bucket === 'other_raw_shape' && detail && !exampleOtherRawKeys) {
      exampleOtherRawKeys = detail;
    }
  }

  const report = {
    source: loaded && loaded.source != null ? loaded.source : null,
    totalSetups: total,
    mappedSetups: mapped,
    unmappedSetups: unmapped,
    unmappedPct:
      total > 0 ? Math.round((unmapped / total) * 10000) / 100 : null,
    buckets,
    sampleSetupIds: samples,
    exampleOtherRawKeys,
  };

  if (!jsonOnly) {
    console.log('Evolution guard — unmapped setup diagnostic');
    console.log('Source:', report.source);
    console.log(
      `Total ${total} | mapped ${mapped} | unmapped ${unmapped} (${report.unmappedPct}%)`
    );
    console.log('');
    const order = Object.keys(buckets).sort(
      (ka, kb) => (buckets[kb] || 0) - (buckets[ka] || 0)
    );
    for (const b of order) {
      console.log(`  ${b}: ${buckets[b]}`);
      if (samples[b] && samples[b].length) {
        console.log(`    e.g. ${samples[b].join(', ')}`);
      }
      if (b === 'other_raw_shape' && report.exampleOtherRawKeys) {
        console.log(
          `    example extra keys: ${report.exampleOtherRawKeys.join(', ')}`
        );
      }
    }
    console.log('');
  }
  console.log(JSON.stringify(report, null, 2));
}

module.exports = {
  unionKeysForSetup,
  classifyUnmappedSetup,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(
      'diagnoseEvolutionGuardUnmapped:',
      err && err.message ? err.message : err
    );
    process.exit(1);
  });
}
