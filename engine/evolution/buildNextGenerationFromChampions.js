#!/usr/bin/env node
'use strict';

/**
 * Next Generation Builder — Generate child strategies only from active champions.
 * Mutation source = registry.champions only. Writes setup_mut_*.json into generated_strategies.
 * Report: discovery/next_generation_report.json
 *
 * Wave 1 — parents from meta_ranking for under-represented symbols (opt-in):
 *   NEUROPILOT_WAVE1_NEXT_GEN_INJECTION=1
 *   NEUROPILOT_WAVE1_SYMBOLS=ADAUSDT,XRPUSDT
 *   NEUROPILOT_WAVE1_NEXT_GEN_MIN_PARENTS_PER_SYMBOL (default 2; 0 = off)
 *   NEUROPILOT_WAVE1_NEXT_GEN_MIN_STABILITY or NEUROPILOT_WAVE1_MIN_AVG_META_SCORE (optional floor)
 *
 * Run-scoped salt for storage IDs: NEXT_GEN_ID_RUN_SALT → NEUROPILOT_CYCLE_ID → timestamp.
 * Varies childName/childSetupId across runs without changing rules or compositeSig (duplicateSignature).
 *
 * Expansion: NEXT_GEN_MAX_PER_CHAMPION (optional, default 4) caps children written per champion.
 *
 * Opt-in: NEUROPILOT_MUTATION_HOTSPOT_POLICY=1 + JSON policy (see MUTATION_HOTSPOT_POLICY.md)
 * dampens mutation mix for specific champion parentSetupIds (thinly-traded hotspots).
 *
 * Learning loop v1 (paper-driven mutation mix): NEUROPILOT_MUTATION_PAPER_LEARNING=1
 * reads governance/paper_trades.jsonl, maps strategyId/setupId → mutationType via generated_strategies,
 * ranks types by per-trade expectancy, applies bounded multipliers to profile slot weights / jitterScale.
 * Tunables: MUTATION_PAPER_LEARNING_MIN_TRADES, MIN_PER_TYPE, MIN_MUL, MAX_MUL.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataRoot = require('../dataRoot');
const { computeCanonicalSetupId } = require('./canonicalSetupId');
const {
  scoreVariantWithMetaLearning,
} = require('./buildPatternMetaLearning');
const { loadMutationHotspotPolicy, applyHotspotPolicyToProfile } = require('./mutationHotspotPolicy');
const { applyWave1NextGenInjection } = require('./wave1NextGenInjection');
const {
  computePaperMutationLearning,
  applyPaperMutationProfileAdjust,
  buildMutationPaperLearningArtifactDoc,
} = require('./paperMutationLearning');
const { applyNextGenSignalRulePatches } = require('./nextGenSignalRulePatches');

/**
 * Per-champion child budget for this process (env override; default 4 = historical behavior).
 */
function resolveMaxChildrenPerChampion() {
  try {
    const raw = process.env.NEXT_GEN_MAX_PER_CHAMPION;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  } catch (e) {
    // eslint-disable-next-line no-console -- fail-soft audit
    console.warn(
      JSON.stringify({
        tag: 'NEXT_GEN_MAX_PER_CHAMPION_WARNING',
        message: e && e.message ? String(e.message) : String(e),
      })
    );
  }
  return 4;
}

const NEXT_GEN_MAX_CHILDREN = Math.max(1, parseInt(process.env.NEXT_GEN_MAX_CHILDREN || '40', 10));
const MAX_CHILDREN_PER_CHAMPION = resolveMaxChildrenPerChampion();
const nextGenMaxPerChampionSource =
  Number.isFinite(Number(process.env.NEXT_GEN_MAX_PER_CHAMPION)) &&
  Number(process.env.NEXT_GEN_MAX_PER_CHAMPION) > 0
    ? 'env'
    : 'default';
// eslint-disable-next-line no-console -- one line per process / run
console.log(
  JSON.stringify({
    tag: 'NEXT_GEN_EXPANSION_CONFIG',
    maxChildrenPerChampion: MAX_CHILDREN_PER_CHAMPION,
    source: nextGenMaxPerChampionSource,
  })
);

const NUMERIC_CLAMP = [0, 1];
const JITTER_DELTA = 0.06;

function safeReadJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function shortHash(str) {
  return crypto.createHash('sha1').update(String(str), 'utf8').digest('hex').slice(0, 6);
}

/**
 * Resolves non-empty salt for childName/childSetupId only (compositeSig unchanged).
 * @returns {{ salt: string, source: 'env'|'cycle_id'|'timestamp'|'error_fallback' }}
 */
function resolveNextGenRunSalt() {
  try {
    const envSalt = process.env.NEXT_GEN_ID_RUN_SALT;
    if (envSalt != null && typeof envSalt === 'string' && envSalt.trim().length > 0) {
      return { salt: envSalt.trim(), source: 'env' };
    }
    const cycle = process.env.NEUROPILOT_CYCLE_ID;
    if (cycle != null && String(cycle).trim().length > 0) {
      return { salt: String(cycle).trim(), source: 'cycle_id' };
    }
    return { salt: String(Date.now()), source: 'timestamp' };
  } catch (e) {
    // eslint-disable-next-line no-console -- fail-soft audit
    console.warn(
      JSON.stringify({
        tag: 'NEXT_GEN_SALT_WARNING',
        phase: 'resolveNextGenRunSalt',
        message: e && e.message ? String(e.message) : String(e),
      })
    );
    return { salt: String(Date.now()), source: 'error_fallback' };
  }
}

function clamp(v, minMax = NUMERIC_CLAMP) {
  const [min, max] = minMax;
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return Math.round((Math.max(min, Math.min(max, n))) * 1e6) / 1e6;
}

function materialRulesSignature(rules) {
  const r = rules && typeof rules === 'object' ? rules : {};
  const keys = Object.keys(r).sort();
  const parts = keys.map((k) => `${k}:${Number(r[k])}`);
  return parts.join('|');
}

function numericSeed(s) {
  const str = String(s || '');
  let n = 1;
  for (let i = 0; i < str.length; i++) {
    n = (n * 31 + str.charCodeAt(i)) >>> 0;
  }
  return n || 1;
}

function mutateParameterJitter(rules, seed, jitterScale = 1) {
  const scale = Number.isFinite(Number(jitterScale)) ? Number(jitterScale) : 1;
  const effective = JITTER_DELTA * scale;
  const out = { ...(rules && typeof rules === 'object' ? rules : {}) };
  const keys = Object.keys(out).filter((k) => typeof out[k] === 'number');
  for (let i = 0; i < keys.length; i++) {
    const k = keys[keys.length - 1 - (seed % keys.length)];
    const v = out[k];
    const delta = (seed % 100) / 100 * 2 * effective - effective;
    out[k] = clamp(v + delta);
  }
  return out;
}

const SESSION_PHASES = ['open', 'mid', 'close'];
const REGIME_VALUES = ['trend', 'range', 'volatile'];

function mutateSessionFlip(rules) {
  const out = { ...(rules && typeof rules === 'object' ? rules : {}) };
  const current = out.session_phase || 'mid';
  const idx = SESSION_PHASES.indexOf(String(current).toLowerCase());
  const next = SESSION_PHASES[(idx + 1) % SESSION_PHASES.length];
  out.session_phase = next;
  return out;
}

function mutateRegimeFlip(rules) {
  const out = { ...(rules && typeof rules === 'object' ? rules : {}) };
  const current = out.regime || 'trend';
  const list = REGIME_VALUES;
  const idx = list.indexOf(String(current).toLowerCase());
  const next = list[(idx + 1) % list.length];
  out.regime = next;
  return out;
}

function mutateForcedFamilyShift(rules, seed, shiftScale = 1) {
  const sc = Number.isFinite(Number(shiftScale)) ? Number(shiftScale) : 1;
  const stepBody = 0.12 * sc;
  const stepClose = 0.1 * sc;
  const out = { ...(rules && typeof rules === 'object' ? rules : {}) };
  if (Number.isFinite(out.body_pct_min)) {
    out.body_pct_min = clamp(
      out.body_pct_min + (seed % 2 === 0 ? stepBody : -stepBody)
    );
  }
  if (Number.isFinite(out.close_strength_min)) {
    out.close_strength_min = clamp(
      out.close_strength_min + (seed % 2 === 0 ? -stepClose : stepClose)
    );
  }
  return out;
}

function getAdaptiveMutationProfile(champion) {
  const momentum = Number.isFinite(Number(champion.momentumMetaScore))
    ? Number(champion.momentumMetaScore)
    : Number.isFinite(Number(champion.avgMetaScore))
      ? Number(champion.avgMetaScore)
      : 0;

  const nights = Number.isFinite(Number(champion.nightsInHistory))
    ? Number(champion.nightsInHistory)
    : 0;

  if (nights >= 6 && momentum < 0.48) {
    return {
      jitterScale: 2.2,
      forcedFamilyShiftWeight: 2,
      regimeFlipWeight: 2,
      sessionFlipWeight: 2,
      mode: 'aggressive_recovery',
    };
  }

  if (momentum >= 0.49) {
    return {
      jitterScale: 0.9,
      forcedFamilyShiftWeight: 1,
      regimeFlipWeight: 1,
      sessionFlipWeight: 1,
      mode: 'precision_refine',
    };
  }

  return {
    jitterScale: 1.4,
    forcedFamilyShiftWeight: 2,
    regimeFlipWeight: 2,
    sessionFlipWeight: 2,
    mode: 'balanced',
  };
}

/**
 * @param {object} champion
 * @param {string} parentSetupId
 * @param {null | { doc: object }} hotspotPolicyState
 * @param {null | { skipped?: boolean, multipliers?: object }} paperMutationAdjust
 * @returns {{ mutations: Array<{ type: string, fn: Function }>, hotspotApplied: object|null, profile: object }}
 */
function buildMutationsConfigResult(
  champion,
  parentSetupId,
  hotspotPolicyState,
  paperMutationAdjust = null
) {
  let p = getAdaptiveMutationProfile(champion);
  let hotspotApplied = null;
  if (hotspotPolicyState && hotspotPolicyState.doc) {
    const r = applyHotspotPolicyToProfile(p, parentSetupId, hotspotPolicyState.doc);
    p = r.profile;
    hotspotApplied = r.appliedRule;
  }
  if (
    paperMutationAdjust &&
    !paperMutationAdjust.skipped &&
    paperMutationAdjust.multipliers &&
    typeof paperMutationAdjust.multipliers === 'object' &&
    Object.keys(paperMutationAdjust.multipliers).length > 0
  ) {
    p = applyPaperMutationProfileAdjust(p, paperMutationAdjust);
  }

  const base = String(parentSetupId) + String(champion.setupId || '');
  const list = [];

  const jitterSlotCount = 3;
  for (let j = 0; j < jitterSlotCount; j++) {
    const jKey = `j${j}`;
    list.push({
      type: 'parameter_jitter',
      fn: (pr, pid) =>
        mutateParameterJitter(pr, numericSeed(base + jKey), p.jitterScale),
    });
  }

  const weightSlots = (w, defaultIfUnset) => {
    const n = Math.round(Number(w));
    if (!Number.isFinite(n)) return Math.max(1, defaultIfUnset);
    return Math.max(0, n);
  };
  const ns = weightSlots(p.sessionFlipWeight, 1);
  const nr = weightSlots(p.regimeFlipWeight, 1);
  const nf = weightSlots(p.forcedFamilyShiftWeight, 1);

  for (let w = 0; w < ns; w++) {
    list.push({ type: 'session_flip', fn: (pr) => mutateSessionFlip(pr) });
  }
  for (let w = 0; w < nr; w++) {
    list.push({ type: 'regime_flip', fn: (pr) => mutateRegimeFlip(pr) });
  }
  for (let w = 0; w < nf; w++) {
    list.push({
      type: 'forced_family_shift',
      fn: (pr, pid) =>
        mutateForcedFamilyShift(
          pr,
          numericSeed(base + 'fs' + w),
          p.jitterScale
        ),
    });
  }

  return { mutations: list, hotspotApplied, profile: p };
}

/** @deprecated Prefer buildMutationsConfigResult for hotspot metadata; this returns mutations only. */
function buildMutationsConfig(champion, parentSetupId, hotspotPolicyState = null) {
  return buildMutationsConfigResult(champion, parentSetupId, hotspotPolicyState, null).mutations;
}

function buildFamilyKey(rules) {
  const r = rules && typeof rules === 'object' ? rules : {};
  const body = Number.isFinite(r.body_pct_min)
    ? (r.body_pct_min < 0.45 ? 'body_low' : r.body_pct_min < 0.6 ? 'body_mid' : 'body_high')
    : 'body_na';
  const close = Number.isFinite(r.close_strength_min)
    ? (r.close_strength_min < 0.68 ? 'cs_low' : r.close_strength_min < 0.8 ? 'cs_mid' : 'cs_high')
    : 'cs_na';
  const session = r.session_phase || 'session_na';
  const regime = r.regime || 'regime_na';
  return [regime, session, body, close].join('|');
}

function loadChampionRegistry(championSetupsDir) {
  const p = path.join(championSetupsDir, 'champion_registry.json');
  const j = safeReadJson(p);
  if (!j || !Array.isArray(j.champions)) return [];
  return j.champions.filter(
    (c) =>
      c &&
      c.setupId &&
      c.liveStatus !== 'extinct' &&
      c.liveStatus !== 'killed'
  );
}

function loadStrategyMapBySetupId(generatedDir) {
  const map = Object.create(null);
  if (!fs.existsSync(generatedDir)) return map;
  const files = fs.readdirSync(generatedDir).filter((f) => (f.endsWith('.js') || f.endsWith('.json')) && (f.startsWith('setup_') || f.startsWith('setup_mut_')));
  for (const f of files) {
    const fullPath = path.join(generatedDir, f);
    try {
      let name, rules;
      if (f.endsWith('.json')) {
        const j = safeReadJson(fullPath);
        if (!j || !j.rules) continue;
        name = j.setupId || j.name || f.replace(/\.(json|js)$/, '');
        rules = j.rules;
      } else {
        const mod = require(fullPath);
        if (!mod || (!mod.name && !mod.rules)) continue;
        name = mod.name || f.replace('.js', '');
        rules = mod.rules && typeof mod.rules === 'object' ? mod.rules : {};
      }
      const setupId = computeCanonicalSetupId({ name, rules });
      map[setupId] = { name, rules };
    } catch (_) { /* skip */ }
  }
  return map;
}

function loadMetaStrategiesBySetupId(discoveryDir) {
  const p = path.join(discoveryDir, 'meta_ranking.json');
  const j = safeReadJson(p);
  const map = Object.create(null);
  if (!j || !Array.isArray(j.strategies)) return map;
  for (const s of j.strategies) {
    if (!s || !s.setupId) continue;
    const id = String(s.setupId);
    if (s.rules && typeof s.rules === 'object' && Object.keys(s.rules).length) {
      map[id] = { name: id.split('_').slice(0, 3).join('_') || 'setup', rules: s.rules };
    }
  }
  return map;
}

function extractCanonicalFamilyKey(setupId) {
  if (!setupId) return null;
  const parts = String(setupId).split('_');
  if (parts.length >= 3) {
    return parts.slice(0, 3).join('_');
  }
  return String(setupId);
}

function hasNonEmptyRules(rules) {
  return !!(rules && typeof rules === 'object' && Object.keys(rules).length);
}

/**
 * Redundancy metrics for one champion's variant list (instrumentation only).
 * @param {string} parentSetupId
 * @param {Array<{ rules: object, mutationType: string }>} variants
 * @param {object} parentRules
 * @returns {object}
 */
function computeChampionRedundancyStats(parentSetupId, variants, parentRules) {
  const parentMatSig = materialRulesSignature(parentRules);
  const seenMat = new Set();
  let duplicateMaterialSignatureAttempts = 0;
  let jitterNoOpCount = 0;
  const variantAttemptsByMutationType = Object.create(null);
  const redundantAttemptsByMutationType = Object.create(null);

  for (const v of variants) {
    const ms = materialRulesSignature(v.rules);
    const mt = String(v.mutationType || 'unknown');

    variantAttemptsByMutationType[mt] = (variantAttemptsByMutationType[mt] || 0) + 1;

    if (seenMat.has(ms)) {
      duplicateMaterialSignatureAttempts += 1;
      redundantAttemptsByMutationType[mt] = (redundantAttemptsByMutationType[mt] || 0) + 1;
    } else {
      seenMat.add(ms);
    }

    if (mt === 'parameter_jitter' && ms === parentMatSig) {
      jitterNoOpCount += 1;
    }
  }

  return {
    parentSetupId,
    variantAttempts: variants.length,
    distinctMaterialSignatures: seenMat.size,
    duplicateMaterialSignatureAttempts,
    jitterNoOpCount,
    variantAttemptsByMutationType,
    redundantAttemptsByMutationType,
  };
}

function mergeCountMaps(target, source) {
  if (!source) return;
  for (const k of Object.keys(source)) {
    target[k] = (target[k] || 0) + source[k];
  }
}

function topEntriesFromMap(map, limit = 15) {
  return Object.entries(map || {})
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(0, limit));
}

/** Per-mutation-type bucket for precandidate filter (before meta-learning sort / budget). */
function emptyFilterMutationBucket() {
  return {
    variantAttempts: 0,
    passedPrecandidate: 0,
    rejectedDuplicateCompositeSigOnly: 0,
    rejectedExistingSetupIdOnly: 0,
    rejectedBoth: 0,
    rejectedDistinctMaterialInParentBatch: 0,
  };
}

function mergeFilterMutationBuckets(target, source) {
  if (!source) return;
  for (const mt of Object.keys(source)) {
    if (!target[mt]) target[mt] = emptyFilterMutationBucket();
    const t = target[mt];
    const s = source[mt];
    t.variantAttempts += s.variantAttempts;
    t.passedPrecandidate += s.passedPrecandidate;
    t.rejectedDuplicateCompositeSigOnly += s.rejectedDuplicateCompositeSigOnly;
    t.rejectedExistingSetupIdOnly += s.rejectedExistingSetupIdOnly;
    t.rejectedBoth += s.rejectedBoth;
    t.rejectedDistinctMaterialInParentBatch += s.rejectedDistinctMaterialInParentBatch;
  }
}

/**
 * Classify each variant vs precandidate filter (instrumentation only).
 * Composite sig = parentFamilyKey|mutationType|materialRulesSignature(rules) (global duplicateSignature set).
 */
function analyzePrecandidateFilterForChampion(
  variants,
  parentSetupId,
  duplicateSignature,
  existingSetupIds
) {
  const matCounts = Object.create(null);
  for (const v of variants) {
    const ms = materialRulesSignature(v.rules);
    matCounts[ms] = (matCounts[ms] || 0) + 1;
  }

  const champFilter = {
    parentSetupId,
    variantAttempts: variants.length,
    passedPrecandidateCount: 0,
    rejectedDuplicateCompositeSigOnly: 0,
    rejectedExistingSetupIdOnly: 0,
    rejectedBoth: 0,
    rejectedDistinctMaterialInParentBatch: 0,
    byMutationType: Object.create(null),
  };

  for (const v of variants) {
    const dup = duplicateSignature.has(v.sig);
    const ex = existingSetupIds.has(v.childSetupId);
    const passes = !dup && !ex;
    const mt = String(v.mutationType || 'unknown');
    if (!champFilter.byMutationType[mt]) {
      champFilter.byMutationType[mt] = emptyFilterMutationBucket();
    }
    const b = champFilter.byMutationType[mt];
    b.variantAttempts += 1;

    const ms = materialRulesSignature(v.rules);
    const distinctMatAmongSiblings = matCounts[ms] === 1;

    if (passes) {
      champFilter.passedPrecandidateCount += 1;
      b.passedPrecandidate += 1;
    } else {
      if (distinctMatAmongSiblings) {
        champFilter.rejectedDistinctMaterialInParentBatch += 1;
        b.rejectedDistinctMaterialInParentBatch += 1;
      }
      if (dup && ex) {
        champFilter.rejectedBoth += 1;
        b.rejectedBoth += 1;
      } else if (dup) {
        champFilter.rejectedDuplicateCompositeSigOnly += 1;
        b.rejectedDuplicateCompositeSigOnly += 1;
      } else {
        champFilter.rejectedExistingSetupIdOnly += 1;
        b.rejectedExistingSetupIdOnly += 1;
      }
    }
  }

  champFilter.rejectedTotal =
    champFilter.variantAttempts - champFilter.passedPrecandidateCount;

  return champFilter;
}

function extractSetupShape(setupId) {
  const m = String(setupId || '').match(/^pattern_(\d+)_(open|mid|close)_/i);
  if (!m) return null;
  return {
    patternNum: m[1],
    sessionPhase: String(m[2]).toLowerCase(),
  };
}

function pickBestRulesCandidate(rows) {
  const arr = Array.isArray(rows) ? rows.filter((r) => r && hasNonEmptyRules(r.rules)) : [];
  if (!arr.length) return null;

  arr.sort((a, b) => {
    const aMeta = Number.isFinite(Number(a.meta_score)) ? Number(a.meta_score) : -Infinity;
    const bMeta = Number.isFinite(Number(b.meta_score)) ? Number(b.meta_score) : -Infinity;
    if (bMeta !== aMeta) return bMeta - aMeta;

    const aVal = Number.isFinite(Number(a.validation_score)) ? Number(a.validation_score) : -Infinity;
    const bVal = Number.isFinite(Number(b.validation_score)) ? Number(b.validation_score) : -Infinity;
    if (bVal !== aVal) return bVal - aVal;

    const aTrades = Number.isFinite(Number(a.trades)) ? Number(a.trades) : -Infinity;
    const bTrades = Number.isFinite(Number(b.trades)) ? Number(b.trades) : -Infinity;
    return bTrades - aTrades;
  });

  return arr[0];
}

function resolvePrototypeRulesBySetupShape(champion, metaRows = []) {
  const shape = extractSetupShape(champion && champion.setupId);
  if (!shape) return null;

  const samePhase = metaRows.filter((row) => {
    if (!row || !hasNonEmptyRules(row.rules)) return false;
    const rules = row.rules || {};
    const rowPhase = String(rules.session_phase || '').toLowerCase();
    return rowPhase === shape.sessionPhase;
  });

  if (!samePhase.length) return null;

  const preferred = samePhase.filter((row) => String(row.source || '').toLowerCase() === 'grid');
  const best = pickBestRulesCandidate(preferred.length ? preferred : samePhase);

  return best && hasNonEmptyRules(best.rules) ? best.rules : null;
}

function resolveChampionRules(champion, metaMap, strategyMap, metaRows = []) {
  const id = String(champion.setupId || '');
  const familyKey =
    champion.familyKey ||
    champion.parentFamilyId ||
    extractCanonicalFamilyKey(id);

  const fromChampion = hasNonEmptyRules(champion.rules) ? champion.rules : null;
  if (fromChampion) return fromChampion;

  const fromMetaExact =
    (metaMap[id] && hasNonEmptyRules(metaMap[id].rules) ? metaMap[id].rules : null) ||
    (Array.isArray(metaRows)
      ? metaRows.find((r) => r && String(r.setupId) === id && hasNonEmptyRules(r.rules))?.rules
      : null) ||
    null;
  if (fromMetaExact) return fromMetaExact;

  const fromStrategyExact =
    strategyMap[id] && hasNonEmptyRules(strategyMap[id].rules)
      ? strategyMap[id].rules
      : null;
  if (fromStrategyExact) return fromStrategyExact;

  const familyCandidates = (Array.isArray(metaRows) ? metaRows : []).filter((row) => {
    if (!row || !row.setupId || !hasNonEmptyRules(row.rules)) return false;

    const rowFamilyKey =
      row.familyKey ||
      row.parentFamilyId ||
      extractCanonicalFamilyKey(row.setupId);

    if (familyKey && rowFamilyKey === familyKey) return true;
    if (familyKey && String(row.setupId).startsWith(String(familyKey) + '_')) return true;

    return false;
  });

  if (familyCandidates.length) {
    familyCandidates.sort((a, b) => {
      const aMeta = Number.isFinite(Number(a.meta_score)) ? Number(a.meta_score) : -Infinity;
      const bMeta = Number.isFinite(Number(b.meta_score)) ? Number(b.meta_score) : -Infinity;
      if (bMeta !== aMeta) return bMeta - aMeta;

      const aVal = Number.isFinite(Number(a.validation_score))
        ? Number(a.validation_score)
        : -Infinity;
      const bVal = Number.isFinite(Number(b.validation_score))
        ? Number(b.validation_score)
        : -Infinity;
      if (bVal !== aVal) return bVal - aVal;

      const aTrades = Number.isFinite(Number(a.trades)) ? Number(a.trades) : -Infinity;
      const bTrades = Number.isFinite(Number(b.trades)) ? Number(b.trades) : -Infinity;
      return bTrades - aTrades;
    });

    return familyCandidates[0].rules;
  }

  const prototypeRules = resolvePrototypeRulesBySetupShape(champion, metaRows);
  if (prototypeRules) return prototypeRules;

  return null;
}

function runBuildNextGenerationFromChampions(opts = {}) {
  const championSetupsDir = opts.championSetupsDir ?? dataRoot.getPath('champion_setups');
  const generatedDir = opts.generatedDir ?? dataRoot.getPath('generated_strategies');
  const discoveryDir = opts.discoveryDir ?? dataRoot.getPath('discovery');

  ensureDir(generatedDir);
  ensureDir(discoveryDir);

  let champions = loadChampionRegistry(championSetupsDir);
  const strategyMap = loadStrategyMapBySetupId(generatedDir);
  const metaMap = loadMetaStrategiesBySetupId(discoveryDir);
  const metaPath = path.join(discoveryDir, 'meta_ranking.json');
  const metaJson = safeReadJson(metaPath) || {};
  const metaRows = Array.isArray(metaJson.strategies) ? metaJson.strategies : [];

  const wave1NextGen = applyWave1NextGenInjection(champions, metaRows);
  champions = wave1NextGen.champions;
  if (wave1NextGen.audit.enabled) {
    // eslint-disable-next-line no-console -- operational
    console.log('WAVE1_NEXT_GEN_INJECTION', {
      injectedParents: wave1NextGen.audit.injectedSetupIds.length,
      symbols: wave1NextGen.audit.symbols,
      minParentsPerSymbol: wave1NextGen.audit.minParentsPerSymbol,
      skipped: wave1NextGen.audit.skipped || null,
      minStabilityApplied: wave1NextGen.audit.minStabilityApplied,
      note: wave1NextGen.audit.note || null,
    });
  }
  const metaLearningPath = path.join(discoveryDir, 'pattern_meta_learning.json');
  const metaLearning = safeReadJson(metaLearningPath) || {};

  let nextGenSaltResolved;
  try {
    nextGenSaltResolved = resolveNextGenRunSalt();
  } catch (e) {
    nextGenSaltResolved = { salt: String(Date.now()), source: 'error_fallback' };
    // eslint-disable-next-line no-console -- fail-soft audit
    console.warn(
      JSON.stringify({
        tag: 'NEXT_GEN_SALT_WARNING',
        message: e && e.message ? String(e.message) : String(e),
      })
    );
  }
  const nextGenIdRunSalt = nextGenSaltResolved.salt;
  const nextGenSaltSource = nextGenSaltResolved.source;

  const saltDigest = shortHash(nextGenIdRunSalt);
  // eslint-disable-next-line no-console -- operational; never log raw salt (secrets / cycle ids stay off console when possible — digest only)
  console.log(
    JSON.stringify({
      tag: 'NEXT_GEN_SALT',
      saltDigest,
      saltLength: String(nextGenIdRunSalt).length,
      source: nextGenSaltSource,
    })
  );

  // eslint-disable-next-line no-console -- operational policy
  console.log('NEXT_GEN_ID_POLICY', {
    runSaltEnabled: true,
    runSaltSource: nextGenSaltSource,
    saltDigest,
    affects: 'childName_childSetupId_only',
    compositeSigUnchanged: true,
  });

  const mutationHotspotPolicy = loadMutationHotspotPolicy();
  const mutationHotspotApplications = [];
  if (mutationHotspotPolicy) {
    // eslint-disable-next-line no-console -- operational
    console.log('MUTATION_HOTSPOT_POLICY', {
      enabled: mutationHotspotPolicy.enabled,
      path: mutationHotspotPolicy.path || null,
      warning: mutationHotspotPolicy.warning || null,
      rulesLoaded:
        mutationHotspotPolicy.doc && Array.isArray(mutationHotspotPolicy.doc.rules)
          ? mutationHotspotPolicy.doc.rules.length
          : 0,
    });
  }

  let paperMutationLearningResult = null;
  if (String(process.env.NEUROPILOT_MUTATION_PAPER_LEARNING || '').trim() === '1') {
    const root = dataRoot.getDataRoot();
    const mPath = path.join(discoveryDir, 'mutation_paper_learning.json');
    const paperStatsMappedTrades = (r) => {
      if (!r || !r.stats) return 0;
      const n = Number(r.stats.mappedTrades);
      return Number.isFinite(n) ? n : 0;
    };
    try {
      paperMutationLearningResult = computePaperMutationLearning({
        dataRoot: root,
        governanceDir: path.join(root, 'governance'),
        generatedDir,
      });
      if (paperMutationLearningResult && !paperMutationLearningResult.skipped) {
        // eslint-disable-next-line no-console -- operational; no PnL dumps
        console.log(
          JSON.stringify({
            tag: 'MUTATION_PAPER_LEARNING',
            applied: true,
            multipliers: paperMutationLearningResult.multipliers,
            tradeCount: paperMutationLearningResult.tradeCount,
            stats: {
              mappedTrades: paperStatsMappedTrades(paperMutationLearningResult),
            },
          })
        );
      } else if (paperMutationLearningResult && paperMutationLearningResult.skipped) {
        // eslint-disable-next-line no-console -- operational
        console.log(
          JSON.stringify({
            tag: 'MUTATION_PAPER_LEARNING_SKIP',
            reason: paperMutationLearningResult.reason,
            tradeCount: paperMutationLearningResult.tradeCount,
            stats: {
              mappedTrades: paperStatsMappedTrades(paperMutationLearningResult),
            },
            minTotal: paperMutationLearningResult.minTotal,
            minPerType: paperMutationLearningResult.minPerType,
            minMul: paperMutationLearningResult.minMul,
            maxMul: paperMutationLearningResult.maxMul,
          })
        );
      }
    } catch (e) {
      paperMutationLearningResult = null;
      // eslint-disable-next-line no-console -- fail-soft audit
      console.warn(
        JSON.stringify({
          tag: 'MUTATION_PAPER_LEARNING_ERROR',
          message: e && e.message ? String(e.message) : String(e),
        })
      );
    }
    try {
      if (paperMutationLearningResult) {
        const doc = buildMutationPaperLearningArtifactDoc(paperMutationLearningResult);
        fs.writeFileSync(mPath, JSON.stringify(doc, null, 2), 'utf8');
      }
    } catch (writeErr) {
      // eslint-disable-next-line no-console -- fail-soft audit
      console.warn(
        JSON.stringify({
          tag: 'MUTATION_PAPER_LEARNING_ARTIFACT_WRITE_ERROR',
          message:
            writeErr && writeErr.message ? String(writeErr.message) : String(writeErr),
        })
      );
    }
  }

  const maxTotal = Math.min(NEXT_GEN_MAX_CHILDREN, opts.maxTotalChildren ?? NEXT_GEN_MAX_CHILDREN);
  const maxPerChampion = Math.min(MAX_CHILDREN_PER_CHAMPION, opts.maxChildrenPerChampion ?? MAX_CHILDREN_PER_CHAMPION);

  const existingSetupIds = new Set();
  try {
    const names = fs.readdirSync(generatedDir);
    for (const n of names) {
      if (n.startsWith('setup_mut_') && (n.endsWith('.json') || n.endsWith('.js'))) {
        const base = n.replace(/\.(json|js)$/, '');
        const id = base.replace(/^setup_mut_/, '');
        if (id) existingSetupIds.add(id);
      }
    }
  } catch (_) { /* ignore */ }

  const skipReasons = {
    noRules: 0,
    noVariantsProduced: 0,
    allVariantsFiltered: 0,
    duplicateSetupId: 0,
    duplicateSignature: 0,
    writeError: 0,
  };

  const duplicateSignature = new Set();
  const written = [];
  const byMutationType = Object.create(null);
  const byParentSetupId = Object.create(null);
  let skippedDuplicates = 0;
  let totalGenerated = 0;

  const redundancyInstrumentation = {
    totalVariantAttempts: 0,
    globalDistinctMaterialSignaturesAmongAttempts: 0,
    duplicateMaterialSignatureAttemptsTotal: 0,
    jitterNoOpCountTotal: 0,
    championsWithRulesAttempted: 0,
    variantAttemptsByMutationType: Object.create(null),
    redundantAttemptsByMutationType: Object.create(null),
    perChampion: [],
  };
  const globalMaterialSigsAmongAttempts = new Set();

  const filterInstrumentation = {
    variantsPassedPrecandidateFilter: 0,
    variantsRejectedTotal: 0,
    rejectedDuplicateCompositeSigOnly: 0,
    rejectedExistingSetupIdOnly: 0,
    rejectedBothCompositeSigAndExistingId: 0,
    rejectedDistinctMaterialInParentBatch: 0,
    championsAnalyzedForPrecandidate: 0,
    championsWithZeroAfterPrecandidate: 0,
    byMutationType: Object.create(null),
    perChampion: [],
    filterSemantics:
      'Precandidate: pass iff compositeSig not in global duplicateSignature AND childSetupId not in existingSetupIds (disk + this run). compositeSig = parentFamilyKey|mutationType|materialRulesSignature(rules).',
  };

  champions.forEach((champion, championIndex) => {
    if (totalGenerated >= maxTotal) return;

    const parentRules = resolveChampionRules(champion, metaMap, strategyMap, metaRows);
    if (!parentRules || typeof parentRules !== 'object' || !Object.keys(parentRules).length) {
      skipReasons.noRules += 1;
      if (championIndex < 3) {
        console.log('NEXT_GEN_DEBUG', {
          setupId: champion.setupId,
          hasRules: !!parentRules,
          ruleKeys: parentRules ? Object.keys(parentRules) : [],
        });
      }
      return;
    }

    if (championIndex < 3) {
      console.log('NEXT_GEN_DEBUG', {
        setupId: champion.setupId,
        hasRules: !!parentRules,
        ruleKeys: parentRules ? Object.keys(parentRules) : [],
      });
    }

    const parentSetupId = String(champion.setupId);
    const parentFamilyId = champion.parentFamilyId || champion.familyKey || parentSetupId;
    const parentFamilyKey = champion.familyKey || buildFamilyKey(parentRules);
    const parentLineageKey = champion.lineageKey || `${parentFamilyKey}_L0`;
    const parentGeneration = Number.isFinite(Number(champion.generation)) ? Number(champion.generation) : 0;
    const childGeneration = parentGeneration + 1;
    const lineageRoot = parentLineageKey.replace(/_L\d+$/, '') || parentFamilyKey;
    const childLineageKey = `${lineageRoot}_L${childGeneration}`;

    const mutRes = buildMutationsConfigResult(
      champion,
      parentSetupId,
      mutationHotspotPolicy,
      paperMutationLearningResult && !paperMutationLearningResult.skipped
        ? paperMutationLearningResult
        : null
    );
    const mutationsConfig = mutRes.mutations;
    if (mutRes.hotspotApplied) {
      mutationHotspotApplications.push({
        parentSetupId,
        applied: mutRes.hotspotApplied,
        profileAfter: {
          jitterScale: mutRes.profile.jitterScale,
          sessionFlipWeight: mutRes.profile.sessionFlipWeight,
          regimeFlipWeight: mutRes.profile.regimeFlipWeight,
          forcedFamilyShiftWeight: mutRes.profile.forcedFamilyShiftWeight,
          mode: mutRes.profile.mode,
        },
      });
    }

    const variants = [];
    for (const mut of mutationsConfig) {
      let rules = mut.fn.length >= 2 ? mut.fn(parentRules, parentSetupId) : mut.fn(parentRules);
      const patchSeed = numericSeed(`${parentSetupId}|${mut.type}|${materialRulesSignature(rules)}`);
      rules = applyNextGenSignalRulePatches(rules, patchSeed);
      const sig = `${parentFamilyKey}|${mut.type}|${materialRulesSignature(rules)}`;
      const childNameSeed = `${parentSetupId}|${mut.type}|${sig}|${nextGenIdRunSalt}`;
      const childName = `mut_${shortHash(childNameSeed)}`;
      const childSetupId = computeCanonicalSetupId({ name: childName, rules });
      variants.push({ rules, mutationType: mut.type, sig, childSetupId });
    }

    redundancyInstrumentation.championsWithRulesAttempted += 1;
    redundancyInstrumentation.totalVariantAttempts += variants.length;
    for (const v of variants) {
      globalMaterialSigsAmongAttempts.add(materialRulesSignature(v.rules));
    }

    const champRed = computeChampionRedundancyStats(
      parentSetupId,
      variants,
      parentRules
    );
    redundancyInstrumentation.perChampion.push(champRed);
    redundancyInstrumentation.duplicateMaterialSignatureAttemptsTotal +=
      champRed.duplicateMaterialSignatureAttempts;
    redundancyInstrumentation.jitterNoOpCountTotal += champRed.jitterNoOpCount;
    mergeCountMaps(
      redundancyInstrumentation.variantAttemptsByMutationType,
      champRed.variantAttemptsByMutationType
    );
    mergeCountMaps(
      redundancyInstrumentation.redundantAttemptsByMutationType,
      champRed.redundantAttemptsByMutationType
    );

    if (!Array.isArray(variants) || !variants.length) {
      skipReasons.noVariantsProduced += 1;
      if (championIndex < 3) {
        console.log('NEXT_GEN_VARIANTS_DEBUG', {
          setupId: champion.setupId,
          variantsProduced: 0,
          filteredVariants: 0,
        });
      }
      return;
    }

    const champFilter = analyzePrecandidateFilterForChampion(
      variants,
      parentSetupId,
      duplicateSignature,
      existingSetupIds
    );
    filterInstrumentation.variantsPassedPrecandidateFilter +=
      champFilter.passedPrecandidateCount;
    filterInstrumentation.variantsRejectedTotal += champFilter.rejectedTotal;
    filterInstrumentation.rejectedDuplicateCompositeSigOnly +=
      champFilter.rejectedDuplicateCompositeSigOnly;
    filterInstrumentation.rejectedExistingSetupIdOnly +=
      champFilter.rejectedExistingSetupIdOnly;
    filterInstrumentation.rejectedBothCompositeSigAndExistingId +=
      champFilter.rejectedBoth;
    filterInstrumentation.rejectedDistinctMaterialInParentBatch +=
      champFilter.rejectedDistinctMaterialInParentBatch;
    filterInstrumentation.championsAnalyzedForPrecandidate += 1;
    if (champFilter.passedPrecandidateCount === 0) {
      filterInstrumentation.championsWithZeroAfterPrecandidate += 1;
    }
    mergeFilterMutationBuckets(
      filterInstrumentation.byMutationType,
      champFilter.byMutationType
    );
    filterInstrumentation.perChampion.push(champFilter);

    const filteredVariants = variants.filter(
      (v) => !duplicateSignature.has(v.sig) && !existingSetupIds.has(v.childSetupId)
    );

    if (championIndex < 3) {
      console.log('NEXT_GEN_VARIANTS_DEBUG', {
        setupId: champion.setupId,
        variantsProduced: variants.length,
        filteredVariants: filteredVariants.length,
        precandidateRejected: champFilter.rejectedTotal,
        precandidateDupCompositeOnly: champFilter.rejectedDuplicateCompositeSigOnly,
        precandidateExistingIdOnly: champFilter.rejectedExistingSetupIdOnly,
        precandidateBoth: champFilter.rejectedBoth,
      });
    }

    if (!Array.isArray(filteredVariants) || !filteredVariants.length) {
      skipReasons.allVariantsFiltered += 1;
      return;
    }

    filteredVariants.sort(
      (a, b) =>
        scoreVariantWithMetaLearning(b.rules, metaLearning) -
        scoreVariantWithMetaLearning(a.rules, metaLearning)
    );

    const budget = Math.min(maxPerChampion, maxTotal - totalGenerated);
    let produced = 0;

    for (const v of filteredVariants) {
      if (produced >= budget) break;
      if (duplicateSignature.has(v.sig)) {
        skipReasons.duplicateSignature += 1;
        continue;
      }
      if (existingSetupIds.has(v.childSetupId)) {
        skipReasons.duplicateSetupId += 1;
        continue;
      }

      const childFamilyKey = buildFamilyKey(v.rules);
      const child = {
        setupId: v.childSetupId,
        parentSetupId,
        parentFamilyId,
        familyKey: childFamilyKey,
        lineageKey: childLineageKey,
        generation: childGeneration,
        mutationType: v.mutationType,
        source: 'champion_mutation',
        rules: v.rules,
      };

      const filename = `setup_mut_${v.childSetupId}.json`;
      const filePath = path.join(generatedDir, filename);
      try {
        fs.writeFileSync(filePath, JSON.stringify(child, null, 2), 'utf8');
        written.push(filePath);
        existingSetupIds.add(v.childSetupId);
        duplicateSignature.add(v.sig);
        byMutationType[v.mutationType] = (byMutationType[v.mutationType] || 0) + 1;
        byParentSetupId[parentSetupId] = (byParentSetupId[parentSetupId] || 0) + 1;
        produced++;
        totalGenerated++;
      } catch (e) {
        console.warn('buildNextGeneration: write failed', filename, e && e.message);
        skipReasons.writeError += 1;
      }
    }
  });

  redundancyInstrumentation.globalDistinctMaterialSignaturesAmongAttempts =
    globalMaterialSigsAmongAttempts.size;

  const perChSorted = redundancyInstrumentation.perChampion
    .slice()
    .sort((a, b) => {
      const d =
        b.duplicateMaterialSignatureAttempts -
        a.duplicateMaterialSignatureAttempts;
      if (d !== 0) return d;
      return b.variantAttempts - a.variantAttempts;
    });
  redundancyInstrumentation.topRedundantParents = perChSorted.slice(0, 15).map((c) => ({
    parentSetupId: c.parentSetupId,
    duplicateMaterialSignatureAttempts: c.duplicateMaterialSignatureAttempts,
    distinctMaterialSignatures: c.distinctMaterialSignatures,
    variantAttempts: c.variantAttempts,
    jitterNoOpCount: c.jitterNoOpCount,
  }));

  redundancyInstrumentation.topRedundantMutationTypes = topEntriesFromMap(
    redundancyInstrumentation.redundantAttemptsByMutationType,
    15
  );

  const jitterAttempts =
    redundancyInstrumentation.variantAttemptsByMutationType.parameter_jitter || 0;
  redundancyInstrumentation.parameterJitterAttempts = jitterAttempts;
  redundancyInstrumentation.jitterNoOpRate =
    jitterAttempts > 0
      ? Math.round(
          (redundancyInstrumentation.jitterNoOpCountTotal / jitterAttempts) * 1e6
        ) / 1e6
      : null;

  redundancyInstrumentation.childrenWrittenByMutationType = { ...byMutationType };
  redundancyInstrumentation.childrenWrittenByParentSetupId = { ...byParentSetupId };

  const pcFilter = filterInstrumentation.perChampion.slice();
  pcFilter.sort((a, b) => {
    const d = b.rejectedTotal - a.rejectedTotal;
    if (d !== 0) return d;
    return b.variantAttempts - a.variantAttempts;
  });
  filterInstrumentation.topChampionsByPrecandidateRejections = pcFilter
    .slice(0, 15)
    .map((c) => ({
      parentSetupId: c.parentSetupId,
      variantAttempts: c.variantAttempts,
      passedPrecandidateCount: c.passedPrecandidateCount,
      rejectedTotal: c.rejectedTotal,
      rejectedDuplicateCompositeSigOnly: c.rejectedDuplicateCompositeSigOnly,
      rejectedExistingSetupIdOnly: c.rejectedExistingSetupIdOnly,
      rejectedBoth: c.rejectedBoth,
      rejectedDistinctMaterialInParentBatch: c.rejectedDistinctMaterialInParentBatch,
    }));

  const allBlocked = filterInstrumentation.perChampion.filter(
    (c) => c.passedPrecandidateCount === 0 && c.variantAttempts > 0
  );
  allBlocked.sort((a, b) => b.variantAttempts - a.variantAttempts);
  filterInstrumentation.topChampionsAllVariantsPrecandidateFiltered = allBlocked
    .slice(0, 15)
    .map((c) => ({
      parentSetupId: c.parentSetupId,
      variantAttempts: c.variantAttempts,
      rejectedDuplicateCompositeSigOnly: c.rejectedDuplicateCompositeSigOnly,
      rejectedExistingSetupIdOnly: c.rejectedExistingSetupIdOnly,
      rejectedBoth: c.rejectedBoth,
      rejectedDistinctMaterialInParentBatch: c.rejectedDistinctMaterialInParentBatch,
      byMutationType: c.byMutationType,
    }));

  const idGeneration = {
    runSaltEnabled: true,
    runSaltSource: nextGenSaltSource,
    runSaltDigest: saltDigest,
    runSaltLength: String(nextGenIdRunSalt).length,
    semantics:
      'Affects childName/childSetupId only; does not affect compositeSig or rules. Salt: NEXT_GEN_ID_RUN_SALT, else NEUROPILOT_CYCLE_ID, else timestamp. Report stores digest only.',
  };

  const report = {
    generatedAt: new Date().toISOString(),
    dataRoot: dataRoot.getDataRoot(),
    championsSeen: champions.length,
    childrenGenerated: written.length,
    skippedDuplicates,
    skipReasons,
    byMutationType,
    byParentSetupId,
    idGeneration,
    mutationHotspotPolicy: mutationHotspotPolicy
      ? {
          enabled: true,
          path: mutationHotspotPolicy.path || null,
          warning: mutationHotspotPolicy.warning || null,
          rulesLoaded:
            mutationHotspotPolicy.doc && Array.isArray(mutationHotspotPolicy.doc.rules)
              ? mutationHotspotPolicy.doc.rules.length
              : 0,
          parentsMatched: mutationHotspotApplications.length,
          applications: mutationHotspotApplications,
        }
      : { enabled: false },
    redundancyInstrumentation,
    filterInstrumentation,
    wave1NextGenInjection: wave1NextGen.audit,
    paperMutationLearning: (() => {
      if (String(process.env.NEUROPILOT_MUTATION_PAPER_LEARNING || '').trim() !== '1') {
        return { enabled: false };
      }
      const mappedOf = (r) => {
        if (!r || !r.stats) return 0;
        const n = Number(r.stats.mappedTrades);
        return Number.isFinite(n) ? n : 0;
      };
      if (paperMutationLearningResult && !paperMutationLearningResult.skipped) {
        return {
          applied: true,
          multipliers: paperMutationLearningResult.multipliers,
          tradeCount: paperMutationLearningResult.tradeCount,
          stats: { mappedTrades: mappedOf(paperMutationLearningResult) },
          artifact: 'mutation_paper_learning.json',
        };
      }
      const base = {
        applied: false,
        skippedReason:
          paperMutationLearningResult && paperMutationLearningResult.skipped
            ? paperMutationLearningResult.reason
            : 'compute_failed_or_empty',
        stats: { mappedTrades: mappedOf(paperMutationLearningResult) },
      };
      if (paperMutationLearningResult && paperMutationLearningResult.skipped) {
        base.artifact = 'mutation_paper_learning.json';
      }
      if (
        paperMutationLearningResult &&
        paperMutationLearningResult.tradeCount != null &&
        Number.isFinite(Number(paperMutationLearningResult.tradeCount))
      ) {
        base.tradeCount = Number(paperMutationLearningResult.tradeCount);
      }
      return base;
    })(),
  };

  const reportPath = path.join(discoveryDir, 'next_generation_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  return {
    reportPath,
    written,
    report,
  };
}

function main() {
  const result = runBuildNextGenerationFromChampions();
  const ri = result.report.redundancyInstrumentation;
  const fi = result.report.filterInstrumentation;
  console.log('Next Generation Builder done.');
  console.log('  Champions seen:', result.report.championsSeen);
  console.log('  Children generated:', result.report.childrenGenerated);
  console.log('  Skipped duplicates:', result.report.skippedDuplicates);
  console.log('  Skip reasons:', result.report.skipReasons);
  if (ri) {
    console.log('NEXT_GEN_REDUNDANCY_SUMMARY', {
      totalVariantAttempts: ri.totalVariantAttempts,
      globalDistinctMaterialSignaturesAmongAttempts:
        ri.globalDistinctMaterialSignaturesAmongAttempts,
      duplicateMaterialSignatureAttemptsTotal:
        ri.duplicateMaterialSignatureAttemptsTotal,
      jitterNoOpCountTotal: ri.jitterNoOpCountTotal,
      parameterJitterAttempts: ri.parameterJitterAttempts,
      jitterNoOpRate: ri.jitterNoOpRate,
      topRedundantParents: ri.topRedundantParents,
      topRedundantMutationTypes: ri.topRedundantMutationTypes,
    });
  }
  if (fi) {
    console.log('NEXT_GEN_FILTER_SUMMARY', {
      variantsPassedPrecandidateFilter: fi.variantsPassedPrecandidateFilter,
      variantsRejectedTotal: fi.variantsRejectedTotal,
      rejectedDuplicateCompositeSigOnly: fi.rejectedDuplicateCompositeSigOnly,
      rejectedExistingSetupIdOnly: fi.rejectedExistingSetupIdOnly,
      rejectedBothCompositeSigAndExistingId: fi.rejectedBothCompositeSigAndExistingId,
      rejectedDistinctMaterialInParentBatch: fi.rejectedDistinctMaterialInParentBatch,
      championsWithZeroAfterPrecandidate: fi.championsWithZeroAfterPrecandidate,
      championsAnalyzedForPrecandidate: fi.championsAnalyzedForPrecandidate,
      byMutationType: fi.byMutationType,
      topChampionsAllVariantsPrecandidateFiltered:
        fi.topChampionsAllVariantsPrecandidateFiltered,
    });
  }
  console.log('  Report:', result.reportPath);
}

if (require.main === module) {
  main();
}

module.exports = {
  runBuildNextGenerationFromChampions,
  buildMutationsConfig,
  buildMutationsConfigResult,
  getAdaptiveMutationProfile,
  computeChampionRedundancyStats,
  materialRulesSignature,
  analyzePrecandidateFilterForChampion,
};
