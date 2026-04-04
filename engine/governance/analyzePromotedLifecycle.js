#!/usr/bin/env node
'use strict';

/**
 * Paper-driven lifecycle scoring for promoted setups (read-only analysis + optional report).
 * Does not modify promoted_children.json. Intended for pre-manifest filtering when
 * NEUROPILOT_MANIFEST_LIFECYCLE_ENABLE=1 (see buildPromotedManifest.js).
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

const LIFECYCLE_REPORT_FILENAME = 'promoted_lifecycle_report.json';

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/**
 * Desk override: if DATA_ROOT_OVERRIDE points to an existing directory, use it.
 * Else opts.dataRoot, else dataRoot.getDataRoot().
 * @param {object} [opts]
 * @param {string} [opts.dataRoot]
 * @returns {string}
 */
function resolveLifecycleDataRoot(opts = {}) {
  if (opts.dataRoot && String(opts.dataRoot).trim()) return path.resolve(String(opts.dataRoot).trim());
  const o = process.env.DATA_ROOT_OVERRIDE;
  if (o && String(o).trim()) {
    const p = path.resolve(String(o).trim());
    if (fs.existsSync(p)) return p;
  }
  return dataRoot.getDataRoot();
}

function manifestLifecycleFeatureEnabled() {
  return envFlag('NEUROPILOT_MANIFEST_LIFECYCLE_ENABLE', false);
}

function manifestLifecycleSuspendBlocks() {
  if (!manifestLifecycleFeatureEnabled()) return false;
  return envFlag('NEUROPILOT_MANIFEST_LIFECYCLE_SUSPEND_BLOCKS', true);
}

function manifestLifecycleKillBlocks() {
  if (!manifestLifecycleFeatureEnabled()) return false;
  return envFlag('NEUROPILOT_MANIFEST_LIFECYCLE_KILL_BLOCKS', true);
}

function manifestLifecycleWriteReportDefault() {
  return envFlag('NEUROPILOT_MANIFEST_LIFECYCLE_WRITE_REPORT', true);
}

function loadPaperMetricsByStrategy(root) {
  const p = path.join(root, 'governance', 'paper_trades_metrics_by_strategy.json');
  const j = safeReadJson(p);
  const map = new Map();
  if (!j || j.aggregation !== 'by_strategy' || !Array.isArray(j.buckets)) return { map, path: p };
  for (const b of j.buckets) {
    if (!b || typeof b !== 'object') continue;
    const sid = b.strategyId != null ? String(b.strategyId).trim() : '';
    if (!sid) continue;
    map.set(sid, b);
  }
  return { map, path: p };
}

function buildStrictRecentMap(strict) {
  const m = new Map();
  if (!strict || typeof strict !== 'object') return m;
  for (const x of strict.promoted_and_paper_recent || []) {
    const id = String(x.strategyId || x.setupKey || '').trim();
    if (!id) continue;
    m.set(id, {
      pnlRecent: Number(x.pnlRecent) || 0,
      tradesRecent: Number(x.tradesRecent) || 0,
      lastTradeTs: x.lastTradeTs != null ? String(x.lastTradeTs) : null,
      visibleInRecentPaper: true,
    });
  }
  for (const x of strict.promoted_not_seen_in_paper_last_7d || []) {
    const id = String(x.strategyId || x.setupKey || '').trim();
    if (!id) continue;
    if (!m.has(id)) {
      m.set(id, {
        pnlRecent: 0,
        tradesRecent: 0,
        lastTradeTs: null,
        visibleInRecentPaper: false,
      });
    }
  }
  return m;
}

function familyPrefixFromId(setupId) {
  const s = String(setupId || '');
  if (s.startsWith('mut_')) return 'mut_';
  if (s.startsWith('familyexp_')) return 'familyexp_';
  return 'other';
}

/**
 * Auditable 0–100 score + status. Conservative: missing data never yields KILL without veto path.
 * @param {object} params
 * @returns {{ lifecycleScore: number, lifecycleStatus: string, lifecycleReasons: string[] }}
 */
function scoreOneSetup(params) {
  const { strategyId, metricsRow, recent } = params;
  const reasons = [];

  let score = 50;

  const atTrades = metricsRow && Number.isFinite(Number(metricsRow.trades)) ? Number(metricsRow.trades) : 0;
  const atPnl =
    metricsRow && Number.isFinite(Number(metricsRow.totalPnl)) ? Number(metricsRow.totalPnl) : null;
  const pfRaw =
    metricsRow && metricsRow.profitFactor != null
      ? Number(metricsRow.profitFactor)
      : metricsRow && metricsRow.pf != null
        ? Number(metricsRow.pf)
        : null;
  const pf = Number.isFinite(pfRaw) ? pfRaw : null;

  if (!metricsRow) {
    score -= 8;
    reasons.push('no_paper_metrics_row');
  } else {
    if (atTrades >= 20 && atPnl != null && atPnl > 200) {
      score += 18;
      reasons.push('alltime_pnl_strong_positive');
    } else if (atTrades >= 10 && atPnl != null && atPnl > 50) {
      score += 12;
      reasons.push('alltime_pnl_moderate_positive');
    } else if (atTrades >= 5 && atPnl != null && atPnl > 0) {
      score += 6;
      reasons.push('alltime_pnl_positive');
    } else if (atTrades >= 15 && atPnl != null && atPnl < -400) {
      score -= 18;
      reasons.push('alltime_pnl_deep_negative');
    } else if (atTrades >= 8 && atPnl != null && atPnl < -150) {
      score -= 12;
      reasons.push('alltime_pnl_negative');
    }

    if (atTrades < 5 && atTrades > 0) {
      score -= 4;
      reasons.push('low_trade_count_confidence');
    }

    if (pf != null) {
      if (pf >= 1.15) {
        score += 8;
        reasons.push('profit_factor_favorable');
      } else if (pf < 0.95) {
        score -= 12;
        reasons.push('profit_factor_below_0_95');
      } else if (pf < 1.02) {
        score -= 5;
        reasons.push('profit_factor_weak');
      }
    } else {
      reasons.push('profit_factor_missing');
    }
  }

  if (recent) {
    if (recent.visibleInRecentPaper) {
      if (recent.tradesRecent >= 1 && recent.pnlRecent > 2) {
        score += 7;
        reasons.push('recent_pnl_positive');
      } else if (recent.tradesRecent >= 1 && recent.pnlRecent < -3) {
        score -= 10;
        reasons.push('recent_pnl_negative');
      } else {
        reasons.push('recent_activity_mixed_or_flat');
      }
    } else {
      score -= 6;
      reasons.push('not_seen_in_paper_last_7d_strict');
    }
  } else {
    score -= 5;
    reasons.push('no_strict_mapping_entry');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let status = 'WATCH';
  if (score > 70) status = 'KEEP';
  else if (score >= 50) status = 'WATCH';
  else if (score >= 30) status = 'DOWNGRADE';
  else if (score >= 15) status = 'SUSPEND';
  else status = 'KILL';

  const strongAllTimePositive =
    atTrades >= 15 && atPnl != null && atPnl > 150 && (pf == null || pf >= 0.98);
  if (strongAllTimePositive && (status === 'KILL' || status === 'SUSPEND' || status === 'DOWNGRADE')) {
    status = 'WATCH';
    reasons.push('veto_strong_alltime_positive_floor_watch');
  }

  if (!metricsRow && status === 'KILL') {
    status = 'WATCH';
    reasons.push('veto_no_metrics_no_kill');
  }

  if (!metricsRow && status === 'SUSPEND') {
    status = 'DOWNGRADE';
    reasons.push('veto_no_metrics_downgrade_instead_of_suspend');
  }

  return { lifecycleScore: score, lifecycleStatus: status, lifecycleReasons: reasons };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataRoot]
 * @param {object[]} [opts.promotedStrategies] rows from promoted_children.strategies
 * @param {boolean} [opts.writeReport]
 * @returns {{ generatedAt: string, dataRoot: string, rows: object[], summary: object, scoringNotes: string[] }}
 */
function analyzePromotedLifecycle(opts = {}) {
  const root = resolveLifecycleDataRoot(opts);
  const scoringNotes = [
    'Base score 50; adjustments from paper metrics + strict_mapping recent slice.',
    'Strong all-time positive veto caps severity at WATCH (no KILL/SUSPEND/DOWNGRADE from score alone).',
    'Missing metrics: no KILL; SUSPEND downgraded to DOWNGRADE.',
  ];

  const strictPath = path.join(root, 'governance', 'paper_trades_strict_mapping_report.json');
  const strict = safeReadJson(strictPath);
  const recentMap = buildStrictRecentMap(strict);

  const { map: metricsMap, path: metricsPath } = loadPaperMetricsByStrategy(root);

  const strategies = Array.isArray(opts.promotedStrategies) ? opts.promotedStrategies : [];
  const setupIds = [];
  for (const row of strategies) {
    if (!row || typeof row !== 'object') continue;
    const sid = row.setupId != null ? String(row.setupId).trim() : '';
    if (sid) setupIds.push(sid);
  }
  const uniqueIds = Array.from(new Set(setupIds));

  const rows = [];
  for (const strategyId of uniqueIds) {
    const metricsRow = metricsMap.get(strategyId) || null;
    const recent = recentMap.get(strategyId) || null;
    const scored = scoreOneSetup({ strategyId, metricsRow, recent });
    rows.push({
      setupKey: strategyId,
      strategyId,
      lifecycleScore: scored.lifecycleScore,
      lifecycleStatus: scored.lifecycleStatus,
      reasons: scored.lifecycleReasons,
      recentTrades: recent ? recent.tradesRecent : null,
      recentPnl: recent ? recent.pnlRecent : null,
      allTimeTrades: metricsRow && Number.isFinite(Number(metricsRow.trades)) ? Number(metricsRow.trades) : null,
      allTimePnl:
        metricsRow && Number.isFinite(Number(metricsRow.totalPnl)) ? Number(metricsRow.totalPnl) : null,
      profitFactor:
        metricsRow && metricsRow.profitFactor != null && Number.isFinite(Number(metricsRow.profitFactor))
          ? Number(metricsRow.profitFactor)
          : metricsRow && metricsRow.pf != null && Number.isFinite(Number(metricsRow.pf))
            ? Number(metricsRow.pf)
            : null,
      visibleInRecentPaper: recent ? !!recent.visibleInRecentPaper : false,
      inPromotedManifest: true,
      familyPrefix: familyPrefixFromId(strategyId),
    });
  }

  const byStatus = (s) => rows.filter((r) => r.lifecycleStatus === s).length;
  const summary = {
    sourceStrategyCount: uniqueIds.length,
    rowCount: rows.length,
    keepCount: byStatus('KEEP'),
    watchCount: byStatus('WATCH'),
    downgradeCount: byStatus('DOWNGRADE'),
    suspendCount: byStatus('SUSPEND'),
    killCount: byStatus('KILL'),
    strictReportPresent: !!strict,
    strictReportPath: strictPath,
    metricsPath,
    metricsBucketCount: metricsMap.size,
  };

  const generatedAt = new Date().toISOString();
  return {
    generatedAt,
    dataRoot: root,
    rows,
    summary,
    scoringNotes,
  };
}

/**
 * @param {object[]} items manifest items (with strategyId)
 * @param {Map<string, object>} lifecycleByStrategyId map strategyId -> row from analyzePromotedLifecycle.rows
 * @param {{ suspendBlocks: boolean, killBlocks: boolean }} policy
 * @returns {{ items: object[], filteredOut: object[] }}
 */
function tagManifestItemsOnly(items, lifecycleByStrategyId) {
  return items.map((item) => {
    const sid = String(item.strategyId || item.setupId || '').trim();
    const row = lifecycleByStrategyId.get(sid);
    const status = row ? row.lifecycleStatus : 'WATCH';
    const score = row ? row.lifecycleScore : 50;
    const reasons = row ? row.reasons : ['lifecycle_row_missing_treated_watch'];
    return {
      ...item,
      lifecycleStatus: status,
      lifecycleScore: score,
      lifecycleReasons: reasons,
    };
  });
}

function filterAndTagManifestItems(items, lifecycleByStrategyId, policy) {
  const out = [];
  const filteredOut = [];
  for (const item of items) {
    const sid = String(item.strategyId || item.setupId || '').trim();
    const row = lifecycleByStrategyId.get(sid);
    const status = row ? row.lifecycleStatus : 'WATCH';
    const score = row ? row.lifecycleScore : 50;
    const reasons = row ? row.reasons : ['lifecycle_row_missing_treated_watch'];
    const tagged = {
      ...item,
      lifecycleStatus: status,
      lifecycleScore: score,
      lifecycleReasons: reasons,
    };
    let include = true;
    if (status === 'SUSPEND' && policy.suspendBlocks) include = false;
    if (status === 'KILL' && policy.killBlocks) include = false;
    if (include) out.push(tagged);
    else filteredOut.push({ strategyId: sid, lifecycleStatus: status, lifecycleScore: score });
  }
  return { items: out, filteredOut };
}

function writePromotedLifecycleReport(root, doc) {
  const gov = path.join(root, 'governance');
  ensureDir(gov);
  const outPath = path.join(gov, LIFECYCLE_REPORT_FILENAME);
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf8');
  return outPath;
}

/**
 * @param {object} analysis from analyzePromotedLifecycle
 * @returns {Map<string, object>}
 */
function rowsToMap(analysis) {
  const m = new Map();
  for (const r of analysis.rows || []) {
    if (r && r.strategyId) m.set(String(r.strategyId), r);
  }
  return m;
}

module.exports = {
  LIFECYCLE_REPORT_FILENAME,
  resolveLifecycleDataRoot,
  manifestLifecycleFeatureEnabled,
  manifestLifecycleSuspendBlocks,
  manifestLifecycleKillBlocks,
  manifestLifecycleWriteReportDefault,
  analyzePromotedLifecycle,
  filterAndTagManifestItems,
  tagManifestItemsOnly,
  writePromotedLifecycleReport,
  rowsToMap,
  scoreOneSetup,
};

if (require.main === module) {
  const root = resolveLifecycleDataRoot({});
  const promotedPath = path.join(root, 'discovery', 'promoted_children.json');
  const promotedDoc = safeReadJson(promotedPath);
  const promotedStrategies =
    promotedDoc && Array.isArray(promotedDoc.strategies) ? promotedDoc.strategies : [];
  const analysis = analyzePromotedLifecycle({
    dataRoot: root,
    promotedStrategies,
    writeReport: true,
  });
  const reportDoc = {
    generatedAt: analysis.generatedAt,
    dataRoot: analysis.dataRoot,
    sourceArtifact: promotedPath,
    summary: analysis.summary,
    scoringNotes: analysis.scoringNotes,
    rows: analysis.rows,
  };
  const outPath = writePromotedLifecycleReport(root, reportDoc);
  console.log('[analyzePromotedLifecycle] wrote', outPath);
  console.log('[analyzePromotedLifecycle] summary', JSON.stringify(analysis.summary));
}
