'use strict';

/**
 * Portfolio Governor (P6)
 * Maps governance signals → bounded, traceable portfolio decisions and optional rewrite of strategy_portfolio.json.
 *
 * Inputs (discovery/):
 *   - governance_mini_report.json (optional; if absent, supervisor-only inference)
 *   - supervisor_config.json
 *   - meta_ranking.json
 *   - strategy_portfolio.json (optional; portfolio-only mode if missing)
 *   - mutation_policy.json (optional context in decisionInputs)
 *
 * Outputs:
 *   - portfolio_governor.json
 *   - portfolio_governor_history.json (append-only array)
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const { appendGovernorMetricsEvent } = require('../observability/governorMetrics');
const { writePortfolio } = require('../meta/championPortfolioBuilder');
const { applyTrendMemoryToGovernorDecision } = require('../governance/trendMemoryApply');

const GOVERNOR_VERSION = 'p6-v1';

/** Hard cap for maxNewAllocations (no silent override above this). */
const DEFAULT_MAX_NEW_ALLOCATIONS_CAP = 24;

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

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round6(v) {
  return Math.round(safeNum(v, 0) * 1e6) / 1e6;
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function resolveExperimentId(opts = {}) {
  if (opts.experimentId) return String(opts.experimentId);
  if (process.env.EXPERIMENT_ID && String(process.env.EXPERIMENT_ID).trim()) {
    return String(process.env.EXPERIMENT_ID).trim();
  }
  const meta = opts.metaRanking || null;
  if (meta && meta.experimentId) return String(meta.experimentId);
  return null;
}

/**
 * When no governance_mini_report (or no governanceStatus on it), infer stress signals
 * so DEGRADED is not exclusively tied to the end-of-run mini report.
 *
 * Env:
 *   SUPERVISOR_MAX_INVALID_RATIO (default 0.2)
 *   PORTFOLIO_GOVERNOR_DEGRADED_IR_FRACTION — ir >= maxIr * fraction triggers (default 0.55)
 *   PORTFOLIO_GOVERNOR_DEGRADED_MIN_SIGNALS — min matching signals (default 1)
 */
function inferDegradedFromSignals(supervisor, discoveryDir) {
  const reasons = [];
  if (!supervisor || supervisor.cycle_valid !== true) return reasons;

  const maxIr = Math.max(0.0001, safeNum(process.env.SUPERVISOR_MAX_INVALID_RATIO, 0.2));
  const irFrac = clamp(safeNum(process.env.PORTFOLIO_GOVERNOR_DEGRADED_IR_FRACTION, 0.55), 0.05, 1);
  const ir = safeNum(supervisor.invalidResultRatio, 0);
  if (ir >= maxIr * irFrac) {
    reasons.push(
      `degraded_signal:invalidResultRatio_stress:${round6(ir)}_gte_threshold_${round6(maxIr * irFrac)}`
    );
  }

  if (supervisor.fallbackApplied === true) {
    reasons.push(
      `degraded_signal:supervisor_fallbackApplied:${String(supervisor.fallbackReason || 'unknown')}`
    );
  }

  const expansionPath = path.join(discoveryDir, 'family_expansion_report.json');
  const expansion = safeReadJson(expansionPath);
  if (expansion) {
    const fw = safeNum(expansion.files_written, 0);
    const ls = safeNum(expansion.leaders_selected, 0);
    if (fw === 0 && ls > 0) {
      reasons.push('degraded_signal:expansion_zero_output_with_leaders');
    }
  }

  return reasons;
}

/**
 * Portfolio mode: healthy | degraded | blocked
 * Precedence: !cycle_valid OR governanceStatus BLOCKED → blocked;
 *             governanceStatus DEGRADED (and cycle_valid) → degraded;
 *             governanceStatus OK from mini → healthy (no heuristic override);
 *             sans mini (ou sans governanceStatus) → heuristiques DEGRADED si signaux;
 *             else → healthy.
 */
function resolveMode(supervisor, miniReport, discoveryDir) {
  const dir = discoveryDir || dataRoot.getPath('discovery');
  const cycle_valid = !!(supervisor && supervisor.cycle_valid === true);
  let governanceStatus = 'OK';
  const miniHasStatus = !!(miniReport && typeof miniReport.governanceStatus === 'string');
  if (miniHasStatus) {
    governanceStatus = String(miniReport.governanceStatus).trim().toUpperCase();
  }

  const reasons = [];

  if (!supervisor) {
    reasons.push('missing_supervisor_config:default_blocked');
    return {
      mode: 'blocked',
      governanceStatus: 'BLOCKED',
      cycle_valid: false,
      decisionReasons: reasons,
    };
  }

  if (!cycle_valid) {
    reasons.push('supervisor_cycle_invalid');
    if (Array.isArray(supervisor.cycle_invalid_reasons) && supervisor.cycle_invalid_reasons.length) {
      reasons.push(`cycle_invalid_reasons:${supervisor.cycle_invalid_reasons.join('|')}`);
    }
    return {
      mode: 'blocked',
      governanceStatus: 'BLOCKED',
      cycle_valid: false,
      decisionReasons: reasons,
    };
  }

  if (governanceStatus === 'BLOCKED') {
    reasons.push('governance_mini_report_status_BLOCKED');
    return {
      mode: 'blocked',
      governanceStatus: 'BLOCKED',
      cycle_valid: true,
      decisionReasons: reasons,
    };
  }

  if (governanceStatus === 'DEGRADED') {
    reasons.push('governance_mini_report_status_DEGRADED');
    return {
      mode: 'degraded',
      governanceStatus: 'DEGRADED',
      cycle_valid: true,
      decisionReasons: reasons,
    };
  }

  if (miniHasStatus && governanceStatus === 'OK') {
    reasons.push('governance_mini_report_OK');
    reasons.push('governance_OK_supervisor_cycle_valid');
    return {
      mode: 'healthy',
      governanceStatus: 'OK',
      cycle_valid: true,
      decisionReasons: reasons,
    };
  }

  const minSig = Math.max(1, Math.floor(safeNum(process.env.PORTFOLIO_GOVERNOR_DEGRADED_MIN_SIGNALS, 1)));
  const degradedSignals = inferDegradedFromSignals(supervisor, dir);
  if (degradedSignals.length >= minSig) {
    return {
      mode: 'degraded',
      governanceStatus: 'DEGRADED',
      cycle_valid: true,
      decisionReasons: degradedSignals,
    };
  }

  reasons.push('governance_OK_supervisor_cycle_valid');
  if (!miniHasStatus) {
    reasons.push('no_governance_mini_report_status_field:heuristic_degraded_not_triggered');
  }
  return {
    mode: 'healthy',
    governanceStatus: 'OK',
    cycle_valid: true,
    decisionReasons: reasons,
  };
}

function baselineMaxAllocations(metaRanking, portfolio, cap, envPortfolioMax) {
  const envMax = safeNum(envPortfolioMax, safeNum(process.env.PORTFOLIO_MAX, 12));
  const fromMeta =
    metaRanking && Array.isArray(metaRanking.strategies)
      ? Math.min(metaRanking.strategies.length, envMax)
      : envMax;
  const fromPortfolio =
    portfolio && Array.isArray(portfolio.strategies) ? portfolio.strategies.length : fromMeta;
  return clamp(Math.min(fromMeta, fromPortfolio, envMax), 0, cap);
}

function buildDecision(mode, ctx) {
  const cap = Math.max(0, safeNum(ctx.maxAllocCap, DEFAULT_MAX_NEW_ALLOCATIONS_CAP));
  const normalMax = baselineMaxAllocations(ctx.metaRanking, ctx.portfolio, cap, ctx.envPortfolioMax);

  const decisionReasons = [...(ctx.baseReasons || [])];
  let holdCash = false;
  let targetExposure = 1;
  let maxNewAllocations = normalMax;
  let promotionMode = 'normal';
  let admissionThresholdMultiplier = 1;

  if (mode === 'healthy') {
    targetExposure = clamp(1, 0, 1);
    maxNewAllocations = clamp(normalMax, 0, cap);
    promotionMode = 'normal';
    admissionThresholdMultiplier = 1;
    holdCash = false;
    decisionReasons.push('scenario_healthy:targetExposure=1,promotionMode=normal');
  } else if (mode === 'degraded') {
    const reducedExposure = clamp(0.55, 0, 1);
    targetExposure = reducedExposure;
    maxNewAllocations = clamp(Math.floor(normalMax * 0.5), 0, cap);
    promotionMode = 'conservative';
    admissionThresholdMultiplier = 1.25;
    holdCash = true;
    decisionReasons.push(
      `scenario_degraded:targetExposure=${reducedExposure},maxNewAllocations_scaled,max_promotion=conservative,admission_mult=${admissionThresholdMultiplier}`
    );
  } else {
    targetExposure = 0;
    maxNewAllocations = 0;
    promotionMode = 'blocked';
    admissionThresholdMultiplier = 1;
    holdCash = true;
    decisionReasons.push('scenario_blocked:targetExposure=0,maxNewAllocations=0,promotionMode=blocked');
  }

  targetExposure = round6(clamp(targetExposure, 0, 1));
  maxNewAllocations = Math.floor(clamp(maxNewAllocations, 0, cap));

  if (mode === 'degraded' && admissionThresholdMultiplier <= 1) {
    admissionThresholdMultiplier = 1.01;
    decisionReasons.push('bound_fix:admissionThresholdMultiplier_forced_above_1_for_degraded');
  }

  return {
    experimentId: ctx.experimentId,
    cycleId: ctx.experimentId || null,
    governorVersion: GOVERNOR_VERSION,
    governanceStatus: ctx.governanceStatus,
    cycle_valid: ctx.cycle_valid,
    holdCash,
    targetExposure,
    maxNewAllocations,
    promotionMode,
    admissionThresholdMultiplier: round6(admissionThresholdMultiplier),
    decisionReasons,
    decisionInputs: ctx.decisionInputs,
  };
}

/**
 * Apply governor decision to a portfolio object (mutates a clone).
 */
function applyGovernorToPortfolio(portfolio, decision) {
  const out = portfolio && typeof portfolio === 'object' ? JSON.parse(JSON.stringify(portfolio)) : {};
  const reasons = [];

  let strategies = Array.isArray(out.strategies) ? [...out.strategies] : [];
  strategies.sort((a, b) => safeNum(b.allocation_weight, 0) - safeNum(a.allocation_weight, 0));

  const before = strategies.length;
  if (decision.maxNewAllocations < strategies.length) {
    strategies = strategies.slice(0, decision.maxNewAllocations);
    reasons.push(`applied_trim_strategies:${before}->${strategies.length}`);
  }

  const te = clamp(safeNum(decision.targetExposure, 0), 0, 1);
  let sumW = strategies.reduce((s, r) => s + safeNum(r.allocation_weight, 0), 0);

  if (decision.promotionMode === 'blocked' || te <= 0) {
    out.strategies = [];
    out.cash_weight = 1;
    out.is_fully_invested = false;
    out.expected_return = 0;
    out.constraint_status = 'portfolio_governor_blocked';
    reasons.push('applied_full_cash:strategies_cleared');
  } else {
    if (sumW <= 0 && strategies.length > 0) {
      const eq = te / strategies.length;
      strategies = strategies.map((r) => ({ ...r, allocation_weight: round6(eq) }));
      sumW = te;
      reasons.push('applied_equal_weights:previous_sum_zero');
    } else if (strategies.length > 0) {
      const scale = te / sumW;
      strategies = strategies.map((r) => ({
        ...r,
        allocation_weight: round6(safeNum(r.allocation_weight, 0) * scale),
      }));
    }
    const newSum = strategies.reduce((s, r) => s + safeNum(r.allocation_weight, 0), 0);
    out.cash_weight = round6(clamp(1 - newSum, 0, 1));
    out.strategies = strategies;
    out.is_fully_invested = out.cash_weight <= 1e-6;
    out.constraint_status =
      out.cash_weight > 1e-6 ? 'portfolio_governor_partial_cash' : 'ok';
    const er = strategies.reduce(
      (s, r) => s + safeNum(r.allocation_weight, 0) * safeNum(r.expected_return ?? r.expectancy, 0),
      0
    );
    out.expected_return = round6(er);
    reasons.push(`applied_targetExposure=${te},cash_weight=${out.cash_weight}`);
  }

  out.portfolio_governor_applied = true;
  out.portfolioGovernor = {
    governorVersion: decision.governorVersion,
    governanceStatus: decision.governanceStatus,
    cycle_valid: decision.cycle_valid,
    targetExposure: decision.targetExposure,
    maxNewAllocations: decision.maxNewAllocations,
    promotionMode: decision.promotionMode,
    admissionThresholdMultiplier: decision.admissionThresholdMultiplier,
    holdCash: decision.holdCash,
    applyTrace: reasons,
    trendMemoryApply: decision.trendMemoryApply || null,
  };

  return { portfolio: out, applyTrace: reasons };
}

function sanitizeGovernorReasonToken(s, maxLen = 200) {
  const t = String(s || '')
    .replace(/[^\w.:-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, maxLen);
  return t || '';
}

/**
 * Stable one-line audit. Ops: grep `\\[Governor metrics\\]` (do not change prefix).
 */
function logGovernorMetrics(decision, mode) {
  const cycleId = decision.cycleId || decision.experimentId || 'n/a';
  const decisionStr = String(decision.governanceStatus || 'UNKNOWN').toUpperCase();
  const modeStr = String(mode || 'unknown');
  const reasons = Array.isArray(decision.decisionReasons) ? decision.decisionReasons : [];
  const reasonToken = reasons.length ? sanitizeGovernorReasonToken(reasons[0]) : 'n/a';
  const tm = decision.trendMemoryApply || {};
  const filesRead = decision.decisionInputs && decision.decisionInputs.filesRead;
  const policySource = tm.appliedFromTrendMemory
    ? 'trend'
    : filesRead && filesRead.mutation_policy
      ? 'mutation'
      : 'baseline';
  const riskState = modeStr;
  const line =
    `[Governor metrics] cycleId=${cycleId} decision=${decisionStr} mode=${modeStr} reason=${reasonToken} policySource=${policySource} riskState=${riskState}`;
  console.log(line);
  appendGovernorMetricsEvent(line);
}

function appendHistory(historyPath, entry) {
  let hist = [];
  if (fs.existsSync(historyPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      if (Array.isArray(j)) hist = j;
      else if (j && Array.isArray(j.entries)) hist = j.entries;
    } catch {
      hist = [];
    }
  }
  hist.push(entry);
  ensureDir(path.dirname(historyPath));
  fs.writeFileSync(historyPath, JSON.stringify(hist, null, 2), 'utf8');
}

/**
 * @param {object} opts
 * @param {string} [opts.discoveryDir]
 * @param {boolean} [opts.applyToPortfolio=true]
 * @param {object} [opts.supervisor] - inject for tests
 * @param {object} [opts.miniReport]
 * @param {object} [opts.metaRanking]
 * @param {object} [opts.portfolio]
 * @param {object} [opts.mutationPolicy]
 */
function runPortfolioGovernor(opts = {}) {
  const discoveryDir = opts.discoveryDir || dataRoot.getPath('discovery');
  const applyToPortfolio = opts.applyToPortfolio !== false;

  const paths = {
    governanceMini: path.join(discoveryDir, 'governance_mini_report.json'),
    supervisor: path.join(discoveryDir, 'supervisor_config.json'),
    metaRanking: path.join(discoveryDir, 'meta_ranking.json'),
    strategyPortfolio: path.join(discoveryDir, 'strategy_portfolio.json'),
    mutationPolicy: path.join(discoveryDir, 'mutation_policy.json'),
    outGovernor: path.join(discoveryDir, 'portfolio_governor.json'),
    outHistory: path.join(discoveryDir, 'portfolio_governor_history.json'),
  };

  const supervisor = opts.supervisor != null ? opts.supervisor : safeReadJson(paths.supervisor);
  const miniReport = opts.miniReport != null ? opts.miniReport : safeReadJson(paths.governanceMini);
  const metaRanking = opts.metaRanking != null ? opts.metaRanking : safeReadJson(paths.metaRanking);
  const portfolio = opts.portfolio != null ? opts.portfolio : safeReadJson(paths.strategyPortfolio);
  const mutationPolicy =
    opts.mutationPolicy != null ? opts.mutationPolicy : safeReadJson(paths.mutationPolicy);

  const resolved = resolveMode(supervisor, miniReport, discoveryDir);
  const experimentId = resolveExperimentId({ ...opts, metaRanking });

  const decisionInputs = {
    filesRead: {
      governance_mini_report: fs.existsSync(paths.governanceMini),
      supervisor_config: fs.existsSync(paths.supervisor),
      meta_ranking: fs.existsSync(paths.metaRanking),
      strategy_portfolio: fs.existsSync(paths.strategyPortfolio),
      mutation_policy: fs.existsSync(paths.mutationPolicy),
    },
    supervisorCycleValid: supervisor ? supervisor.cycle_valid : null,
    miniReportGovernanceStatus: miniReport ? miniReport.governanceStatus : null,
    metaStrategyCount: metaRanking && Array.isArray(metaRanking.strategies) ? metaRanking.strategies.length : 0,
    portfolioStrategyCount: portfolio && Array.isArray(portfolio.strategies) ? portfolio.strategies.length : 0,
    mutationPolicyVersion: mutationPolicy && mutationPolicy.policyVersion ? mutationPolicy.policyVersion : null,
    maxNewAllocationsCap: safeNum(opts.maxAllocCap, DEFAULT_MAX_NEW_ALLOCATIONS_CAP),
  };

  let decision = buildDecision(resolved.mode, {
    experimentId,
    governanceStatus: resolved.governanceStatus,
    cycle_valid: resolved.cycle_valid,
    baseReasons: resolved.decisionReasons,
    metaRanking,
    portfolio,
    maxAllocCap: decisionInputs.maxNewAllocationsCap,
    envPortfolioMax: opts.envPortfolioMax,
    decisionInputs,
  });

  const tmGov = applyTrendMemoryToGovernorDecision(
    decision,
    discoveryDir,
    decisionInputs.maxNewAllocationsCap
  );
  if (tmGov.decisionPatch) {
    decision = {
      ...decision,
      ...tmGov.decisionPatch,
      decisionReasons: [...decision.decisionReasons, ...tmGov.reasons],
      trendMemoryApply: {
        appliedFromTrendMemory: tmGov.appliedFromTrendMemory,
        appliedDeltas: tmGov.appliedDeltas,
      },
    };
  } else if (tmGov.reasons && tmGov.reasons.length) {
    decision = {
      ...decision,
      decisionReasons: [...decision.decisionReasons, ...tmGov.reasons],
      trendMemoryApply: {
        appliedFromTrendMemory: tmGov.appliedFromTrendMemory,
        appliedDeltas: tmGov.appliedDeltas,
      },
    };
  }

  let applyTrace = [];
  let portfolioOutPath = null;
  if (applyToPortfolio && portfolio) {
    const { portfolio: next, applyTrace: tr } = applyGovernorToPortfolio(portfolio, decision);
    applyTrace = tr;
    ensureDir(discoveryDir);
    portfolioOutPath = writePortfolio(next, paths.strategyPortfolio);
    decision.decisionReasons = [...decision.decisionReasons, ...applyTrace];
  } else if (applyToPortfolio && !portfolio) {
    decision.decisionReasons.push('no_strategy_portfolio_file:decision_only_no_rewrite');
  }

  const outPayload = {
    ...decision,
    generatedAt: new Date().toISOString(),
    discoveryDir,
    applyToPortfolio: !!applyToPortfolio,
    portfolioWritten: !!portfolioOutPath,
    trendMemoryApply: decision.trendMemoryApply || {
      appliedFromTrendMemory: false,
      appliedDeltas: null,
    },
  };

  ensureDir(discoveryDir);
  fs.writeFileSync(paths.outGovernor, JSON.stringify(outPayload, null, 2), 'utf8');
  logGovernorMetrics(outPayload, resolved.mode);

  appendHistory(paths.outHistory, {
    at: outPayload.generatedAt,
    experimentId: outPayload.experimentId,
    cycleId: outPayload.cycleId || null,
    governorVersion: outPayload.governorVersion,
    governanceStatus: outPayload.governanceStatus,
    cycle_valid: outPayload.cycle_valid,
    targetExposure: outPayload.targetExposure,
    maxNewAllocations: outPayload.maxNewAllocations,
    promotionMode: outPayload.promotionMode,
    holdCash: outPayload.holdCash,
    decisionReasons: outPayload.decisionReasons,
  });

  return {
    decision: outPayload,
    paths,
    portfolioOutPath,
    mode: resolved.mode,
  };
}

module.exports = {
  GOVERNOR_VERSION,
  DEFAULT_MAX_NEW_ALLOCATIONS_CAP,
  resolveMode,
  inferDegradedFromSignals,
  buildDecision,
  applyGovernorToPortfolio,
  runPortfolioGovernor,
};

if (require.main === module) {
  try {
    const r = runPortfolioGovernor();
    console.log('Portfolio Governor done.');
    console.log('  out:', r.paths.outGovernor);
    console.log('  governanceStatus:', r.decision.governanceStatus);
    console.log('  cycle_valid:', r.decision.cycle_valid);
    console.log('  targetExposure:', r.decision.targetExposure);
    console.log('  maxNewAllocations:', r.decision.maxNewAllocations);
    console.log('  promotionMode:', r.decision.promotionMode);
    console.log('  holdCash:', r.decision.holdCash);
  } catch (err) {
    console.error('Portfolio Governor failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}
