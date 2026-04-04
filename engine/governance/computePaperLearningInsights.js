'use strict';

/**
 * Learning Loop V1 — suggestive only. Reads paper metrics; NEVER mutates engines or policy files.
 * Contract: PAPER_LEARNING_INSIGHTS_SCHEMA.md
 */

const LEARNING_INSIGHTS_VERSION = '1.0.0';
const SOURCE = 'paper_trades_metrics_v2';

/** Min trades per strategy to enter ranking / percentile suggestions */
const MIN_TRADES_PER_STRATEGY = 5;

/** Min eligible strategies (each with >= MIN_TRADES) to emit boost/reduce percentiles */
const MIN_ELIGIBLE_STRATEGIES_FOR_SUGGESTIONS = 3;

const CONFIDENCE_LOW_MAX_TOTAL_TRADES = 19;
const CONFIDENCE_MEDIUM_MAX_TOTAL_TRADES = 59;

function roundScore(x) {
  return Math.round(x * 1e6) / 1e6;
}

function populationVariance(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return values.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
}

/**
 * @param {object|null} paperMetrics - V1 global blob
 * @param {object|null} v2 - paperTradesMetricsV2 full
 */
function computePaperLearningInsights(paperMetrics, v2) {
  const generatedAt = new Date().toISOString();

  const safeBase = {
    learningInsightsVersion: LEARNING_INSIGHTS_VERSION,
    generatedAt,
    source: SOURCE,
    global: {
      trades: 0,
      winRate: null,
      totalPnl: null,
      avgPnl: null,
    },
    strategyRanking: [],
    suggestions: {
      strategiesToBoost: [],
      strategiesToReduce: [],
      notes: [],
    },
    confidence: 'low',
    summaryBestStrategyId: null,
    summaryWorstStrategyId: null,
    safety: {
      mode: 'suggestive_only',
      applied: false,
    },
  };

  if (!v2 || typeof v2 !== 'object') {
    safeBase.suggestions.notes.push('missing_or_invalid_paper_trades_metrics_v2');
    return safeBase;
  }

  const pm = paperMetrics && typeof paperMetrics === 'object' ? paperMetrics : {};
  const globalTrades = typeof pm.validTradeCount === 'number' ? pm.validTradeCount : 0;
  safeBase.global = {
    trades: globalTrades,
    winRate: pm.winRate != null ? pm.winRate : null,
    totalPnl: pm.totalPnl != null ? pm.totalPnl : null,
    avgPnl: pm.avgPnl != null ? pm.avgPnl : null,
  };

  const parseErrors = typeof v2.parseErrors === 'number' ? v2.parseErrors : 0;
  if (parseErrors > 0) {
    safeBase.suggestions.notes.push('paper_jsonl_parse_errors_present_treat_insights_with_caution');
  }

  const byStrategy = Array.isArray(v2.byStrategy) ? v2.byStrategy : [];
  const eligible = byStrategy.filter(
    (s) => s && typeof s === 'object' && typeof s.trades === 'number' && s.trades >= MIN_TRADES_PER_STRATEGY
  );

  if (eligible.length === 0) {
    safeBase.suggestions.notes.push(
      `no_strategy_meets_min_trades_${MIN_TRADES_PER_STRATEGY}_for_ranking`
    );
    safeBase.confidence = deriveConfidence(globalTrades, 0, parseErrors);
    return safeBase;
  }

  const pnls = eligible.map((e) => (e.totalPnl != null ? e.totalPnl : 0));
  const wrs = eligible.map((e) => (e.winRate != null ? e.winRate : 0));
  const minP = Math.min(...pnls);
  const maxP = Math.max(...pnls);
  const minW = Math.min(...wrs);
  const maxW = Math.max(...wrs);

  function normP(p) {
    if (maxP === minP) return 0.5;
    return (p - minP) / (maxP - minP);
  }
  function normW(w) {
    if (maxW === minW) return 0.5;
    return (w - minW) / (maxW - minW);
  }

  const varPnl = populationVariance(pnls);
  const meanAbsPnl = pnls.reduce((a, b) => a + Math.abs(b), 0) / pnls.length;
  if (eligible.length >= 2 && varPnl > 0 && meanAbsPnl > 1e-8 && varPnl / meanAbsPnl > 2) {
    safeBase.suggestions.notes.push('high_variance_across_strategy_total_pnl');
  }

  const ranking = eligible
    .map((s) => {
      const pnl = s.totalPnl != null ? s.totalPnl : 0;
      const wr = s.winRate != null ? s.winRate : 0;
      const score = roundScore(0.7 * normP(pnl) + 0.3 * normW(wr));
      return {
        strategyId: String(s.strategyId),
        trades: s.trades,
        winRate: s.winRate,
        totalPnl: s.totalPnl,
        score,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.strategyId.localeCompare(b.strategyId);
    });

  safeBase.strategyRanking = ranking;
  if (ranking.length > 0) {
    safeBase.summaryBestStrategyId = ranking[0].strategyId;
    safeBase.summaryWorstStrategyId = ranking[ranking.length - 1].strategyId;
  }

  const n = ranking.length;
  if (n >= MIN_ELIGIBLE_STRATEGIES_FOR_SUGGESTIONS) {
    const k = Math.max(1, Math.ceil(n * 0.2));
    safeBase.suggestions.strategiesToBoost = ranking.slice(0, k).map((r) => r.strategyId);
    safeBase.suggestions.strategiesToReduce = ranking
      .slice(-k)
      .map((r) => r.strategyId)
      .reverse();
  } else {
    safeBase.suggestions.notes.push(
      `insufficient_eligible_strategies_for_percentile_suggestions_need_${MIN_ELIGIBLE_STRATEGIES_FOR_SUGGESTIONS}`
    );
  }

  safeBase.confidence = deriveConfidence(globalTrades, n, parseErrors);

  return safeBase;
}

function deriveConfidence(totalTrades, eligibleCount, parseErrors) {
  if (parseErrors > 0) return 'low';
  if (totalTrades < CONFIDENCE_LOW_MAX_TOTAL_TRADES || eligibleCount < 2) return 'low';
  if (totalTrades <= CONFIDENCE_MEDIUM_MAX_TOTAL_TRADES || eligibleCount < 3) return 'medium';
  return 'high';
}

module.exports = {
  computePaperLearningInsights,
  LEARNING_INSIGHTS_VERSION,
  MIN_TRADES_PER_STRATEGY,
  MIN_ELIGIBLE_STRATEGIES_FOR_SUGGESTIONS,
  SOURCE,
};
