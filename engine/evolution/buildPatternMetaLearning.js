#!/usr/bin/env node
'use strict';

/**
 * Aggregates winning rule traits from champion_registry → pattern_meta_learning.json
 * for next-gen mutation bias.
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

const STRONG_VALIDATED_MIN_MOMENTUM = Number(
  process.env.META_LEARNING_STRONG_VALIDATED_MIN || 0.48
);

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function bucketBody(v) {
  if (!Number.isFinite(Number(v))) return null;
  const x = Number(v);
  if (x < 0.45) return 'low';
  if (x < 0.6) return 'mid';
  return 'high';
}

function bucketCloseStrength(v) {
  if (!Number.isFinite(Number(v))) return null;
  const x = Number(v);
  if (x < 0.68) return 'low';
  if (x < 0.8) return 'mid';
  return 'high';
}

function bucketVolume(v) {
  if (!Number.isFinite(Number(v))) return null;
  const x = Number(v);
  if (x < 1.1) return 'low';
  if (x < 1.35) return 'mid';
  return 'high';
}

function regimeKey(r) {
  if (!r || typeof r !== 'object') return null;
  const g = String(r.regime || '').toLowerCase();
  if (!g) return null;
  if (g === 'trend') return 'breakout';
  return g;
}

function addScore(agg, category, key, delta) {
  if (!key) return;
  if (!agg[category]) agg[category] = Object.create(null);
  const k = String(key).toLowerCase();
  agg[category][k] = (agg[category][k] || 0) + delta;
}

function normalizeCategory(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const vals = Object.values(obj).filter((v) => Number.isFinite(v) && v !== 0);
  if (!vals.length) return {};
  const sum = vals.reduce((a, b) => a + b, 0);
  const n = vals.length;
  const mean = sum / n;
  if (!Number.isFinite(mean) || mean === 0) return { ...obj };
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = Math.round((Number(v) / mean) * 1000) / 1000;
  }
  return out;
}

function momentumOf(entry) {
  if (Number.isFinite(Number(entry.momentumMetaScore)))
    return Number(entry.momentumMetaScore);
  if (Number.isFinite(Number(entry.avgMetaScore))) return Number(entry.avgMetaScore);
  return null;
}

function extractFromRules(rules, agg, delta) {
  if (!rules || typeof rules !== 'object') return;
  const phase = rules.session_phase;
  if (phase) addScore(agg, 'session_phase', phase, delta);

  const reg = regimeKey(rules);
  if (reg) addScore(agg, 'regime', reg, delta);

  const bb = bucketBody(rules.body_pct_min);
  if (bb) addScore(agg, 'body_bucket', bb, delta);

  const cb = bucketCloseStrength(rules.close_strength_min);
  if (cb) addScore(agg, 'close_strength_bucket', cb, delta);

  const vb = bucketVolume(rules.volume_ratio);
  if (vb) addScore(agg, 'volume_bucket', vb, delta);
}

function runBuildPatternMetaLearning(opts = {}) {
  const championDir = opts.championSetupsDir ?? dataRoot.getPath('champion_setups');
  const discoveryDir = opts.discoveryDir ?? dataRoot.getPath('discovery');
  const regPath = path.join(championDir, 'champion_registry.json');
  const outPath = path.join(discoveryDir, 'pattern_meta_learning.json');

  const registry = safeReadJson(regPath);
  if (!registry || !Array.isArray(registry.setups)) {
    const empty = {
      generatedAt: new Date().toISOString(),
      championCount: 0,
      validatedCount: 0,
      candidatePenaltyCount: 0,
      weights: {},
      error: 'no_registry_or_setups',
    };
    if (!fs.existsSync(discoveryDir)) {
      fs.mkdirSync(discoveryDir, { recursive: true });
    }
    fs.writeFileSync(outPath, JSON.stringify(empty, null, 2), 'utf8');
    return { outPath, report: empty };
  }

  const setups = registry.setups;
  const agg = {
    session_phase: Object.create(null),
    regime: Object.create(null),
    body_bucket: Object.create(null),
    close_strength_bucket: Object.create(null),
    volume_bucket: Object.create(null),
  };

  let championCount = 0;
  let validatedStrong = 0;
  let candidatePenalty = 0;

  for (const e of setups) {
    if (!e || !e.rules) continue;
    const mom = momentumOf(e);
    const sr = String(e.statusReason || '');

    if (e.status === 'champion') {
      championCount += 1;
      extractFromRules(e.rules, agg, 2);
      continue;
    }

    if (e.status === 'validated' && mom != null && mom >= STRONG_VALIDATED_MIN_MOMENTUM) {
      validatedStrong += 1;
      extractFromRules(e.rules, agg, 1);
      continue;
    }

    if (
      e.status === 'candidate' &&
      (sr === 'stagnation_drop' || sr === 'extinction_low_momentum')
    ) {
      candidatePenalty += 1;
      extractFromRules(e.rules, agg, -1);
    }
  }

  const weights = {
    session_phase: normalizeCategory(agg.session_phase),
    regime: normalizeCategory(agg.regime),
    body_bucket: normalizeCategory(agg.body_bucket),
    close_strength_bucket: normalizeCategory(agg.close_strength_bucket),
    volume_bucket: normalizeCategory(agg.volume_bucket),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    championCount,
    validatedCount: validatedStrong,
    candidatePenaltyCount: candidatePenalty,
    weights,
  };

  if (!fs.existsSync(discoveryDir)) {
    fs.mkdirSync(discoveryDir, { recursive: true });
  }
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  return { outPath, report };
}

function main() {
  const { outPath, report } = runBuildPatternMetaLearning();
  console.log('Pattern meta-learning done.');
  console.log('  Champions:', report.championCount);
  console.log('  Strong validated:', report.validatedCount);
  console.log('  Candidate penalties:', report.candidatePenaltyCount);
  console.log('  Out:', outPath);
}

if (require.main === module) {
  main();
}

function clampMetaWeight(w) {
  const n = Number(w);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n, 0.85), 1.25);
}

module.exports = {
  runBuildPatternMetaLearning,
  clampMetaWeight,
  scoreVariantWithMetaLearning(rules, metaLearning) {
    let score = 1;
    if (!rules || typeof rules !== 'object' || !metaLearning?.weights) return score;

    const phase = String(rules.session_phase || '').toLowerCase();
    if (phase && metaLearning.weights.session_phase?.[phase]) {
      score *= clampMetaWeight(metaLearning.weights.session_phase[phase]);
    }

    const regRaw = String(rules.regime || '').toLowerCase();
    const reg = regRaw === 'trend' ? 'breakout' : regRaw;
    if (reg && metaLearning.weights.regime?.[reg]) {
      score *= clampMetaWeight(metaLearning.weights.regime[reg]);
    }

    const bb = bucketBody(rules.body_pct_min);
    if (bb && metaLearning.weights.body_bucket?.[bb]) {
      score *= clampMetaWeight(metaLearning.weights.body_bucket[bb]);
    }

    const cb = bucketCloseStrength(rules.close_strength_min);
    if (cb && metaLearning.weights.close_strength_bucket?.[cb]) {
      score *= clampMetaWeight(metaLearning.weights.close_strength_bucket[cb]);
    }

    const vb = bucketVolume(rules.volume_ratio);
    if (vb && metaLearning.weights.volume_bucket?.[vb]) {
      score *= clampMetaWeight(metaLearning.weights.volume_bucket[vb]);
    }

    return score;
  },
};
