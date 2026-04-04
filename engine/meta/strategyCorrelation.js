#!/usr/bin/env node
'use strict';

/**
 * Strategy Correlation / Similarity Proxy
 *
 * Goal:
 *  - provide a lightweight, deterministic similarity proxy between strategies
 *  - penalize candidates that are too close to already selected strategies
 *  - enable diversified portfolio selection before final allocation
 *
 * This is NOT a true return-correlation engine yet.
 * It uses structural similarity:
 *  - family / parent family
 *  - parent setup lineage
 *  - source / mutation type
 *  - session phase / regime inferred from rules
 *  - byAsset overlap
 *  - byTimeframe overlap
 */

const { computeReturnCorrelationPenalty, getPairCorrelation } = require('./strategyReturnCorrelation');

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round6(v) {
  return Math.round(safeNum(v, 0) * 1e6) / 1e6;
}

function normalizeMap(objOrArray, keyField, valueField) {
  const out = new Map();

  if (Array.isArray(objOrArray)) {
    for (const row of objOrArray) {
      if (!row) continue;
      const k = String(row[keyField] || '').trim();
      if (!k) continue;
      out.set(k, safeNum(row[valueField], 0));
    }
    return out;
  }

  if (objOrArray && typeof objOrArray === 'object') {
    for (const [k, v] of Object.entries(objOrArray)) {
      out.set(String(k), safeNum(v, 0));
    }
  }

  return out;
}

function normalizeWeightsMap(m) {
  const total = Array.from(m.values()).reduce((a, b) => a + safeNum(b, 0), 0);
  if (total <= 0) return m;

  const out = new Map();
  for (const [k, v] of m.entries()) {
    out.set(k, safeNum(v, 0) / total);
  }
  return out;
}

function cosineLikeSimilarity(mapA, mapB) {
  const a = normalizeWeightsMap(mapA);
  const b = normalizeWeightsMap(mapB);

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [, v] of a.entries()) normA += v * v;
  for (const [, v] of b.entries()) normB += v * v;

  for (const [k, va] of a.entries()) {
    const vb = b.get(k);
    if (vb != null) dot += va * vb;
  }

  if (normA <= 0 || normB <= 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

function getRules(strategy) {
  return strategy && typeof strategy.rules === 'object' && strategy.rules
    ? strategy.rules
    : {};
}

function getSessionPhase(strategy) {
  const rules = getRules(strategy);
  return String(
    strategy.session_phase ||
      rules.session_phase ||
      strategy.sessionPhase ||
      'unknown'
  ).toLowerCase();
}

function getRegime(strategy) {
  const rules = getRules(strategy);
  return String(
    strategy.regime ||
      rules.regime ||
      strategy.inferredRegime ||
      'unknown'
  ).toLowerCase();
}

function getAssetMap(strategy) {
  return normalizeMap(strategy.byAsset || [], 'asset', 'contribution');
}

function getTimeframeMap(strategy) {
  return normalizeMap(strategy.byTimeframe || [], 'timeframe', 'contribution');
}

function computeStrategySimilarity(a, b, opts = {}) {
  const weights = {
    sameFamily: safeNum(opts.sameFamilyWeight, 0.22),
    sameParentFamily: safeNum(opts.sameParentFamilyWeight, 0.16),
    sameParent: safeNum(opts.sameParentWeight, 0.10),
    sameMutationType: safeNum(opts.sameMutationTypeWeight, 0.05),
    sameSource: safeNum(opts.sameSourceWeight, 0.03),
    sameSession: safeNum(opts.sameSessionWeight, 0.08),
    sameRegime: safeNum(opts.sameRegimeWeight, 0.08),
    assetOverlap: safeNum(opts.assetOverlapWeight, 0.16),
    timeframeOverlap: safeNum(opts.timeframeOverlapWeight, 0.12),
  };

  let score = 0;

  const familyA = String(a.familyId || '').trim();
  const familyB = String(b.familyId || '').trim();
  const parentFamilyA = String(a.parentFamilyId || '').trim();
  const parentFamilyB = String(b.parentFamilyId || '').trim();
  const parentA = String(a.parentSetupId || '').trim();
  const parentB = String(b.parentSetupId || '').trim();
  const mutationA = String(a.mutationType || '').trim();
  const mutationB = String(b.mutationType || '').trim();
  const sourceA = String(a.source || '').trim();
  const sourceB = String(b.source || '').trim();

  if (familyA && familyB && familyA === familyB) score += weights.sameFamily;
  if (parentFamilyA && parentFamilyB && parentFamilyA === parentFamilyB) {
    score += weights.sameParentFamily;
  }
  if (parentA && parentB && parentA === parentB) score += weights.sameParent;
  if (mutationA && mutationB && mutationA === mutationB) score += weights.sameMutationType;
  if (sourceA && sourceB && sourceA === sourceB) score += weights.sameSource;

  if (getSessionPhase(a) === getSessionPhase(b)) score += weights.sameSession;
  if (getRegime(a) === getRegime(b)) score += weights.sameRegime;

  const assetSim = cosineLikeSimilarity(getAssetMap(a), getAssetMap(b));
  const timeframeSim = cosineLikeSimilarity(getTimeframeMap(a), getTimeframeMap(b));

  score += assetSim * weights.assetOverlap;
  score += timeframeSim * weights.timeframeOverlap;

  return round6(Math.max(0, Math.min(1, score)));
}

function computeCorrelationPenalty(candidate, selected, opts = {}) {
  const selectedList = Array.isArray(selected) ? selected : [];
  if (!selectedList.length) {
    return {
      penalty: 0,
      avgSimilarity: 0,
      maxSimilarity: 0,
      details: [],
    };
  }

  const penaltyScale = safeNum(opts.penaltyScale, 0.35);
  const floorIgnore = safeNum(opts.floorIgnore, 0.15);

  const details = selectedList.map((s) => {
    const similarity = computeStrategySimilarity(candidate, s, opts);
    return {
      againstSetupId: s.setupId,
      similarity,
    };
  });

  const sims = details.map((d) => d.similarity);
  const avgSimilarity =
    sims.reduce((a, b) => a + safeNum(b, 0), 0) / Math.max(1, sims.length);
  const maxSimilarity = sims.reduce((m, v) => Math.max(m, safeNum(v, 0)), 0);

  const effectiveAvg = Math.max(0, avgSimilarity - floorIgnore);
  const effectiveMax = Math.max(0, maxSimilarity - floorIgnore);

  const penalty = round6(
    Math.min(
      0.5,
      penaltyScale * (effectiveAvg * 0.55 + effectiveMax * 0.45)
    )
  );

  return {
    penalty,
    avgSimilarity: round6(avgSimilarity),
    maxSimilarity: round6(maxSimilarity),
    details,
  };
}

function selectDiversifiedPortfolio(candidates, opts = {}) {
  const list = Array.isArray(candidates) ? [...candidates] : [];
  const maxStrategies = Math.max(1, safeNum(opts.maxStrategies, 12));

  const maxSimilarityThreshold = safeNum(opts.maxSimilarityThreshold, 0.75);
  const forceDiversifiedSlot = !!opts.forceDiversifiedSlot;

  const selected = [];
  const rejected = [];

  const returnCorrMatrix = opts.returnCorrMatrix || null;
  const structureWeight = safeNum(opts.structurePenaltyWeight, 0.4);
  const returnWeight = safeNum(opts.returnPenaltyWeight, 0.6);

  while (list.length && selected.length < maxStrategies) {
    const rescored = list.map((candidate) => {
      const corr = computeCorrelationPenalty(candidate, selected, opts);
      const structurePenalty = corr.penalty;

      let returnPenalty = 0;
      if (returnCorrMatrix && returnCorrMatrix.matrix) {
        const ret = computeReturnCorrelationPenalty(candidate, selected, returnCorrMatrix, {
          penaltyScale: safeNum(opts.returnCorrelationPenaltyScale, 0.45),
          floorIgnore: safeNum(opts.returnCorrelationFloorIgnore, 0.2),
        });
        returnPenalty = ret.penalty;
      }

      const finalPenalty = round6(structurePenalty * structureWeight + returnPenalty * returnWeight);
      const baseScore = safeNum(candidate.portfolio_score, safeNum(candidate.meta_score, 0));
      const adjustedScore = round6(baseScore - finalPenalty);

      const rejectedByThreshold =
        corr.maxSimilarity > maxSimilarityThreshold && selected.length > 0;

      return {
        ...candidate,
        correlation_penalty: corr.penalty,
        return_correlation_penalty: returnPenalty,
        avg_similarity_to_selected: corr.avgSimilarity,
        max_similarity_to_selected: corr.maxSimilarity,
        rejected_by_similarity_threshold: rejectedByThreshold,
        correlation_details: corr.details,
        adjusted_portfolio_score: adjustedScore,
      };
    });

    let eligible = rescored.filter((x) => !x.rejected_by_similarity_threshold);
    if (!eligible.length) {
      eligible = rescored;
    }

    eligible.sort((a, b) => {
      return (
        safeNum(b.adjusted_portfolio_score, 0) - safeNum(a.adjusted_portfolio_score, 0) ||
        safeNum(b.portfolio_score, 0) - safeNum(a.portfolio_score, 0) ||
        safeNum(b.meta_score, 0) - safeNum(a.meta_score, 0) ||
        safeNum(b.expectancy, 0) - safeNum(a.expectancy, 0)
      );
    });

    let chosen = eligible[0];

    if (
      forceDiversifiedSlot &&
      selected.length === maxStrategies - 1 &&
      eligible.length > 1
    ) {
      eligible.sort(
        (a, b) =>
          safeNum(a.max_similarity_to_selected, 0) -
          safeNum(b.max_similarity_to_selected, 0)
      );
      chosen = eligible[0];
    }

    selected.push(chosen);

    const chosenId = String(chosen.setupId || '');
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (String(list[i].setupId || '') === chosenId) {
        list.splice(i, 1);
      }
    }

    for (const r of rescored) {
      if (String(r.setupId || '') !== chosenId) rejected.push(r);
    }
  }

  const pairwise = [];
  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) {
      pairwise.push({
        a: selected[i].setupId,
        b: selected[j].setupId,
        similarity: computeStrategySimilarity(selected[i], selected[j], opts),
      });
    }
  }

  const avgPairwise =
    pairwise.length
      ? pairwise.reduce((a, b) => a + safeNum(b.similarity, 0), 0) / pairwise.length
      : 0;

  const maxPairwise =
    pairwise.length
      ? pairwise.reduce((m, x) => Math.max(m, safeNum(x.similarity, 0)), 0)
      : 0;

  let avgReturnCorr = 0;
  let maxReturnCorr = 0;
  if (returnCorrMatrix && returnCorrMatrix.matrix && selected.length >= 2) {
    const returnPairs = [];
    for (let i = 0; i < selected.length; i += 1) {
      for (let j = i + 1; j < selected.length; j += 1) {
        const c = getPairCorrelation(returnCorrMatrix, selected[i].setupId, selected[j].setupId);
        returnPairs.push(c);
      }
    }
    if (returnPairs.length) {
      avgReturnCorr = returnPairs.reduce((a, b) => a + safeNum(b, 0), 0) / returnPairs.length;
      maxReturnCorr = Math.max(...returnPairs.map((x) => safeNum(x, 0)));
    }
  }

  const correlationSummary = {
    selection_mode: 'score_minus_correlation_penalty',
    avg_pairwise_similarity: round6(avgPairwise),
    max_pairwise_similarity: round6(maxPairwise),
    pairwise_count: pairwise.length,
    pairwise,
    avg_return_correlation: returnCorrMatrix ? round6(avgReturnCorr) : null,
    max_return_correlation: returnCorrMatrix ? round6(maxReturnCorr) : null,
    return_series_count: returnCorrMatrix ? safeNum(returnCorrMatrix.seriesCount, 0) : 0,
  };

  return {
    selected,
    rejected,
    correlationSummary,
  };
}

module.exports = {
  computeStrategySimilarity,
  computeCorrelationPenalty,
  selectDiversifiedPortfolio,
};
