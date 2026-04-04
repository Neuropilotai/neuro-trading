'use strict';

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const { buildP7MetricsLogLine, appendP7MetricsEvent } = require('../observability/p7Metrics');
const { getCurrentCycleId } = require('./cycleContext');

const TREND_MEMORY_VERSION = 'p7-v1';
const DEFAULT_WINDOW_SIZE = 30;
const DEFAULT_MAX_FILES = 200;
const MAX_ABS_DELTA = 0.2;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round6(v) {
  return Math.round(safeNum(v, 0) * 1e6) / 1e6;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + safeNum(x, 0), 0) / arr.length;
}

function toTrendLabel(delta, eps = 0.01) {
  if (delta > eps) return 'up';
  if (delta < -eps) return 'down';
  return 'flat';
}

/**
 * Order archive reports by logical time: generatedAt (ISO), then experimentId, then path.
 * Falls back to mtime when generatedAt missing/invalid (filesystem order no longer primary).
 */
function listGovernanceArchiveReports(reportsDir) {
  if (!fs.existsSync(reportsDir)) return [];
  const paths = fs
    .readdirSync(reportsDir)
    .filter((f) => /^governance_mini_report_.*\.json$/i.test(f))
    .map((f) => path.join(reportsDir, f));

  const rows = paths.map((p) => {
    const st = fs.statSync(p);
    const json = safeReadJson(p);
    const g = json && json.generatedAt != null ? String(json.generatedAt) : '';
    const t = g ? Date.parse(g) : NaN;
    const expId = json && json.experimentId != null ? String(json.experimentId) : '';
    return {
      path: p,
      json,
      mtimeMs: st.mtimeMs,
      genMs: Number.isFinite(t) ? t : st.mtimeMs,
      experimentId: expId,
    };
  });

  rows.sort((a, b) => {
    if (a.genMs !== b.genMs) return a.genMs - b.genMs;
    const c = a.experimentId.localeCompare(b.experimentId);
    if (c !== 0) return c;
    return a.path.localeCompare(b.path);
  });

  return rows.map((r) => r.path);
}

function loadLastNGovernanceReports(discoveryDir, windowSize) {
  const reportsDir = path.join(discoveryDir, 'reports');
  const files = listGovernanceArchiveReports(reportsDir);
  const picked = files.slice(-windowSize);
  const rows = picked
    .map((p) => ({ path: p, json: safeReadJson(p) }))
    .filter((x) => x.json && typeof x.json === 'object')
    .map((x) => x.json);
  const skipped = picked.length - rows.length;
  if (skipped > 0) {
    console.warn(
      `[runTrendMemory] skipped ${skipped} unreadable governance_mini_report archive(s) in window (see ${reportsDir})`
    );
  }
  return { reportsDir, filesTotal: files.length, reports: rows, pickedCount: picked.length };
}

/** Count non-trivial suggestion fields when apply is enabled (for P7 metrics line). */
function countP7ApplySignals(computed, applyEnabled) {
  if (!applyEnabled || !computed || typeof computed !== 'object') return 0;
  const p = computed.policyAdjustments || {};
  const o = computed.portfolioAdjustments || {};
  let n = 0;
  const mtd = p.mutationTypeWeightDeltas || {};
  for (const v of Object.values(mtd)) {
    if (Math.abs(safeNum(v, 0)) > 1e-9) n += 1;
  }
  if (Array.isArray(p.familiesToDeprioritize) && p.familiesToDeprioritize.length) n += 1;
  if (Array.isArray(p.familiesToBoost) && p.familiesToBoost.length) n += 1;
  if (Math.abs(safeNum(o.exposureMultiplier, 1) - 1) > 1e-9) n += 1;
  if (Math.abs(safeNum(o.admissionThresholdDelta, 0)) > 1e-9) n += 1;
  if (Math.abs(safeNum(o.maxNewAllocationsDelta, 0)) > 1e-9) n += 1;
  return n;
}

function readHistoryEntries(filePath) {
  const j = safeReadJson(filePath);
  if (!j) return [];
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.entries)) return j.entries;
  return [];
}

function buildSignals(reports, governorEntries, mutationEntries) {
  const n = Math.max(1, reports.length);
  const statuses = reports.map((r) => String(r.governanceStatus || '')).filter(Boolean);
  const degradedRate = statuses.length
    ? statuses.filter((s) => s === 'DEGRADED').length / statuses.length
    : 0;
  const blockedRate = statuses.length
    ? statuses.filter((s) => s === 'BLOCKED').length / statuses.length
    : 0;

  const invalidRatios = reports
    .map((r) => safeNum(r.supervisor && r.supervisor.invalidResultRatio, null))
    .filter((x) => x != null);
  const avgInvalidRatio = invalidRatios.length ? mean(invalidRatios) : 0;

  const fallbackFlags = reports.map((r) => !!(r.expansion && r.expansion.fallbackApplied));
  const fallbackRate = fallbackFlags.length
    ? fallbackFlags.filter(Boolean).length / fallbackFlags.length
    : 0;

  const budgetUtil = reports
    .map((r) => {
      const m = safeNum(r.budgetAudit && r.budgetAudit.mutationBudget, null);
      const f = safeNum(r.budgetAudit && r.budgetAudit.files_written, null);
      if (m == null || f == null || m <= 0) return null;
      return clamp(f / m, 0, 2);
    })
    .filter((x) => x != null);
  const avgBudgetUtilization = budgetUtil.length ? mean(budgetUtil) : 0;

  const zeroExpansionFlags = reports.map((r) => {
    const leaders = safeNum(r.expansion && r.expansion.leaders_selected, 0);
    const fw = safeNum(r.budgetAudit && r.budgetAudit.files_written, 0);
    return leaders > 0 && fw <= 0;
  });
  const zeroExpansionRate = zeroExpansionFlags.length
    ? zeroExpansionFlags.filter(Boolean).length / zeroExpansionFlags.length
    : 0;

  const holdCashValues = [];
  for (const r of reports) {
    if (r.supervisor && typeof r.supervisor.holdCash === 'boolean') {
      holdCashValues.push(r.supervisor.holdCash ? 1 : 0);
    }
  }
  for (const g of governorEntries) {
    if (typeof g.holdCash === 'boolean') holdCashValues.push(g.holdCash ? 1 : 0);
  }
  const avgHoldCashRate = holdCashValues.length ? mean(holdCashValues) : 0;

  // Optional contextual rates from governor history (not part of minimal contract).
  const governorWindow = governorEntries.slice(-n);
  const conservativeRate = governorWindow.length
    ? governorWindow.filter((x) => String(x.promotionMode || '') === 'conservative').length /
      governorWindow.length
    : 0;
  const blockedPromotionRate = governorWindow.length
    ? governorWindow.filter((x) => String(x.promotionMode || '') === 'blocked').length /
      governorWindow.length
    : 0;

  const out = {
    degradedRate: round6(degradedRate),
    blockedRate: round6(blockedRate),
    avgInvalidRatio: round6(avgInvalidRatio),
    fallbackRate: round6(fallbackRate),
    avgBudgetUtilization: round6(avgBudgetUtilization),
    zeroExpansionRate: round6(zeroExpansionRate),
    avgHoldCashRate: round6(avgHoldCashRate),
  };

  return {
    signals: out,
    contextualRates: {
      conservativeRate: round6(conservativeRate),
      blockedPromotionRate: round6(blockedPromotionRate),
    },
    sampleCounts: {
      reports: reports.length,
      governorEntries: governorEntries.length,
      mutationEntries: mutationEntries.length,
    },
  };
}

function buildFamilyStats(reports, topLimit = 12) {
  const byFamily = {};
  for (const r of reports) {
    const families = r.expansion && Array.isArray(r.expansion.familiesToExpand)
      ? r.expansion.familiesToExpand
      : [];
    const leaders = safeNum(r.expansion && r.expansion.leaders_selected, 0);
    const filesWritten = safeNum(r.budgetAudit && r.budgetAudit.files_written, 0);
    const successProxy = leaders > 0 ? clamp(filesWritten / leaders, 0, 1) : 0;
    const sterile = leaders > 0 && filesWritten <= 0 ? 1 : 0;
    for (const fam of families) {
      const k = String(fam || '').trim();
      if (!k) continue;
      if (!byFamily[k]) byFamily[k] = { selected: 0, successProxySum: 0, sterile: 0 };
      byFamily[k].selected += 1;
      byFamily[k].successProxySum += successProxy;
      byFamily[k].sterile += sterile;
    }
  }
  const totalRuns = Math.max(1, reports.length);
  const rows = Object.entries(byFamily)
    .map(([family, v]) => ({
      family,
      selectionRate: v.selected / totalRuns,
      successProxy: v.selected > 0 ? v.successProxySum / v.selected : 0,
      sterileRate: v.selected > 0 ? v.sterile / v.selected : 0,
    }))
    .sort((a, b) => b.selectionRate - a.selectionRate)
    .slice(0, topLimit);

  const out = {};
  for (const r of rows) {
    out[r.family] = {
      selectionRate: round6(r.selectionRate),
      successProxy: round6(r.successProxy),
      sterileRate: round6(r.sterileRate),
    };
  }
  return out;
}

function buildMutationDrift(mutationEntries) {
  const latest = mutationEntries.slice(-10);
  const types = new Set();
  for (const e of latest) {
    const by = e && e.byMutationType && typeof e.byMutationType === 'object' ? e.byMutationType : {};
    for (const k of Object.keys(by)) types.add(k);
  }
  const out = {};
  for (const t of Array.from(types)) {
    const arr = latest
      .map((e) => safeNum(e.byMutationType && e.byMutationType[t], null))
      .filter((x) => x != null);
    if (!arr.length) continue;
    const avg = mean(arr);
    const delta = arr.length >= 2 ? arr[arr.length - 1] - arr[0] : 0;
    out[t] = {
      avg: round6(avg),
      trend: toTrendLabel(delta),
    };
  }
  return out;
}

function computeSuggestions(signals, familyStats, mutationDrift, contextualRates) {
  const reasons = [];
  const policyAdjustments = {
    familiesToDeprioritize: [],
    familiesToBoost: [],
    mutationTypeWeightDeltas: {},
  };
  const portfolioAdjustments = {
    exposureMultiplier: 1,
    maxNewAllocationsDelta: 0,
    admissionThresholdDelta: 0,
  };

  if (signals.blockedRate >= 0.35 || contextualRates.blockedPromotionRate >= 0.35) {
    portfolioAdjustments.exposureMultiplier = round6(clamp(0.9, 1 - 0.2, 1 + 0.2));
    portfolioAdjustments.admissionThresholdDelta = round6(clamp(0.1, -MAX_ABS_DELTA, MAX_ABS_DELTA));
    reasons.push('trend_blocked_rate_high:shift_conservative_portfolio_bias');
  } else if (signals.degradedRate >= 0.4 || signals.avgHoldCashRate >= 0.45) {
    portfolioAdjustments.exposureMultiplier = round6(clamp(0.95, 1 - 0.2, 1 + 0.2));
    portfolioAdjustments.admissionThresholdDelta = round6(clamp(0.05, -MAX_ABS_DELTA, MAX_ABS_DELTA));
    reasons.push('trend_degraded_or_holdCash_high:light_conservative_bias');
  }

  if (signals.avgBudgetUtilization <= 0.35 && signals.fallbackRate >= 0.4) {
    policyAdjustments.mutationTypeWeightDeltas.parameter_jitter = round6(
      clamp(0.06, -MAX_ABS_DELTA, MAX_ABS_DELTA)
    );
    policyAdjustments.mutationTypeWeightDeltas.hybrid_family_shift = round6(
      clamp(-0.04, -MAX_ABS_DELTA, MAX_ABS_DELTA)
    );
    reasons.push('budget_underuse_with_fallback:rebalance_toward_stable_mutations');
  }

  for (const [fam, stats] of Object.entries(familyStats || {})) {
    if (stats.selectionRate >= 0.25 && stats.sterileRate >= 0.6) {
      policyAdjustments.familiesToDeprioritize.push(fam);
    } else if (stats.selectionRate >= 0.2 && stats.successProxy >= 0.6) {
      policyAdjustments.familiesToBoost.push(fam);
    }
  }

  if (mutationDrift.parameter_jitter && mutationDrift.parameter_jitter.trend === 'down') {
    policyAdjustments.mutationTypeWeightDeltas.parameter_jitter = round6(
      clamp(
        safeNum(policyAdjustments.mutationTypeWeightDeltas.parameter_jitter, 0) + 0.03,
        -MAX_ABS_DELTA,
        MAX_ABS_DELTA
      )
    );
    reasons.push('parameter_jitter_downtrend:small_upward_recenter');
  }

  policyAdjustments.familiesToDeprioritize = policyAdjustments.familiesToDeprioritize.slice(0, 20);
  policyAdjustments.familiesToBoost = policyAdjustments.familiesToBoost.slice(0, 20);
  portfolioAdjustments.maxNewAllocationsDelta = Math.trunc(
    clamp(portfolioAdjustments.maxNewAllocationsDelta, -5, 5)
  );

  return { policyAdjustments, portfolioAdjustments, reasons };
}

function appendHistory(historyPath, payload) {
  const prev = safeReadJson(historyPath);
  const entries = prev && Array.isArray(prev.entries) ? prev.entries : [];
  entries.push(payload);
  ensureDir(path.dirname(historyPath));
  fs.writeFileSync(
    historyPath,
    JSON.stringify(
      {
        version: TREND_MEMORY_VERSION,
        entries,
      },
      null,
      2
    ),
    'utf8'
  );
}

function runTrendMemory(opts = {}) {
  const root = opts.dataRoot || dataRoot.getDataRoot();
  const discoveryDir = opts.discoveryDir || dataRoot.getPath('discovery');
  const windowSize = Math.max(
    1,
    Math.floor(safeNum(opts.windowSize, safeNum(process.env.TREND_MEMORY_WINDOW_SIZE, DEFAULT_WINDOW_SIZE)))
  );
  const maxFiles = Math.max(
    windowSize,
    Math.floor(safeNum(opts.maxFiles, safeNum(process.env.TREND_MEMORY_MAX_FILES, DEFAULT_MAX_FILES)))
  );

  const loaded = loadLastNGovernanceReports(discoveryDir, windowSize);
  const governorEntries = readHistoryEntries(path.join(discoveryDir, 'portfolio_governor_history.json'));
  const mutationEntries = readHistoryEntries(path.join(discoveryDir, 'mutation_policy_history.json'));

  const { signals, contextualRates, sampleCounts } = buildSignals(
    loaded.reports,
    governorEntries,
    mutationEntries
  );
  const familyStats = buildFamilyStats(loaded.reports);
  const mutationDrift = buildMutationDrift(mutationEntries);
  const computed = computeSuggestions(signals, familyStats, mutationDrift, contextualRates);

  const applyEnabled = String(process.env.TREND_MEMORY_APPLY || '').toLowerCase() === 'true';
  const applyMode = String(process.env.TREND_MEMORY_APPLY_MODE || 'disabled');
  const appliedFromTrendMemory = applyEnabled;
  const appliedDeltas = applyEnabled ? computed : { policyAdjustments: {}, portfolioAdjustments: {} };

  const coverageWarning =
    loaded.reports.length < Math.min(windowSize, 3)
      ? `limited_governance_archive_coverage:${loaded.reports.length}_reports`
      : null;

  const experimentsConsidered = loaded.reports
    .map((r) => String(r.experimentId || ''))
    .filter(Boolean)
    .slice(-windowSize);

  const cycleTag = getCurrentCycleId() || process.env.EXPERIMENT_ID || null;

  const payload = {
    trendMemoryVersion: TREND_MEMORY_VERSION,
    generatedAt: new Date().toISOString(),
    dataRoot: root,
    producingCycleId: cycleTag,
    windowSize,
    experimentsConsidered,
    signals,
    familyStats,
    mutationDrift,
    suggestions: {
      policyAdjustments: computed.policyAdjustments,
      portfolioAdjustments: computed.portfolioAdjustments,
    },
    safety: {
      bounded: true,
      notes: [
        'suggestive_by_default',
        `trend_memory_apply=${applyEnabled}`,
        `trend_memory_apply_mode=${applyMode}`,
        `max_abs_delta=${MAX_ABS_DELTA}`,
      ],
    },
    decisionReasons: computed.reasons,
    contextualRates,
    coverageWarning,
    appliedFromTrendMemory,
    appliedDeltas,
    inputsUsed: {
      governanceReportsRead: loaded.reports.length,
      governanceReportsAvailable: loaded.filesTotal,
      portfolioGovernorHistoryEntries: governorEntries.length,
      mutationPolicyHistoryEntries: mutationEntries.length,
      sampleCounts,
      maxArchiveFiles: maxFiles,
    },
  };

  const outPath = path.join(discoveryDir, 'run_trend_memory.json');
  const historyPath = path.join(discoveryDir, 'run_trend_memory_history.json');

  ensureDir(discoveryDir);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  const reportsLoaded = loaded.reports.length;
  const reportsConsidered = loaded.pickedCount;
  let p7Status = 'ok';
  let p7Source = 'archive';
  if (reportsLoaded === 0) {
    p7Status = 'empty';
    p7Source = 'none';
  } else if (coverageWarning) {
    p7Status = 'degraded';
    p7Source = 'fallback';
  }
  const p7Line = buildP7MetricsLogLine({
    cycleId: cycleTag || 'n/a',
    producingCycleId: cycleTag || 'n/a',
    windowSize,
    reportsConsidered,
    reportsLoaded,
    applyCount: countP7ApplySignals(computed, applyEnabled),
    applyExpected: applyEnabled ? 1 : 0,
    status: p7Status,
    source: p7Source,
  });
  console.log(p7Line);
  appendP7MetricsEvent(p7Line);

  appendHistory(historyPath, {
    at: payload.generatedAt,
    trendMemoryVersion: payload.trendMemoryVersion,
    producingCycleId: payload.producingCycleId || null,
    experimentsConsidered: payload.experimentsConsidered,
    signals: payload.signals,
    suggestions: payload.suggestions,
    coverageWarning: payload.coverageWarning,
    appliedFromTrendMemory: payload.appliedFromTrendMemory,
  });

  return { outPath, historyPath, payload };
}

module.exports = {
  TREND_MEMORY_VERSION,
  runTrendMemory,
  buildSignals,
  buildFamilyStats,
  buildMutationDrift,
  computeSuggestions,
};

if (require.main === module) {
  try {
    const result = runTrendMemory();
    console.log('Run trend memory done.');
    console.log('  out:', result.outPath);
    console.log('  history:', result.historyPath);
    console.log('  experimentsConsidered:', result.payload.experimentsConsidered.length);
    console.log(
      '  signals:',
      JSON.stringify(result.payload.signals)
    );
  } catch (err) {
    console.error('runTrendMemory failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}
