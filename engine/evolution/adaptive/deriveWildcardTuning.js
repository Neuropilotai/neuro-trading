'use strict';

/**
 * P2 — Effective wildcard thresholds from stagnation (deterministic).
 * @param {object} args
 * @param {number} args.baseMinDelta
 * @param {number} args.baseMaxPromotions
 * @param {{ isStagnating: boolean }} args.stagnation
 */
function deriveAdaptiveWildcardOpts({
  baseMinDelta,
  baseMaxPromotions,
  stagnation,
}) {
  if (process.env.EVOLUTION_ADAPTIVE_ENABLE !== '1') {
    return {
      minDelta: baseMinDelta,
      maxPromotions: baseMaxPromotions,
    };
  }

  let minDelta = baseMinDelta;
  let maxPromotions = baseMaxPromotions;

  if (stagnation.isStagnating) {
    minDelta = baseMinDelta * 0.75;
    maxPromotions = baseMaxPromotions + 2;
  }

  const minFloor = Number(
    process.env.EVOLUTION_ADAPTIVE_MIN_DELTA_FLOOR ?? 0.0001
  );
  const maxCap = Number(
    process.env.EVOLUTION_ADAPTIVE_MAX_PROMOTIONS_CAP ?? 10
  );

  const floorOk = Number.isFinite(minFloor) && minFloor >= 0 ? minFloor : 0.0001;
  const capOk =
    Number.isFinite(maxCap) && maxCap >= 1 ? Math.min(10, maxCap) : 10;

  return {
    minDelta: Math.max(minDelta, floorOk),
    maxPromotions: Math.min(maxPromotions, capOk),
  };
}

module.exports = {
  deriveAdaptiveWildcardOpts,
};
