'use strict';

/**
 * NeuroPilot Quant Engine v1 — Research Report Generator
 *
 * Generates a structured research report from performance analysis, strategy ranking,
 * and optional metadata. Pure function: no side effects, no database or file writes.
 *
 * Inputs:
 *   - analysis: from performanceAnalyzer.analyze(records)
 *   - ranking: from strategyRanking.rank(analysis)
 *   - metadata: optional { generatedAt, symbol, timeframe, note, ... }
 *
 * Output:
 *   - { generatedAt, summary, ranking, recommendations, notes }
 */

/**
 * Build report metadata (generatedAt, etc.). Safe for missing metadata.
 *
 * @param {object} [metadata] - Optional { generatedAt: Date|string|number, symbol, timeframe, ... }
 * @returns {object} { generatedAt: ISO string, ...rest } for report header
 */
function buildReportMetadata(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  let generatedAt = meta.generatedAt;
  if (generatedAt == null) {
    generatedAt = new Date().toISOString();
  } else if (typeof generatedAt === 'number') {
    generatedAt = new Date(generatedAt).toISOString();
  } else if (typeof generatedAt === 'string') {
    generatedAt = new Date(generatedAt).toISOString();
  } else if (generatedAt instanceof Date) {
    generatedAt = generatedAt.toISOString();
  } else {
    generatedAt = new Date().toISOString();
  }
  return {
    generatedAt,
    ...meta,
  };
}

/**
 * Build summary section from analysis. Safe for empty analysis.
 *
 * @param {object} [analysis] - Performance analysis object
 * @returns {object} { totalRecords, validSignals, tradeableSignals, topRegime, topStrategy }
 */
function buildSummary(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    return {
      totalRecords: 0,
      validSignals: 0,
      tradeableSignals: 0,
      topRegime: null,
      topStrategy: null,
    };
  }
  const totals = analysis.totals || {};
  return {
    totalRecords: typeof totals.totalRecords === 'number' ? totals.totalRecords : 0,
    validSignals: typeof totals.validSignals === 'number' ? totals.validSignals : 0,
    tradeableSignals: typeof totals.tradeableSignals === 'number' ? totals.tradeableSignals : 0,
    topRegime: analysis.topRegime != null ? analysis.topRegime : null,
    topStrategy: analysis.topStrategy != null ? analysis.topStrategy : null,
  };
}

/**
 * Build notes array from analysis, ranking, and metadata (data quality, sample size, etc.). Easy to extend.
 *
 * @param {object} [analysis] - Performance analysis
 * @param {object} [ranking] - Strategy ranking
 * @param {object} [metadata] - Optional metadata (note, symbol, timeframe)
 * @returns {string[]} Array of note strings
 */
function buildNotes(analysis, ranking, metadata) {
  const notes = [];

  const summary = buildSummary(analysis);
  if (summary.totalRecords > 0) {
    notes.push(`Total records: ${summary.totalRecords}`);
    notes.push(`Tradeable signals: ${summary.tradeableSignals} (${summary.totalRecords > 0 ? ((summary.tradeableSignals / summary.totalRecords) * 100).toFixed(1) : 0}%)`);
  } else {
    notes.push('No records in analysis');
  }

  const minSample = 30;
  if (summary.totalRecords > 0 && summary.totalRecords < minSample) {
    notes.push(`Low sample size (${summary.totalRecords} < ${minSample}); consider more data for robust ranking`);
  }

  if (ranking && Array.isArray(ranking.recommendations) && ranking.recommendations.length > 0) {
    const first = ranking.recommendations[0];
    if (typeof first === 'string' && first.includes('Insufficient')) {
      notes.push('Ranking indicates insufficient data for strong recommendations');
    }
  }

  if (metadata && typeof metadata.note === 'string' && metadata.note.trim()) {
    notes.push(metadata.note.trim());
  }

  if (metadata && (metadata.symbol || metadata.timeframe)) {
    const parts = [];
    if (metadata.symbol) parts.push(metadata.symbol);
    if (metadata.timeframe) parts.push(metadata.timeframe);
    notes.push(`Context: ${parts.join(' ')}`);
  }

  return notes;
}

/**
 * Generate a structured research report. Pure function; safe for empty inputs.
 *
 * @param {object} [analysis] - Performance analysis from performanceAnalyzer.analyze(records)
 * @param {object} [ranking] - Strategy ranking from strategyRanking.rank(analysis)
 * @param {object} [metadata] - Optional { generatedAt, symbol, timeframe, note, ... }
 * @returns {object} { generatedAt, summary, ranking, recommendations, notes }
 */
function generate(analysis, ranking, metadata = {}) {
  const meta = buildReportMetadata(metadata);
  const summary = buildSummary(analysis);
  const rankingSafe = ranking && typeof ranking === 'object' ? ranking : { topStrategies: [], topRegimes: [], recommendations: [] };
  const recommendations = Array.isArray(rankingSafe.recommendations) ? rankingSafe.recommendations : [];
  const notes = buildNotes(analysis, rankingSafe, metadata);

  return {
    generatedAt: meta.generatedAt,
    summary,
    ranking: {
      topStrategies: Array.isArray(rankingSafe.topStrategies) ? rankingSafe.topStrategies : [],
      topRegimes: Array.isArray(rankingSafe.topRegimes) ? rankingSafe.topRegimes : [],
    },
    recommendations,
    notes,
  };
}

module.exports = {
  generate,
  buildSummary,
  buildNotes,
  buildReportMetadata,
};
