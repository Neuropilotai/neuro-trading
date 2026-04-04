'use strict';

/**
 * Signal Generator — Read champions, evaluate current bar (or feature row) against champion rules; emit signals when rules pass.
 *
 * Flow: champion registry → generator → candidate signals (only from champion setups + current market context).
 * Champion rules are loaded from strategy_batch_results_*.json (name + rules persisted by runTopKBacktests).
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');
const { loadChampionRegistrySync } = require('../champions/loadChampionRegistry');
const { getChampionsOnly } = require('../champions/filterChampionSetups');
const { barPassesRules } = require('../discovery/fastVectorScan');
const { buildFeatureMatrix } = require('../features/buildFeatureMatrix');

/**
 * Load setupId -> { name, rules } for champion setupIds from batch_results (strategy_batch_results_*.json).
 * @param {Set<string>|Array<string>} championSetupIds
 * @param {{ batchDir?: string }} [opts]
 * @returns {Map<string, { name: string, rules: object }>}
 */
function loadChampionRules(championSetupIds, opts = {}) {
  const set = new Set(Array.isArray(championSetupIds) ? championSetupIds : [].concat(...championSetupIds));
  const batchDir = opts.batchDir || dataRoot.getPath('batch_results');
  const out = new Map();
  if (!fs.existsSync(batchDir)) return out;
  const files = fs.readdirSync(batchDir).filter((f) => /^strategy_batch_results_.*\.json$/i.test(f));
  for (const f of files) {
    const filePath = path.join(batchDir, f);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    const results = data.results || [];
    for (const r of results) {
      const id = r && r.setupId ? String(r.setupId) : null;
      if (!id || !set.has(id) || out.has(id)) continue;
      const rules = r.rules && typeof r.rules === 'object' ? r.rules : {};
      out.set(id, { name: r.name || id, rules });
    }
  }
  return out;
}

/**
 * Generate signals from a single bar: run champion rules; if a setup passes, emit one signal per champion that passed.
 *
 * @param {{ symbol: string, timeframe: string, open: number, high: number, low: number, close: number, volume?: number, time?: number }} bar - Current or last closed bar
 * @param {{ championDir?: string, batchDir?: string }} [opts]
 * @returns {Array<{ setupId: string, symbol: string, timeframe: string, side: string, price: number, time: number }>}
 */
function generateSignalsFromBar(bar, opts = {}) {
  const registry = loadChampionRegistrySync(opts.championDir);
  if (!registry) return [];
  const champions = getChampionsOnly(registry);
  if (!champions.length) return [];

  const championIds = new Set(champions.map((c) => c.setupId || c.setup_id).filter(Boolean));
  const rulesMap = loadChampionRules(championIds, opts);
  if (!rulesMap.size) return [];

  const candles = [bar];
  const matrix = buildFeatureMatrix(candles, { symbol: bar.symbol || '', timeframe: bar.timeframe || '' });
  const row = matrix.rows && matrix.rows[0];
  if (!row) return [];

  const signals = [];
  const time = bar.time ?? bar.t ?? Date.now();
  const price = bar.close ?? bar.c ?? 0;

  for (const ch of champions) {
    const id = ch.setupId || ch.setup_id;
    if (!id) continue;
    const entry = rulesMap.get(id);
    const rules = entry ? entry.rules : (ch.rules || ch.setup?.rules);
    if (!rules || typeof rules !== 'object') continue;
    if (!barPassesRules(row, rules)) continue;
    signals.push({
      setupId: id,
      symbol: bar.symbol || '',
      timeframe: bar.timeframe || '',
      side: 'long',
      price,
      time,
      size: 1,
    });
  }
  return signals;
}

/**
 * Generate signals from a pre-built feature row (e.g. from a running feature matrix). Avoids rebuilding matrix for one bar.
 *
 * @param {object} featureRow - One row from buildFeatureMatrix (body_pct, close_strength, etc.)
 * @param {{ symbol: string, timeframe: string, close: number, time: number }} context - Symbol, timeframe, price, time for the signal
 * @param {{ championDir?: string, batchDir?: string }} [opts]
 * @returns {Array<{ setupId: string, symbol: string, timeframe: string, side: string, price: number, time: number }>}
 */
function generateSignalsFromRow(featureRow, context, opts = {}) {
  const registry = loadChampionRegistrySync(opts.championDir);
  if (!registry) return [];
  const champions = getChampionsOnly(registry);
  if (!champions.length) return [];

  const championIds = new Set(champions.map((c) => c.setupId || c.setup_id).filter(Boolean));
  const rulesMap = loadChampionRules(championIds, opts);
  const signals = [];
  const { symbol = '', timeframe = '', close = 0, time = Date.now() } = context;

  for (const ch of champions) {
    const id = ch.setupId || ch.setup_id;
    if (!id) continue;
    const entry = rulesMap.get(id);
    const rules = entry ? entry.rules : (ch.rules || ch.setup?.rules);
    if (!rules || typeof rules !== 'object') continue;
    if (!barPassesRules(featureRow, rules)) continue;
    signals.push({
      setupId: id,
      symbol,
      timeframe,
      side: 'long',
      price: close,
      time,
      size: 1,
    });
  }
  return signals;
}

module.exports = {
  loadChampionRules,
  generateSignalsFromBar,
  generateSignalsFromRow,
};
