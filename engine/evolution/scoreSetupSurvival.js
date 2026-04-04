'use strict';

/**
 * Strategy Evolution Engine — Score each setup for survival and promotion.
 *
 * Rules:
 * - Positive night: expectancy > 0, trades >= 20, bootstrap_risk < 20% (or null).
 * - Validated: at least 2 positive nights out of the last 3.
 * - Champion: expectancy > 0, trades >= 30, bootstrap < 10%, at least 3 consecutive validations.
 * - Demote: expectancy negative, bootstrap explodes, or too few validations.
 */

// Thresholds (configurable via env or args later)
const VALIDATED_MIN_TRADES = 20;
const VALIDATED_MAX_BOOTSTRAP = 0.2;
const CHAMPION_MIN_TRADES = 30;
const CHAMPION_MAX_BOOTSTRAP = 0.1;
const VALIDATED_MIN_POSITIVE_NIGHTS_IN_LAST = 2;
const VALIDATED_LAST_N_NIGHTS = 3;
const CHAMPION_CONSECUTIVE_VALIDATIONS = 3;

/** Minimum number of nights before any setup can become champion. */
const MIN_NIGHTS_FOR_CHAMPION = 3;

/** Single-night validated: minimum trades on current run. */
const SINGLE_NIGHT_VALIDATED_MIN_TRADES = 15;

/** Single-night validated: minimum meta_score to consider (when no validation/walk-forward). */
const SINGLE_NIGHT_VALIDATED_MIN_META_SCORE = 0.4;

/** Single-night validated: minimum validation_score to accept (when validation available). */
const SINGLE_NIGHT_VALIDATED_MIN_VALIDATION_SCORE = 0.45;

// Champion calibration (multi-night, quality + stability)
const CHAMPION_MIN_SURVIVAL_SCORE = 0.75;
const CHAMPION_MIN_META_SCORE = 0.47;
const CHAMPION_MIN_BEATS_PARENT_RATE = 0.5;
const CHAMPION_MIN_VALIDATION_SCORE = 0.55;
/** Stability: at least this many positive nights in the last 3. */
const CHAMPION_STABILITY_MIN_POSITIVE_IN_LAST_3 = 2;
/** Stability: OR at least this many positive nights in full history. */
const CHAMPION_STABILITY_MIN_NIGHTS_SURVIVED = 2;

/**
 * Compute from history: nightsSurvived (positive count), avgMetaScore, beatsParentRate, avgParentVsChildScore, lastRaw.
 * Used only for champion graduation.
 * @param {Array} history - Sorted by date ascending
 * @returns {{ nightsSurvived: number, avgMetaScore: number|null, beatsParentRate: number|null, avgParentVsChildScore: number|null, lastRaw: object }}
 */
function getChampionQualityMetrics(history) {
  if (!Array.isArray(history) || !history.length) {
    return { nightsSurvived: 0, avgMetaScore: null, beatsParentRate: null, avgParentVsChildScore: null, lastRaw: {} };
  }
  const positiveCount = history.filter((h) => isPositiveNight(h)).length;
  const metaScores = history.map((h) => h.meta_score != null ? h.meta_score : (h.raw && h.raw.meta_score)).filter((v) => Number.isFinite(v));
  const avgMetaScore = metaScores.length > 0 ? metaScores.reduce((a, b) => a + b, 0) / metaScores.length : null;
  const beatsRates = history.map((h) => (h.beats_parent === true || (h.raw && h.raw.beats_parent === true)) ? 1 : 0);
  const beatsParentRate = beatsRates.length > 0 ? beatsRates.reduce((a, b) => a + b, 0) / beatsRates.length : null;
  const pvcScores = history.map((h) => h.parent_vs_child_score != null ? h.parent_vs_child_score : (h.raw && h.raw.parent_vs_child_score)).filter((v) => Number.isFinite(v));
  const avgParentVsChildScore = pvcScores.length > 0 ? pvcScores.reduce((a, b) => a + b, 0) / pvcScores.length : null;
  const last = history[history.length - 1];
  const lastRaw = (last && (last.raw || last)) || {};
  return { nightsSurvived: positiveCount, avgMetaScore, beatsParentRate, avgParentVsChildScore, lastRaw };
}

/** Average of finite numbers in array; null if none. */
function avgValues(arr) {
  if (!Array.isArray(arr)) return null;
  const finite = arr.filter((v) => Number.isFinite(Number(v)));
  return finite.length ? finite.reduce((a, b) => a + Number(b), 0) / finite.length : null;
}

/**
 * Check if a single night record counts as "positive" (validated for that night).
 * bootstrap_risk may be null (e.g. when using meta_ranking.json without bootstrap).
 * @param {{ expectancy: number|null, trades: number, bootstrap_risk: number|null }} night
 * @returns {boolean}
 */
function isPositiveNight(night) {
  if (!night || typeof night !== 'object') return false;

  const expectancy = Number(night.expectancy);
  const trades = Number(night.trades);
  const bootstrapRisk =
    night.bootstrap_risk == null ? null : Number(night.bootstrap_risk);

  const metaScore =
    night.raw && Number.isFinite(Number(night.raw.meta_score))
      ? Number(night.raw.meta_score)
      : Number.isFinite(Number(night.meta_score))
        ? Number(night.meta_score)
        : null;

  // Standard path
  const expectancyOk = Number.isFinite(expectancy) && expectancy > 0;
  const tradesOk = Number.isFinite(trades) && trades >= 20;
  const bootstrapOk =
    bootstrapRisk == null ||
    (Number.isFinite(bootstrapRisk) && bootstrapRisk <= 0.2);

  if (expectancyOk && tradesOk && bootstrapOk) {
    return true;
  }

  // Legacy-safe fallback:
  // nightly/discovery rows may have missing expectancy/trades/bootstrap,
  // but still carry a useful meta_score.
  if (Number.isFinite(metaScore) && metaScore >= 0.45) {
    return true;
  }

  return false;
}

/**
 * Check if a single night is "champion-grade" (stricter).
 */
function isChampionNight(record) {
  const e = record.expectancy;
  const t = record.trades;
  const b = record.bootstrap_risk;
  if (e == null || e <= 0) return false;
  if (t < CHAMPION_MIN_TRADES) return false;
  if (b != null && b > CHAMPION_MAX_BOOTSTRAP) return false;
  return true;
}

/**
 * Count consecutive positive nights from the end of history (most recent first).
 * @param {Array<{ dateKey: string, expectancy: number|null, trades: number, bootstrap_risk: number|null }>} history
 * @returns {number}
 */
function countConsecutivePositiveFromEnd(history) {
  if (!history.length) return 0;
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (!isPositiveNight(history[i])) break;
    count++;
  }
  return count;
}

/**
 * Count positive nights in the last N nights.
 * @param {Array} history - Sorted by date ascending
 * @param {number} n - Last n nights
 * @returns {number}
 */
function countPositiveInLastN(history, n) {
  const last = history.slice(-n);
  return last.filter(isPositiveNight).length;
}

/**
 * Compute survival score in [0, 1]. Based on ratio of positive nights and consecutive streak.
 * @param {Array} history
 * @returns {number}
 */
function computeSurvivalScore(history) {
  if (!history.length) return 0;
  const positiveRatio = history.filter(isPositiveNight).length / history.length;
  const consecutive = countConsecutivePositiveFromEnd(history);
  const streakFactor = Math.min(1, consecutive / CHAMPION_CONSECUTIVE_VALIDATIONS);
  return Math.round((positiveRatio * 0.5 + streakFactor * 0.5) * 100) / 100;
}

/**
 * Check if the current (last) night is strong enough for single-night validated.
 * Uses meta_score, validationPassed/validation_score, expectancy, trades, beats_parent.
 * @param {object} last - Last history row (may have .raw from meta_ranking)
 * @returns {boolean}
 */
function isStrongSingleNight(last) {
  if (!last) return false;

  const trades = Number(last.trades);
  if (!Number.isFinite(trades) || trades < SINGLE_NIGHT_VALIDATED_MIN_TRADES) return false;

  const expectancy = last.expectancy;
  if (expectancy != null && expectancy <= 0) return false;

  if (last.bootstrap_risk != null && last.bootstrap_risk > VALIDATED_MAX_BOOTSTRAP) return false;

  const raw = last.raw || last;

  const validationPassed = raw.validationPassed === true;
  const validationScore = Number(raw.validation_score);
  const hasValidationScore = Number.isFinite(validationScore);

  const metaScore = Number(raw.meta_score);
  const hasMetaScore = Number.isFinite(metaScore);

  const beatsParent = raw.beats_parent === true;
  const parentVsChild = Number(raw.parent_vs_child_score);

  if (validationPassed || (hasValidationScore && validationScore >= SINGLE_NIGHT_VALIDATED_MIN_VALIDATION_SCORE)) {
    return true;
  }
  if (hasMetaScore && metaScore >= SINGLE_NIGHT_VALIDATED_MIN_META_SCORE) {
    return true;
  }
  if (beatsParent && Number.isFinite(parentVsChild) && parentVsChild > 0) {
    return true;
  }

  return false;
}

/**
 * Determine status: candidate | validated | champion.
 * Optionally takes survivalScore so champion can require minimum survival score.
 *
 * Champion (calibrated): requires MIN_NIGHTS_FOR_CHAMPION, stability (2 of last 3 positive OR 2+ positive nights),
 * quality (survivalScore >= 0.75, avgMetaScore >= 0.47), and at least one of: beatsParentRate >= 0.5,
 * avgParentVsChildScore > 0, validationPassed, or validation_score >= 0.55. Does not require 3 consecutive.
 *
 * @param {Array} history - Sorted by date ascending
 * @param {number} [survivalScore] - From computeSurvivalScore(history), for champion gate
 * @returns {{ status: 'candidate'|'validated'|'champion', reason: string }}
 */
function computeStatus(history, survivalScore = 0) {
  const sorted = Array.isArray(history) ? history.slice() : [];
  if (!sorted.length) {
    return { status: 'candidate', reason: 'no_history' };
  }

  const last = sorted[sorted.length - 1];
  const nightsCount = (history && Array.isArray(history) && Number.isFinite(history.length))
    ? history.length
    : sorted.length;
  const positiveInLast3 = sorted.slice(-3).filter((h) => isPositiveNight(h)).length;

  const metaScores = sorted
    .map((h) => {
      if (Number.isFinite(Number(h.meta_score))) return Number(h.meta_score);
      if (h.raw && Number.isFinite(Number(h.raw.meta_score))) return Number(h.raw.meta_score);
      if (h.raw && Number.isFinite(Number(h.raw.metaScore))) return Number(h.raw.metaScore);
      return null;
    })
    .filter((v) => Number.isFinite(v));

  const avgMetaScore = avgValues(metaScores);

  const validationScores = sorted
    .map((h) => {
      if (Number.isFinite(Number(h.validation_score))) return Number(h.validation_score);
      if (h.raw && Number.isFinite(Number(h.raw.validation_score))) return Number(h.raw.validation_score);
      if (h.raw && Number.isFinite(Number(h.raw.validationScore))) return Number(h.raw.validationScore);
      return null;
    })
    .filter((v) => Number.isFinite(v));

  const avgValidationScore = avgValues(validationScores);

  const isMutationSetup =
    !!(
      last.parentSetupId ||
      last.mutationType ||
      String(last.setupId || '').startsWith('mut_')
    );
  const beatsParentRate = avgValues(sorted.map((h) => (h.beats_parent === true || (h.raw && h.raw.beats_parent === true)) ? 1 : 0));
  const avgParentVsChildScore = avgValues(sorted.map((h) => h.parent_vs_child_score != null ? h.parent_vs_child_score : (h.raw && h.raw.parent_vs_child_score)));
  const nightsSurvived = sorted.filter((h) => isPositiveNight(h)).length;

  const lastTrades = Number.isFinite(Number(last && last.trades)) ? Number(last.trades) : 0;
  const lastBootstrap =
    last && last.bootstrap_risk == null
      ? null
      : Number.isFinite(Number(last && last.bootstrap_risk))
        ? Number(last.bootstrap_risk)
        : null;

  const lastRaw = last && last.raw ? last.raw : {};
  const lastValidationPassed = lastRaw && lastRaw.validationPassed === true;
  const lastValidationScore =
    Number.isFinite(Number(lastRaw && lastRaw.validation_score))
      ? Number(lastRaw.validation_score)
      : null;

  let isBaseSetup =
    !last.parentSetupId ||
    last.parentSetupId === 'root' ||
    last.lineageDepth === 0 ||
    !Number.isFinite(Number(avgParentVsChildScore));
  // fallback safety: detect base by depth
  if (!isBaseSetup && Number(last.lineageDepth) === 0) {
    isBaseSetup = true;
  }

  const championTradesOk =
    isBaseSetup
      ? lastTrades >= 15
      : lastTrades >= 30;
  const championBootstrapOk = lastBootstrap == null || lastBootstrap <= 0.2;
  const championStabilityOk =
    positiveInLast3 >= 2 || nightsSurvived >= 2;

  const championQualityOk =
    survivalScore >= 0.75 &&
    Number.isFinite(avgMetaScore) &&
    avgMetaScore >= 0.47;

  const championParentChildSignalOk =
    (Number.isFinite(beatsParentRate) && beatsParentRate >= 0.5) ||
    (Number.isFinite(avgParentVsChildScore) && avgParentVsChildScore > 0) ||
    lastValidationPassed === true ||
    (Number.isFinite(lastValidationScore) && lastValidationScore >= 0.55);

  // Base setups can become champion without parent/child metrics
  const championBaseSignalOk =
    isBaseSetup &&
    survivalScore >= 0.9 &&
    Number.isFinite(avgMetaScore) &&
    avgMetaScore >= 0.485 &&
    nightsSurvived >= 3;

  const championSignalOk =
    isBaseSetup
      ? championBaseSignalOk
      : championParentChildSignalOk;

  // Force unlock base setups if all core metrics are strong
  const championBaseOverride =
    isBaseSetup &&
    nightsCount >= 3 &&
    survivalScore >= 0.95 &&
    avgMetaScore >= 0.48;

  const mutationChampionOverride =
    isMutationSetup &&
    nightsCount >= 4 &&
    survivalScore >= 0.95 &&
    Number(avgMetaScore) >= 0.48 &&
    (avgValidationScore == null || Number(avgValidationScore) >= 0.6);

  if (isMutationSetup && process.env.EVOLUTION_DEBUG_MUTATION === '1') {
    console.log('MUTATION_STATUS_DEBUG', {
      setupId: last.setupId || null,
      nightsCount,
      survivalScore,
      avgMetaScore,
      avgValidationScore,
      parentSetupId: last.parentSetupId || null,
      mutationType: last.mutationType || null,
      isMutationSetup,
      mutationChampionOverride,
    });
  }

  if (mutationChampionOverride) {
    return {
      status: 'champion',
      reason: 'champion_mutation_accelerated',
    };
  }

  if (
    (
      nightsCount >= 3 &&
      championTradesOk &&
      championBootstrapOk &&
      championStabilityOk &&
      championQualityOk &&
      championSignalOk
    ) ||
    championBaseOverride
  ) {
    return {
      status: 'champion',
      reason: isBaseSetup && (championBaseSignalOk || championBaseOverride)
        ? 'champion_base_multi_night'
        : 'champion_multi_night',
    };
  }

  // validated multi-night
  if (positiveInLast3 >= 2 && lastTrades >= 20) {
    return { status: 'validated', reason: 'validated_multi_night' };
  }

  // validated single-night
  if (sorted.length === 1 && isStrongSingleNight(last)) {
    return { status: 'validated', reason: 'validated_single_night' };
  }

  return { status: 'candidate', reason: 'candidate_default' };
}

/**
 * Score one setup: status, survivalScore, nightsSurvived, avgExpectancy, avgBootstrapRisk.
 * @param {string} setupId
 * @param {Array<{ date: string, dateKey: string, expectancy: number|null, trades: number, bootstrap_risk: number|null, winRate: number|null }>} history
 * @returns {{ setupId: string, status: string, survivalScore: number, nightsSurvived: number, avgExpectancy: number|null, avgBootstrapRisk: number|null, lastTrades: number }}
 */
function scoreSetupSurvival(setupId, history) {
  const sorted = [...history].sort((a, b) => (a.dateKey || '').localeCompare(b.dateKey || ''));

  const survivalScore = computeSurvivalScore(sorted);
  const { status, reason: statusReason } = computeStatus(sorted, survivalScore);

  const withExpectancy = sorted.filter((r) => r.expectancy != null);
  const avgExpectancy =
    withExpectancy.length > 0
      ? Math.round((withExpectancy.reduce((s, r) => s + r.expectancy, 0) / withExpectancy.length) * 100) / 100
      : null;

  const withBootstrap = sorted.filter((r) => r.bootstrap_risk != null);
  const avgBootstrapRisk =
    withBootstrap.length > 0
      ? Math.round((withBootstrap.reduce((s, r) => s + r.bootstrap_risk, 0) / withBootstrap.length) * 100) / 100
      : null;

  const last = sorted[sorted.length - 1];
  const lastTrades = last ? last.trades : 0;

  return {
    setupId,
    status,
    statusReason,
    survivalScore,
    nightsSurvived: sorted.length,
    avgExpectancy,
    avgBootstrapRisk,
    lastTrades,
  };
}

module.exports = {
  scoreSetupSurvival,
  isPositiveNight,
  isChampionNight,
  isStrongSingleNight,
  getChampionQualityMetrics,
  countConsecutivePositiveFromEnd,
  countPositiveInLastN,
  computeSurvivalScore,
  computeStatus,
  VALIDATED_MIN_TRADES,
  VALIDATED_MAX_BOOTSTRAP,
  CHAMPION_MIN_TRADES,
  CHAMPION_MAX_BOOTSTRAP,
  CHAMPION_CONSECUTIVE_VALIDATIONS,
  MIN_NIGHTS_FOR_CHAMPION,
  CHAMPION_MIN_SURVIVAL_SCORE,
  CHAMPION_MIN_META_SCORE,
  CHAMPION_MIN_BEATS_PARENT_RATE,
  CHAMPION_MIN_VALIDATION_SCORE,
  CHAMPION_STABILITY_MIN_POSITIVE_IN_LAST_3,
  CHAMPION_STABILITY_MIN_NIGHTS_SURVIVED,
  SINGLE_NIGHT_VALIDATED_MIN_TRADES,
  SINGLE_NIGHT_VALIDATED_MIN_META_SCORE,
  SINGLE_NIGHT_VALIDATED_MIN_VALIDATION_SCORE,
};
