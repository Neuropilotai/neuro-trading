'use strict';

/**
 * Paper-aware gates for promotion (amont). Used by promotionGuard.evaluatePromotionCandidate.
 * Reads governance/* artifacts only; does not modify lifecycle manifest code.
 */

const fs = require('fs');
const path = require('path');

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveGovernanceRoot(dataRoot) {
  if (dataRoot && String(dataRoot).trim()) return path.resolve(String(dataRoot).trim());
  return null;
}

/**
 * Load paper metrics + strict recent slice + cooldown once per buildPromotedChildren pass.
 * @param {string|null} dataRoot
 * @returns {{ root: string|null, metricsMap: Map<string,object>, recentMap: Map<string,object>, cooldown: object, paths: object }}
 */
function loadPromotionPaperContext(dataRoot) {
  const root = resolveGovernanceRoot(dataRoot);
  const empty = {
    root,
    metricsMap: new Map(),
    recentMap: new Map(),
    cooldown: {},
    paths: {},
  };
  if (!root) return empty;

  const gov = path.join(root, 'governance');
  const metricsPath = path.join(gov, 'paper_trades_metrics_by_strategy.json');
  const strictPath = path.join(gov, 'paper_trades_strict_mapping_report.json');
  const cooldownPath = path.join(gov, 'promoted_paper_cooldown.json');

  const metricsMap = new Map();
  const mj = safeReadJson(metricsPath);
  if (mj && mj.aggregation === 'by_strategy' && Array.isArray(mj.buckets)) {
    for (const b of mj.buckets) {
      if (!b || typeof b !== 'object') continue;
      const sid = b.strategyId != null ? String(b.strategyId).trim() : '';
      if (sid) metricsMap.set(sid, b);
    }
  }

  const recentMap = new Map();
  const strict = safeReadJson(strictPath);
  if (strict && typeof strict === 'object') {
    for (const x of strict.promoted_and_paper_recent || []) {
      const id = String(x.strategyId || x.setupKey || '').trim();
      if (!id) continue;
      recentMap.set(id, {
        pnlRecent: Number(x.pnlRecent) || 0,
        tradesRecent: Number(x.tradesRecent) || 0,
        visibleInRecentPaper: true,
      });
    }
    for (const x of strict.promoted_not_seen_in_paper_last_7d || []) {
      const id = String(x.strategyId || x.setupKey || '').trim();
      if (!id) continue;
      if (!recentMap.has(id)) {
        recentMap.set(id, {
          pnlRecent: 0,
          tradesRecent: 0,
          visibleInRecentPaper: false,
        });
      }
    }
  }

  const cooldown = safeReadJson(cooldownPath);
  const cd = cooldown && typeof cooldown === 'object' && !Array.isArray(cooldown) ? cooldown : {};

  return {
    root,
    metricsMap,
    recentMap,
    cooldown: cd,
    paths: { metricsPath, strictPath, cooldownPath },
  };
}

function setupIdFromCandidate(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  if (c.setupId != null && String(c.setupId).trim()) return String(c.setupId).trim();
  if (c.strategyId != null && String(c.strategyId).trim()) return String(c.strategyId).trim();
  return '';
}

function isStrongAllTimePositive(allTimeTrades, allTimePnl) {
  const minPnl = envNum('NEUROPILOT_PROMOTION_PAPER_STRONG_POSITIVE_PNL', 200);
  const minTr = Math.max(1, Math.floor(envNum('NEUROPILOT_PROMOTION_PAPER_STRONG_POSITIVE_TRADES', 15)));
  return (
    Number.isFinite(allTimeTrades) &&
    allTimeTrades >= minTr &&
    Number.isFinite(allTimePnl) &&
    allTimePnl > minPnl
  );
}

/**
 * Phase 2: paperScore 0–100 (auditable).
 * @param {{ allTimeTrades: number, allTimePnl: number|null, recentTrades: number, recentPnl: number, hasMetrics: boolean }} p
 */
function computePaperScore(p) {
  let score = 50;
  if (!p.hasMetrics) return { score: 50, notes: ['no_paper_metrics'] };

  const notes = [];
  const atP = p.allTimePnl;
  const atT = p.allTimeTrades;
  if (Number.isFinite(atP)) {
    if (atP < -5000) {
      score -= 40;
      notes.push('alltime_pnl_severe');
    } else if (atP < -1000) {
      score -= 25;
      notes.push('alltime_pnl_bad');
    } else if (atP < -200) {
      score -= 15;
      notes.push('alltime_pnl_weak');
    } else if (atP > 300) {
      score += 15;
      notes.push('alltime_pnl_strong');
    } else if (atP > 50) {
      score += 8;
      notes.push('alltime_pnl_ok');
    }
  }

  if (Number.isFinite(p.recentPnl) && p.recentTrades >= 1) {
    if (p.recentPnl < -100) {
      score -= 25;
      notes.push('recent_pnl_bad');
    } else if (p.recentPnl < -30) {
      score -= 15;
      notes.push('recent_pnl_weak');
    } else if (p.recentPnl > 20) {
      score += 10;
      notes.push('recent_pnl_good');
    }
  } else if (p.recentTrades === 0 && !p.visibleInRecentPaper) {
    score -= 5;
    notes.push('no_recent_visibility');
  }

  if (Number.isFinite(atT) && atT >= 50) {
    score += 5;
    notes.push('trade_count_stability_hint');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, notes };
}

/**
 * Apply paper-aware gates. Mutates `reasons` array; returns paper diagnostics for metricsSnapshot.
 * @param {object} candidate
 * @param {object} paperCtx from loadPromotionPaperContext
 * @param {Array} reasons
 * @returns {object} paperDiag for snapshot
 */
function applyPaperAwarePromotionGates(candidate, paperCtx, reasons) {
  const filterOn = envFlag('NEUROPILOT_PROMOTION_PAPER_FILTER_ENABLE', false);
  const scoreOn = envFlag('NEUROPILOT_PROMOTION_PAPER_SCORE_ENABLE', false);
  const cooldownReadOn = filterOn && envFlag('NEUROPILOT_PROMOTION_PAPER_COOLDOWN_ENABLE', true);

  const setupId = setupIdFromCandidate(candidate);
  const paperDiag = {
    paperFilterEnabled: filterOn,
    paperScoreEnabled: scoreOn,
    setupId,
    hasPaperMetricsRow: false,
    allTimeTrades: null,
    allTimePnl: null,
    recentTrades: null,
    recentPnl: null,
    visibleInRecentPaper: null,
    paperScore: null,
    paperScoreNotes: null,
    paperCooldownActive: false,
  };

  if (!filterOn && !scoreOn) return paperDiag;

  const metricsRow =
    setupId && paperCtx.metricsMap && paperCtx.metricsMap.get
      ? paperCtx.metricsMap.get(setupId)
      : null;
  const recent =
    setupId && paperCtx.recentMap && paperCtx.recentMap.get
      ? paperCtx.recentMap.get(setupId)
      : null;

  let allTimeTrades = null;
  let allTimePnl = null;
  if (metricsRow && typeof metricsRow === 'object') {
    const t = Number(metricsRow.trades);
    const p = Number(metricsRow.totalPnl);
    if (Number.isFinite(t)) allTimeTrades = t;
    if (Number.isFinite(p)) allTimePnl = p;
    paperDiag.hasPaperMetricsRow = true;
  }

  let recentTrades = 0;
  let recentPnl = 0;
  let visibleInRecentPaper = false;
  if (recent) {
    recentTrades = Number(recent.tradesRecent) || 0;
    recentPnl = Number(recent.pnlRecent) || 0;
    visibleInRecentPaper = !!recent.visibleInRecentPaper;
  }

  paperDiag.allTimeTrades = allTimeTrades;
  paperDiag.allTimePnl = allTimePnl;
  paperDiag.recentTrades = recentTrades;
  paperDiag.recentPnl = recentPnl;
  paperDiag.visibleInRecentPaper = visibleInRecentPaper;

  const hasMetrics = paperDiag.hasPaperMetricsRow;
  if (!hasMetrics && !recent) {
    return paperDiag;
  }

  if (cooldownReadOn && setupId && paperCtx.cooldown && paperCtx.cooldown[setupId]) {
    const entry = paperCtx.cooldown[setupId];
    const until = entry && entry.blockedUntil != null ? String(entry.blockedUntil) : '';
    const t = until ? Date.parse(until) : NaN;
    if (Number.isFinite(t) && t > Date.now()) {
      paperDiag.paperCooldownActive = true;
      reasons.push({
        code: 'REJECT_PAPER_COOLDOWN',
        message: 'promotion blocked by promoted_paper_cooldown.json',
        actual: until,
        required: 'blockedUntil <= now',
      });
      return paperDiag;
    }
  }

  if (isStrongAllTimePositive(allTimeTrades || 0, allTimePnl != null ? allTimePnl : NaN)) {
    paperDiag.paperStrongPositiveBypass = true;
    if (scoreOn) {
      const ps = computePaperScore({
        allTimeTrades: allTimeTrades || 0,
        allTimePnl,
        recentTrades,
        recentPnl,
        visibleInRecentPaper,
        hasMetrics,
      });
      paperDiag.paperScore = ps.score;
      paperDiag.paperScoreNotes = ps.notes;
    }
    return paperDiag;
  }

  if (filterOn && hasMetrics) {
    const minAtTrades = Math.max(1, Math.floor(envNum('NEUROPILOT_PROMOTION_PAPER_MIN_ALLTIME_TRADES', 100)));
    const maxAtPnl = envNum('NEUROPILOT_PROMOTION_PAPER_MAX_ALLTIME_PNL', -1000);

    const allTimeBlock =
      Number.isFinite(allTimeTrades) &&
      allTimeTrades >= minAtTrades &&
      Number.isFinite(allTimePnl) &&
      allTimePnl < maxAtPnl;

    if (allTimeBlock) {
      console.log(
        JSON.stringify({
          tag: 'PROMOTION_PAPER_FILTER_BLOCK',
          setupId,
          reason: 'alltime_negative',
          allTimePnl,
          recentPnl,
        })
      );
      reasons.push({
        code: 'REJECT_PAPER_FILTER_ALLTIME',
        message: 'paper all-time PnL below threshold with sufficient trades',
        actual: { allTimeTrades, allTimePnl },
        required: { minAllTimeTrades: minAtTrades, maxAllTimePnl: maxAtPnl },
      });
    }
  }

  if (filterOn && reasons.length === 0) {
    const minRecTrades = Math.max(1, Math.floor(envNum('NEUROPILOT_PROMOTION_PAPER_MIN_RECENT_TRADES', 5)));
    const maxRecPnl = envNum('NEUROPILOT_PROMOTION_PAPER_MAX_RECENT_PNL', -200);
    const recentBlock =
      recent != null &&
      recentTrades >= minRecTrades &&
      Number.isFinite(recentPnl) &&
      recentPnl < maxRecPnl;

    if (recentBlock) {
      console.log(
        JSON.stringify({
          tag: 'PROMOTION_PAPER_FILTER_BLOCK',
          setupId,
          reason: 'recent_negative',
          allTimePnl,
          recentPnl,
        })
      );
      reasons.push({
        code: 'REJECT_PAPER_FILTER_RECENT',
        message: 'paper recent PnL below threshold with sufficient recent trades',
        actual: { recentTrades, recentPnl },
        required: { minRecentTrades: minRecTrades, maxRecentPnl: maxRecPnl },
      });
    }
  }

  if (scoreOn && reasons.length === 0) {
    const ps = computePaperScore({
      allTimeTrades: allTimeTrades || 0,
      allTimePnl,
      recentTrades,
      recentPnl,
      visibleInRecentPaper,
      hasMetrics,
    });
    paperDiag.paperScore = ps.score;
    paperDiag.paperScoreNotes = ps.notes;
    const blockBelow = envNum('NEUROPILOT_PROMOTION_PAPER_SCORE_BLOCK_BELOW', 30);
    if (Number.isFinite(ps.score) && ps.score < blockBelow) {
      console.log(
        JSON.stringify({
          tag: 'PROMOTION_PAPER_SCORE_BLOCK',
          setupId,
          paperScore: ps.score,
          notes: ps.notes,
        })
      );
      reasons.push({
        code: 'REJECT_PAPER_SCORE_BLOCK',
        message: 'paper score below minimum',
        actual: ps.score,
        required: `>= ${blockBelow}`,
      });
    } else if (ps.score >= 30 && ps.score < 50) {
      console.log(
        JSON.stringify({
          tag: 'PROMOTION_PAPER_SCORE_WARN',
          setupId,
          paperScore: ps.score,
          notes: ps.notes,
        })
      );
    }
  }

  return paperDiag;
}

const PAPER_FILTER_REJECT_CODES = new Set([
  'REJECT_PAPER_FILTER_ALLTIME',
  'REJECT_PAPER_FILTER_RECENT',
  'REJECT_PAPER_SCORE_BLOCK',
]);

function shouldRecordPaperCooldown(reasons) {
  if (!envFlag('NEUROPILOT_PROMOTION_PAPER_COOLDOWN_RECORD', true)) return false;
  if (!Array.isArray(reasons)) return false;
  return reasons.some((r) => r && PAPER_FILTER_REJECT_CODES.has(r.code));
}

/**
 * Merge cooldown entry for setupId (7d default). Best-effort; ignores failures.
 * @param {string} dataRoot
 * @param {string} setupId
 * @param {string} [reason]
 */
function recordPromotionPaperCooldown(dataRoot, setupId, reason = 'negative_paper') {
  const root = resolveGovernanceRoot(dataRoot);
  if (!root || !setupId) return;
  const days = Math.max(1, Math.floor(envNum('NEUROPILOT_PROMOTION_PAPER_COOLDOWN_DAYS', 7)));
  const cooldownPath = path.join(root, 'governance', 'promoted_paper_cooldown.json');
  let doc = safeReadJson(cooldownPath);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
  const until = new Date(Date.now() + days * 86400000).toISOString();
  doc[setupId] = { blockedUntil: until, reason: String(reason || 'negative_paper') };
  try {
    const dir = path.dirname(cooldownPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cooldownPath, JSON.stringify(doc, null, 2), 'utf8');
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  loadPromotionPaperContext,
  applyPaperAwarePromotionGates,
  computePaperScore,
  recordPromotionPaperCooldown,
  shouldRecordPaperCooldown,
  PAPER_FILTER_REJECT_CODES,
};
