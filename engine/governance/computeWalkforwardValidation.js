'use strict';

/**
 * Walk-forward style validation from per-trade returns (segment pass-rate gate).
 * Used by buildPromotedChildren → promotionGuard (walkForwardPass).
 */

const DEFAULT_SEGMENT_SIZE = 12;
const DEFAULT_MIN_PASS_RATE = 0.5;

function segmentMean(returns) {
  if (!returns.length) return 0;
  let s = 0;
  for (const r of returns) s += Number(r) || 0;
  return s / returns.length;
}

/**
 * @param {{ tradeReturns?: unknown[] }} input
 * @param {{ segmentSize?: number, minPassRate?: number }} [opts]
 */
function computeWalkforwardValidation(input, opts = {}) {
  const tradeReturns = Array.isArray(input.tradeReturns) ? input.tradeReturns : [];
  const segmentSize = Math.max(
    1,
    Math.floor(
      Number.isFinite(Number(opts.segmentSize)) ? Number(opts.segmentSize) : DEFAULT_SEGMENT_SIZE
    )
  );
  const minPassRate = Number.isFinite(Number(opts.minPassRate))
    ? Number(opts.minPassRate)
    : DEFAULT_MIN_PASS_RATE;

  if (tradeReturns.length === 0) {
    return {
      present: false,
      reason: 'insufficient_history',
      passed: false,
      segmentsEvaluated: 0,
      windows: [],
    };
  }

  const windows = [];
  for (let i = 0; i + segmentSize <= tradeReturns.length; i += segmentSize) {
    const slice = tradeReturns.slice(i, i + segmentSize);
    const mean = segmentMean(slice);
    windows.push({
      startIndex: i,
      endIndex: i + segmentSize - 1,
      segmentMean: mean,
      passed: mean > 0,
    });
  }

  if (windows.length < 3) {
    return {
      present: false,
      reason: 'insufficient_history',
      passed: false,
      segmentsEvaluated: windows.length,
      windows,
    };
  }

  const passedSeg = windows.filter((w) => w.passed).length;
  const passRate = passedSeg / windows.length;
  const segmentOk = passRate >= minPassRate;

  let globalMean = 0;
  for (const r of tradeReturns) globalMean += Number(r) || 0;
  globalMean /= tradeReturns.length;

  let passed = segmentOk;
  let reason = passed ? 'ok' : 'failed_segments';

  if (!segmentOk && globalMean < -0.005) {
    reason = 'failed_segments_and_score';
  } else if (segmentOk && globalMean < -0.015) {
    passed = false;
    reason = 'failed_score';
  }

  return {
    present: true,
    passed,
    reason,
    segmentsEvaluated: windows.length,
    windows,
    passRate,
    globalMean,
  };
}

/**
 * @param {object} candidate guard candidate (mutated copy returned)
 * @param {object} row batch row (may carry tradeReturns)
 * @param {object} [opts] optional { wfOpts, timeframe }
 */
function applyComputedWalkforwardToGuardCandidate(candidate, row, opts = {}) {
  const out = candidate && typeof candidate === 'object' ? { ...candidate } : {};
  if (String(process.env.NEUROPILOT_WF_COMPUTED_DISABLE || '').trim() === '1') {
    return out;
  }
  const tr = row && Array.isArray(row.tradeReturns) ? row.tradeReturns : null;
  if (!tr || tr.length === 0) return out;

  const wfOpts = opts && opts.wfOpts && typeof opts.wfOpts === 'object' ? opts.wfOpts : {};
  const wf = computeWalkforwardValidation({ tradeReturns: tr }, wfOpts);

  out.walkforward = {
    present: wf.present,
    passed: wf.passed,
    reason: wf.reason,
    segmentsEvaluated: wf.segmentsEvaluated,
    windows: wf.windows,
    ...(Number.isFinite(wf.passRate) ? { passRate: wf.passRate } : {}),
    ...(Number.isFinite(wf.globalMean) ? { globalMean: wf.globalMean } : {}),
  };

  if (wf.present === true) {
    out.walkForwardPass = wf.passed === true;
  }

  return out;
}

module.exports = {
  computeWalkforwardValidation,
  applyComputedWalkforwardToGuardCandidate,
};
