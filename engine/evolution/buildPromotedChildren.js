#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const { resolveMode } = require('../learning/phaseGate');
const {
  evaluatePromotionCandidate,
  enforcePaperOnlyRuntime,
} = require('../learning/promotionGuard');
const {
  loadPromotionPaperContext,
  recordPromotionPaperCooldown,
  shouldRecordPaperCooldown,
} = require('../learning/promotionGuardPaperAware');
const { applyComputedWalkforwardToGuardCandidate } = require('../governance/computeWalkforwardValidation');
const { runWfUpstreamAudit, scanAllBatchRows } = require('./wfUpstreamAudit');
const {
  resolveUpstreamIndex,
  enrichGuardRejectionsFromUpstreamIndex,
  enrichWfMissingAuditNoValidationSiblingSamples,
} = require('./wfMissingDiagnostic');

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function num(v, fallback = 0) {
  return Number.isFinite(Number(v)) ? Number(v) : fallback;
}

function normalizeRules(rules) {
  const r = rules && typeof rules === 'object' ? { ...rules } : {};
  return {
    session_phase: r.session_phase || null,
    regime: r.regime || null,
    body_pct_min: Number.isFinite(Number(r.body_pct_min)) ? Number(r.body_pct_min) : null,
    close_strength_min: Number.isFinite(Number(r.close_strength_min)) ? Number(r.close_strength_min) : null,
    volume_ratio: Number.isFinite(Number(r.volume_ratio)) ? Number(r.volume_ratio) : null,
  };
}

function buildRuleKey(rules) {
  return JSON.stringify(normalizeRules(rules || {}));
}

function buildPromotionKey(row) {
  return [
    String(row.parentSetupId || ''),
    String(row.mutationType || 'unknown'),
    buildRuleKey(row.rules || {}),
  ].join('|');
}

function buildFamilyKey(rules) {
  const r = normalizeRules(rules);
  const body =
    Number.isFinite(r.body_pct_min)
      ? r.body_pct_min < 0.45
        ? 'body_low'
        : r.body_pct_min < 0.6
          ? 'body_mid'
          : 'body_high'
      : 'body_na';

  const close =
    Number.isFinite(r.close_strength_min)
      ? r.close_strength_min < 0.68
        ? 'cs_low'
        : r.close_strength_min < 0.8
          ? 'cs_mid'
          : 'cs_high'
      : 'cs_na';

  const vol =
    Number.isFinite(r.volume_ratio)
      ? r.volume_ratio < 1.0
        ? 'vol_low'
        : r.volume_ratio < 1.35
          ? 'vol_mid'
          : 'vol_high'
      : 'vol_na';

  return [
    r.regime || 'regime_na',
    r.session_phase || 'session_na',
    body,
    vol,
    close,
  ].join('|');
}

function buildParentFamilyPromotionKey(row) {
  return [
    String(row.parentSetupId || 'no_parent'),
    buildFamilyKey(row.rules || {}),
  ].join('|');
}

function buildParentFamilyDiversityKey(row) {
  const parentSetupId = String(row.parentSetupId || 'no_parent');
  const familyKey = buildFamilyKey(row.rules || {});
  return `${parentSetupId}|${familyKey}`;
}

function buildExistingPromotedMap(existingRows) {
  const map = new Map();
  for (const row of existingRows || []) {
    if (!row || !row.setupId) continue;
    map.set(String(row.setupId), row);
  }
  return map;
}

function computePromotionBreadthScore(distinctBatchFiles) {
  const n = Math.max(0, Number(distinctBatchFiles) || 0);

  // Breadth score normalized in [0, 0.10]
  // 1 file  -> 0.00
  // 2 files -> 0.02
  // 3 files -> 0.04
  // 4 files -> 0.06
  // 5 files -> 0.08
  // 6+      -> 0.10
  if (n >= 6) return 0.10;
  if (n >= 5) return 0.08;
  if (n >= 4) return 0.06;
  if (n >= 3) return 0.04;
  if (n >= 2) return 0.02;
  return 0.00;
}

function isPromotable(row, opts = {}) {
  const minTrades = Math.max(1, num(opts.minTrades, 50));
  const minScore = num(opts.minScore, 0);
  const minExpectancy = num(opts.minExpectancy, 0);

  return !!(
    row &&
    row.parentSetupId &&
    row.mutationType &&
    row.beats_parent === true &&
    num(row.trades, 0) >= minTrades &&
    num(row.expectancy, -999) > minExpectancy &&
    num(row.parent_vs_child_score, -999) > minScore &&
    row.rules &&
    typeof row.rules === 'object'
  );
}

/**
 * Gross-profit / gross-loss ratio from per-trade returns. Used only when row omits profitFactor/pf.
 * @param {unknown[]} tradeReturns
 * @returns {number|null|typeof Infinity}
 */
function deriveProfitFactorFromTradeReturns(tradeReturns) {
  if (!Array.isArray(tradeReturns) || tradeReturns.length === 0) return null;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const r of tradeReturns) {
    const x = Number(r);
    if (!Number.isFinite(x)) continue;
    if (x > 0) grossProfit += x;
    else if (x < 0) grossLoss += -x;
  }
  if (grossLoss > 0) return grossProfit / grossLoss;
  if (grossLoss === 0 && grossProfit > 0) return Infinity;
  return null;
}

/** Batch row is walk-forward validation segment (promotion guard can derive walkForwardPass). */
function isWalkForwardValidationRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.isValidation === true) return true;
  return String(row.walkforwardSplit || '').toLowerCase() === 'validation';
}

/** Broader than isWalkForwardValidationRow: any row that looks like a validation split (audit / schema drift). */
function hasValidationLikeMetadata(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.isValidation === true) return true;
  const wf = String(row.walkforwardSplit || '').toLowerCase();
  if (wf === 'validation') return true;
  const ds = String(row.datasetSplit || '').toLowerCase();
  return ds === 'validation';
}

function summarizeRowForWfAudit(row) {
  const r = row && typeof row === 'object' ? row : {};
  let wfRaw = null;
  if (r.walkForwardPass === true || r.walkForwardPass === false) wfRaw = r.walkForwardPass;
  else if (r.walk_forward_pass === true || r.walk_forward_pass === false) wfRaw = r.walk_forward_pass;
  return {
    setupId: r.setupId != null ? String(r.setupId) : null,
    walkforwardSplit: r.walkforwardSplit != null ? String(r.walkforwardSplit) : null,
    datasetSplit: r.datasetSplit != null ? String(r.datasetSplit) : null,
    isValidation: r.isValidation === true,
    walkForwardPassRaw: wfRaw,
    isWalkForwardValidationRow: isWalkForwardValidationRow(r),
    hasValidationLikeMetadata: hasValidationLikeMetadata(r),
    parent_vs_child_score: num(r.parent_vs_child_score, -Infinity),
    expectancy: num(r.expectancy, -Infinity),
    trades: num(r.trades, -Infinity),
  };
}

/**
 * Walk-forward signal as seen by promotionGuard.extractWalkForwardPassRaw (explicit booleans only).
 * Differs from rowToGuardCandidate when row only has isValidation / walkforwardSplit.
 */
function extractWalkForwardPassGuardOnly(row) {
  const o = row && typeof row === 'object' ? row : {};
  if (o.walkForwardPass === true || o.walk_forward_pass === true) return true;
  if (o.walkForwardPass === false || o.walk_forward_pass === false) return false;
  return undefined;
}

function buildWfAuditReport(rowsByPromotionKey, bestByPromotionKey, dedupedRows, mergeSibling = false) {
  const promotionKeysTotal = rowsByPromotionKey.size;
  let promotionKeysWithMultipleRows = 0;
  let promotionKeysWithAnyValidationLikeRow = 0;
  let promotionKeysWhereValidationRowMatchesDetector = 0;
  let promotionKeysWhereWinnerIsValidationRow = 0;
  let promotionKeysWithValidationSiblingButTrainWinner = 0;

  for (const [, rows] of rowsByPromotionKey) {
    if (rows.length > 1) promotionKeysWithMultipleRows += 1;
    const anyValLike = rows.some((r) => hasValidationLikeMetadata(r));
    const anyDetector = rows.some((r) => isWalkForwardValidationRow(r));
    if (anyValLike) promotionKeysWithAnyValidationLikeRow += 1;
    if (anyDetector) promotionKeysWhereValidationRowMatchesDetector += 1;
  }

  for (const [key, rows] of rowsByPromotionKey) {
    const winner = bestByPromotionKey.get(key);
    if (!winner) continue;
    if (isWalkForwardValidationRow(winner)) promotionKeysWhereWinnerIsValidationRow += 1;
    const hasValSibling = rows.some((r) => hasValidationLikeMetadata(r) && r !== winner);
    const trainWins =
      hasValidationLikeMetadata(winner) === false &&
      rows.some((r) => hasValidationLikeMetadata(r));
    if (trainWins) promotionKeysWithValidationSiblingButTrainWinner += 1;
  }

  let promotedCandidatesWithWalkForwardPassDefined = 0;
  let promotedCandidatesWithWalkForwardPassTrue = 0;
  let promotedCandidatesWithWalkForwardPassFalse = 0;
  let promotedCandidatesWithWalkForwardPassNullish = 0;

  for (const row of dedupedRows) {
    const gc = mergeSibling
      ? mergeSiblingWalkForwardPass(row, buildPromotionKey(row), rowsByPromotionKey)
      : rowToGuardCandidate(row);
    const wf = gc.walkForwardPass;
    if (typeof wf === 'boolean') {
      promotedCandidatesWithWalkForwardPassDefined += 1;
      if (wf === true) promotedCandidatesWithWalkForwardPassTrue += 1;
      else promotedCandidatesWithWalkForwardPassFalse += 1;
    } else {
      promotedCandidatesWithWalkForwardPassNullish += 1;
    }
  }

  const problematicSamples = [];
  for (const [key, rows] of rowsByPromotionKey) {
    if (problematicSamples.length >= 10) break;
    const winner = bestByPromotionKey.get(key);
    if (!winner) continue;
    const gc = mergeSibling
      ? mergeSiblingWalkForwardPass(winner, key, rowsByPromotionKey)
      : rowToGuardCandidate(winner);
    const wfNullish = typeof gc.walkForwardPass !== 'boolean';
    const hasVal = rows.some((r) => hasValidationLikeMetadata(r));
    const winnerVal = isWalkForwardValidationRow(winner);
    const interesting = (hasVal && !winnerVal) || wfNullish;
    if (!interesting) continue;

    problematicSamples.push({
      promotionKey: key,
      winner: {
        ...summarizeRowForWfAudit(winner),
        rowToGuardCandidateWalkForwardPass:
          gc.walkForwardPass === true || gc.walkForwardPass === false ? gc.walkForwardPass : null,
        extractWalkForwardPassGuardOnly:
          extractWalkForwardPassGuardOnly(gc) === undefined
            ? null
            : extractWalkForwardPassGuardOnly(gc),
      },
      siblingRows: rows.map((r) => summarizeRowForWfAudit(r)),
    });
  }

  let diagnostic = 'E_unclassified';
  if (promotionKeysWithAnyValidationLikeRow === 0) {
    diagnostic = 'A_no_validation_like_rows_among_promotable';
  } else if (
    promotionKeysWhereValidationRowMatchesDetector === 0 &&
    promotionKeysWithAnyValidationLikeRow > 0
  ) {
    diagnostic = 'B_validation_like_metadata_present_but_detector_never_matches';
  } else if (promotionKeysWithValidationSiblingButTrainWinner > 0) {
    diagnostic = 'C_train_row_wins_dedupe_while_validation_sibling_exists';
  } else if (
    promotionKeysWhereWinnerIsValidationRow > 0 &&
    promotedCandidatesWithWalkForwardPassNullish > 0
  ) {
    diagnostic = 'D_validation_winner_but_walkforwardpass_missing_on_guard_candidate';
  } else {
    diagnostic = 'E_other_or_mixed';
  }

  return {
    generatedAt: new Date().toISOString(),
    wfMergeSiblingApplied: !!mergeSibling,
    promotionKeysTotal,
    promotionKeysWithMultipleRows,
    promotionKeysWithAnyValidationLikeRow,
    promotionKeysWhereValidationRowMatchesDetector,
    promotionKeysWhereWinnerIsValidationRow,
    promotionKeysWithValidationSiblingButTrainWinner,
    promotedCandidatesWithWalkForwardPassDefined,
    promotedCandidatesWithWalkForwardPassTrue,
    promotedCandidatesWithWalkForwardPassFalse,
    promotedCandidatesWithWalkForwardPassNullish,
    diagnostic,
    problematicSamples,
  };
}

/**
 * Fields from the winning batch row needed by rowToGuardCandidate / promotionGuard.
 * Preserved through dedupe (the .map after bestByPromotionKey) which previously dropped them.
 */
function pickBatchGuardPropagation(row) {
  const r = row && typeof row === 'object' ? row : {};
  const o = {};
  if (Array.isArray(r.tradeReturns) && r.tradeReturns.length > 0) {
    o.tradeReturns = r.tradeReturns;
  }
  if (typeof r.walkforwardSplit === 'string' && r.walkforwardSplit.length > 0) {
    o.walkforwardSplit = r.walkforwardSplit;
  }
  if (typeof r.datasetSplit === 'string' && r.datasetSplit.length > 0) {
    o.datasetSplit = r.datasetSplit;
  }
  if (r.isValidation === true || r.isValidation === false) {
    o.isValidation = r.isValidation;
  }
  if (Number.isFinite(Number(r.profitFactor))) {
    o.profitFactor = Number(r.profitFactor);
  } else if (Number.isFinite(Number(r.pf))) {
    o.pf = Number(r.pf);
  }
  if (Number.isFinite(Number(r.topTradesPnlShare))) {
    o.topTradesPnlShare = Number(r.topTradesPnlShare);
  }
  if (r.walkForwardPass === true || r.walkForwardPass === false) {
    o.walkForwardPass = r.walkForwardPass;
  }
  if (r.walk_forward_pass === true || r.walk_forward_pass === false) {
    o.walk_forward_pass = r.walk_forward_pass;
  }
  return o;
}

function normalizeGuardReasons(reasons) {
  if (!Array.isArray(reasons)) return [];
  return reasons.map((r) => {
    if (r && typeof r === 'object') {
      return {
        code: String(r.code || 'REJECT_GUARD_UNKNOWN'),
        message: String(r.message || 'promotion guard rejected candidate'),
        actual: r.actual != null ? r.actual : null,
        required: r.required != null ? r.required : null,
      };
    }
    return {
      code: 'REJECT_GUARD_UNKNOWN',
      message: String(r || 'promotion guard rejected candidate'),
      actual: null,
      required: null,
    };
  });
}

function rowToGuardCandidate(row) {
  const drawdownPct = Number.isFinite(Number(row.drawdownPct))
    ? Number(row.drawdownPct)
    : Number.isFinite(Number(row.maxDrawdownPct))
      ? Number(row.maxDrawdownPct)
      : Number.isFinite(Number(row.maxDrawdown))
        ? Number(row.maxDrawdown)
        : null;
  let profitFactor = Number.isFinite(Number(row.profitFactor))
    ? Number(row.profitFactor)
    : Number.isFinite(Number(row.pf))
      ? Number(row.pf)
      : null;
  if (profitFactor == null && row && Array.isArray(row.tradeReturns) && row.tradeReturns.length > 0) {
    profitFactor = deriveProfitFactorFromTradeReturns(row.tradeReturns);
  }
  const topTradesPnlShare = Number.isFinite(Number(row.topTradesPnlShare))
    ? Number(row.topTradesPnlShare)
    : null;

  let walkForwardPass;
  if (row && (row.walkForwardPass === true || row.walk_forward_pass === true)) walkForwardPass = true;
  else if (row && (row.walkForwardPass === false || row.walk_forward_pass === false)) walkForwardPass = false;
  else if (row && row.isValidation === true) walkForwardPass = true;
  else if (row && String(row.walkforwardSplit || '').toLowerCase() === 'validation') walkForwardPass = true;
  else walkForwardPass = undefined;

  const out = {
    setupId: row && row.setupId != null ? String(row.setupId) : 'unknown',
    strategyId: row && row.setupId != null ? String(row.setupId) : 'unknown',
    trades: num(row && row.trades, 0),
    expectancy: num(row && row.expectancy, 0),
    drawdownPct,
    profitFactor,
    topTradesPnlShare,
    direction: row && row.direction != null
      ? String(row.direction).toLowerCase()
      : (row && row.rules && row.rules.direction != null ? String(row.rules.direction).toLowerCase() : ''),
    strategyType: row && row.strategyType != null
      ? String(row.strategyType).toLowerCase()
      : (row && row.mutationType != null ? String(row.mutationType).toLowerCase() : ''),
    avgTradeDuration: Number.isFinite(Number(row && row.avgTradeDuration))
      ? Number(row.avgTradeDuration)
      : Number.isFinite(Number(row && row.avgTradeDurationBars))
        ? Number(row.avgTradeDurationBars)
        : 0,
  };
  if (walkForwardPass !== undefined) {
    out.walkForwardPass = walkForwardPass;
  }
  return out;
}

/**
 * Enrichit uniquement le candidat guard du gagnant dedupe avec le booléen walk-forward d'une sœur
 * validation (même promotionKey). Défaut: off (NEUROPILOT_WF_MERGE_SIBLING=1 ou opts.wfMergeSibling).
 * Ne modifie pas le dedupe, les métriques métier, ni promotionGuard.
 * @param {{ siblingMergeApplied?: number }|null} [stats] — si fourni, incrémenté quand une fusion est appliquée
 */
function mergeSiblingWalkForwardPass(winnerRow, promotionKey, rowsByPromotionKey, stats) {
  const winnerCandidate = rowToGuardCandidate(winnerRow);
  if (typeof winnerCandidate.walkForwardPass === 'boolean') return winnerCandidate;

  const siblings = rowsByPromotionKey.get(promotionKey) || [];
  const validationSibling = siblings.find((r) => isWalkForwardValidationRow(r));
  if (!validationSibling) return winnerCandidate;

  const validationCandidate = rowToGuardCandidate(validationSibling);
  if (typeof validationCandidate.walkForwardPass !== 'boolean') return winnerCandidate;

  const wf = validationCandidate.walkForwardPass;
  if (stats && typeof stats === 'object') {
    stats.siblingMergeApplied = (Number(stats.siblingMergeApplied) || 0) + 1;
  }

  return {
    ...winnerCandidate,
    walkForwardPass: wf,
    walk_forward_pass: wf,
  };
}

const WF_MISSING_BUCKETS = [
  'NO_VALIDATION_SIBLING',
  'VALIDATION_SIBLING_NO_BOOL',
  'WINNER_ALREADY_BOOL_BUT_STILL_MISSING',
  'OTHER_SCHEMA_OR_FLOW_ANOMALY',
];

function extractWinnerWalkForwardPassRaw(row) {
  const r = row && typeof row === 'object' ? row : {};
  if (r.walkForwardPass === true || r.walkForwardPass === false) return r.walkForwardPass;
  if (r.walk_forward_pass === true || r.walk_forward_pass === false) return r.walk_forward_pass;
  return null;
}

function validationSiblingSummaryForAudit(r) {
  const c = rowToGuardCandidate(r);
  return {
    setupId: r.setupId != null ? String(r.setupId) : null,
    isValidation: r.isValidation === true,
    walkforwardSplit: r.walkforwardSplit != null ? String(r.walkforwardSplit) : null,
    datasetSplit: r.datasetSplit != null ? String(r.datasetSplit) : null,
    candidateWalkForwardPass:
      typeof c.walkForwardPass === 'boolean' ? c.walkForwardPass : null,
  };
}

/**
 * READ-ONLY classification for REJECT_WALKFORWARD_MISSING (no side effects).
 */
function classifyWalkForwardMissingCase(winnerRow, rowsByPromotionKey) {
  const promotionKey = buildPromotionKey(winnerRow);
  const siblings = rowsByPromotionKey.get(promotionKey) || [];
  const validationSiblings = siblings.filter((r) => isWalkForwardValidationRow(r));
  const winnerCandidate = rowToGuardCandidate(winnerRow);

  if (validationSiblings.length === 0) return 'NO_VALIDATION_SIBLING';

  const validationCandidates = validationSiblings.map((r) => rowToGuardCandidate(r));
  const anyValidationBool = validationCandidates.some((c) => typeof c.walkForwardPass === 'boolean');
  if (!anyValidationBool) return 'VALIDATION_SIBLING_NO_BOOL';

  if (typeof winnerCandidate.walkForwardPass === 'boolean') {
    return 'WINNER_ALREADY_BOOL_BUT_STILL_MISSING';
  }

  return 'OTHER_SCHEMA_OR_FLOW_ANOMALY';
}

function mapToTopNEntries(map, n, idField) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, count]) => ({ [idField]: id, count }));
}

/**
 * READ-ONLY audit of guard rejections with REJECT_WALKFORWARD_MISSING.
 * Env: NEUROPILOT_WF_MISSING_AUDIT=1 — does not change promotion behavior.
 */
function buildWfMissingAuditReport(args) {
  const {
    guardRejected,
    dedupedRows,
    rowsByPromotionKey,
    wfMergeSibling,
    guardEvaluated,
    guardPassed,
  } = args;

  const dedupedBySetupId = new Map();
  for (const row of dedupedRows || []) {
    if (row && row.setupId != null) dedupedBySetupId.set(String(row.setupId), row);
  }

  const missingRecords = [];
  for (const rej of guardRejected || []) {
    const reasons = Array.isArray(rej.reasons) ? rej.reasons : [];
    const hasMissing = reasons.some((r) => r && r.code === 'REJECT_WALKFORWARD_MISSING');
    if (!hasMissing) continue;
    const sid = rej.strategyId != null ? String(rej.strategyId) : null;
    const winnerRow = sid ? dedupedBySetupId.get(sid) : null;
    missingRecords.push({ rej, winnerRow, strategyId: sid });
  }

  const bucketCounts = {
    NO_VALIDATION_SIBLING: 0,
    VALIDATION_SIBLING_NO_BOOL: 0,
    WINNER_ALREADY_BOOL_BUT_STILL_MISSING: 0,
    OTHER_SCHEMA_OR_FLOW_ANOMALY: 0,
  };

  const samplesByBucket = {
    NO_VALIDATION_SIBLING: [],
    VALIDATION_SIBLING_NO_BOOL: [],
    WINNER_ALREADY_BOOL_BUT_STILL_MISSING: [],
    OTHER_SCHEMA_OR_FLOW_ANOMALY: [],
  };

  const parentMaps = {};
  const mutationMaps = {};
  for (const b of WF_MISSING_BUCKETS) {
    parentMaps[b] = new Map();
    mutationMaps[b] = new Map();
  }

  const MAX_SAMPLES = 20;

  for (const { rej, winnerRow, strategyId } of missingRecords) {
    let bucket;
    if (!winnerRow) {
      bucket = 'OTHER_SCHEMA_OR_FLOW_ANOMALY';
    } else {
      bucket = classifyWalkForwardMissingCase(winnerRow, rowsByPromotionKey);
    }

    bucketCounts[bucket] += 1;

    const parent = rej.parentSetupId != null ? String(rej.parentSetupId) : 'unknown';
    const mut = rej.mutationType != null ? String(rej.mutationType) : 'unknown';
    parentMaps[bucket].set(parent, (parentMaps[bucket].get(parent) || 0) + 1);
    mutationMaps[bucket].set(mut, (mutationMaps[bucket].get(mut) || 0) + 1);

    if (samplesByBucket[bucket].length < MAX_SAMPLES) {
      const promotionKey = winnerRow ? buildPromotionKey(winnerRow) : null;
      const winnerCandidate = winnerRow ? rowToGuardCandidate(winnerRow) : null;
      const siblings = winnerRow ? rowsByPromotionKey.get(buildPromotionKey(winnerRow)) || [] : [];
      const validationSiblings = siblings.filter((r) => isWalkForwardValidationRow(r));

      samplesByBucket[bucket].push({
        promotionKey,
        strategyId,
        parentSetupId: parent,
        mutationType: mut,
        winnerWalkForwardPassRaw: winnerRow ? extractWinnerWalkForwardPassRaw(winnerRow) : null,
        winnerCandidateWalkForwardPass:
          winnerCandidate && typeof winnerCandidate.walkForwardPass === 'boolean'
            ? winnerCandidate.walkForwardPass
            : null,
        validationSiblingCount: validationSiblings.length,
        validationSiblingSummaries: validationSiblings.slice(0, 3).map(validationSiblingSummaryForAudit),
        reasonBucket: bucket,
      });
    }
  }

  const missingTotal = missingRecords.length;

  const bucketSharesPct = {};
  for (const b of WF_MISSING_BUCKETS) {
    bucketSharesPct[b] =
      missingTotal > 0
        ? Number(((100 * bucketCounts[b]) / missingTotal).toFixed(2))
        : 0;
  }

  const topParentsByBucket = {};
  const topMutationTypesByBucket = {};
  for (const b of WF_MISSING_BUCKETS) {
    topParentsByBucket[b] = mapToTopNEntries(parentMaps[b], 10, 'parentSetupId');
    topMutationTypesByBucket[b] = mapToTopNEntries(mutationMaps[b], 10, 'mutationType');
  }

  return {
    generatedAt: new Date().toISOString(),
    wfMergeSiblingEnabled: !!wfMergeSibling,
    promotionGuardEvaluated: guardEvaluated,
    promotionGuardPassed: guardPassed,
    promotionGuardRejected: (guardRejected || []).length,
    missingTotal,
    bucketCounts,
    bucketSharesPct,
    samplesByBucket,
    topParentsByBucket,
    topMutationTypesByBucket,
  };
}

function buildPromotedChildren(opts = {}) {
  const batchDir = opts.batchDir || dataRoot.getPath('batch_results');
  const discoveryDir = opts.discoveryDir || dataRoot.getPath('discovery');
  const outPath = path.join(discoveryDir, 'promoted_children.json');

  const portfolioGovernorPath = path.join(discoveryDir, 'portfolio_governor.json');
  const portfolioGovernor = safeReadJson(portfolioGovernorPath);

  const existingPromotedJson = safeReadJson(outPath);
  const existingPromotedRows =
    existingPromotedJson && Array.isArray(existingPromotedJson.strategies)
      ? existingPromotedJson.strategies
      : [];
  const existingPromotedMap = buildExistingPromotedMap(existingPromotedRows);

  const maxPromotedPerParent = Math.max(1, num(opts.maxPromotedPerParent, 3));
  const maxPromotedPerParentFamily = Math.max(1, num(opts.maxPromotedPerParentFamily, 2));
  const maxPromotedPerMutationType = Math.max(1, num(opts.maxPromotedPerMutationType, 2));
  let maxPromotedTotal = Math.max(1, num(opts.maxPromotedTotal, 12));
  // 2 = recommended compromise; 3 = stricter when population grows (avoids mono-market false positives)
  let minDistinctBatchFiles = Math.max(1, num(opts.minDistinctBatchFiles, 2));
  const learningMode = String(
    opts.learningMode || process.env.NEUROPILOT_LEARNING_MODE || 'core_3m'
  );
  const { config: modeConfig } = resolveMode(learningMode);
  const runtimeMode = enforcePaperOnlyRuntime(learningMode);
  const guardCfg =
    modeConfig && modeConfig.promotionGuard && typeof modeConfig.promotionGuard === 'object'
      ? modeConfig.promotionGuard
      : {};

  if (portfolioGovernor && typeof portfolioGovernor === 'object') {
    const pm = String(portfolioGovernor.promotionMode || 'normal');
    const mult = Math.max(1, num(portfolioGovernor.admissionThresholdMultiplier, 1));
    if (pm === 'blocked') {
      minDistinctBatchFiles = 999999;
      maxPromotedTotal = 0;
    } else if (pm === 'conservative') {
      minDistinctBatchFiles = Math.max(
        minDistinctBatchFiles,
        Math.ceil(minDistinctBatchFiles * mult)
      );
    }
  }

  const files = fs.existsSync(batchDir)
    ? fs.readdirSync(batchDir)
        .filter((f) => /^strategy_batch_results_.*\.json$/i.test(f))
        .map((f) => path.join(batchDir, f))
    : [];

  const bestByPromotionKey = new Map();
  /** promotionKey -> all promotable rows seen (for WF audit: siblings under same key). */
  const rowsByPromotionKey = new Map();
  /** promotionKey -> Set of batch file paths where this key had a promotable (beats_parent) row */
  const batchFilesByPromotionKey = new Map();
  /** Prefer WF validation row when train vs validation metrics differ only within these bands (dedupe only). */
  const PROMOTION_EPS_SCORE = 1e-4;
  const PROMOTION_EPS_EXP = 1e-4;
  const PROMOTION_TRADES_TOL = 2;
  let rowsSeen = 0;
  let childrenSeen = 0;

  for (const file of files) {
    const json = safeReadJson(file);
    if (!json || !Array.isArray(json.results)) continue;

    for (const row of json.results) {
      rowsSeen += 1;
      if (row && row.parentSetupId) childrenSeen += 1;

      const promotable = isPromotable(row, opts);
      // WF sibling lookup (mergeSibling, wf audit): validation rows often fail isPromotable (e.g. minTrades on
      // the val split) but must still appear under the same promotionKey as the train row.
      if (
        !promotable &&
        isWalkForwardValidationRow(row) &&
        row.parentSetupId &&
        row.mutationType &&
        row.rules &&
        typeof row.rules === 'object'
      ) {
        const wfKey = buildPromotionKey(row);
        if (!rowsByPromotionKey.has(wfKey)) rowsByPromotionKey.set(wfKey, []);
        rowsByPromotionKey.get(wfKey).push(row);
      }

      if (!promotable) continue;

      const key = buildPromotionKey(row);
      if (!rowsByPromotionKey.has(key)) rowsByPromotionKey.set(key, []);
      rowsByPromotionKey.get(key).push(row);
      if (!batchFilesByPromotionKey.has(key)) batchFilesByPromotionKey.set(key, new Set());
      batchFilesByPromotionKey.get(key).add(file);

      const prev = bestByPromotionKey.get(key);

      if (!prev) {
        bestByPromotionKey.set(key, row);
        continue;
      }

      const prevScore = num(prev.parent_vs_child_score, -Infinity);
      const nextScore = num(row.parent_vs_child_score, -Infinity);
      const prevExp = num(prev.expectancy, -Infinity);
      const nextExp = num(row.expectancy, -Infinity);
      const prevTrades = num(prev.trades, -Infinity);
      const nextTrades = num(row.trades, -Infinity);

      const sDiff = nextScore - prevScore;
      const eDiff = nextExp - prevExp;
      const tDiff = nextTrades - prevTrades;

      if (Math.abs(sDiff) > PROMOTION_EPS_SCORE) {
        if (sDiff > 0) bestByPromotionKey.set(key, row);
        continue;
      }
      if (Math.abs(eDiff) > PROMOTION_EPS_EXP) {
        if (eDiff > 0) bestByPromotionKey.set(key, row);
        continue;
      }
      if (Math.abs(tDiff) > PROMOTION_TRADES_TOL) {
        if (tDiff > 0) bestByPromotionKey.set(key, row);
        continue;
      }
      // Within epsilon / trade tolerance: prefer walk-forward validation segment for guard WF propagation.
      if (isWalkForwardValidationRow(row) && !isWalkForwardValidationRow(prev)) {
        bestByPromotionKey.set(key, row);
      }
    }
  }

  const deduped = Array.from(bestByPromotionKey.values())
    .filter((row) => {
      const distinctCount = (batchFilesByPromotionKey.get(buildPromotionKey(row)) || new Set()).size;
      return distinctCount >= minDistinctBatchFiles;
    })
    .map((row) => {
      const distinctBatchFiles = (batchFilesByPromotionKey.get(buildPromotionKey(row)) || new Set()).size;
      const promotion_breadth_score = computePromotionBreadthScore(distinctBatchFiles);

      return {
        setupId: row.setupId,
        name: row.name || row.setupId,
        rules: row.rules,
        source: row.source || 'familyexp',
        generation: num(row.generation, 1),
        parentSetupId: row.parentSetupId || null,
        parentFamilyId: row.parentFamilyId || null,
        mutationType: row.mutationType || null,
        expectancy: num(row.expectancy, 0),
        trades: num(row.trades, 0),
        winRate: Number.isFinite(Number(row.winRate)) ? Number(row.winRate) : null,
        beats_parent: row.beats_parent === true,
        parent_vs_child_score: num(row.parent_vs_child_score, 0),
        familyKey: buildFamilyKey(row.rules || {}),
        distinctBatchFiles,
        promotion_breadth_score,
        ...pickBatchGuardPropagation(row),
      };
    })
    .sort((a, b) => {
      return (
        num(b.parent_vs_child_score, -Infinity) - num(a.parent_vs_child_score, -Infinity) ||
        num(b.promotion_breadth_score, -Infinity) - num(a.promotion_breadth_score, -Infinity) ||
        num(b.expectancy, -Infinity) - num(a.expectancy, -Infinity) ||
        num(b.trades, -Infinity) - num(a.trades, -Infinity)
      );
    });

  const wfMergeSibling =
    process.env.NEUROPILOT_WF_MERGE_SIBLING === '1' || opts.wfMergeSibling === true;

  const wfAuditEnabled = process.env.NEUROPILOT_WF_AUDIT === '0' ? false : opts.wfAudit !== false;
  const wfAudit = wfAuditEnabled
    ? buildWfAuditReport(rowsByPromotionKey, bestByPromotionKey, deduped, wfMergeSibling)
    : null;
  if (wfAudit) {
    const { problematicSamples, ...wfAuditSummary } = wfAudit;
    console.log(
      JSON.stringify({
        tag: '[wf-audit]',
        summary: wfAuditSummary,
        problematicSampleCount: Array.isArray(problematicSamples) ? problematicSamples.length : 0,
      })
    );
    try {
      fs.writeFileSync(
        path.join(discoveryDir, 'wf_promotion_audit.json'),
        JSON.stringify(wfAudit, null, 2),
        'utf8'
      );
    } catch (_) {
      /* ignore audit write errors */
    }
  }

  const promoted = [];
  const guardRejected = [];
  const rejectedByReason = {};
  let guardEvaluated = 0;
  let guardPassed = 0;
  const wfSiblingMergeStats = wfMergeSibling ? { siblingMergeApplied: 0 } : null;
  const perParentCounts = {};
  const perParentFamilyCounts = {};
  const perMutationTypeCounts = {};
  const seenParentFamilyDiversityKeys = new Set();

  const paperPromotionContext = loadPromotionPaperContext(dataRoot.getDataRoot());

  for (const row of deduped) {
    if (promoted.length >= maxPromotedTotal) break;

    guardEvaluated += 1;
    const promotionKeyForGuard = buildPromotionKey(row);
    let guardCandidate = wfMergeSibling
      ? mergeSiblingWalkForwardPass(row, promotionKeyForGuard, rowsByPromotionKey, wfSiblingMergeStats)
      : rowToGuardCandidate(row);
    guardCandidate = applyComputedWalkforwardToGuardCandidate(guardCandidate, row, {
      timeframe: row.timeframe != null ? String(row.timeframe) : null,
    });
    const guardEval = evaluatePromotionCandidate(
      guardCandidate,
      guardCfg,
      learningMode,
      paperPromotionContext
    );
    if (runtimeMode.paperOnly && runtimeMode.executionMode !== 'paper') {
      guardEval.eligible = false;
      guardEval.ok = false;
      guardEval.reasons.push({
        code: 'REJECT_NOT_PAPER_ELIGIBLE',
        message: 'paper-only runtime mismatch',
        actual: runtimeMode.executionMode,
        required: 'paper',
      });
    }
    if (!guardEval.eligible) {
      const reasons = normalizeGuardReasons(guardEval.reasons);
      if (shouldRecordPaperCooldown(guardEval.reasons)) {
        recordPromotionPaperCooldown(
          dataRoot.getDataRoot(),
          String(guardCandidate.strategyId || '').trim(),
          'negative_paper'
        );
      }
      for (const reason of reasons) {
        const code = reason.code;
        rejectedByReason[code] = (rejectedByReason[code] || 0) + 1;
      }
      guardRejected.push({
        strategyId: guardCandidate.strategyId,
        promotionKey: promotionKeyForGuard,
        parentSetupId: row.parentSetupId || null,
        mutationType: row.mutationType || null,
        eligible: false,
        target: 'paper',
        mode: guardEval.mode || learningMode,
        reasons,
        thresholdsApplied: guardEval.thresholdsApplied || guardCfg,
        metricsSnapshot: guardEval.metricsSnapshot || guardCandidate,
        contextApplied: guardEval.contextApplied === true,
        marketContext: guardEval.marketContext || null,
        contextAlignment: guardEval.contextAlignment || null,
        contextScoreDelta: Number.isFinite(Number(guardEval.contextScoreDelta))
          ? Number(guardEval.contextScoreDelta)
          : 0,
      });
      continue;
    }
    guardPassed += 1;

    const parentKey = String(row.parentSetupId || 'no_parent');
    const mutationType = String(row.mutationType || 'unknown');
    const parentFamilyKey = buildParentFamilyPromotionKey(row);
    const parentFamilyDiversityKey = buildParentFamilyDiversityKey(row);

    // Cap global par parent
    if ((perParentCounts[parentKey] || 0) >= maxPromotedPerParent) continue;

    // Cap par parent + famille
    if ((perParentFamilyCounts[parentFamilyKey] || 0) >= maxPromotedPerParentFamily) continue;

    // Cap par mutation type
    if ((perMutationTypeCounts[mutationType] || 0) >= maxPromotedPerMutationType) continue;

    // Diversité forte: un seul promu par parent + familyKey
    if (seenParentFamilyDiversityKeys.has(parentFamilyDiversityKey)) continue;

    perParentCounts[parentKey] = (perParentCounts[parentKey] || 0) + 1;
    perParentFamilyCounts[parentFamilyKey] = (perParentFamilyCounts[parentFamilyKey] || 0) + 1;
    perMutationTypeCounts[mutationType] = (perMutationTypeCounts[mutationType] || 0) + 1;
    seenParentFamilyDiversityKeys.add(parentFamilyDiversityKey);

    const existingPromoted = existingPromotedMap.get(String(row.setupId)) || null;
    const nowIso = new Date().toISOString();

    // Refresh rule:
    // - if child still beats parent now => promotedAt becomes now
    // - otherwise old promotedAt would only matter if we were carrying non-winning rows,
    //   but here only current winners are promoted, so current win refreshes timestamp
    const refreshedPromotedAt = nowIso;

    promoted.push({
      setupId: row.setupId,
      name: row.name || row.setupId,
      rules: row.rules || {},
      source: row.source || 'familyexp',
      generation: num(row.generation, 1),
      parentSetupId: row.parentSetupId || null,
      parentFamilyId: row.parentFamilyId || null,
      mutationType,
      expectancy: num(row.expectancy, 0),
      trades: num(row.trades, 0),
      winRate: Number.isFinite(Number(row.winRate)) ? Number(row.winRate) : null,
      beats_parent: row.beats_parent === true,
      parent_vs_child_score: num(row.parent_vs_child_score, 0),
      familyKey: buildFamilyKey(row.rules || {}),
      distinctBatchFiles: num(row.distinctBatchFiles, 0),
      promotion_breadth_score: num(row.promotion_breadth_score, 0),
      firstPromotedAt:
        existingPromoted && existingPromoted.firstPromotedAt
          ? existingPromoted.firstPromotedAt
          : existingPromoted && existingPromoted.promotedAt
            ? existingPromoted.promotedAt
            : nowIso,
      promotedAt: refreshedPromotedAt,
      promotionReason: existingPromoted
        ? 'beats_parent_refresh'
        : 'beats_parent_with_thresholds',
      promotionGuard: {
        eligible: true,
        target: 'paper',
        mode: guardEval.mode || learningMode,
        reasons: [],
        thresholdsApplied: guardEval.thresholdsApplied || guardCfg,
        metricsSnapshot: guardEval.metricsSnapshot || guardCandidate,
        contextApplied: guardEval.contextApplied === true,
        marketContext: guardEval.marketContext || null,
        contextAlignment: guardEval.contextAlignment || null,
        contextScoreDelta: Number.isFinite(Number(guardEval.contextScoreDelta))
          ? Number(guardEval.contextScoreDelta)
          : 0,
      },
      familyLeader: true,
      promotedLeader: true,
    });
  }

  const wfMissingSemanticEnabled =
    process.env.NEUROPILOT_WF_MISSING_SEMANTIC !== '0' && opts.wfMissingSemantic !== false;
  const wfMissingDiagnosticEnabled = wfMissingSemanticEnabled;
  const wfUpstreamAuditEnabled =
    process.env.NEUROPILOT_WF_UPSTREAM_AUDIT === '1' || opts.wfUpstreamAudit === true;
  let allBatchRowsScan = null;
  let wfMissingDiagnosticCounts = {};
  // wfMissingSemanticCounts is kept as a deprecated compatibility mirror of wfMissingDiagnosticCounts.
  let wfMissingSemanticCounts = {};
  let wfMissingDiagnosticSummary = {};

  const needBatchScanForWf = wfUpstreamAuditEnabled;
  if (needBatchScanForWf) {
    allBatchRowsScan = scanAllBatchRows(batchDir);
  }

  const wfMissingAuditEnabled =
    process.env.NEUROPILOT_WF_MISSING_AUDIT === '1' || opts.wfMissingAudit === true;
  let wfMissingAuditReport = null;
  if (wfMissingAuditEnabled) {
    wfMissingAuditReport = buildWfMissingAuditReport({
      guardRejected,
      dedupedRows: deduped,
      rowsByPromotionKey,
      wfMergeSibling,
      guardEvaluated,
      guardPassed,
    });
  }

  let wfUpstreamAuditReport = null;
  if (wfUpstreamAuditEnabled) {
    wfUpstreamAuditReport = runWfUpstreamAudit({
      batchDir,
      discoveryDir,
      opts,
      buildPromotionKey,
      isWalkForwardValidationRow,
      isPromotable,
      num,
      wfMissingAuditReport,
      allRows: allBatchRowsScan,
    });
    try {
      ensureDir(discoveryDir);
      fs.writeFileSync(
        path.join(discoveryDir, 'wf_upstream_audit.json'),
        JSON.stringify(wfUpstreamAuditReport, null, 2),
        'utf8'
      );
    } catch (_) {
      /* ignore audit write errors */
    }
    if (wfUpstreamAuditReport.cases && wfUpstreamAuditReport.cases.length > 0) {
      console.log(
        JSON.stringify({
          tag: '[wf-audit]',
          upstreamCases: wfUpstreamAuditReport.cases.length,
          summaryCounts: wfUpstreamAuditReport.summaryCounts,
        })
      );
    }
  }

  if (wfMissingSemanticEnabled) {
    const index = resolveUpstreamIndex(discoveryDir, wfUpstreamAuditReport);
    const wfAuditPath = path.join(discoveryDir, 'wf_upstream_audit.json');
    const wfUpstreamAuditPathResolved = fs.existsSync(wfAuditPath) ? wfAuditPath : null;
    const enrichDiag = enrichGuardRejectionsFromUpstreamIndex({
      guardRejected,
      index,
      wfUpstreamAuditPath: wfUpstreamAuditPathResolved,
    });
    wfMissingDiagnosticSummary = enrichDiag.summary || {};
    wfMissingDiagnosticCounts = wfMissingDiagnosticSummary;
    wfMissingSemanticCounts = wfMissingDiagnosticCounts;
    if (wfMissingAuditReport && index) {
      enrichWfMissingAuditNoValidationSiblingSamples(
        wfMissingAuditReport,
        index,
        wfUpstreamAuditPathResolved
      );
    }
    if (enrichDiag.enrichedCount > 0) {
      console.log(
        JSON.stringify({
          tag: '[wf-diagnostic]',
          enrichedNoValidationSibling: enrichDiag.enrichedCount,
          breakdown: wfMissingDiagnosticSummary,
        })
      );
    }
  }

  if (wfMissingAuditEnabled && wfMissingAuditReport) {
    try {
      ensureDir(discoveryDir);
      fs.writeFileSync(
        path.join(discoveryDir, 'wf_missing_audit.json'),
        JSON.stringify(wfMissingAuditReport, null, 2),
        'utf8'
      );
    } catch (_) {
      /* ignore audit write errors */
    }
    if (wfMissingAuditReport.missingTotal > 0) {
      console.log(
        JSON.stringify({
          tag: '[wf-audit]',
          missingTotal: wfMissingAuditReport.missingTotal,
          bucketCounts: wfMissingAuditReport.bucketCounts,
        })
      );
    }
  }

  const minTrades = Math.max(1, num(opts.minTrades, 50));
  const minScore = num(opts.minScore, 0);
  const minExpectancy = num(opts.minExpectancy, 0);

  const payload = {
    learningMode,
    wfMergeSiblingEnabled: wfMergeSibling,
    wfSiblingMergeAppliedCount: wfSiblingMergeStats ? wfSiblingMergeStats.siblingMergeApplied || 0 : 0,
    wfMissingDiagnosticEnabled,
    // wfMissingSemanticEnabled is kept as a deprecated compatibility mirror of wfMissingDiagnosticEnabled.
    wfMissingSemanticEnabled,
    wfMissingDiagnosticCounts,
    wfMissingSemanticCounts,
    wfMissingDiagnosticSummary,
    wfMissingAuditEnabled,
    wfMissingAuditPath: wfMissingAuditEnabled ? path.join(discoveryDir, 'wf_missing_audit.json') : null,
    wfMissingAuditSummary: wfMissingAuditReport
      ? {
          generatedAt: wfMissingAuditReport.generatedAt,
          missingTotal: wfMissingAuditReport.missingTotal,
          bucketCounts: wfMissingAuditReport.bucketCounts,
          bucketSharesPct: wfMissingAuditReport.bucketSharesPct,
        }
      : null,
    wfUpstreamAuditEnabled,
    wfUpstreamAuditPath: wfUpstreamAuditEnabled
      ? path.join(discoveryDir, 'wf_upstream_audit.json')
      : null,
    wfUpstreamAuditSummary: wfUpstreamAuditReport
      ? {
          generatedAt: wfUpstreamAuditReport.generatedAt,
          casesAnalyzed: wfUpstreamAuditReport.cases.length,
          summaryCounts: wfUpstreamAuditReport.summaryCounts,
          totalBatchRowsScanned: wfUpstreamAuditReport.totalBatchRowsScanned,
        }
      : null,
    paperOnlyMode: runtimeMode.paperOnly,
    promotionTargetEnvironment: runtimeMode.executionMode,
    promotionGuard: {
      mode: learningMode,
      paperOnly: runtimeMode.paperOnly,
      thresholdsApplied: guardCfg,
      evaluated: guardEvaluated,
      passed: guardPassed,
      rejected: guardRejected.length,
      rejectedByReason,
      rejectedByWfMissingDiagnostic: wfMissingDiagnosticCounts,
      // rejectedByWfMissingSemantic is kept as a deprecated compatibility mirror of rejectedByWfMissingDiagnostic.
      rejectedByWfMissingSemantic: wfMissingSemanticCounts,
    },
    rejectedCandidatesSample: guardRejected.slice(0, 300),
    generatedAt: new Date().toISOString(),
    refreshedAt: new Date().toISOString(),
    source: 'batch_results',
    portfolioGovernor:
      portfolioGovernor && typeof portfolioGovernor === 'object'
        ? {
            promotionMode: portfolioGovernor.promotionMode || null,
            admissionThresholdMultiplier: num(portfolioGovernor.admissionThresholdMultiplier, 1),
            governanceStatus: portfolioGovernor.governanceStatus || null,
          }
        : null,
    minTrades,
    minScore,
    minExpectancy,
    minDistinctBatchFiles,
    rowsSeen,
    childrenSeen,
    wfAudit: wfAudit || null,
    dedupedBySignature: deduped.length,
    promoted: promoted.length,
    existingPromotedCount: existingPromotedRows.length,
    maxPromotedPerParent,
    maxPromotedPerParentFamily,
    maxPromotedPerMutationType,
    maxPromotedTotal,
    byMutationType: promoted.reduce((acc, row) => {
      const t = String(row.mutationType || 'unknown');
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {}),
    strategies: promoted,
  };

  ensureDir(discoveryDir);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log('Promoted children built.');
  console.log(`  Batch files: ${files.length}`);
  console.log(`  Rows seen: ${rowsSeen}`);
  console.log(`  Children seen: ${childrenSeen}`);
  const candidatesBeforeDistinctFilter = Array.from(bestByPromotionKey.values()).length;
  console.log(`  Candidates (best per signature): ${candidatesBeforeDistinctFilter}`);
  console.log(`  After minDistinctBatchFiles>=${minDistinctBatchFiles}: ${deduped.length}`);
  console.log(`  Promotion guard evaluated: ${guardEvaluated}`);
  console.log(`  Promotion guard passed: ${guardPassed}`);
  console.log(`  Promotion guard rejected: ${guardRejected.length}`);
  console.log(`  Promoted (capped): ${promoted.length}`);
  console.log(`  Output: ${outPath}`);
  if (wfMergeSibling && wfSiblingMergeStats && wfSiblingMergeStats.siblingMergeApplied > 0) {
    console.log(
      JSON.stringify({
        tag: '[wf-audit]',
        siblingMergeApplied: wfSiblingMergeStats.siblingMergeApplied,
      })
    );
  }

  return {
    outPath,
    promoted,
  };
}

if (require.main === module) {
  try {
    buildPromotedChildren({
      minTrades: process.env.PROMOTED_CHILDREN_MIN_TRADES || 50,
      minScore: process.env.PROMOTED_CHILDREN_MIN_SCORE || 0,
      minExpectancy: process.env.PROMOTED_CHILDREN_MIN_EXPECTANCY || 0,
      minDistinctBatchFiles: process.env.PROMOTED_CHILDREN_MIN_DISTINCT_BATCH_FILES || 2,
      maxPromotedPerParent: process.env.PROMOTED_CHILDREN_MAX_PER_PARENT || 3,
      maxPromotedPerParentFamily: process.env.PROMOTED_CHILDREN_MAX_PER_PARENT_FAMILY || 2,
      maxPromotedPerMutationType: process.env.PROMOTED_CHILDREN_MAX_PER_MUTATION_TYPE || 2,
      maxPromotedTotal: process.env.PROMOTED_CHILDREN_MAX_TOTAL || 12,
    });
  } catch (err) {
    console.error('buildPromotedChildren failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  buildPromotedChildren,
  isPromotable,
};
