'use strict';

const fs = require('fs').promises;
const path = require('path');
const liveExecutionGate = require('./liveExecutionGate');
const paperTradingService = require('./paperTradingService');
const policyApplicationService = require('./policyApplicationService');
const capitalAllocationService = require('./capitalAllocationService');
const correlationOverlapService = require('./correlationOverlapService');

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getLatestPath() {
  return path.join(getDataDir(), 'autonomous_entry_latest.json');
}

function getHistoryPath() {
  return path.join(getDataDir(), 'autonomous_entry_history.jsonl');
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function parseCoordinatorEnv() {
  return {
    symbolCooldownSec: parseInt(process.env.AUTO_ENTRY_SYMBOL_COOLDOWN_SECONDS || '600', 10),
    strategySymbolCooldownSec: parseInt(
      process.env.AUTO_ENTRY_STRATEGY_SYMBOL_COOLDOWN_SECONDS || '900',
      10
    ),
    maxPosTotal: parseInt(process.env.AUTO_ENTRY_MAX_POSITIONS_TOTAL || '3', 10),
    maxPosPerSymbol: parseInt(process.env.AUTO_ENTRY_MAX_POSITIONS_PER_SYMBOL || '1', 10),
    maxEntriesPerSymbolPerHour: parseInt(
      process.env.AUTO_ENTRY_MAX_ENTRIES_PER_SYMBOL_PER_HOUR || '2',
      10
    ),
    riskPct: parseFloat(process.env.AUTO_ENTRY_DEFAULT_RISK_PCT || '0.005'),
    maxExposurePct: parseFloat(process.env.AUTO_ENTRY_MAX_EXPOSURE_PCT || '0.04'),
    minNotional: parseFloat(process.env.AUTO_ENTRY_MIN_NOTIONAL || '10'),
    maxNotional: parseFloat(process.env.AUTO_ENTRY_MAX_NOTIONAL || '120'),
    qtyStep: parseFloat(process.env.AUTO_ENTRY_QUANTITY_STEP || '0.001'),
    historyMaxRead: parseInt(process.env.AUTO_ENTRY_HISTORY_MAX_READ || '5000', 10),
  };
}

function strategyNameForCandidate(candidate) {
  const t = String(candidate?.setupType || '').toLowerCase();
  if (t === 'breakout_continuation') return 'auto-breakout-v1';
  if (t === 'trend_pullback') return 'auto-pullback-v1';
  return 'auto-unknown-v1';
}

function quantize(v, step) {
  const s = Number(step) > 0 ? Number(step) : 0.001;
  return Math.floor((Number(v) || 0) / s) * s;
}

function parseISOms(s) {
  const t = Date.parse(String(s || ''));
  return Number.isFinite(t) ? t : null;
}

async function saveLatestAutonomousEntry(record) {
  try {
    const file = getLatestPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn(`[auto-entry] save latest failed: ${e.message}`);
    return false;
  }
}

async function appendAutonomousEntryHistory(record) {
  try {
    const file = getHistoryPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch (e) {
    console.warn(`[auto-entry] append history failed: ${e.message}`);
    return false;
  }
}

async function readAutonomousEntryHistory(limit = 100) {
  const E = parseCoordinatorEnv();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), E.historyMaxRead);
  try {
    const text = await fs.readFile(getHistoryPath(), 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < lim; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch (e) {
        /* skip corrupt */
      }
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    return [];
  }
}

async function loadLatestAutonomousEntry() {
  try {
    const raw = await fs.readFile(getLatestPath(), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return null;
  }
}

function latestPolicyContextForCandidate(policyState, candidate) {
  const entities = Array.isArray(policyState?.entities) ? policyState.entities : [];
  const symbol = String(candidate.symbol || '').toUpperCase();
  const strategy = strategyNameForCandidate(candidate);
  const sym = entities.find((e) => e.entityType === 'symbol' && String(e.entityKey).toUpperCase() === symbol);
  const strat = entities.find((e) => e.entityType === 'strategy' && String(e.entityKey) === strategy);
  const global = policyState?.globalPolicy || {};
  return { symbolEntity: sym || null, strategyEntity: strat || null, global };
}

function overlapContextForCandidate(overlapState, candidate) {
  const symbol = String(candidate.symbol || '').toUpperCase();
  const strat = strategyNameForCandidate(candidate);
  const idx = correlationOverlapService.buildEntityCrowdingIndex(overlapState || {});
  const sy = idx.get(`symbol|${symbol}`) || {};
  const st = idx.get(`strategy|${strat}`) || {};
  const top = overlapState?.crowdingDiagnostics?.topCrowdedClusters || [];
  const crowded = top.find((c) => (c.clusterKey || '').includes(symbol) || (c.clusterKey || '').includes(strat));
  return {
    totalCrowdingScore: overlapState?.crowdingDiagnostics?.totalCrowdingScore ?? 0,
    symbolOverlapScore: sy.overlapScore || 0,
    strategyOverlapScore: st.overlapScore || 0,
    symbolCrowdingScore: sy.crowdingScore || 0,
    strategyCrowdingScore: st.crowdingScore || 0,
    crowdedCluster: crowded ? crowded.clusterKey : null,
    warnings: overlapState?.warnings || [],
  };
}

function allocationContextForCandidate(allocationPlan, candidate) {
  const symbol = String(candidate.symbol || '').toUpperCase();
  const strat = strategyNameForCandidate(candidate);
  const sr = (allocationPlan?.symbolAllocations || []).find((r) => String(r.symbol || '').toUpperCase() === symbol);
  const tr = (allocationPlan?.strategyAllocations || []).find((r) => String(r.strategy || '') === strat);
  return {
    deployableCapital: allocationPlan?.portfolio?.recommendedDeployableCapital ?? null,
    symbolWeight: sr?.weight ?? null,
    strategyWeight: tr?.weight ?? null,
    symbolRecommendedCapital: sr?.recommendedCapital ?? null,
    strategyRecommendedCapital: tr?.recommendedCapital ?? null,
  };
}

function computeSizing(candidate, accountSummary, allocationContext, overlapContext) {
  const E = parseCoordinatorEnv();
  const equity =
    Number(accountSummary?.equity) ||
    Number(accountSummary?.bookEquity) ||
    Number(accountSummary?.balance) ||
    0;
  const px = Number(candidate.entryReferencePrice) || 0;
  if (!(equity > 0 && px > 0)) return { quantity: 0, notional: 0 };

  const stop = Number(candidate.stopLoss);
  const stopDist = Number.isFinite(stop) ? Math.abs(px - stop) : px * 0.004;
  const riskBudget = equity * E.riskPct;
  const qtyByRisk = stopDist > 0 ? riskBudget / stopDist : 0;
  const notionalCap = equity * E.maxExposurePct;

  let notional = Math.max(E.minNotional, Math.min(notionalCap, E.maxNotional));
  if (allocationContext?.symbolRecommendedCapital != null) {
    notional = Math.min(notional, Number(allocationContext.symbolRecommendedCapital) || notional);
  }
  const crowd = Number(overlapContext?.totalCrowdingScore) || 0;
  const crowdMul = clamp(1 - crowd * 0.6, 0.3, 1);
  notional *= crowdMul;

  let qty = Math.min(qtyByRisk > 0 ? qtyByRisk : notional / px, notional / px);
  qty = quantize(qty, E.qtyStep);
  if (!(qty > 0)) return { quantity: 0, notional: 0 };
  return { quantity: round4(qty), notional: round4(qty * px) };
}

function getOpenPositionContext(candidate, accountSummary) {
  const symbol = String(candidate.symbol || '').toUpperCase();
  const positions = Array.isArray(accountSummary?.positions) ? accountSummary.positions : [];
  const sameSymbol = positions.filter((p) => String(p.symbol || '').toUpperCase() === symbol);
  const autonomousOpen = positions.filter((p) => p.autonomousTag === true);
  return {
    sameSymbolOpenCount: sameSymbol.length,
    autonomousOpenCount: autonomousOpen.length,
    openPositionsTotal: positions.length,
    sameSymbol,
  };
}

async function getCooldownContext(candidate, nowIso) {
  const E = parseCoordinatorEnv();
  const nowMs = parseISOms(nowIso) || Date.now();
  const history = await readAutonomousEntryHistory(500);
  const symbol = String(candidate.symbol || '').toUpperCase();
  const strategy = strategyNameForCandidate(candidate);
  const oneHourAgo = nowMs - 60 * 60 * 1000;
  const symHits = history.filter((h) => {
    if (h?.symbol !== symbol) return false;
    const t = parseISOms(h.generatedAt);
    return t != null && t >= oneHourAgo && h.executed === true;
  });
  const lastSym = history.find((h) => h?.symbol === symbol && h.executed === true);
  const lastStratSym = history.find(
    (h) => h?.symbol === symbol && h.strategy === strategy && h.executed === true
  );
  const dSymSec = lastSym ? (nowMs - parseISOms(lastSym.generatedAt)) / 1000 : Number.POSITIVE_INFINITY;
  const dStratSec = lastStratSym
    ? (nowMs - parseISOms(lastStratSym.generatedAt)) / 1000
    : Number.POSITIVE_INFINITY;
  return {
    entriesLastHourSymbol: symHits.length,
    symbolCooldownActive: dSymSec < E.symbolCooldownSec,
    strategySymbolCooldownActive: dStratSec < E.strategySymbolCooldownSec,
  };
}

async function buildGovernanceDecision(candidate, scored, deps = {}) {
  const nowIso = new Date().toISOString();
  const reasons = [];
  const warnings = [];
  const E = parseCoordinatorEnv();
  const policyState = deps.policyState || (await policyApplicationService.loadPolicyState());
  const allocationPlan =
    deps.allocationPlan || (await capitalAllocationService.loadLatestAllocationPlan());
  const overlapState =
    deps.overlapState || (await correlationOverlapService.loadLatestCorrelationOverlapState());
  const accountSummary = deps.accountSummary || paperTradingService.getAccountSummary();

  const policyCtx = latestPolicyContextForCandidate(policyState, candidate);
  const allocCtx = allocationContextForCandidate(allocationPlan, candidate);
  const ovCtx = overlapContextForCandidate(overlapState, candidate);
  const openCtx = getOpenPositionContext(candidate, accountSummary);
  const cooldownCtx = await getCooldownContext(candidate, nowIso);

  let governanceDecision = 'allow';
  if (String(candidate.side || 'BUY').toUpperCase() !== 'BUY') {
    governanceDecision = 'reject';
    reasons.push('long_only_paper_autonomous_v1');
  }
  if (!scored?.eligiblePreGovernance) {
    governanceDecision = 'reject';
    reasons.push('failed_pre_governance_score');
  }
  const mode = String(policyCtx.global?.portfolioRiskMode || 'normal').toLowerCase();
  if (mode === 'defensive' || mode === 'degraded') {
    governanceDecision = 'reject';
    reasons.push(`policy_mode_${mode}`);
  } else if (mode === 'restricted' || mode === 'cautious') {
    warnings.push(`policy_mode_${mode}`);
  }

  if (policyCtx.symbolEntity && policyCtx.symbolEntity.eligible === false) {
    governanceDecision = 'reject';
    reasons.push('policy_symbol_ineligible');
  }
  if (policyCtx.strategyEntity && policyCtx.strategyEntity.eligible === false) {
    governanceDecision = 'reject';
    reasons.push('policy_strategy_ineligible');
  }

  if ((ovCtx.totalCrowdingScore || 0) >= parseFloat(process.env.CROWDING_SEVERE_THRESHOLD || '0.72')) {
    governanceDecision = 'reject';
    reasons.push('severe_crowding');
  } else if ((ovCtx.totalCrowdingScore || 0) >= parseFloat(process.env.CROWDING_HIGH_THRESHOLD || '0.55')) {
    warnings.push('high_crowding');
  }

  if (openCtx.sameSymbolOpenCount >= E.maxPosPerSymbol) {
    governanceDecision = 'reject';
    reasons.push('same_symbol_position_exists');
  }
  if (openCtx.autonomousOpenCount >= E.maxPosTotal) {
    governanceDecision = 'reject';
    reasons.push('max_autonomous_positions_reached');
  }
  if (cooldownCtx.symbolCooldownActive) {
    governanceDecision = 'reject';
    reasons.push('symbol_cooldown_active');
  }
  if (cooldownCtx.strategySymbolCooldownActive) {
    governanceDecision = 'reject';
    reasons.push('strategy_symbol_cooldown_active');
  }
  if (cooldownCtx.entriesLastHourSymbol >= E.maxEntriesPerSymbolPerHour) {
    governanceDecision = 'reject';
    reasons.push('entries_per_symbol_per_hour_limit');
  }

  const sizing = computeSizing(candidate, accountSummary, allocCtx, ovCtx);
  if (!(sizing.quantity > 0 && sizing.notional >= E.minNotional)) {
    governanceDecision = 'reject';
    reasons.push('invalid_sizing');
  }

  const finalDecision = governanceDecision === 'allow' ? 'allow' : 'reject';
  const finalReason = reasons[0] || 'allowed';
  const strategy = strategyNameForCandidate(candidate);
  const orderIntent =
    finalDecision === 'allow'
      ? buildOrderIntentFromCandidate(candidate, sizing, {
          strategy,
          score: scored?.score,
          overlap: ovCtx,
        })
      : null;

  return {
    candidateId: candidate.candidateId,
    symbol: candidate.symbol,
    strategy,
    setupType: candidate.setupType,
    side: candidate.side,
    preGovernanceScore: scored?.score ?? null,
    governanceDecision,
    finalDecision,
    finalReason,
    policyDecision: {
      globalMode: mode,
      symbolDecision: policyCtx.symbolEntity?.decision || null,
      strategyDecision: policyCtx.strategyEntity?.decision || null,
    },
    allocationContext: allocCtx,
    overlapContext: ovCtx,
    openPositionContext: openCtx,
    cooldownContext: cooldownCtx,
    recommendedQuantity: sizing.quantity,
    recommendedNotional: sizing.notional,
    recommendedStopLoss: candidate.stopLoss,
    recommendedTakeProfit: candidate.takeProfit,
    reasons,
    warnings,
    metadata: {
      source: 'autonomous_entry_engine',
      generatedAt: nowIso,
    },
    orderIntent,
  };
}

function buildOrderIntentFromCandidate(candidate, sizing, context = {}) {
  const strategy = context.strategy || strategyNameForCandidate(candidate);
  const score = context.score ?? null;
  return {
    symbol: String(candidate.symbol || '').toUpperCase(),
    action: String(candidate.side || 'BUY').toUpperCase(),
    quantity: sizing.quantity,
    price: round4(candidate.entryReferencePrice),
    stopLoss: round4(candidate.stopLoss),
    takeProfit: round4(candidate.takeProfit),
    confidence: score != null ? round4(clamp(Number(score), 0, 1)) : null,
    strategy,
    regime: candidate.regime || null,
    actionSource: 'autonomous_entry_engine',
    metadata: {
      source: 'autonomous_entry_engine',
      setupType: candidate.setupType,
      score,
      sessionTag: candidate.features?.sessionTag || null,
      hourUTC: candidate.features?.hourUTC ?? null,
      overlapSummary: context.overlap || null,
      candidateId: candidate.candidateId,
    },
    autonomousTag: true,
    autonomousCandidateId: candidate.candidateId,
    autonomousSetupType: candidate.setupType,
    maxHoldingMinutes: candidate.expectedHoldingClass === 'short_to_medium'
      ? parseInt(process.env.AUTO_EXIT_DEFAULT_MAX_HOLD_MINUTES || '90', 10)
      : parseInt(process.env.AUTO_EXIT_DEFAULT_MAX_HOLD_MINUTES || '90', 10),
  };
}

async function submitAutonomousPaperOrder(orderIntent, deps = {}) {
  const gate = deps.liveExecutionGate || liveExecutionGate;
  if (String(gate.getTradingMode ? gate.getTradingMode() : 'paper').toLowerCase() !== 'paper') {
    return { ok: false, reason: 'autonomous_engine_paper_only' };
  }
  const accountBalance =
    deps.accountBalance ||
    Number(paperTradingService.getAccountSummary()?.equity) ||
    Number(process.env.ACCOUNT_BALANCE || '500');
  const result = await gate.executeOrder(orderIntent, { accountBalance });
  if (!result.success) return { ok: false, reason: result.reason || 'execution_rejected', result };
  return { ok: true, result };
}

async function runAutonomousEntryCycle(input = {}, deps = {}) {
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const scoredMap = new Map((input.scoredCandidates || []).map((s) => [s.candidateId, s]));
  const records = [];

  for (const c of candidates) {
    const scored = scoredMap.get(c.candidateId) || null;
    const decision = await buildGovernanceDecision(c, scored, deps);
    let execution = null;
    let executed = false;
    if (decision.finalDecision === 'allow' && decision.orderIntent) {
      try {
        execution = await submitAutonomousPaperOrder(decision.orderIntent, deps);
        executed = execution.ok === true;
      } catch (e) {
        execution = { ok: false, reason: e.message };
      }
    }
    const record = {
      generatedAt: new Date().toISOString(),
      candidateId: c.candidateId,
      symbol: c.symbol,
      strategy: decision.strategy,
      setupType: c.setupType,
      score: scored?.score ?? null,
      confidence: scored?.confidence ?? null,
      finalDecision: decision.finalDecision,
      finalReason: executed ? 'executed' : decision.finalReason,
      executed,
      executionResult: execution || null,
      decision,
      source: 'autonomous_entry_engine',
    };
    await saveLatestAutonomousEntry(record);
    await appendAutonomousEntryHistory(record);
    records.push(record);
  }

  return {
    generatedAt: new Date().toISOString(),
    candidatesSeen: candidates.length,
    candidatesAccepted: records.filter((r) => r.finalDecision === 'allow').length,
    candidatesRejected: records.filter((r) => r.finalDecision !== 'allow').length,
    entriesExecuted: records.filter((r) => r.executed).length,
    records,
  };
}

async function getAutonomousRejections(limit = 100) {
  const rows = await readAutonomousEntryHistory(limit);
  return rows.filter((r) => r.finalDecision !== 'allow' || r.executed !== true);
}

module.exports = {
  parseCoordinatorEnv,
  strategyNameForCandidate,
  saveLatestAutonomousEntry,
  appendAutonomousEntryHistory,
  readAutonomousEntryHistory,
  loadLatestAutonomousEntry,
  latestPolicyContextForCandidate,
  allocationContextForCandidate,
  overlapContextForCandidate,
  computeSizing,
  buildOrderIntentFromCandidate,
  buildGovernanceDecision,
  submitAutonomousPaperOrder,
  runAutonomousEntryCycle,
  getAutonomousRejections,
};
