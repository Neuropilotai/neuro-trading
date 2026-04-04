'use strict';

/**
 * P0 — Instrumentation from last metrics + history (deterministic).
 * @param {{ lastMetrics: object | null, history: object[] }} args
 */
function computeLearningScores({ lastMetrics, history }) {
  if (!lastMetrics) {
    return {
      learningScore: null,
      explorationScore: null,
      adaptationScore: null,
    };
  }

  const learningScore = Number(lastMetrics.delta ?? 0);

  const explorationScore =
    Number(lastMetrics.wildcardPromotions ?? 0) +
    Number(lastMetrics.wildcardPromotionsTieBreak ?? 0);

  const h = Array.isArray(history) ? history : [];
  const stagnation =
    h.length >= 5 && h.slice(-5).every((x) => Number(x.delta) <= 0);

  const adaptationScore = stagnation ? 1 : 0;

  return {
    learningScore,
    explorationScore,
    adaptationScore,
  };
}

module.exports = {
  computeLearningScores,
};
