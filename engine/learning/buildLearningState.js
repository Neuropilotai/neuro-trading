#!/usr/bin/env node
'use strict';

/**
 * Phase 1: build canonical governance/learning_state.json + learning_feedback_summary.json.
 * Write-only — no engine wiring. Fail-soft: always exits 0; structured warnings on stderr.
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const { parsePaperTradesJsonlContent } = require('../governance/parsePaperTradesJsonl');
const { computePaperMutationLearning } = require('../evolution/paperMutationLearning');
const { emptyLearningStateShell, LEARNING_STATE_SCHEMA_VERSION } = require('./loadLearningState');

const FEEDBACK_SCHEMA_VERSION = '1.0.0';
const EPS = 1e-6;

function logWarn(code, message, detail = {}) {
  const line = JSON.stringify({
    level: 'warn',
    code: String(code || 'unknown'),
    message: String(message || ''),
    ...detail,
  });
  process.stderr.write(`${line}\n`);
}

function safeReadJson(absPath) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return { ok: false, data: null, warning: 'missing_file' };
    const raw = fs.readFileSync(absPath, 'utf8');
    return { ok: true, data: JSON.parse(raw), warning: null };
  } catch (e) {
    return {
      ok: false,
      data: null,
      warning: String(e && e.message ? e.message : e),
    };
  }
}

function normalizeId(v) {
  if (v == null) return '';
  return String(v).trim();
}

function setupKeyFromParts(setupId, strategyId) {
  const s = normalizeId(setupId);
  if (s) return s;
  return normalizeId(strategyId) || '';
}

function keyPrefix(key) {
  const k = normalizeId(key).toLowerCase();
  if (k.startsWith('mut_')) return 'mut_';
  if (k.startsWith('familyexp_')) return 'familyexp_';
  if (k.startsWith('example_')) return 'example_';
  return 'other';
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}

function tanhApprox(x) {
  const t = Math.tanh(x);
  return Number.isFinite(t) ? t : 0;
}

function buildEmptyFeedback(generatedAt) {
  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    generatedAt,
    changes: {
      boostedSetups: 0,
      downweightedSetups: 0,
    },
    topActions: [],
    dominantRejectReason: null,
    explanations: [],
  };
}

function summarizeMutationLearningResult(result) {
  if (!result || typeof result !== 'object') {
    return {
      skipped: true,
      reason: 'empty_result',
      tradeCount: 0,
      multipliersSnapshot: {},
      artifactApplied: false,
    };
  }
  const mult = result.multipliers && typeof result.multipliers === 'object' ? result.multipliers : {};
  const snap = {};
  for (const k of Object.keys(mult)) {
    if (typeof mult[k] === 'number' && Number.isFinite(mult[k])) snap[k] = mult[k];
  }
  return {
    skipped: result.skipped === true,
    reason: result.reason != null ? String(result.reason) : null,
    tradeCount:
      result.tradeCount != null && Number.isFinite(Number(result.tradeCount))
        ? Number(result.tradeCount)
        : 0,
    multipliersSnapshot: snap,
    artifactApplied: false,
  };
}

function aggregatePaperTrades(trades) {
  const bySetup = new Map();
  if (!Array.isArray(trades)) return bySetup;
  for (const t of trades) {
    if (!t || typeof t !== 'object') continue;
    const key = setupKeyFromParts(t.setupId, t.strategyId);
    if (!key) continue;
    const pnl = Number(t.pnl);
    const p = Number.isFinite(pnl) ? pnl : 0;
    if (!bySetup.has(key)) {
      bySetup.set(key, { n: 0, netR: 0, wins: 0, losses: 0 });
    }
    const agg = bySetup.get(key);
    agg.n += 1;
    agg.netR += p;
    if (p > 0) agg.wins += 1;
    else if (p < 0) agg.losses += 1;
  }
  return bySetup;
}

function collectPromotedSetupKeys(promotedJson) {
  const keys = new Set();
  const rows = promotedJson && Array.isArray(promotedJson.strategies) ? promotedJson.strategies : [];
  for (const r of rows) {
    const k = setupKeyFromParts(r && r.setupId, r && r.strategyId);
    if (k) keys.add(k);
  }
  return keys;
}

function structuralFromAnalysisRow(row) {
  if (!row || typeof row !== 'object') return 0.5;
  const w7 = row.windows && row.windows.last_7d ? row.windows.last_7d : {};
  const wr = Number(w7.winRate);
  const pf = Number(w7.profitFactor);
  let s = 0.5;
  if (Number.isFinite(wr)) s += 0.25 * tanhApprox((wr - 50) / 25);
  if (Number.isFinite(pf) && pf > 0) s += 0.15 * tanhApprox(Math.log(pf + 1e-9));
  return clamp01(s);
}

function dominantRejectFromAnalysis(analysisData) {
  try {
    const sm = analysisData && analysisData.strictMappingReport;
    if (!sm || typeof sm !== 'object') return null;
    const jd = sm.joinDiagnostics;
    const npm = jd && Array.isArray(jd.no_plausible_match) ? jd.no_plausible_match : [];
    if (npm.length > 0) return 'no_plausible_match';
    const pns = Array.isArray(sm.promoted_not_seen_in_paper_last_7d)
      ? sm.promoted_not_seen_in_paper_last_7d
      : [];
    if (pns.length > 5) return 'promoted_not_seen_in_paper_last_7d';
  } catch {
    /* fail-soft */
  }
  return null;
}

function scoreSetup(n, netR) {
  const nSafe = Math.max(0, Number(n) || 0);
  const denom = 5 + nSafe;
  const paperScore = clamp01(0.5 + 0.5 * tanhApprox(netR / Math.max(1e-6, denom)) * Math.min(1, nSafe / 10));
  const stability = Math.min(1, nSafe / 20);
  const structuralScore = 0.5;
  const confidenceScore = clamp01(0.5 * paperScore + 0.3 * structuralScore + 0.2 * stability);
  return { paperScore, structuralScore, confidenceScore };
}

function deriveActions(n, netR, confidenceScore, structuralScore) {
  const nSafe = Math.max(0, Number(n) || 0);
  const reasons = [];
  let generationWeightMultiplier = 1;
  let promotionWeightMultiplier = 1;
  let mutationRadiusMultiplier = 1;
  let isSoftBlocked = false;

  if (nSafe >= 5 && confidenceScore >= 0.65 && netR > 0) {
    generationWeightMultiplier = 1.1;
    promotionWeightMultiplier = 1.05;
    reasons.push('paper_positive_confident');
  } else if (nSafe >= 5 && confidenceScore <= 0.4 && netR < 0) {
    generationWeightMultiplier = 0.9;
    promotionWeightMultiplier = 0.92;
    isSoftBlocked = true;
    reasons.push('paper_negative_confident_soft_block');
  } else if (nSafe >= 3 && netR < 0 && confidenceScore < 0.45) {
    generationWeightMultiplier = 0.95;
    promotionWeightMultiplier = 0.96;
    reasons.push('paper_negative_mild');
  } else {
    reasons.push('neutral_phase1_placeholder');
  }

  if (structuralScore > 0.62) {
    promotionWeightMultiplier = Math.min(1.08, promotionWeightMultiplier * 1.02);
    reasons.push('structural_support');
  } else if (structuralScore < 0.38) {
    generationWeightMultiplier = Math.max(0.92, generationWeightMultiplier * 0.98);
    reasons.push('structural_headwind');
  }

  return {
    generationWeightMultiplier: Math.round(generationWeightMultiplier * 1000) / 1000,
    promotionWeightMultiplier: Math.round(promotionWeightMultiplier * 1000) / 1000,
    mutationRadiusMultiplier: Math.round(mutationRadiusMultiplier * 1000) / 1000,
    isSoftBlocked,
    reasons,
  };
}

function buildFamilyAggregates(bySetupOut) {
  const fam = {};
  const buckets = {};
  for (const [setupKey, row] of Object.entries(bySetupOut)) {
    const pref = keyPrefix(setupKey);
    if (!buckets[pref]) {
      buckets[pref] = { n: 0, netR: 0, paperSum: 0, structSum: 0, confSum: 0, count: 0 };
    }
    const b = buckets[pref];
    b.n += row.tradeCount || 0;
    b.netR += row.netR || 0;
    b.paperSum += row.paperScore || 0;
    b.structSum += row.structuralScore || 0;
    b.confSum += row.confidenceScore || 0;
    b.count += 1;
  }
  for (const [pref, b] of Object.entries(buckets)) {
    const denom = Math.max(1, b.count);
    const paperScore = clamp01(b.paperSum / denom);
    const structuralScore = clamp01(b.structSum / denom);
    const confidenceScore = clamp01(b.confSum / denom);
    const netR = b.netR;
    const actions = deriveActions(b.n, netR, confidenceScore, structuralScore);
    fam[pref] = {
      paperScore,
      structuralScore,
      confidenceScore,
      tradeCount: b.n,
      netR: Math.round(netR * 1e6) / 1e6,
      actions: {
        generationBudgetMultiplier: actions.generationWeightMultiplier,
        generationWeightMultiplier: actions.generationWeightMultiplier,
        promotionWeightMultiplier: actions.promotionWeightMultiplier,
        mutationRadiusMultiplier: actions.mutationRadiusMultiplier,
      },
      reasons: [`family_aggregate:${pref}`],
    };
  }
  return fam;
}

function compareWithPrevious(prevState, nextBySetup, generatedAt) {
  const feedback = buildEmptyFeedback(generatedAt);
  const prevBy = prevState && prevState.bySetup && typeof prevState.bySetup === 'object' ? prevState.bySetup : {};
  let boosted = 0;
  let down = 0;
  const deltas = [];

  for (const [key, row] of Object.entries(nextBySetup)) {
    const nextG =
      row.actions && typeof row.actions.generationWeightMultiplier === 'number'
        ? row.actions.generationWeightMultiplier
        : 1;
    const prevRow = prevBy[key];
    const prevG =
      prevRow && prevRow.actions && typeof prevRow.actions.generationWeightMultiplier === 'number'
        ? prevRow.actions.generationWeightMultiplier
        : null;
    if (prevG == null) continue;
    if (nextG > prevG + EPS) {
      boosted += 1;
      deltas.push({ setupKey: key, delta: nextG - prevG, kind: 'boost' });
    } else if (nextG < prevG - EPS) {
      down += 1;
      deltas.push({ setupKey: key, delta: prevG - nextG, kind: 'downweight' });
    }
  }

  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  feedback.changes.boostedSetups = boosted;
  feedback.changes.downweightedSetups = down;
  feedback.topActions = deltas.slice(0, 10).map((d) => ({
    setupKey: d.setupKey,
    kind: d.kind,
    delta: Math.round(d.delta * 1000) / 1000,
  }));
  return feedback;
}

function main() {
  const generatedAt = new Date().toISOString();
  const root = dataRoot.getDataRoot();
  const governanceDir = path.join(root, 'governance');
  const discoveryDir = path.join(root, 'discovery');
  const generatedDir = path.join(root, 'generated_strategies');

  try {
    fs.mkdirSync(governanceDir, { recursive: true });
  } catch (e) {
    logWarn('governance_mkdir', String(e && e.message ? e.message : e), { governanceDir });
  }

  const outState = path.join(governanceDir, 'learning_state.json');
  const outFeedback = path.join(governanceDir, 'learning_feedback_summary.json');

  const paperPath = path.join(governanceDir, 'paper_trades.jsonl');
  const promotedPath = path.join(discoveryDir, 'promoted_children.json');
  const analysisPath = path.join(governanceDir, 'paper_trades_by_setup_analysis.json');
  const mutationArtifactPath = path.join(discoveryDir, 'mutation_paper_learning.json');

  const shell = emptyLearningStateShell(generatedAt);
  shell.generatedAt = generatedAt;
  shell.schemaVersion = LEARNING_STATE_SCHEMA_VERSION;

  const warnings = [];

  /** @type {typeof shell.inputs} */
  const inputs = {
    paperTrades: {
      path: paperPath,
      used: false,
      warning: null,
    },
    promotedChildren: {
      path: promotedPath,
      used: false,
      warning: null,
    },
    paperTradesBySetupAnalysis: {
      path: analysisPath,
      used: false,
      warning: null,
    },
    mutationLearning: {
      path: mutationArtifactPath,
      used: false,
      warning: null,
    },
  };

  let paperTrades = [];
  if (fs.existsSync(paperPath)) {
    inputs.paperTrades.used = true;
    try {
      const raw = fs.readFileSync(paperPath, 'utf8');
      const parsed = parsePaperTradesJsonlContent(raw);
      paperTrades = Array.isArray(parsed.trades) ? parsed.trades : [];
      if (parsed.parseErrors && parsed.parseErrors.length) {
        const w = `paper_trades_parse_errors:${parsed.parseErrors.length}`;
        warnings.push(w);
        logWarn('paper_trades_parse', w, { path: paperPath, lineCount: parsed.lineCount });
      }
    } catch (e) {
      inputs.paperTrades.warning = String(e && e.message ? e.message : e);
      warnings.push(`paper_trades_read:${inputs.paperTrades.warning}`);
      logWarn('paper_trades_read', inputs.paperTrades.warning, { path: paperPath });
    }
  } else {
    inputs.paperTrades.warning = 'missing_file';
    logWarn('paper_trades_missing', 'paper_trades.jsonl not found', { path: paperPath });
  }

  let promotedJson = null;
  if (fs.existsSync(promotedPath)) {
    inputs.promotedChildren.used = true;
    const pr = safeReadJson(promotedPath);
    if (pr.ok && pr.data) promotedJson = pr.data;
    else {
      inputs.promotedChildren.warning = pr.warning || 'invalid_json';
      warnings.push(`promoted_children:${inputs.promotedChildren.warning}`);
      logWarn('promoted_children_invalid', inputs.promotedChildren.warning, { path: promotedPath });
    }
  } else {
    inputs.promotedChildren.warning = 'missing_file';
    logWarn('promoted_children_missing', 'promoted_children.json not found', { path: promotedPath });
  }

  let analysisData = null;
  if (fs.existsSync(analysisPath)) {
    inputs.paperTradesBySetupAnalysis.used = true;
    const ar = safeReadJson(analysisPath);
    if (ar.ok && ar.data) analysisData = ar.data;
    else {
      inputs.paperTradesBySetupAnalysis.warning = ar.warning || 'invalid_json';
      warnings.push(`analysis:${inputs.paperTradesBySetupAnalysis.warning}`);
      logWarn('analysis_invalid', inputs.paperTradesBySetupAnalysis.warning, { path: analysisPath });
    }
  } else {
    inputs.paperTradesBySetupAnalysis.warning = 'missing_file';
  }

  let mutationArtifact = null;
  if (fs.existsSync(mutationArtifactPath)) {
    inputs.mutationLearning.used = true;
    const mr = safeReadJson(mutationArtifactPath);
    if (mr.ok && mr.data) mutationArtifact = mr.data;
    else {
      inputs.mutationLearning.warning = mr.warning || 'invalid_json';
      warnings.push(`mutation_artifact:${inputs.mutationLearning.warning}`);
      logWarn('mutation_artifact_invalid', inputs.mutationLearning.warning, {
        path: mutationArtifactPath,
      });
    }
  } else {
    inputs.mutationLearning.warning = 'missing_file';
  }

  shell.inputs = inputs;

  const paperAgg = aggregatePaperTrades(paperTrades);
  const promotedKeys = collectPromotedSetupKeys(promotedJson);

  const allKeys = new Set([...paperAgg.keys(), ...promotedKeys]);

  const bySetupOut = {};
  for (const key of allKeys) {
    const agg = paperAgg.get(key) || { n: 0, netR: 0, wins: 0, losses: 0 };
    const base = scoreSetup(agg.n, agg.netR);
    let paperScore = base.paperScore;
    let structuralScore = base.structuralScore;
    let confidenceScore = base.confidenceScore;

    const act = deriveActions(agg.n, agg.netR, confidenceScore, structuralScore);
    bySetupOut[key] = {
      paperScore,
      structuralScore,
      confidenceScore,
      tradeCount: agg.n,
      netR: Math.round(agg.netR * 1e6) / 1e6,
      winRate: agg.n > 0 ? Math.round((100 * agg.wins) / agg.n * 10000) / 10000 : null,
      actions: {
        generationWeightMultiplier: act.generationWeightMultiplier,
        promotionWeightMultiplier: act.promotionWeightMultiplier,
        mutationRadiusMultiplier: act.mutationRadiusMultiplier,
        isSoftBlocked: act.isSoftBlocked,
      },
      reasons: Array.isArray(act.reasons) ? act.reasons.slice() : [],
    };
  }

  const analysisRows = analysisData && Array.isArray(analysisData.setupRows) ? analysisData.setupRows : [];

  for (const [k, v] of Object.entries(bySetupOut)) {
    const agg = paperAgg.get(k) || { n: 0, netR: 0 };
    const ar = analysisRows.find((r) => r && r.setupKey === k);
    if (ar) {
      v.structuralScore = structuralFromAnalysisRow(ar);
      v.confidenceScore = clamp01(
        0.45 * v.paperScore + 0.35 * v.structuralScore + 0.2 * Math.min(1, (agg.n || 0) / 20)
      );
      const act = deriveActions(agg.n, agg.netR, v.confidenceScore, v.structuralScore);
      v.actions = {
        generationWeightMultiplier: act.generationWeightMultiplier,
        promotionWeightMultiplier: act.promotionWeightMultiplier,
        mutationRadiusMultiplier: act.mutationRadiusMultiplier,
        isSoftBlocked: act.isSoftBlocked,
      };
      v.reasons = Array.isArray(act.reasons) ? act.reasons.slice() : [];
    }
  }

  let mlComputed;
  try {
    mlComputed = computePaperMutationLearning({
      dataRoot: root,
      governanceDir,
      generatedDir,
    });
  } catch (e) {
    logWarn('compute_paper_mutation_learning_throw', String(e && e.message ? e.message : e), {});
    mlComputed = {
      skipped: true,
      reason: 'compute_threw',
      tradeCount: 0,
      multipliers: {},
      stats: { mappedTrades: 0 },
    };
  }

  const mlSummary = summarizeMutationLearningResult(mlComputed);
  if (mutationArtifact && typeof mutationArtifact === 'object' && mutationArtifact.applied === true) {
    mlSummary.artifactApplied = true;
  } else {
    mlSummary.artifactApplied = false;
  }

  const dominantReject = dominantRejectFromAnalysis(analysisData);

  shell.globalPolicies = {
    dominantRejectReason: dominantReject,
    mutationLearningComputed: mlSummary,
    mutationLearningArtifactSummary: mutationArtifact
      ? {
          applied: mutationArtifact.applied === true,
          skipped: mutationArtifact.skipped === true,
          reason: mutationArtifact.reason != null ? String(mutationArtifact.reason) : null,
        }
      : null,
    actionBias: mlSummary.skipped ? 'mutation_learning_unavailable' : 'mutation_learning_computed',
  };

  shell.bySetup = bySetupOut;
  shell.byFamily = buildFamilyAggregates(bySetupOut);

  let boosted = 0;
  let downweighted = 0;
  let softBlocked = 0;
  for (const row of Object.values(bySetupOut)) {
    const g = row.actions && row.actions.generationWeightMultiplier;
    const p = row.actions && row.actions.promotionWeightMultiplier;
    if (typeof g === 'number' && g > 1 + EPS) boosted += 1;
    if (typeof g === 'number' && g < 1 - EPS) downweighted += 1;
    if (row.actions && row.actions.isSoftBlocked) softBlocked += 1;
  }

  let famBoost = 0;
  let famCut = 0;
  for (const row of Object.values(shell.byFamily)) {
    const m =
      row.actions && typeof row.actions.generationBudgetMultiplier === 'number'
        ? row.actions.generationBudgetMultiplier
        : 1;
    if (m > 1 + EPS) famBoost += 1;
    if (m < 1 - EPS) famCut += 1;
  }

  shell.summary = {
    setupsBoosted: boosted,
    setupsDownweighted: downweighted,
    softBlockedSetups: softBlocked,
    familiesBoosted: famBoost,
    familiesCut: famCut,
  };

  shell.warnings = warnings;
  shell.window = {
    paperLookbackDays: 30,
    rejectLookbackRuns: 20,
    minTradesPerSetup: 3,
    note: 'Phase 1 — window fields are placeholders for future anchoring',
  };

  let prevState = null;
  try {
    if (fs.existsSync(outState)) {
      prevState = JSON.parse(fs.readFileSync(outState, 'utf8'));
    }
  } catch (e) {
    logWarn('previous_learning_state_unreadable', String(e && e.message ? e.message : e), {
      path: outState,
    });
  }

  const feedback = compareWithPrevious(prevState, bySetupOut, generatedAt);
  feedback.generatedAt = generatedAt;
  feedback.schemaVersion = FEEDBACK_SCHEMA_VERSION;
  feedback.dominantRejectReason = dominantReject;
  feedback.explanations = [
    'Phase 1 build: multipliers are observational; engines are not wired to this file yet.',
    `mutation_learning_computed_skipped=${Boolean(mlSummary.skipped)}`,
  ];
  if (warnings.length) feedback.explanations.push(`warnings_count=${warnings.length}`);

  try {
    fs.writeFileSync(outState, JSON.stringify(shell, null, 2), 'utf8');
    fs.writeFileSync(outFeedback, JSON.stringify(feedback, null, 2), 'utf8');
    process.stdout.write(
      JSON.stringify({
        ok: true,
        generatedAt,
        wrote: { learning_state: outState, learning_feedback_summary: outFeedback },
        dataRoot: root,
      }) + '\n'
    );
  } catch (e) {
    logWarn('write_failed', String(e && e.message ? e.message : e), {});
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { buildLearningState: main };
