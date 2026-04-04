'use strict';

/**
 * Aggregates append-only governance/paper_trades.jsonl into operator metrics (read-only).
 * Contract: PAPER_TRADES_METRICS_SCHEMA.md
 */

const { parsePaperTradesJsonlContent } = require('./parsePaperTradesJsonl');
const { nonProductionNameSignals } = require('./computeStrategyValidationFramework');
const { computeStrategyValidationFromContent } = require('./computeStrategyValidationFramework');

const PAPER_TRADES_METRICS_SCHEMA_VERSION = '1.0.0';

function parseIsoMs(iso) {
  if (iso == null || iso === '') return null;
  const ms = new Date(String(iso)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {string} content - full JSONL file content
 * @param {object} [opts]
 * @param {string} [opts.sourceJsonl] - path for reporting
 * @returns {object} metrics blob
 */
function computePaperTradesMetricsFromJsonlContent(content, opts = {}) {
  const sourceJsonl = opts.sourceJsonl != null ? String(opts.sourceJsonl) : null;
  const generatedAt = new Date().toISOString();
  const filePresent = opts.sourceFilePresent === true;

  if (content == null || content === '') {
    return {
      paperTradesMetricsSchemaVersion: PAPER_TRADES_METRICS_SCHEMA_VERSION,
      generatedAt,
      sourceJsonl,
      sourceExists: filePresent,
      lineCount: 0,
      parseErrors: 0,
      validTradeCount: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRate: null,
      totalPnl: null,
      avgPnl: null,
      byReason: {},
      lastTradeTs: null,
      schemaVersionsSeen: [],
      status: filePresent ? 'no_valid_trades' : 'empty_or_missing',
    };
  }

  const { trades, parseErrors, lineCount } = parsePaperTradesJsonlContent(content);
  const strictValidation = computeStrategyValidationFromContent(content);
  const excludedByValidation = new Set(
    ((strictValidation && Array.isArray(strictValidation.rows)) ? strictValidation.rows : [])
      .filter((r) => r && r.mode === 'promotion' && r.excludedFromRanking === true)
      .map((r) => String(r.strategyId))
  );
  const eligibleTrades = [];
  let excludedNonProductionTrades = 0;
  let excludedByValidationTrades = 0;
  const excludedByStrategy = {};

  for (const t of trades) {
    const sid =
      t.strategyId != null && String(t.strategyId).trim() !== ''
        ? String(t.strategyId).trim()
        : 'unknown';
    const nameSignals = nonProductionNameSignals(sid);
    if (nameSignals.hardMatched) {
      excludedNonProductionTrades += 1;
      excludedByStrategy[sid] = (excludedByStrategy[sid] || 0) + 1;
      continue;
    }
    if (excludedByValidation.has(sid)) {
      excludedByValidationTrades += 1;
      excludedByStrategy[sid] = (excludedByStrategy[sid] || 0) + 1;
      continue;
    }
    eligibleTrades.push(t);
  }

  const schemaSet = new Set();
  for (const o of eligibleTrades) {
    schemaSet.add(String(o.paperExecutionSchemaVersion));
  }

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  const byReason = {};
  let totalPnl = 0;
  let lastMs = null;
  let lastTsIso = null;

  for (const t of eligibleTrades) {
    if (t.pnl > 0) wins++;
    else if (t.pnl < 0) losses++;
    else breakeven++;

    totalPnl += t.pnl;

    const r = t.reason != null && String(t.reason).trim() !== '' ? String(t.reason).trim() : 'unknown';
    byReason[r] = (byReason[r] || 0) + 1;

    const tsCand = t.exitTs || t.ts || null;
    const ms = parseIsoMs(tsCand);
    if (ms != null && (lastMs == null || ms > lastMs)) {
      lastMs = ms;
      lastTsIso = tsCand;
    }
  }

  const n = eligibleTrades.length;
  const winRate = n > 0 ? Math.round((wins / n) * 10000) / 100 : null;
  const avgPnl = n > 0 ? Math.round((totalPnl / n) * 1e8) / 1e8 : null;
  const totalPnlR = n > 0 ? Math.round(totalPnl * 1e8) / 1e8 : null;

  return {
    paperTradesMetricsSchemaVersion: PAPER_TRADES_METRICS_SCHEMA_VERSION,
    generatedAt,
    sourceJsonl,
    sourceExists: true,
    lineCount,
    parseErrors,
    validationExclusionMode: 'promotion_strict',
    rawValidTradeCount: trades.length,
    excludedNonProductionTrades,
    excludedByValidationTrades,
    excludedByStrategy,
    validTradeCount: n,
    wins,
    losses,
    breakeven,
    winRate,
    totalPnl: totalPnlR,
    avgPnl,
    byReason,
    lastTradeTs: lastTsIso,
    schemaVersionsSeen: Array.from(schemaSet).sort(),
    status: n === 0 && parseErrors === 0 ? 'no_valid_trades' : parseErrors > 0 ? 'has_parse_errors' : 'ok',
  };
}

/**
 * @param {string} filePath - absolute path to paper_trades.jsonl
 * @param {import('fs')} [fs] - for tests
 */
function computePaperTradesMetricsFromJsonlFile(filePath, fs = require('fs')) {
  if (!filePath || !fs.existsSync(filePath)) {
    return computePaperTradesMetricsFromJsonlContent('', { sourceJsonl: filePath, sourceFilePresent: false });
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return computePaperTradesMetricsFromJsonlContent(content, {
    sourceJsonl: filePath,
    sourceFilePresent: true,
  });
}

module.exports = {
  computePaperTradesMetricsFromJsonlContent,
  computePaperTradesMetricsFromJsonlFile,
  PAPER_TRADES_METRICS_SCHEMA_VERSION,
};
