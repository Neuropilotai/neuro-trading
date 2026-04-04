#!/usr/bin/env node
'use strict';

/**
 * Strategy Family Clustering
 *
 * Goal:
 * - Group very similar setups into "families"
 * - Avoid portfolios full of near-duplicates
 * - Provide a stable familyId from setup metadata / rules
 *
 * Input supported:
 * - array of strategies
 * - object with { strategies: [...] }
 *
 * Output:
 * - same strategies enriched with:
 *   - familyKey
 *   - familyId
 *   - familyRank
 *   - familySize
 *
 * Typical usage:
 *   const { clusterStrategyFamilies } = require('./clusterStrategyFamilies');
 *   const clustered = clusterStrategyFamilies(metaRanking.strategies);
 *
 * CLI:
 *   node engine/clustering/clusterStrategyFamilies.js /path/to/meta_ranking.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function slug(v) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function shortHash(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, 8);
}

function safeNum(v, fallback = null) {
  return Number.isFinite(v) ? v : fallback;
}

function avg(arr) {
  const vals = (arr || []).filter(Number.isFinite);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Parse setupId patterns like:
 *   pattern_001_close_b64802
 *   pattern_004_open_xxxxx
 *   pattern_010_mid_xxxxx
 */
function parseSetupId(setupId) {
  const s = String(setupId || '');
  const m = s.match(/^pattern_(\d+)_([a-z0-9]+)_([a-f0-9]+)$/i);
  if (!m) {
    return {
      raw: s,
      patternIndex: null,
      sessionPhaseFromId: null,
      idHash: null,
    };
  }

  return {
    raw: s,
    patternIndex: Number(m[1]),
    sessionPhaseFromId: slug(m[2]),
    idHash: slug(m[3]),
  };
}

/**
 * Try to infer a regime / pattern family from available fields.
 * This is intentionally heuristic and stable.
 */
function inferRegime(strategy) {
  const id = parseSetupId(strategy.setupId);
  const setupId = String(strategy.setupId || '').toLowerCase();

  if (setupId.includes('breakout')) return 'breakout';
  if (setupId.includes('reversal')) return 'reversal';
  if (setupId.includes('trend')) return 'trend';
  if (setupId.includes('range')) return 'range';
  if (setupId.includes('close')) return 'close_bias';
  if (setupId.includes('open')) return 'open_bias';
  if (setupId.includes('mid')) return 'mid_bias';

  if (id.sessionPhaseFromId === 'open') return 'open_bias';
  if (id.sessionPhaseFromId === 'mid') return 'mid_bias';
  if (id.sessionPhaseFromId === 'close') return 'close_bias';

  return 'generic';
}

/**
 * Core family signature.
 * The idea is:
 * - same general behavior => same family
 * - small numeric differences should still cluster together
 */
function buildFamilySignature(strategy) {
  const id = parseSetupId(strategy.setupId);

  const sessionPhase =
    slug(strategy.session_phase) ||
    slug(strategy.sessionPhase) ||
    id.sessionPhaseFromId ||
    'na';

  const regime =
    slug(strategy.regime) ||
    slug(strategy.market_regime) ||
    inferRegime(strategy);

  // Coarse trade bucket
  const trades = safeNum(strategy.trades, 0);
  const tradeBucket =
    trades >= 2000 ? 't2000p'
      : trades >= 1000 ? 't1000p'
      : trades >= 500 ? 't500p'
      : trades >= 200 ? 't200p'
      : trades >= 50 ? 't50p'
      : 'tlt50';

  // Coarse expectancy bucket
  const expectancy = safeNum(strategy.expectancy, 0);
  const expectancyBucket =
    expectancy >= 0.001 ? 'e10'
      : expectancy >= 0.0005 ? 'e05'
      : expectancy >= 0.0001 ? 'e01'
      : expectancy > 0 ? 'epos'
      : expectancy === 0 ? 'ezero'
      : 'eneg';

  // Cross-asset bucket
  const crossAsset = safeNum(strategy.cross_asset_score, null);
  const crossAssetBucket =
    crossAsset == null ? 'ca_na'
      : crossAsset >= 0.8 ? 'ca8'
      : crossAsset >= 0.6 ? 'ca6'
      : crossAsset >= 0.4 ? 'ca4'
      : crossAsset >= 0.2 ? 'ca2'
      : 'ca0';

  // Timeframe stability bucket
  const timeframe = safeNum(strategy.timeframe_stability_score, null);
  const timeframeBucket =
    timeframe == null ? 'tf_na'
      : timeframe >= 0.8 ? 'tf8'
      : timeframe >= 0.6 ? 'tf6'
      : timeframe >= 0.4 ? 'tf4'
      : timeframe >= 0.2 ? 'tf2'
      : 'tf0';

  // Pattern index bucket groups patterns 1..10 etc. into broader ranges
  const idx = id.patternIndex;
  const patternBucket =
    idx == null ? 'p_na'
      : idx <= 10 ? 'p1_10'
      : idx <= 25 ? 'p11_25'
      : idx <= 50 ? 'p26_50'
      : idx <= 100 ? 'p51_100'
      : 'p100p';

  const familyKey = [
    regime,
    sessionPhase,
    patternBucket,
    tradeBucket,
    expectancyBucket,
    crossAssetBucket,
    timeframeBucket,
  ].join('|');

  return {
    familyKey,
    familySignature: {
      regime,
      sessionPhase,
      patternBucket,
      tradeBucket,
      expectancyBucket,
      crossAssetBucket,
      timeframeBucket,
    },
  };
}

function buildFamilyId(familyKey) {
  const parts = String(familyKey).split('|');
  const readable = parts.slice(0, 3).map(slug).join('_');
  return `family_${readable}_${shortHash(familyKey)}`;
}

function sortFamilyMembers(members) {
  return members
    .slice()
    .sort((a, b) => {
      const metaA = safeNum(a.meta_score, -Infinity);
      const metaB = safeNum(b.meta_score, -Infinity);
      if (metaB !== metaA) return metaB - metaA;

      const expA = safeNum(a.expectancy, -Infinity);
      const expB = safeNum(b.expectancy, -Infinity);
      if (expB !== expA) return expB - expA;

      const trA = safeNum(a.trades, -Infinity);
      const trB = safeNum(b.trades, -Infinity);
      return trB - trA;
    });
}

function normalizeInput(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.strategies)) return input.strategies;
  return [];
}

function clusterStrategyFamilies(input, opts = {}) {
  const strategies = normalizeInput(input);
  const includeFamilyStats = opts.includeFamilyStats !== false;

  const groups = new Map();

  for (const s of strategies) {
    const strategy = { ...s };
    const { familyKey, familySignature } = buildFamilySignature(strategy);
    const familyId = buildFamilyId(familyKey);

    strategy.familyKey = familyKey;
    strategy.familyId = familyId;
    strategy.familySignature = familySignature;

    if (!groups.has(familyId)) groups.set(familyId, []);
    groups.get(familyId).push(strategy);
  }

  const clustered = [];
  const families = [];

  for (const [familyId, members] of groups.entries()) {
    const sorted = sortFamilyMembers(members);
    const familyKey = sorted[0].familyKey;
    const familySignature = sorted[0].familySignature;

    const familyStats = {
      familyId,
      familyKey,
      familySignature,
      familySize: sorted.length,
      avgMetaScore: avg(sorted.map((x) => safeNum(x.meta_score))),
      avgExpectancy: avg(sorted.map((x) => safeNum(x.expectancy))),
      avgTrades: avg(sorted.map((x) => safeNum(x.trades))),
      leaderSetupId: sorted[0].setupId,
    };

    families.push(familyStats);

    sorted.forEach((item, idx) => {
      clustered.push({
        ...item,
        familyRank: idx + 1,
        familySize: sorted.length,
        familyLeader: idx === 0,
        ...(includeFamilyStats ? { familyStats } : {}),
      });
    });
  }

  clustered.sort((a, b) => {
    const aLeader = a.familyLeader ? 1 : 0;
    const bLeader = b.familyLeader ? 1 : 0;
    if (bLeader !== aLeader) return bLeader - aLeader;

    const metaA = safeNum(a.meta_score, -Infinity);
    const metaB = safeNum(b.meta_score, -Infinity);
    if (metaB !== metaA) return metaB - metaA;

    const expA = safeNum(a.expectancy, -Infinity);
    const expB = safeNum(b.expectancy, -Infinity);
    return expB - expA;
  });

  families.sort((a, b) => {
    const metaA = safeNum(a.avgMetaScore, -Infinity);
    const metaB = safeNum(b.avgMetaScore, -Infinity);
    if (metaB !== metaA) return metaB - metaA;

    const expA = safeNum(a.avgExpectancy, -Infinity);
    const expB = safeNum(b.avgExpectancy, -Infinity);
    return expB - expA;
  });

  return {
    generatedAt: new Date().toISOString(),
    strategiesCount: strategies.length,
    familiesCount: families.length,
    families,
    strategies: clustered,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function main() {
  const inPath = process.argv[2];
  const outPath = process.argv[3];

  if (!inPath) {
    console.error('Usage: node engine/clustering/clusterStrategyFamilies.js <input.json> [output.json]');
    process.exit(1);
  }

  const input = readJson(inPath);
  const clustered = clusterStrategyFamilies(input);

  const finalOut =
    outPath ||
    path.join(path.dirname(inPath), 'strategy_families.json');

  writeJson(finalOut, clustered);

  console.log('Strategy family clustering done.');
  console.log('  Input:', inPath);
  console.log('  Output:', finalOut);
  console.log('  Strategies:', clustered.strategiesCount);
  console.log('  Families:', clustered.familiesCount);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseSetupId,
  inferRegime,
  buildFamilySignature,
  buildFamilyId,
  clusterStrategyFamilies,
};
