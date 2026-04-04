#!/usr/bin/env node
'use strict';

/**
 * Deterministic ticker scoring from market_intelligence.json (no ML).
 * Writes DATA_ROOT/discovery/ticker_candidates.json
 *
 * discoveryScore: +40 dataset present, +20 if >=2 TF, +10 if >=3 TF,
 *                 +10 if crypto/metals priority class, risk penalty from flags.
 * fitScore: base 50, +10 each for 5m/15m/1h, -20 if no timeframes.
 * admissionScore: round(0.6 * discovery + 0.4 * fit), clamp 0–100.
 */

const path = require('path');
const { resolveDiscoveryDir, readJsonSafe, writeJsonPretty } = require('./_discoveryIo');
const { assetClass } = require('./buildMarketIntelligence');

const SCHEMA_VERSION = '1.0.0';

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function riskPenalty(newsRiskFlags, symbol) {
  const f = (newsRiskFlags || []).find((x) => x && x.symbol === symbol);
  if (!f || !f.riskLevel) return 0;
  if (f.riskLevel === 'high') return -20;
  if (f.riskLevel === 'medium') return -10;
  return 0;
}

function priorityBonus(symbol) {
  const ac = assetClass(symbol);
  if (ac === 'crypto' || ac === 'metals') return 10;
  return 0;
}

function computeDiscoveryScore(mi, symbol, tfs) {
  let s = 0;
  const list = tfs || [];
  if (list.length > 0) s += 40;
  if (list.length >= 2) s += 20;
  if (list.length >= 3) s += 10;
  s += priorityBonus(symbol);
  s += riskPenalty(mi.newsRiskFlags, symbol);
  return clamp(s, 0, 100);
}

function computeFitScore(tfs) {
  const list = tfs || [];
  let s = 50;
  const set = new Set(list);
  if (set.has('5m')) s += 10;
  if (set.has('15m')) s += 10;
  if (set.has('1h')) s += 10;
  if (list.length < 1) s -= 20;
  return clamp(s, 0, 100);
}

function computeAdmissionScore(discovery, fit) {
  return clamp(Math.round(0.6 * discovery + 0.4 * fit), 0, 100);
}

function buildTickerCandidatesPayload(marketIntel, opts = {}) {
  const mi = marketIntel && typeof marketIntel === 'object' ? marketIntel : {};
  const universe = Array.isArray(mi.universe) ? mi.universe : [];
  const availableDatasets =
    mi.availableDatasets && typeof mi.availableDatasets === 'object'
      ? mi.availableDatasets
      : {};
  const generatedAt = opts.generatedAt || new Date().toISOString();

  const candidates = universe.map((symbol) => {
    const timeframes = availableDatasets[symbol] || [];
    const discoveryScore = computeDiscoveryScore(mi, symbol, timeframes);
    const fitScore = computeFitScore(timeframes);
    const admissionScore = computeAdmissionScore(discoveryScore, fitScore);
    const hasMinimumSet = timeframes.length >= 2;
    const reasons = [];
    if (timeframes.length > 0) reasons.push('dataset_available');
    if (timeframes.length >= 2) reasons.push('multi_timeframe_present');
    if (timeframes.length >= 3) reasons.push('three_plus_timeframes');
    const ac = assetClass(symbol);
    if (ac === 'crypto') reasons.push('crypto_universe_member');
    if (ac === 'metals') reasons.push('metals_universe_member');
    if (ac === 'fx') reasons.push('fx_universe_member');

    let status = 'ignored';
    if (admissionScore >= 55) status = 'watchlist_candidate';
    const eligibleForPaperAdmission =
      admissionScore >= 70 && hasMinimumSet;

    return {
      symbol,
      discoveryScore,
      fitScore,
      admissionScore,
      status,
      reasons,
      dataCoverage: {
        timeframes,
        hasMinimumSet,
      },
      eligibleForPaperAdmission,
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    sourceMarketIntelligenceAt: mi.generatedAt || null,
    candidates,
  };
}

function writeTickerCandidates(opts = {}) {
  const dir = resolveDiscoveryDir(opts);
  const miPath = path.join(dir, 'market_intelligence.json');
  const mi = readJsonSafe(miPath, null);
  const generatedAt = opts.generatedAt || new Date().toISOString();

  if (!mi || typeof mi !== 'object') {
    const fallback = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt,
      sourceMarketIntelligenceAt: null,
      candidates: [],
      notes: ['market_intelligence.json missing or invalid; run buildMarketIntelligence first'],
    };
    const outPath = path.join(dir, 'ticker_candidates.json');
    writeJsonPretty(outPath, fallback);
    return { path: outPath, payload: fallback };
  }

  const payload = buildTickerCandidatesPayload(mi, { generatedAt });
  const outPath = path.join(dir, 'ticker_candidates.json');
  writeJsonPretty(outPath, payload);
  return { path: outPath, payload };
}

module.exports = {
  SCHEMA_VERSION,
  buildTickerCandidatesPayload,
  writeTickerCandidates,
  computeDiscoveryScore,
  computeFitScore,
  computeAdmissionScore,
};

if (require.main === module) {
  const r = writeTickerCandidates();
  console.log('[scoreTickerCandidates] wrote', r.path, 'candidates=', r.payload.candidates.length);
}
