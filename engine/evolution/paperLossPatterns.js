'use strict';

/**
 * Fail-soft loss-pattern scan on governance/paper_trades.jsonl (learning-only).
 * Opt-in from paperMutationLearning: NEUROPILOT_PAPER_LOSS_PATTERNS=1.
 * No live access; never throws from computePaperLossPatterns (returns null on failure).
 *
 * globalPenalty uses: (A) fast-stop ratio, (C) strongly negative global expectancy only.
 * penaltiesByContext (B) is computed for audit / future use — not folded into globalPenalty.
 */

const fs = require('fs');
const path = require('path');
const dataRootMod = require('../dataRoot');
const { parsePaperTradesJsonlContent } = require('../governance/parsePaperTradesJsonl');

const MIN_TRADES = 50;
const CONTEXT_MIN_N = 20;
const CONTEXT_MAX_EXP = -0.001;
const PEN_CONTEXT = 0.85;
const PEN_GLOBAL_NEGATIVE = 0.95;
const GLOBAL_NEGATIVE_EXP_THRESHOLD = -0.0005;
const PEN_FAST_STOP = 0.95;
const FAST_STOP_RATIO_THRESHOLD = 0.4;

function clampPenalty(x) {
  if (!Number.isFinite(x)) return 1;
  return Math.max(0.8, Math.min(1, x));
}

/** Paper V1: stop exits (includes intrabar priority). */
function isStopReason(reason) {
  const r = String(reason == null ? '' : reason).trim().toLowerCase();
  return r === 'stop' || r === 'stop_intrabar_priority';
}

function dimKey(val) {
  if (val == null) return '(missing)';
  const s = String(val).trim();
  return s || '(missing)';
}

/**
 * @param {{ dataRoot?: string, jsonlPath?: string }} [opts]
 * @returns {{ penaltiesByContext: Record<string, number>, globalPenalty: number, meta: object } | null}
 */
function computePaperLossPatterns(opts = {}) {
  try {
    const root =
      opts.dataRoot && typeof opts.dataRoot === 'string'
        ? opts.dataRoot
        : dataRootMod.getDataRoot();
    const jsonlPath =
      opts.jsonlPath && typeof opts.jsonlPath === 'string'
        ? opts.jsonlPath
        : path.join(root, 'governance', 'paper_trades.jsonl');

    if (!fs.existsSync(jsonlPath)) return null;

    let raw;
    try {
      raw = fs.readFileSync(jsonlPath, 'utf8');
    } catch {
      return null;
    }

    const parsed = parsePaperTradesJsonlContent(raw);
    const trades = parsed && Array.isArray(parsed.trades) ? parsed.trades : [];
    if (trades.length < MIN_TRADES) return null;

    const total = trades.length;
    let fastStopCount = 0;
    let pnlSum = 0;
    const byCtx = Object.create(null);

    for (const t of trades) {
      const p = Number(t.pnl);
      if (Number.isFinite(p)) pnlSum += p;

      const bh = Number(t.barsHeld);
      if (isStopReason(t.reason) && Number.isFinite(bh) && bh <= 1) fastStopCount += 1;

      const k = `${dimKey(t.symbol)}|${dimKey(t.timeframe)}`;
      if (!byCtx[k]) byCtx[k] = { n: 0, pnlSum: 0 };
      byCtx[k].n += 1;
      if (Number.isFinite(p)) byCtx[k].pnlSum += p;
    }

    const globalExp = total > 0 ? pnlSum / total : 0;
    const fastStopRatio = total > 0 ? fastStopCount / total : 0;

    const penaltiesByContext = Object.create(null);
    for (const [k, v] of Object.entries(byCtx)) {
      if (!v || v.n < CONTEXT_MIN_N) continue;
      const exp = v.n > 0 ? v.pnlSum / v.n : 0;
      if (Number.isFinite(exp) && exp < CONTEXT_MAX_EXP) {
        penaltiesByContext[k] = clampPenalty(PEN_CONTEXT);
      }
    }

    let globalPenalty = 1;
    if (Number.isFinite(globalExp) && globalExp < GLOBAL_NEGATIVE_EXP_THRESHOLD) {
      globalPenalty *= PEN_GLOBAL_NEGATIVE;
    }
    if (fastStopRatio > FAST_STOP_RATIO_THRESHOLD) globalPenalty *= PEN_FAST_STOP;

    globalPenalty = clampPenalty(globalPenalty);

    return {
      penaltiesByContext,
      globalPenalty,
      meta: {
        fastStopRatio,
        globalExpectancy: globalExp,
        globalNegativePenaltyApplied:
          Number.isFinite(globalExp) && globalExp < GLOBAL_NEGATIVE_EXP_THRESHOLD,
        penaltiesByContextCount: Object.keys(penaltiesByContext).length,
        tradeCount: total,
      },
    };
  } catch {
    return null;
  }
}

if (require.main === module) {
  const r = computePaperLossPatterns();
  if (r == null) console.log('null');
  else console.log(JSON.stringify(r, null, 2));
}

module.exports = {
  computePaperLossPatterns,
};
