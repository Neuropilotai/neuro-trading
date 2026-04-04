#!/usr/bin/env node
'use strict';

/**
 * V1 market intelligence snapshot (read-only / advisory).
 * Observation → proposition chain; no live execution.
 *
 * Reads DATA_ROOT/datasets_manifest.json only (no mandatory external news).
 * Writes DATA_ROOT/discovery/market_intelligence.json
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');
const { resolveDiscoveryDir, writeJsonPretty } = require('./_discoveryIo');

const SCHEMA_VERSION = '1.0.0';

function assetClass(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.includes('XAU') || s.includes('XAG')) return 'metals';
  if (s.endsWith('USDT') || s.endsWith('BUSD')) return 'crypto';
  const majors = ['USD', 'EUR', 'JPY', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];
  if (s.length >= 6 && majors.some((m) => s.includes(m))) return 'fx';
  return 'other';
}

/**
 * Parse datasets_manifest.json into universe + per-symbol timeframes.
 * @returns {{ symbols: string[], availableDatasets: Record<string, string[]>, errors: string[] }}
 */
function parseManifestToUniverse(manifestPath) {
  const empty = { symbols: [], availableDatasets: {}, errors: [] };
  if (!fs.existsSync(manifestPath)) {
    return { ...empty, errors: ['datasets_manifest.json missing'] };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {
    return { ...empty, errors: ['datasets_manifest.json parse error'] };
  }
  const datasets =
    raw && raw.datasets && typeof raw.datasets === 'object' ? raw.datasets : {};
  const bySymbol = {};
  for (const [key, entry] of Object.entries(datasets)) {
    let symbol =
      entry && entry.symbol ? String(entry.symbol).toUpperCase().trim() : null;
    let tf =
      entry && entry.timeframe ? String(entry.timeframe).toLowerCase().trim() : null;
    if (!symbol || !tf) {
      const idx = key.lastIndexOf('_');
      if (idx > 0) {
        symbol = symbol || key.slice(0, idx).toUpperCase();
        tf = tf || key.slice(idx + 1).toLowerCase();
      }
    }
    if (!symbol || !tf) continue;
    if (!bySymbol[symbol]) bySymbol[symbol] = new Set();
    bySymbol[symbol].add(tf);
  }
  const availableDatasets = {};
  for (const [sym, set] of Object.entries(bySymbol)) {
    availableDatasets[sym] = [...set].sort();
  }
  const universe = Object.keys(availableDatasets).sort();
  return { symbols: universe, availableDatasets, errors: [] };
}

function resolveDataRoot(opts = {}) {
  if (opts.dataRoot) return path.resolve(opts.dataRoot);
  return dataRoot.getDataRoot();
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataRoot] - override DATA_ROOT
 * @param {string} [opts.generatedAt] - ISO timestamp
 */
function buildMarketIntelligencePayload(opts = {}) {
  const root = resolveDataRoot(opts);
  const manifestPath = path.join(root, 'datasets_manifest.json');
  const { symbols, availableDatasets, errors } = parseManifestToUniverse(manifestPath);
  const generatedAt = opts.generatedAt || new Date().toISOString();

  const notes = [
    'v1_read_only',
    'no_external_news_provider_required',
    'observation_to_proposition_queue_paper_first',
  ];
  for (const e of errors) {
    notes.push(`manifest:${e}`);
  }

  const newsRiskFlags = symbols.map((symbol) => {
    const ac = assetClass(symbol);
    const riskLevel = ac === 'metals' ? 'medium' : 'low';
    return {
      symbol,
      riskLevel,
      reason: 'placeholder_no_external_news_provider',
    };
  });

  const marketRegimeHints = {
    crypto: 'unknown',
    metals: 'unknown',
    fx: 'unknown',
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    universe: symbols,
    availableDatasets,
    newsRiskFlags,
    marketRegimeHints,
    notes,
  };
}

function writeMarketIntelligence(opts = {}) {
  const payload = buildMarketIntelligencePayload(opts);
  const dir = resolveDiscoveryDir(opts);
  const outPath = path.join(dir, 'market_intelligence.json');
  writeJsonPretty(outPath, payload);
  return { path: outPath, payload };
}

module.exports = {
  SCHEMA_VERSION,
  buildMarketIntelligencePayload,
  writeMarketIntelligence,
  parseManifestToUniverse,
  assetClass,
};

if (require.main === module) {
  const r = writeMarketIntelligence();
  console.log('[buildMarketIntelligence] wrote', r.path);
}
