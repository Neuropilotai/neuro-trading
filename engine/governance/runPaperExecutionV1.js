#!/usr/bin/env node
'use strict';

/**
 * Paper Execution V1 — append simulated trades to governance/paper_trades.jsonl
 *
 * Enable: NEUROPILOT_PAPER_EXEC_V1=1 (or true/yes/on, case-insensitive)
 *         OR NEUROPILOT_WAVE1_PAPER_SCALE_MODE=1 (same opt-in — throughput / pipeline scale)
 * Input:  <dataRoot>/governance/paper_execution_v1_signals.json  (optional)
 * Output: <dataRoot>/governance/paper_trades.jsonl (append-only)
 * Each appended line includes simulatedAt (wall-clock ISO when the run wrote the line); entryTs/exitTs remain bar times from the dataset.
 *
 * Wave 1 desk policy (optional): NEUROPILOT_WAVE1_PAPER_ENABLED=1 + NEUROPILOT_WAVE1_SYMBOLS
 * — for those symbols only: strategyId must be in NEUROPILOT_EXECUTION_STRATEGY_WHITELIST
 *   (default ORB_breakout_v1,EMA_pullback_v2), and daily caps via wave1PaperCaps.js.
 *
 * If flag OFF: exits 0 immediately (no file reads, no writes).
 * If flag ON and signals file missing: logs to stderr, exits 0 (non-blocking pipeline).
 *
 * Per-run bar throttle (default ON): at most one simulated trade per
 * strategyId|symbol|timeframe|barIndex within a single run. Disable with
 * NEUROPILOT_PAPER_EXEC_BAR_THROTTLE=0.
 *
 * Persistent throttle (default ON): governance/paper_exec_seen_keys.json
 * records datasetKey|strategyId|symbol|timeframe|barIndex (datasetKey or "na")
 * so repeats across runs do not append duplicate trades. Disable with
 * NEUROPILOT_PAPER_EXEC_PERSISTENT_THROTTLE=0.
 *
 * governance/paper_exec_v1_last_run.json — last run counters for dashboard/metrics.
 * Observability (dashboard): tier1Count, tier2Count (strict allowlist sizes), promotedManifestPersistentDupAttempts,
 * promotedManifestBypassGranted (alias of promotedReplayBypassCount), appendZeroPrimaryReason (when effectiveAppended===0).
 *
 * Optional opts (callers only — default live paths unchanged):
 *   opts.outJsonl, opts.seenKeysStorePath, opts.lastRunPath — override governance outputs (use separate files for shadow lane).
 *   opts.shadowRenewalLane — when true, refuses live default paths for trades/seen_keys/last_run (safety).
 *   opts.laneName — tag appended JSONL lines with lane + signalLane (required for shadow renewal; default tag shadow_renewal).
 * Shadow renewal does not feed official metrics; use runPaperExecutionRenewalShadowV1.js + NP_SHADOW_RENEWAL_LANE_ENABLE=1.
 * Trade JSONL lines include additive source-audit fields (signalSource, barIndex, datasetKey, setupId, shadowInjection, …)
 * copied from the in-memory signal at write time — for jq / desk traceability; does not change execution outcomes.
 *
 * Promoted replay bypass (persistent duplicate only, paper-only, opt-in):
 *   NEUROPILOT_PAPER_ALLOW_PROMOTED_REPLAY=1
 * Optional smart allowlist from governance/paper_trades_strict_mapping_report.json (+ tier2 manifest/signals):
 *   NEUROPILOT_PAPER_PROMOTED_REPLAY_SMART_ONLY=1
 *   NEUROPILOT_PAPER_PROMOTED_REPLAY_REQUIRE_NOT_SEEN_7D=1  (tier1 only)
 * Optional scored allowlist: NP_SMART_ALLOWLIST_V2=1 — ranking + budget-aware selection (still SMART_ONLY=1).
 *   NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_SETUPS_PER_RUN (default 5)
 *   NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_BARS_PER_SETUP (default 3)
 * Optional replay_boost_policy.json as score modulator (bounded, not authoritative):
 *   NP_SMART_REPLAY_POLICY_INTEGRATION_ENABLE=1 (default off) — fuse policy tiers into smart replay score.
 *   NP_SMART_REPLAY_POLICY_BOOSTED_BONUS, NEUTRAL_BONUS, THROTTLED_PENALTY, FROZEN_PENALTY,
 *   NP_SMART_REPLAY_POLICY_CONFIDENCE_WEIGHT, NP_SMART_REPLAY_POLICY_STRICT_GUARD_ENABLE,
 *   NP_SMART_REPLAY_POLICY_DROP_FROZEN_STRICT, NP_SMART_REPLAY_POLICY_STRICT_GUARD_FLOOR
 * Auto-throttle (governance/auto_throttle_policy.json): NP_AUTO_THROTTLE_ENABLE=1 (default off)
 *   + buildAutoThrottlePolicy.js / run_auto_throttle_policy_loop.sh. Modulates smart replay score + per-setup bars.
 * Capital allocation (governance/capital_allocation_policy.json): NP_CAPITAL_ALLOCATION_ENABLE=1 (default off)
 *   + buildCapitalAllocationPolicy.js / run_capital_allocation_policy_loop.sh. Fused smart score + merged per-setup bar caps + optional global replay factor.
 *
 * After a successful promoted persistent bypass, optional market-tail alignment (replay only):
 *   NEUROPILOT_PAPER_PROMOTED_RECENT_MARKET_ALIGN=1 (default on) — re-point barIndex to the latest
 *   safe entry index in the same dataset so exitTs/ts can fall in the rolling market 7d window.
 *
 * Replay boost (paper-only, opt-in): NEUROPILOT_PAPER_REPLAY_BOOST_ENABLE=1
 * — requires promoted replay bypass ON; reorders promoted_manifest signals by priority tier/score,
 *   assigns per-setup max replay bars from governance/replay_boost_priority.json inputs (see replayBoostPolicy.js).
 * Optional file policy (supervisor / desk quant): NP_REPLAY_BOOST_POLICY_ENABLE=1 (default) reads
 *   governance/replay_boost_policy.json (see buildReplayBoostPolicy.js + replayBoostPolicyCore.js).
 *   Optional: NEUROPILOT_PAPER_REPLAY_BOOST_MAX_TIER_A, NEUROPILOT_PAPER_REPLAY_BOOST_MAX_TIER_B,
 *   NEUROPILOT_PAPER_REPLAY_BOOST_MIN_TRADES_FOR_PF_MALUS, NEUROPILOT_PAPER_REPLAY_BOOST_REQUIRE_PROMOTED=1
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const { readBinaryStoreSync } = require('../datasetBinaryStore');
const riskEngine = require('../execution/executionRiskEngine');
const wave1PaperCaps = require('./wave1PaperCaps');
const {
  simulatePaperTradeV1,
  PAPER_EXECUTION_V1_DEFAULT_R_MULTIPLE,
} = require('./paperExecutionV1Simulator');
const replayBoostPolicy = require('./replayBoostPolicy');
const replayBoostPolicyCore = require('./replayBoostPolicyCore');
const capitalAllocationPolicyCore = require('./capitalAllocationPolicyCore');
const smartReplayAllowlistV2 = require('./smartReplayAllowlistV2');
const { PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE } = require('./renewalShadowConstants');

const PAPER_EXEC_SEEN_KEYS_FILENAME = 'paper_exec_seen_keys.json';
const PAPER_EXEC_LAST_RUN_FILENAME = 'paper_exec_v1_last_run.json';
const PAPER_EXEC_SEEN_KEYS_SCHEMA_VERSION = 1;
const PAPER_EXEC_LAST_RUN_SCHEMA_VERSION = 1;

function envBoolOptIn(name) {
  const v = (process.env[name] || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function isPaperExecV1Enabled() {
  return envBoolOptIn('NEUROPILOT_PAPER_EXEC_V1') || envBoolOptIn('NEUROPILOT_WAVE1_PAPER_SCALE_MODE');
}

/** promoted_manifest + shadow renewal inject source — bypass / identity / replay bookkeeping. */
function isPromotedManifestLikeSignalSource(src) {
  const s = String(src || '').trim();
  return s === 'promoted_manifest' || s === PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE;
}

/**
 * @param {object} opts
 * @returns {object}
 */
function renewalShadowInjectionLastRunSlice(opts) {
  if (!opts || !opts.shadowRenewalLane) return {};
  const rep = opts.renewalShadowInjectionReport;
  if (!rep) {
    return {
      renewalInjectionEnabled: false,
      renewalInjectionCandidateCount: 0,
      renewalInjectionSignalsAdded: 0,
      renewalInjectionKeysSkippedAlreadySeen: 0,
      renewalInjectionSkippedNoValidBar: 0,
      renewalInjectionSkippedInvalidManifest: 0,
      renewalInjectionShadowSignalsPath: null,
    };
  }
  return {
    renewalInjectionEnabled: true,
    renewalInjectionCandidateCount: rep.candidateCount,
    renewalInjectionSignalsAdded: rep.signalsAdded,
    renewalInjectionKeysSkippedAlreadySeen: rep.keysSkippedAlreadySeen,
    renewalInjectionSkippedNoValidBar: rep.skippedNoValidBar,
    renewalInjectionSkippedInvalidManifest: rep.skippedInvalidManifest,
    renewalInjectionShadowSignalsPath: rep.shadowSignalsPath || null,
  };
}

function paperExecBarThrottleEnabled() {
  const v = (process.env.NEUROPILOT_PAPER_EXEC_BAR_THROTTLE || '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}

/** @param {{ strategyId?: string, setupId?: string, symbol?: string, timeframe?: string, barIndex?: number }} sig */
function paperExecBarThrottleKey(sig) {
  const sid = String(sig.strategyId || sig.setupId || '').trim();
  const sym = String(sig.symbol || '').toUpperCase().trim();
  const tf = String(sig.timeframe || '').trim();
  const bi = Number(sig.barIndex);
  const barPart = Number.isFinite(bi) ? String(Math.floor(bi)) : 'na';
  return `${sid}|${sym}|${tf}|${barPart}`;
}

function paperExecPersistentThrottleEnabled() {
  const v = (process.env.NEUROPILOT_PAPER_EXEC_PERSISTENT_THROTTLE || '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}

function paperExecPromotedReplayBypassEnabled() {
  const v = (process.env.NEUROPILOT_PAPER_ALLOW_PROMOTED_REPLAY || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function paperExecPromotedReplayMaxPerRun() {
  const raw = process.env.NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_PER_RUN;
  if (raw == null || String(raw).trim() === '') return 20;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

function paperExecPromotedReplaySmartOnlyEnabled() {
  const v = (process.env.NEUROPILOT_PAPER_PROMOTED_REPLAY_SMART_ONLY || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function paperExecPromotedReplayRequireNotSeen7dEnabled() {
  const v = (process.env.NEUROPILOT_PAPER_PROMOTED_REPLAY_REQUIRE_NOT_SEEN_7D || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function paperExecPromotedReplayMaxSetupsPerRun() {
  const raw = process.env.NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_SETUPS_PER_RUN;
  if (raw == null || String(raw).trim() === '') return 5;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

function paperExecPromotedReplayMaxBarsPerSetup() {
  const raw = process.env.NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_BARS_PER_SETUP;
  if (raw == null || String(raw).trim() === '') return 3;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

/** Default on: align promoted replay to dataset tail so market timestamps are recent (strict mapping 7d). */
function paperExecPromotedRecentMarketAlignEnabled() {
  const v = (process.env.NEUROPILOT_PAPER_PROMOTED_RECENT_MARKET_ALIGN || '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}

/**
 * Latest safe entry bar index (same symbol/timeframe dataset). Leaves ≥1 bar after entry for exit path.
 * @param {{ barIndex?: number }} signal
 * @param {object[]} candles
 * @returns {number|null}
 */
function resolveRecentBarIndexForSignal(signal, candles) {
  const n = Array.isArray(candles) ? candles.length : 0;
  const raw = signal && signal.barIndex;
  const orig = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : null;
  if (n < 2) return orig;
  return Math.max(0, n - 2);
}

/**
 * Read-only allowlist: tier1 = promoted_not_seen_in_paper_last_7d (strict mapping report);
 * tier2 = promoted_manifest ∩ promoted_manifest signals, not in promoted_and_paper_recent.
 * Fail-soft on missing/invalid files.
 */
function loadPromotedReplaySmartAllowlist(dataRoot) {
  const govDir = path.join(dataRoot, 'governance');
  const strictPath = path.join(govDir, 'paper_trades_strict_mapping_report.json');
  const discDir = path.join(dataRoot, 'discovery');
  const manifestPath = path.join(discDir, 'promoted_manifest.json');
  const signalsPath = path.join(govDir, 'paper_execution_v1_signals.json');

  const empty = () => ({
    enabledSource: false,
    selectedSetupKeys: new Set(),
    selectedReasonBySetupKey: new Map(),
    sourceSummary: {
      strictMappingPresent: false,
      promotedNotSeen7dCount: 0,
      promotedAndPaperRecentCount: 0,
      tier2Count: 0,
    },
  });

  try {
    if (!fs.existsSync(strictPath)) return empty();
    const strict = readJsonSafe(strictPath);
    if (!strict || typeof strict !== 'object') return empty();

    const out = empty();
    out.sourceSummary.strictMappingPresent = true;

    const tier1 = Array.isArray(strict.promoted_not_seen_in_paper_last_7d)
      ? strict.promoted_not_seen_in_paper_last_7d
      : [];
    const recentOverlap = Array.isArray(strict.promoted_and_paper_recent)
      ? strict.promoted_and_paper_recent
      : [];

    out.sourceSummary.promotedNotSeen7dCount = tier1.length;
    out.sourceSummary.promotedAndPaperRecentCount = recentOverlap.length;

    const recentKeys = new Set(
      recentOverlap
        .map((r) => (r && r.setupKey ? String(r.setupKey).trim() : ''))
        .filter(Boolean)
    );

    for (const row of tier1) {
      const setupKey = row && typeof row.setupKey === 'string' ? row.setupKey.trim() : '';
      if (!setupKey) continue;
      out.selectedSetupKeys.add(setupKey);
      out.selectedReasonBySetupKey.set(setupKey, 'promoted_not_seen_in_paper_last_7d');
    }

    const manifest = readJsonSafe(manifestPath);
    const signalsDoc = readJsonSafe(signalsPath);
    const manifestKeys = new Set(
      (Array.isArray(manifest && manifest.items) ? manifest.items : [])
        .map((x) => String((x && x.setupId) || (x && x.strategyId) || '').trim())
        .filter(Boolean)
    );
    const signalRows = Array.isArray(signalsDoc && signalsDoc.signals) ? signalsDoc.signals : [];
    const tier2Candidates = new Set();
    for (const s of signalRows) {
      if (!s || s.signalSource !== 'promoted_manifest') continue;
      const k = String(s.setupId || s.strategyId || '').trim();
      if (!k || !manifestKeys.has(k)) continue;
      if (recentKeys.has(k)) continue;
      if (out.selectedReasonBySetupKey.has(k)) continue;
      tier2Candidates.add(k);
    }
    for (const k of Array.from(tier2Candidates).sort()) {
      out.selectedSetupKeys.add(k);
      out.selectedReasonBySetupKey.set(k, 'tier2_manifest_signals_not_in_recent_paper');
    }
    out.sourceSummary.tier2Count = tier2Candidates.size;

    out.enabledSource = out.selectedSetupKeys.size > 0;
    return out;
  } catch {
    return empty();
  }
}

function getReplaySetupKey(signal) {
  if (!signal || typeof signal !== 'object') return '';
  return String(signal.setupId || signal.strategyId || '').trim();
}

function promotedReplayBarsUsedForSetup(setupKey, barsBySetup) {
  return Number(barsBySetup.get(setupKey) || 0);
}

function shouldBypassPersistentThrottleForPromotedSignal({
  signal,
  pkey,
  bypassedPersistentKeysThisRun,
  persistentDuplicate,
  promotedReplayBypassOn,
  promotedReplayBypassCount,
  promotedReplayMaxPerRun,
  smartOnlyOn,
  requireNotSeen7dOn,
  smartAllowlist,
  maxSetupsPerRun,
  maxBarsPerSetup,
  promotedReplayUsedSetups,
  promotedReplayBarsBySetup,
  getMaxBarsForSetup,
}) {
  if (!persistentDuplicate) {
    return { ok: false, reason: 'not_persistent_duplicate' };
  }
  if (bypassedPersistentKeysThisRun.has(pkey)) {
    return { ok: false, reason: 'pkey_already_bypassed_this_run' };
  }
  if (!promotedReplayBypassOn) {
    return { ok: false, reason: 'bypass_disabled' };
  }
  if (!signal || !isPromotedManifestLikeSignalSource(signal.signalSource)) {
    return { ok: false, reason: 'not_promoted_manifest' };
  }
  if (promotedReplayBypassCount >= promotedReplayMaxPerRun) {
    return { ok: false, reason: 'budget_exhausted' };
  }

  const setupKey = getReplaySetupKey(signal);
  if (!setupKey) {
    return { ok: false, reason: 'missing_setup_key' };
  }

  if (smartOnlyOn) {
    if (
      requireNotSeen7dOn &&
      smartAllowlist &&
      smartAllowlist.tier1KeysFor7d &&
      !smartAllowlist.tier1KeysFor7d.has(setupKey)
    ) {
      return { ok: false, reason: 'not_required_not_seen_7d', setupKey };
    }
    if (!smartAllowlist || !smartAllowlist.selectedSetupKeys.has(setupKey)) {
      if (smartAllowlist && smartAllowlist.v2Meta) {
        const sc = smartAllowlist.v2Meta.scoreBySetup.get(setupKey);
        const cl = smartAllowlist.v2Meta.classBySetup.get(setupKey);
        return {
          ok: false,
          reason: 'smart_v2_not_selected',
          setupKey,
          smartReplayScore: sc,
          smartReplayClass: cl,
        };
      }
      return { ok: false, reason: 'not_in_smart_allowlist', setupKey };
    }
    if (requireNotSeen7dOn && !(smartAllowlist && smartAllowlist.v2Meta)) {
      const allowReason = smartAllowlist.selectedReasonBySetupKey.get(setupKey);
      if (allowReason !== 'promoted_not_seen_in_paper_last_7d') {
        return { ok: false, reason: 'not_required_not_seen_7d', setupKey };
      }
    }
  }

  const setupsUsed = promotedReplayUsedSetups.size;
  const setupAlreadyUsed = promotedReplayUsedSetups.has(setupKey);
  if (!setupAlreadyUsed && setupsUsed >= maxSetupsPerRun) {
    return { ok: false, reason: 'setup_budget_exhausted', setupKey };
  }

  const barsUsed = promotedReplayBarsUsedForSetup(setupKey, promotedReplayBarsBySetup);
  const barCap =
    typeof getMaxBarsForSetup === 'function' ? getMaxBarsForSetup(setupKey) : maxBarsPerSetup;
  const cap = Math.max(0, Math.floor(Number(barCap) || 0));
  if (cap <= 0) {
    return { ok: false, reason: 'bars_per_setup_exhausted', setupKey };
  }
  if (barsUsed >= cap) {
    return { ok: false, reason: 'bars_per_setup_exhausted', setupKey };
  }

  return {
    ok: true,
    reason: smartOnlyOn ? 'smart_promoted_replay' : 'promoted_replay',
    setupKey,
    allowReason: smartAllowlist && smartAllowlist.selectedReasonBySetupKey
      ? smartAllowlist.selectedReasonBySetupKey.get(setupKey) || null
      : null,
  };
}

/** datasetKey|strategyId|symbol|timeframe|barIndex (datasetKey trimmed or "na") */
function paperExecPersistentThrottleKey(sig) {
  const dk = sig.datasetKey != null ? String(sig.datasetKey).trim() : '';
  const base = paperExecBarThrottleKey(sig);
  return `${dk || 'na'}|${base}`;
}

function loadSeenKeysStore(seenPath) {
  const raw = readJsonSafe(seenPath);
  if (!raw || typeof raw !== 'object') {
    return { schemaVersion: PAPER_EXEC_SEEN_KEYS_SCHEMA_VERSION, updatedAt: null, keys: {} };
  }
  const keys =
    raw.keys && typeof raw.keys === 'object' && !Array.isArray(raw.keys) ? { ...raw.keys } : {};
  return {
    schemaVersion: PAPER_EXEC_SEEN_KEYS_SCHEMA_VERSION,
    updatedAt: raw.updatedAt || null,
    keys,
  };
}

function saveSeenKeysStore(seenPath, store) {
  const out = {
    schemaVersion: PAPER_EXEC_SEEN_KEYS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    keys: store.keys || {},
  };
  fs.mkdirSync(path.dirname(seenPath), { recursive: true });
  fs.writeFileSync(seenPath, JSON.stringify(out, null, 2), 'utf8');
}

function writePaperExecLastRun(lastRunFilePath, body) {
  fs.mkdirSync(path.dirname(lastRunFilePath), { recursive: true });
  fs.writeFileSync(lastRunFilePath, JSON.stringify(body, null, 2), 'utf8');
}

/** @param {object} opts */
function shadowLaneLastRunFields(opts) {
  if (!opts || !opts.shadowRenewalLane) return {};
  const laneName = String(opts.laneName || '').trim() || 'shadow_renewal';
  return { laneName, shadowMode: true, shadowRenewalLane: true };
}

/** @param {object} opts */
function effectiveTradeLaneTag(opts) {
  if (!opts) return '';
  if (opts.shadowRenewalLane) {
    return String(opts.laneName || '').trim() || 'shadow_renewal';
  }
  return String(opts.laneName || '').trim();
}

/**
 * Additive fields for JSONL audit: values come from the normalized signal in flight (after bar align), not recomputed.
 * @param {object} sig
 * @param {object} [_opts]
 * @returns {object}
 */
function buildPaperTradeSourceAuditFields(sig, _opts) {
  if (!sig || typeof sig !== 'object') return {};
  const out = {};
  const src = sig.signalSource != null ? String(sig.signalSource).trim() : '';
  if (src) out.signalSource = src;
  const bi = Number(sig.barIndex);
  if (Number.isFinite(bi)) out.barIndex = Math.floor(bi);
  const dk = sig.datasetKey != null ? String(sig.datasetKey).trim() : '';
  if (dk) out.datasetKey = dk;
  const su = sig.setupId != null ? String(sig.setupId).trim() : '';
  const st = sig.strategyId != null ? String(sig.strategyId).trim() : '';
  if (su) out.setupId = su;
  else if (st) out.setupId = st;

  const dir = sig.direction != null ? String(sig.direction).trim().toLowerCase() : '';
  if (dir === 'long' || dir === 'short') out.signalDirection = dir;

  if (sig.signalTs != null) {
    out.signalTs =
      typeof sig.signalTs === 'number' && Number.isFinite(sig.signalTs)
        ? sig.signalTs
        : String(sig.signalTs);
  } else if (sig.signalTimestamp != null) {
    out.signalTs =
      typeof sig.signalTimestamp === 'number' && Number.isFinite(sig.signalTimestamp)
        ? sig.signalTimestamp
        : String(sig.signalTimestamp);
  }

  const sb = sig.signalBuildId != null ? String(sig.signalBuildId).trim() : '';
  if (sb) out.signalBuildId = sb;
  else if (sig.buildId != null && String(sig.buildId).trim() !== '') {
    out.signalBuildId = String(sig.buildId).trim();
  }

  if (sig.shadowInjection === true) {
    out.shadowInjection = true;
    if (sig.shadowInjectionType != null && String(sig.shadowInjectionType).trim() !== '') {
      out.shadowInjectionType = String(sig.shadowInjectionType).trim();
    }
    if (sig.shadowInjectionBuildId != null && String(sig.shadowInjectionBuildId).trim() !== '') {
      out.shadowInjectionBuildId = String(sig.shadowInjectionBuildId).trim();
    }
    if (sig.shadowInjectionReason != null && String(sig.shadowInjectionReason).trim() !== '') {
      out.shadowInjectionReason = String(sig.shadowInjectionReason).trim();
    }
  } else {
    out.shadowInjection = false;
  }

  const rv = sig.renewalSignalSourceVersion;
  if (rv != null && (typeof rv === 'number' ? Number.isFinite(rv) : String(rv).trim() !== '')) {
    out.renewalSignalSourceVersion = typeof rv === 'number' ? rv : String(rv).trim();
  }

  return out;
}

/**
 * Shadow lane only: trade-outcome counters for last_run (renewalShadowTradesWritten === effectiveAppended for this lane).
 * @param {object} opts
 * @param {number} appended
 * @param {number} injectedCount
 * @param {number} baseCount
 */
function renewalShadowTradeOutcomeLastRunSlice(opts, appended, injectedCount, baseCount) {
  if (!opts || !opts.shadowRenewalLane) return {};
  const a = Math.max(0, Math.floor(Number(appended) || 0));
  const inj = Math.max(0, Math.floor(Number(injectedCount) || 0));
  const base = Math.max(0, Math.floor(Number(baseCount) || 0));
  return {
    renewalShadowTradesWritten: a,
    renewalShadowInjectedTradesWritten: inj,
    renewalShadowBaseTradesWritten: base,
  };
}

/**
 * Refuse shadow mode writing to live governance artefacts (foot-gun guard).
 * @param {string} govDir
 * @param {object} opts
 * @param {string} outJsonl
 * @param {string} seenKeysStorePath
 * @param {string} lastRunPath
 */
function assertShadowRenewalPathsIsolated(govDir, opts, outJsonl, seenKeysStorePath, lastRunPath) {
  if (!opts || !opts.shadowRenewalLane) return;
  // Shadow lane must use dedicated *renewal_shadow* paths — never wire these into live aggregation readers.
  const liveTrades = path.join(govDir, 'paper_trades.jsonl');
  const liveSeen = path.join(govDir, PAPER_EXEC_SEEN_KEYS_FILENAME);
  const liveLast = path.join(govDir, PAPER_EXEC_LAST_RUN_FILENAME);
  const r = path.resolve;
  if (r(outJsonl) === r(liveTrades)) {
    throw new Error('[paper_exec_v1] shadowRenewalLane: outJsonl must not be live paper_trades.jsonl');
  }
  if (r(seenKeysStorePath) === r(liveSeen)) {
    throw new Error('[paper_exec_v1] shadowRenewalLane: seenKeysStorePath must not be live paper_exec_seen_keys.json');
  }
  if (r(lastRunPath) === r(liveLast)) {
    throw new Error('[paper_exec_v1] shadowRenewalLane: lastRunPath must not be live paper_exec_v1_last_run.json');
  }
}

/**
 * Deterministic, read-only label when effectiveAppended === 0 (dashboard / jq only; does not drive behavior).
 * Priority matches ops runbook: no_signals → V2+frozen → V2+circuit → converged tiers + persistent dup →
 * promoted dup attempts without bypass → generic persistent dup → bar-only dup → fallback.
 * @param {object} p
 * @returns {string|null}
 */
function computeAppendZeroPrimaryReason(p) {
  const appended = Number(p.appended) || 0;
  if (appended > 0) return null;
  const signalsLen = Math.max(0, Math.floor(Number(p.signalsLen) || 0));
  const skipped = p.skipped != null ? String(p.skipped) : '';
  if (skipped === 'signals array empty' || signalsLen === 0) return 'no_signals';

  const persistentOn = Boolean(p.persistentOn);
  const smartOnlyOn = Boolean(p.smartOnlyOn);
  const promotedReplayBypassOn = Boolean(p.promotedReplayBypassOn);
  const dupP = Math.max(0, Math.floor(Number(p.duplicateSkippedPersistent) || 0));
  const dupRun = Math.max(0, Math.floor(Number(p.duplicateSkippedRun) || 0));
  const bypassCount = Math.max(0, Math.floor(Number(p.promotedReplayBypassCount) || 0));
  const pmAttempts = Math.max(0, Math.floor(Number(p.promotedManifestPersistentDupAttempts) || 0));

  const src = p.sourceSummary && typeof p.sourceSummary === 'object' ? p.sourceSummary : {};
  const t1 = Math.max(0, Math.floor(Number(src.promotedNotSeen7dCount) || 0));
  const t2 = Math.max(0, Math.floor(Number(src.tier2Count) || 0));

  const v2Ran = p.smartReplayV2Stats != null && typeof p.smartReplayV2Stats === 'object';
  const stats = v2Ran ? p.smartReplayV2Stats : {};
  const v2c = stats.candidates != null ? Math.floor(Number(stats.candidates)) : null;

  const obs = p.smartReplayObservability && typeof p.smartReplayObservability === 'object'
    ? p.smartReplayObservability
    : {};
  const frozenEx =
    obs.smartReplayFrozenExcludedStrict != null
      ? Math.floor(Number(obs.smartReplayFrozenExcludedStrict))
      : null;
  const circuit = obs.smartReplayCircuitState != null ? String(obs.smartReplayCircuitState).trim() : '';

  // 2) V2 a tourné + 0 candidats + exclusions frozen strict (signal dominant desk audit)
  if (
    v2Ran &&
    smartOnlyOn &&
    promotedReplayBypassOn &&
    v2c === 0 &&
    frozenEx != null &&
    frozenEx > 0
  ) {
    return 'v2_zero_candidates_frozen_strict';
  }
  // 3) V2 + 0 candidats + circuit ouvert, sans signal frozen strict ci-dessus
  if (v2Ran && smartOnlyOn && promotedReplayBypassOn && v2c === 0 && circuit.toUpperCase() === 'OPEN') {
    return 'v2_zero_candidates_circuit_open';
  }
  // 4) Allowlist nouveauté vide + skips persistants
  if (t1 === 0 && t2 === 0 && dupP > 0) {
    return 'converged_allowlist_empty_persistent_dup';
  }
  // 5) Tentatives promoted_manifest sur clé persistante, aucun bypass accordé
  if (persistentOn && promotedReplayBypassOn && pmAttempts > 0 && bypassCount === 0) {
    return 'persistent_dup_no_bypass';
  }
  if (dupP > 0) return 'persistent_duplicate_skips';
  if (dupRun > 0 && dupP === 0) return 'bar_throttle_skips_only';
  return 'other_zero_append';
}

function replayBoostLastRunStub(envOn, bypassOn) {
  const armed = Boolean(envOn && bypassOn);
  return {
    replayBoostEnabled: armed,
    replayBoostPolicyVersion: null,
    replayBoostTopSetups: [],
    replayBoostTierCounts: null,
    replayBoostUsedBudgetByTier: null,
    replayBoostPolicyEnabled: false,
    replayBoostPolicyGeneratedAt: null,
    replayBoostPolicyMode: null,
    replayBoostBoostedSeen: 0,
    replayBoostBoostedUsed: 0,
    replayBoostFrozenSkipped: 0,
    replayBoostGlobalControlsApplied: null,
    replayBoostTopUsedSetups: [],
    replayBoostReasonHistogram: {},
    replayBoostFilePolicy: false,
  };
}

/**
 * V2 cycle bucket keys (computePaperTradesMetricsV2.cycleKeyFromTrade): from env only; null → _unknown_cycle in metrics.
 * cycleId = NEUROPILOT_CYCLE_ID || EXPERIMENT_ID; experimentId = EXPERIMENT_ID || cycleId.
 */
function resolvePaperExecCycleIds() {
  const cycleId = process.env.NEUROPILOT_CYCLE_ID || process.env.EXPERIMENT_ID || null;
  const experimentId = process.env.EXPERIMENT_ID || cycleId || null;
  return { cycleId, experimentId };
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function resolveBinPath(root, signal) {
  if (signal.binPath) {
    const raw = String(signal.binPath).trim();
    return path.isAbsolute(raw) ? raw : path.join(root, raw);
  }
  const key = signal.datasetKey != null ? String(signal.datasetKey).trim() : '';
  if (!key) return null;
  const manifestPath = path.join(root, 'datasets_manifest.json');
  const man = readJsonSafe(manifestPath);
  const ds = man && man.datasets && man.datasets[key];
  const bp = ds && ds.paths && ds.paths.bin ? String(ds.paths.bin).trim() : '';
  if (!bp) return null;
  return path.isAbsolute(bp) ? bp : path.join(root, bp);
}

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataRoot]
 * @param {string} [opts.signalsPath] - override path to signals JSON
 * @param {string} [opts.outJsonl] - override output jsonl path
 * @param {string} [opts.seenKeysStorePath] - override persistent throttle store (required isolated path for shadowRenewalLane)
 * @param {string} [opts.lastRunPath] - override last-run JSON path
 * @param {boolean} [opts.shadowRenewalLane] - shadow renewal lane; enforces non-live paths for out/seen/lastRun
 * @param {string} [opts.laneName] - tag each appended trade (lane + signalLane); default shadow_renewal when shadowRenewalLane
 * @param {object|null} [opts.renewalShadowInjectionReport] - optional stats from buildRenewalShadowInjectedSignals (shadow lane only)
 * @returns {{ enabled: boolean, skipped?: string, appended?: number, outPath?: string, duplicateSkippedRun?: number, duplicateSkippedPersistent?: number, seenKeysBefore?: number|null, seenKeysAfter?: number|null, seenKeysStorePath?: string|null, paperExecBarThrottleEnabled?: boolean, paperExecPersistentThrottleEnabled?: boolean }}
 */
function runPaperExecutionV1(opts = {}) {
  if (!isPaperExecV1Enabled()) {
    return {
      enabled: false,
      skipped: 'NEUROPILOT_PAPER_EXEC_V1 or NEUROPILOT_WAVE1_PAPER_SCALE_MODE not set',
    };
  }

  const root = opts.dataRoot || dataRoot.getDataRoot();
  const govDir = path.join(root, 'governance');
  fs.mkdirSync(govDir, { recursive: true });
  const signalsPath =
    opts.signalsPath || path.join(govDir, 'paper_execution_v1_signals.json');
  const outJsonl = opts.outJsonl || path.join(govDir, 'paper_trades.jsonl');
  const seenKeysStorePath =
    opts.seenKeysStorePath || path.join(govDir, PAPER_EXEC_SEEN_KEYS_FILENAME);
  const lastRunPath = opts.lastRunPath || path.join(govDir, PAPER_EXEC_LAST_RUN_FILENAME);

  assertShadowRenewalPathsIsolated(govDir, opts, outJsonl, seenKeysStorePath, lastRunPath);

  const throttleOn = paperExecBarThrottleEnabled();
  const persistentOn = paperExecPersistentThrottleEnabled();
  const promotedReplayBypassOn = paperExecPromotedReplayBypassEnabled();
  const promotedReplayMaxPerRun = paperExecPromotedReplayMaxPerRun();
  const smartOnlyOn = paperExecPromotedReplaySmartOnlyEnabled();
  const requireNotSeen7dOn = paperExecPromotedReplayRequireNotSeen7dEnabled();
  const maxSetupsPerRun = paperExecPromotedReplayMaxSetupsPerRun();
  const maxBarsPerSetup = paperExecPromotedReplayMaxBarsPerSetup();
  const smartAllowlistV1 = loadPromotedReplaySmartAllowlist(root);
  let smartAllowlist = smartAllowlistV1;
  /** @type {object|null} */
  let smartReplayV2Stats = null;
  /** @type {object|null} */
  let smartReplayObservability = null;
  const recentMarketAlignOn = paperExecPromotedRecentMarketAlignEnabled();
  const replayBoostEnvOn = envBoolOptIn('NEUROPILOT_PAPER_REPLAY_BOOST_ENABLE');
  const replayBoostOn = Boolean(replayBoostEnvOn && promotedReplayBypassOn);

  if (!fs.existsSync(signalsPath)) {
    return {
      enabled: true,
      skipped: `no signals file: ${signalsPath}`,
      outPath: outJsonl,
      lastRunPath,
      duplicateSkippedRun: 0,
      duplicateSkippedPersistent: 0,
      seenKeysBefore: null,
      seenKeysAfter: null,
      seenKeysStorePath,
      paperExecBarThrottleEnabled: throttleOn,
      paperExecPersistentThrottleEnabled: persistentOn,
      promotedReplayBypassEnabled: promotedReplayBypassOn,
      promotedReplayMaxPerRun,
      promotedReplayBypassCount: 0,
      promotedReplayBypassSample: [],
      promotedReplaySmartOnlyEnabled: smartOnlyOn,
      promotedReplayRequireNotSeen7dEnabled: requireNotSeen7dOn,
      promotedReplayMaxSetupsPerRun: maxSetupsPerRun,
      promotedReplayMaxBarsPerSetup: maxBarsPerSetup,
      promotedReplayEligibleSetupCount: smartAllowlist.selectedSetupKeys.size,
      promotedReplayEligibleSetupSample: Array.from(smartAllowlist.selectedSetupKeys).sort().slice(0, 10),
      promotedReplayUsedSetupCount: 0,
      promotedReplayUsedSetupSample: [],
      promotedReplayBarsBySetup: {},
      promotedReplayAllowlistSourceSummary: smartAllowlist.sourceSummary,
      promotedReplayBlockedReasons: null,
      promotedReplayRecentMarketAlignEnabled: recentMarketAlignOn,
      promotedReplayRecentAlignmentCount: 0,
      ...replayBoostLastRunStub(replayBoostEnvOn, promotedReplayBypassOn),
      ...renewalShadowInjectionLastRunSlice(opts),
    };
  }

  const doc = readJsonSafe(signalsPath);
  let signals = doc && Array.isArray(doc.signals) ? doc.signals : [];

  const replayBoostFilePolicyOn = !['0', 'false', 'no', 'off'].includes(
    String(process.env.NP_REPLAY_BOOST_POLICY_ENABLE || '1').trim().toLowerCase()
  );
  const smartReplayPolicyIntegrationOn = smartReplayAllowlistV2.smartReplayPolicyIntegrationEnabled();
  const policyPathGov = path.join(govDir, 'replay_boost_policy.json');
  let cachedReplayPolicyDoc = null;
  const needPolicyForSmart =
    smartOnlyOn &&
    smartReplayAllowlistV2.smartAllowlistV2Enabled() &&
    smartReplayPolicyIntegrationOn;
  const needPolicyForReplayBoost = replayBoostOn && replayBoostFilePolicyOn;
  if (needPolicyForSmart || needPolicyForReplayBoost) {
    cachedReplayPolicyDoc = replayBoostPolicyCore.loadReplayBoostPolicy(policyPathGov);
  }

  /** Merged caps from smart + replay_boost_policy globalControls (when integration on). */
  let v2MergedCaps = null;
  /** @type {Map<string, number>|null} */
  let v2ReplayBarsCapBySetup = null;
  let v2CapitalGlobalReplayFactor = null;
  if (smartOnlyOn && smartReplayAllowlistV2.smartAllowlistV2Enabled()) {
    let cachedCapitalAllocationDoc = null;
    if (smartReplayAllowlistV2.capitalAllocationPolicyIntegrationEnabled()) {
      cachedCapitalAllocationDoc = capitalAllocationPolicyCore.loadCapitalAllocationPolicy(
        path.join(govDir, 'capital_allocation_policy.json')
      );
    }
    const v2Sel = smartReplayAllowlistV2.buildSmartReplaySelectionV2({
      dataRoot: root,
      signals,
      maxSetupsPerRun,
      maxBarsPerSetup,
      promotedReplayMaxPerRun,
      requireNotSeen7d: requireNotSeen7dOn,
      policyDoc: cachedReplayPolicyDoc,
      policyIntegrationEnabled: smartReplayPolicyIntegrationOn,
      autoThrottleIntegrationEnabled: smartReplayAllowlistV2.autoThrottlePolicyIntegrationEnabled(),
      capitalAllocationIntegrationEnabled:
        smartReplayAllowlistV2.capitalAllocationPolicyIntegrationEnabled(),
      capitalAllocationDoc: cachedCapitalAllocationDoc,
    });
    smartReplayV2Stats = v2Sel.stats;
    smartReplayObservability = v2Sel.smartReplayObservability || null;
    v2MergedCaps = v2Sel.mergedGlobalCaps || null;
    v2CapitalGlobalReplayFactor =
      v2Sel.capitalAllocationGlobalReplayFactor != null &&
      Number.isFinite(v2Sel.capitalAllocationGlobalReplayFactor)
        ? v2Sel.capitalAllocationGlobalReplayFactor
        : null;
    const mergedBarCaps = v2Sel.replayBarsCapBySetup;
    if (mergedBarCaps && mergedBarCaps.size > 0) {
      v2ReplayBarsCapBySetup = mergedBarCaps;
    } else if (v2Sel.autoThrottleBarsBySetup && v2Sel.autoThrottleBarsBySetup.size > 0) {
      v2ReplayBarsCapBySetup = v2Sel.autoThrottleBarsBySetup;
    }
    for (const line of v2Sel.selectionLogLines || []) {
      console.error(`[paper_exec_v1] ${line}`);
    }
    smartAllowlist = {
      enabledSource: v2Sel.stats.candidates > 0,
      selectedSetupKeys: v2Sel.selectedSetupKeys,
      selectedReasonBySetupKey: v2Sel.selectedReasonBySetupKey,
      sourceSummary: {
        ...smartAllowlistV1.sourceSummary,
        smartAllowlistV2: true,
        smartReplayPolicyIntegrated: Boolean(
          smartReplayObservability && smartReplayObservability.smartReplayPolicyIntegrated
        ),
        v2Candidates: v2Sel.stats.candidates,
        v2Selected: v2Sel.stats.selected,
        v2Dropped: v2Sel.stats.dropped,
      },
      v2Meta: {
        scoreBySetup: v2Sel.scoreBySetup,
        classBySetup: v2Sel.classBySetup,
        stats: v2Sel.stats,
      },
      tier1KeysFor7d: requireNotSeen7dOn ? v2Sel.tier1Keys : null,
    };
    smartReplayAllowlistV2.writeSmartReplaySelectionSnapshot(v2Sel, {
      requireNotSeen7d: requireNotSeen7dOn,
      dataRoot: root,
    });
  }

  let replayBoostOpts = null;
  let replayBoostComputed = null;
  let replayBoostSetupMap = new Map();
  /** @type {((setupKey: string) => number) | null} */
  let getMaxBarsForSetupFn = null;
  const replayBoostBypassByTier = { A: 0, B: 0, C: 0, D: 0 };
  let useFileReplayPolicy = false;
  /** @type {{ generatedAt: string|null, policyMode: string|null, globalControls: object|null }|null} */
  let filePolicyMeta = null;
  let effectivePromotedReplayMaxPerRun = promotedReplayMaxPerRun;
  let effectiveMaxSetupsPerRun = maxSetupsPerRun;
  let effectiveMaxBarsPerSetupGlobal = maxBarsPerSetup;
  if (v2MergedCaps) {
    effectivePromotedReplayMaxPerRun = v2MergedCaps.recommendedMaxPerRun;
    effectiveMaxSetupsPerRun = v2MergedCaps.recommendedMaxSetupsPerRun;
    effectiveMaxBarsPerSetupGlobal = v2MergedCaps.recommendedMaxBarsPerSetup;
  }

  if (v2CapitalGlobalReplayFactor != null && Number.isFinite(v2CapitalGlobalReplayFactor)) {
    const f = Math.max(0.45, Math.min(1.12, v2CapitalGlobalReplayFactor));
    effectivePromotedReplayMaxPerRun = Math.max(1, Math.floor(effectivePromotedReplayMaxPerRun * f));
    effectiveMaxSetupsPerRun = Math.max(1, Math.floor(effectiveMaxSetupsPerRun * f));
    effectiveMaxBarsPerSetupGlobal = Math.max(0, Math.floor(effectiveMaxBarsPerSetupGlobal * f));
    console.error(`[paper_exec_v1] capital_allocation global_replay_factor_applied factor=${f}`);
  }

  if (replayBoostOn && signals.length > 0) {
    let filePolicyDoc = cachedReplayPolicyDoc;
    if (!filePolicyDoc && replayBoostFilePolicyOn) {
      filePolicyDoc = replayBoostPolicyCore.loadReplayBoostPolicy(policyPathGov);
    }
    if (filePolicyDoc) {
      useFileReplayPolicy = true;
      const policyExec = replayBoostPolicyCore.executionRowsFromPolicy(filePolicyDoc, {
        baseMaxBarsFromEnv: maxBarsPerSetup,
        promotedReplayMaxPerRunEnv: promotedReplayMaxPerRun,
        maxSetupsPerRunEnv: maxSetupsPerRun,
      });
      filePolicyMeta = {
        generatedAt: filePolicyDoc.generatedAt || null,
        policyMode: filePolicyDoc.policyMode || null,
        globalControls: policyExec.globalControls || null,
      };
      replayBoostSetupMap = policyExec.setupMap;
      const innerGetMax = policyExec.getMaxBarsForSetup;
      getMaxBarsForSetupFn = (setupKey) =>
        Math.min(effectiveMaxBarsPerSetupGlobal, innerGetMax(setupKey));
      effectivePromotedReplayMaxPerRun = Math.min(
        effectivePromotedReplayMaxPerRun,
        policyExec.effectiveMaxPerRun
      );
      effectiveMaxSetupsPerRun = Math.min(effectiveMaxSetupsPerRun, policyExec.effectiveMaxSetups);
      signals = replayBoostPolicy.orderSignalsForReplayBoostStable(signals, replayBoostSetupMap);
    } else {
      replayBoostOpts = {
        ...replayBoostPolicy.parseReplayBoostEnv(),
        baseMaxBarsFromEnv: maxBarsPerSetup,
      };
      const inputs = replayBoostPolicy.loadReplayBoostInputsFromRoot(root);
      replayBoostComputed = replayBoostPolicy.computeReplayBoostPriority(inputs, replayBoostOpts);
      replayBoostSetupMap = replayBoostPolicy.buildSetupMapFromComputed(replayBoostComputed);
      signals = replayBoostPolicy.orderSignalsForReplayBoostStable(signals, replayBoostSetupMap);
      getMaxBarsForSetupFn = (setupKey) => {
        const row = replayBoostSetupMap.get(setupKey);
        if (!row) return Math.min(effectiveMaxBarsPerSetupGlobal, maxBarsPerSetup);
        return Math.min(
          effectiveMaxBarsPerSetupGlobal,
          Math.max(0, Math.floor(Number(row.budgetAssigned) || 0))
        );
      };
    }
  }

  if (v2ReplayBarsCapBySetup && v2ReplayBarsCapBySetup.size > 0) {
    const barCapMap = v2ReplayBarsCapBySetup;
    if (typeof getMaxBarsForSetupFn === 'function') {
      const inner = getMaxBarsForSetupFn;
      getMaxBarsForSetupFn = (sk) => {
        const cap = barCapMap.get(sk);
        const b = inner(sk);
        return cap == null ? b : Math.min(b, cap);
      };
    } else {
      getMaxBarsForSetupFn = (sk) => {
        const cap = barCapMap.get(sk);
        return cap == null
          ? effectiveMaxBarsPerSetupGlobal
          : Math.min(effectiveMaxBarsPerSetupGlobal, cap);
      };
    }
    console.error(
      `[paper_exec_v1] smart_v2 per_setup_bar_caps_active setups=${barCapMap.size}`
    );
  }

  if (signals.length === 0) {
    const emptyStore = persistentOn ? loadSeenKeysStore(seenKeysStorePath) : null;
    const emptyKeyCount = emptyStore ? Object.keys(emptyStore.keys).length : null;
    const emptySs = smartAllowlist.sourceSummary && typeof smartAllowlist.sourceSummary === 'object'
      ? smartAllowlist.sourceSummary
      : {};
    const emptyTier1 = Math.max(0, Math.floor(Number(emptySs.promotedNotSeen7dCount) || 0));
    const emptyTier2 = Math.max(0, Math.floor(Number(emptySs.tier2Count) || 0));
    const emptyObsBody = {
      schemaVersion: PAPER_EXEC_LAST_RUN_SCHEMA_VERSION,
      writtenAt: new Date().toISOString(),
      skipped: 'signals array empty',
      effectiveAppended: 0,
      duplicateSkippedRun: 0,
      duplicateSkippedPersistent: 0,
      tier1Count: emptyTier1,
      tier2Count: emptyTier2,
      promotedManifestPersistentDupAttempts: 0,
      promotedManifestBypassGranted: 0,
      appendZeroPrimaryReason: computeAppendZeroPrimaryReason({
        appended: 0,
        signalsLen: 0,
        skipped: 'signals array empty',
        persistentOn,
        smartOnlyOn,
        promotedReplayBypassOn,
        duplicateSkippedPersistent: 0,
        duplicateSkippedRun: 0,
        promotedReplayBypassCount: 0,
        promotedManifestPersistentDupAttempts: 0,
        promotedReplayBlockedReasons: null,
        sourceSummary: emptySs,
        smartReplayV2Stats,
        smartReplayObservability,
      }),
      seenKeysBefore: emptyKeyCount,
      seenKeysAfter: emptyKeyCount,
      seenKeysStorePath,
      paperExecBarThrottleEnabled: throttleOn,
      paperExecPersistentThrottleEnabled: persistentOn,
      promotedReplayBypassEnabled: promotedReplayBypassOn,
      promotedReplayMaxPerRun,
      promotedReplayBypassCount: 0,
      promotedReplayBypassSample: [],
      promotedReplaySmartOnlyEnabled: smartOnlyOn,
      promotedReplayRequireNotSeen7dEnabled: requireNotSeen7dOn,
      promotedReplayMaxSetupsPerRun: maxSetupsPerRun,
      promotedReplayMaxBarsPerSetup: maxBarsPerSetup,
      promotedReplayEligibleSetupCount: smartAllowlist.selectedSetupKeys.size,
      promotedReplayEligibleSetupSample: Array.from(smartAllowlist.selectedSetupKeys).sort().slice(0, 10),
      promotedReplayUsedSetupCount: 0,
      promotedReplayUsedSetupSample: [],
      promotedReplayBarsBySetup: {},
      promotedReplayAllowlistSourceSummary: smartAllowlist.sourceSummary,
      promotedReplayBlockedReasons: null,
      promotedReplayRecentMarketAlignEnabled: recentMarketAlignOn,
      promotedReplayRecentAlignmentCount: 0,
      smartAllowlistV2Used: smartReplayV2Stats != null,
      smartReplaySelectionStats: smartReplayV2Stats,
      ...(smartReplayObservability || {
        smartReplayFrozenExcludedStrict: null,
        smartReplayCircuitState: null,
        smartReplayHealthOverall: null,
      }),
      ...replayBoostLastRunStub(replayBoostEnvOn, promotedReplayBypassOn),
      ...shadowLaneLastRunFields(opts),
      ...(opts.shadowRenewalLane ? { lastRunPath } : {}),
      ...renewalShadowInjectionLastRunSlice(opts),
      ...renewalShadowTradeOutcomeLastRunSlice(opts, 0, 0, 0),
    };
    writePaperExecLastRun(lastRunPath, emptyObsBody);
    return {
      enabled: true,
      skipped: 'signals array empty',
      appended: 0,
      outPath: outJsonl,
      lastRunPath,
      duplicateSkippedRun: 0,
      duplicateSkippedPersistent: 0,
      tier1Count: emptyTier1,
      tier2Count: emptyTier2,
      promotedManifestPersistentDupAttempts: 0,
      promotedManifestBypassGranted: 0,
      appendZeroPrimaryReason: emptyObsBody.appendZeroPrimaryReason,
      seenKeysBefore: emptyKeyCount,
      seenKeysAfter: emptyKeyCount,
      seenKeysStorePath,
      paperExecBarThrottleEnabled: throttleOn,
      paperExecPersistentThrottleEnabled: persistentOn,
      promotedReplayBypassEnabled: promotedReplayBypassOn,
      promotedReplayMaxPerRun,
      promotedReplayBypassCount: 0,
      promotedReplayBypassSample: [],
      promotedReplaySmartOnlyEnabled: smartOnlyOn,
      promotedReplayRequireNotSeen7dEnabled: requireNotSeen7dOn,
      promotedReplayMaxSetupsPerRun: maxSetupsPerRun,
      promotedReplayMaxBarsPerSetup: maxBarsPerSetup,
      promotedReplayEligibleSetupCount: smartAllowlist.selectedSetupKeys.size,
      promotedReplayEligibleSetupSample: Array.from(smartAllowlist.selectedSetupKeys).sort().slice(0, 10),
      promotedReplayUsedSetupCount: 0,
      promotedReplayUsedSetupSample: [],
      promotedReplayBarsBySetup: {},
      promotedReplayAllowlistSourceSummary: smartAllowlist.sourceSummary,
      promotedReplayBlockedReasons: null,
      promotedReplayRecentMarketAlignEnabled: recentMarketAlignOn,
      promotedReplayRecentAlignmentCount: 0,
      smartAllowlistV2Used: smartReplayV2Stats != null,
      smartReplaySelectionStats: smartReplayV2Stats,
      ...(smartReplayObservability || {}),
      ...replayBoostLastRunStub(replayBoostEnvOn, promotedReplayBypassOn),
      ...renewalShadowInjectionLastRunSlice(opts),
    };
  }

  const cycleCtx = resolvePaperExecCycleIds();

  const wave1PolicyOn = wave1PaperCaps.isWave1PaperPolicyEnabled();
  const wave1SymbolSet = wave1PolicyOn ? riskEngine.parseWave1SymbolSet() : new Set();

  const executedBarKeys = throttleOn ? new Set() : null;

  let persistentStore = null;
  let seenKeysBefore = null;
  let storeDirty = false;
  if (persistentOn) {
    persistentStore = loadSeenKeysStore(seenKeysStorePath);
    seenKeysBefore = Object.keys(persistentStore.keys).length;
  }

  let appended = 0;
  let duplicateSkippedRun = 0;
  let duplicateSkippedPersistent = 0;
  /** promoted_manifest signals that hit an existing persistent throttle key (before bypass outcome). */
  let promotedManifestPersistentDupAttempts = 0;
  let promotedReplayBypassCount = 0;
  const promotedReplayBypassSample = [];
  const bypassedPersistentKeysThisRun = new Set();
  const promotedReplayUsedSetups = new Set();
  const promotedReplayBarsBySetup = new Map();
  const promotedReplayBlockedReasons = {
    bypass_disabled: 0,
    not_promoted_manifest: 0,
    not_persistent_duplicate: 0,
    budget_exhausted: 0,
    missing_setup_key: 0,
    not_in_smart_allowlist: 0,
    smart_v2_not_selected: 0,
    not_required_not_seen_7d: 0,
    setup_budget_exhausted: 0,
    bars_per_setup_exhausted: 0,
    pkey_already_bypassed_this_run: 0,
  };
  let replayBoostBoostedSeen = 0;
  let replayBoostBoostedUsed = 0;
  let replayBoostFrozenSkipped = 0;
  const replayBoostReasonHistogram = Object.create(null);
  if (replayBoostOn && replayBoostSetupMap.size > 0) {
    for (const sig of signals) {
      if (sig && isPromotedManifestLikeSignalSource(sig.signalSource)) {
        const sk = getReplaySetupKey(sig);
        const row = sk ? replayBoostSetupMap.get(sk) : null;
        if (row && row.priorityTier === 'boosted') replayBoostBoostedSeen += 1;
      }
    }
  }
  let promotedReplayRecentAlignmentCount = 0;
  let promotedReplayRecentAlignLogOnce = false;
  let renewalShadowInjectedTradesWritten = 0;
  let renewalShadowBaseTradesWritten = 0;
  for (const sig of signals) {
    let promotedBypassUsed = false;
    if (sig && isPromotedManifestLikeSignalSource(sig.signalSource)) {
      const st = String(sig.strategyId || '').trim();
      const su = String(sig.setupId || '').trim();
      if (!st || !su || st !== su) {
        console.error('promoted_manifest identity mismatch');
        continue;
      }
    }
    const binPath = resolveBinPath(root, sig);
    if (!binPath || !fs.existsSync(binPath)) {
      console.error(
        `[paper_exec_v1] skip signal ${sig.strategyId || sig.setupId || '?'}: missing bin (${binPath || 'no path'})`
      );
      continue;
    }
    let candles;
    let symbol = sig.symbol;
    let timeframe = sig.timeframe;
    try {
      const loaded = readBinaryStoreSync(binPath);
      candles = loaded.candles;
      if (symbol == null || symbol === '') symbol = loaded.symbol;
      if (timeframe == null || timeframe === '') timeframe = loaded.timeframe;
    } catch (e) {
      console.error(`[paper_exec_v1] skip signal: failed to read ${binPath}: ${e && e.message ? e.message : e}`);
      continue;
    }

    const rRaw = Number(sig.rMultiple);
    const rResolved =
      Number.isFinite(rRaw) && rRaw > 0 ? rRaw : PAPER_EXECUTION_V1_DEFAULT_R_MULTIPLE;
    let sigNorm = { ...sig, symbol, timeframe, rMultiple: rResolved };
    const symU = String(symbol || '').toUpperCase().trim();
    const sid = (sigNorm.strategyId || sigNorm.setupId || '').toString();

    if (persistentStore) {
      const pkey = paperExecPersistentThrottleKey(sigNorm);
      if (persistentStore.keys[pkey]) {
        const isPromotedManifest = sigNorm && isPromotedManifestLikeSignalSource(sigNorm.signalSource);
        if (isPromotedManifest) {
          promotedManifestPersistentDupAttempts += 1;
          const decision = shouldBypassPersistentThrottleForPromotedSignal({
            signal: sigNorm,
            pkey,
            bypassedPersistentKeysThisRun,
            persistentDuplicate: true,
            promotedReplayBypassOn,
            promotedReplayBypassCount,
            promotedReplayMaxPerRun: effectivePromotedReplayMaxPerRun,
            smartOnlyOn,
            requireNotSeen7dOn,
            smartAllowlist,
            maxSetupsPerRun: effectiveMaxSetupsPerRun,
            maxBarsPerSetup: effectiveMaxBarsPerSetupGlobal,
            promotedReplayUsedSetups,
            promotedReplayBarsBySetup,
            getMaxBarsForSetup: getMaxBarsForSetupFn || undefined,
          });
          if (decision.ok) {
            promotedBypassUsed = true;
            promotedReplayBypassCount += 1;
            bypassedPersistentKeysThisRun.add(pkey);
            promotedReplayUsedSetups.add(decision.setupKey);
            if (smartAllowlist && smartAllowlist.v2Meta) {
              const sc = smartAllowlist.v2Meta.scoreBySetup.get(decision.setupKey);
              const cl = smartAllowlist.v2Meta.classBySetup.get(decision.setupKey);
              console.error(
                `[paper_exec_v1] smart_replay_v2 selected setupKey=${decision.setupKey} smart_score=${sc != null ? sc : 'n/a'} tier=${cl != null ? cl : 'n/a'}`
              );
            }
            if (replayBoostOn && replayBoostSetupMap.size > 0) {
              const tr = replayBoostSetupMap.get(decision.setupKey);
              const tk = tr && tr.replayPriorityTier;
              if (tk && Object.prototype.hasOwnProperty.call(replayBoostBypassByTier, tk)) {
                replayBoostBypassByTier[tk] += 1;
              }
              if (tr && tr.priorityTier === 'boosted') replayBoostBoostedUsed += 1;
              if (tr && Array.isArray(tr.reasons)) {
                for (const rc of tr.reasons.slice(0, 4)) {
                  const key =
                    typeof rc === 'string' ? rc : rc && rc.code != null ? String(rc.code) : 'reason';
                  replayBoostReasonHistogram[key] = (replayBoostReasonHistogram[key] || 0) + 1;
                }
              }
            }
            const prevBars = promotedReplayBarsUsedForSetup(decision.setupKey, promotedReplayBarsBySetup);
            promotedReplayBarsBySetup.set(decision.setupKey, prevBars + 1);
            if (promotedReplayBypassSample.length < 20) {
              promotedReplayBypassSample.push({
                setupId: String(sigNorm.setupId || ''),
                strategyId: String(sigNorm.strategyId || ''),
                datasetKey: String(sigNorm.datasetKey || ''),
                symbol: String(symU || ''),
                timeframe: String(timeframe || ''),
                barIndex: Number(sigNorm.barIndex),
                bypassReason: decision.reason,
                allowReason: decision.allowReason || null,
              });
            }
          } else {
            const r = decision.reason;
            if (Object.prototype.hasOwnProperty.call(promotedReplayBlockedReasons, r)) {
              promotedReplayBlockedReasons[r] += 1;
            }
            if (
              r === 'bars_per_setup_exhausted' &&
              replayBoostOn &&
              decision.setupKey &&
              replayBoostSetupMap.size > 0
            ) {
              const tr = replayBoostSetupMap.get(decision.setupKey);
              if (tr && tr.priorityTier === 'frozen') replayBoostFrozenSkipped += 1;
            }
            duplicateSkippedPersistent += 1;
            if (r === 'smart_v2_not_selected') {
              const sc = decision.smartReplayScore != null ? decision.smartReplayScore : 'n/a';
              const cl = decision.smartReplayClass != null ? decision.smartReplayClass : 'n/a';
              console.error(
                `[paper_exec_v1] skip persistent duplicate strategyId=${sid} symbol=${symU} timeframe=${timeframe} barIndex=${sigNorm.barIndex} smart_score=${sc} tier=${cl} reason=below_selection_cut`
              );
            } else {
              console.error(
                `[paper_exec_v1] skip persistent duplicate strategyId=${sid} symbol=${symU} timeframe=${timeframe} barIndex=${sigNorm.barIndex} (${r})`
              );
            }
            continue;
          }
        } else {
          duplicateSkippedPersistent += 1;
          promotedReplayBlockedReasons.not_promoted_manifest += 1;
          console.error(
            `[paper_exec_v1] skip persistent duplicate strategyId=${sid} symbol=${symU} timeframe=${timeframe} barIndex=${sigNorm.barIndex}`
          );
          continue;
        }
      }
    }

    if (
      promotedBypassUsed &&
      isPromotedManifestLikeSignalSource(sigNorm.signalSource) &&
      paperExecPromotedRecentMarketAlignEnabled()
    ) {
      const oldIdx = sigNorm.barIndex;
      const newIdx = resolveRecentBarIndexForSignal(sigNorm, candles);
      if (newIdx != null && Number.isFinite(newIdx) && newIdx >= 0) {
        sigNorm = { ...sigNorm, barIndex: newIdx, entryAtBarClose: true };
        promotedReplayRecentAlignmentCount += 1;
        if (!promotedReplayRecentAlignLogOnce) {
          console.error(
            `[paper_exec_v1] promoted_replay_recent_alignment applied: strategyId=${sid} old_barIndex=${oldIdx} new_barIndex=${newIdx}`
          );
          promotedReplayRecentAlignLogOnce = true;
        }
      }
    }

    if (executedBarKeys) {
      const tkey = paperExecBarThrottleKey(sigNorm);
      if (executedBarKeys.has(tkey)) {
        duplicateSkippedRun += 1;
        console.error(
          `[paper_exec_v1] skip duplicate bar throttle strategyId=${sid} symbol=${symU} timeframe=${timeframe} barIndex=${sigNorm.barIndex}`
        );
        continue;
      }
    }

    if (wave1PolicyOn && wave1SymbolSet.size > 0 && symU && wave1SymbolSet.has(symU)) {
      if (!riskEngine.parseWhitelist().has(sid)) {
        console.error(
          `[paper_exec_v1] skip wave1 policy: not_whitelisted strategyId=${sid} symbol=${symU}`
        );
        continue;
      }
      const cap = wave1PaperCaps.canAppendWave1Paper(symU);
      if (!cap.ok) {
        console.error(`[paper_exec_v1] skip wave1 policy: ${cap.reason} symbol=${symU}`);
        continue;
      }
    }

    const rec = simulatePaperTradeV1(candles, sigNorm, {
      cycleId: cycleCtx.cycleId,
      experimentId: cycleCtx.experimentId,
      rMultiple: rResolved,
      maxBarsHeld: typeof sig.maxBarsHeld === 'number' ? sig.maxBarsHeld : null,
    });

    if (rec.reason === 'skip') {
      console.error(
        `[paper_exec_v1] skip (invalid signal) strategyId=${rec.strategyId}: ${rec.detail || ''}`
      );
      continue;
    }

    const tradeLane = effectiveTradeLaneTag(opts);
    const sourceAudit = buildPaperTradeSourceAuditFields(sigNorm, opts);
    const recOut = {
      ...rec,
      ...sourceAudit,
      cycleId: cycleCtx.cycleId,
      experimentId: cycleCtx.experimentId,
      simulatedAt: new Date().toISOString(),
      ...(tradeLane ? { lane: tradeLane, signalLane: tradeLane } : {}),
    };
    appendJsonl(outJsonl, recOut);
    appended += 1;
    if (opts.shadowRenewalLane) {
      if (sigNorm.shadowInjection === true) renewalShadowInjectedTradesWritten += 1;
      else renewalShadowBaseTradesWritten += 1;
    }
    if (executedBarKeys) executedBarKeys.add(paperExecBarThrottleKey(sigNorm));
    if (persistentStore) {
      const pkey = paperExecPersistentThrottleKey(sigNorm);
      const nowIso = new Date().toISOString();
      const prev = persistentStore.keys[pkey] || {};
      persistentStore.keys[pkey] = {
        ...prev,
        firstSeenAt: prev.firstSeenAt || nowIso,
        lastSeenAt: nowIso,
        cycleId: cycleCtx.cycleId,
        experimentId: cycleCtx.experimentId,
      };
      storeDirty = true;
    }

    if (wave1PolicyOn && wave1SymbolSet.size > 0 && symU && wave1SymbolSet.has(symU)) {
      wave1PaperCaps.recordWave1PaperAppend(symU);
    }
  }

  let seenKeysAfter = null;
  if (persistentOn && persistentStore) {
    if (storeDirty) saveSeenKeysStore(seenKeysStorePath, persistentStore);
    seenKeysAfter = Object.keys(persistentStore.keys).length;
  }

  const barsBySetupObj = Object.fromEntries(
    Array.from(promotedReplayBarsBySetup.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  );

  let replayBoostLastRunExtras = replayBoostLastRunStub(replayBoostEnvOn, promotedReplayBypassOn);
  if (replayBoostOn && useFileReplayPolicy && filePolicyMeta && replayBoostSetupMap.size > 0) {
    const topFromMap = Array.from(replayBoostSetupMap.entries())
      .filter(([, v]) => v && v.priorityTier === 'boosted')
      .map(([id, v]) => ({
        setupId: id,
        replayPriorityTier: v.replayPriorityTier,
        replayPriorityScore: v.replayPriorityScore,
        priorityTier: v.priorityTier,
      }))
      .sort((a, b) => b.replayPriorityScore - a.replayPriorityScore)
      .slice(0, 12);
    const topUsed = promotedReplayBypassSample.slice(0, 12).map((x) => x.setupId);
    const pseudoSetups = Array.from(replayBoostSetupMap.values()).map((v) => ({
      replayPriorityTier: v.replayPriorityTier,
    }));
    replayBoostLastRunExtras = {
      replayBoostEnabled: true,
      replayBoostPolicyVersion: replayBoostPolicy.POLICY_VERSION,
      replayBoostFilePolicy: true,
      replayBoostPolicyEnabled: true,
      replayBoostPolicyGeneratedAt: filePolicyMeta.generatedAt,
      replayBoostPolicyMode: filePolicyMeta.policyMode,
      replayBoostBoostedSeen: replayBoostBoostedSeen,
      replayBoostBoostedUsed: replayBoostBoostedUsed,
      replayBoostFrozenSkipped: replayBoostFrozenSkipped,
      replayBoostGlobalControlsApplied: filePolicyMeta.globalControls,
      replayBoostTopUsedSetups: topUsed,
      replayBoostReasonHistogram: { ...replayBoostReasonHistogram },
      replayBoostTopSetups: topFromMap,
      replayBoostTierCounts: replayBoostPolicy.countTiers(pseudoSetups),
      replayBoostUsedBudgetByTier: { ...replayBoostBypassByTier },
    };
    console.error(
      `[paper_exec_v1] replay_boost file policy mode=${filePolicyMeta.policyMode} boosted_seen=${replayBoostBoostedSeen} boosted_used=${replayBoostBoostedUsed} frozen_skipped=${replayBoostFrozenSkipped}`
    );
  } else if (replayBoostOn && replayBoostComputed && replayBoostOpts) {
    const top = replayBoostComputed.setups
      .slice()
      .sort((a, b) =>
        b.replayPriorityScore !== a.replayPriorityScore
          ? b.replayPriorityScore - a.replayPriorityScore
          : a.setupId.localeCompare(b.setupId)
      )
      .slice(0, 12)
      .map((s) => ({
        setupId: s.setupId,
        replayPriorityTier: s.replayPriorityTier,
        replayPriorityScore: s.replayPriorityScore,
      }));
    replayBoostLastRunExtras = {
      replayBoostEnabled: true,
      replayBoostPolicyVersion: replayBoostPolicy.POLICY_VERSION,
      replayBoostPolicyEnabled: false,
      replayBoostFilePolicy: false,
      replayBoostPolicyGeneratedAt: null,
      replayBoostPolicyMode: null,
      replayBoostBoostedSeen: 0,
      replayBoostBoostedUsed: 0,
      replayBoostFrozenSkipped: 0,
      replayBoostGlobalControlsApplied: null,
      replayBoostTopUsedSetups: [],
      replayBoostReasonHistogram: {},
      replayBoostTopSetups: top,
      replayBoostTierCounts: replayBoostPolicy.countTiers(replayBoostComputed.setups),
      replayBoostUsedBudgetByTier: { ...replayBoostBypassByTier },
    };
    try {
      const artifact = replayBoostPolicy.buildReplayBoostArtifactDoc(replayBoostComputed, {
        generatedAt: new Date().toISOString(),
        replayBoostEnabled: true,
        promotedReplayBypassEnabled: promotedReplayBypassOn,
        promotedReplayMaxPerRun,
        usedBypassCount: promotedReplayBypassCount,
        baseMaxBarsPerSetup: maxBarsPerSetup,
        tierBarsA: replayBoostOpts.tierBarsA,
        tierBarsB: replayBoostOpts.tierBarsB,
        tierBarsC: replayBoostOpts.tierBarsC,
        tierBarsD: replayBoostOpts.tierBarsD,
        replayBoostBypassByTier: { ...replayBoostBypassByTier },
      });
      fs.writeFileSync(
        path.join(govDir, 'replay_boost_priority.json'),
        JSON.stringify(artifact, null, 2),
        'utf8'
      );
    } catch (e) {
      console.error(
        `[paper_exec_v1] replay_boost_priority write failed: ${e && e.message ? e.message : e}`
      );
    }
  } else if (replayBoostOn && replayBoostFilePolicyOn && !useFileReplayPolicy) {
    replayBoostLastRunExtras = {
      ...replayBoostLastRunExtras,
      replayBoostPolicyEnabled: false,
      replayBoostFilePolicy: false,
    };
  }

  if (smartReplayV2Stats) {
    console.error(
      `[paper_exec_v1] smart_selection candidates=${smartReplayV2Stats.candidates} selected=${smartReplayV2Stats.selected} dropped=${smartReplayV2Stats.dropped} avg_score=${smartReplayV2Stats.avgScore}`
    );
  }

  const lastRunSs =
    smartAllowlist.sourceSummary && typeof smartAllowlist.sourceSummary === 'object'
      ? smartAllowlist.sourceSummary
      : {};
  const tier1Count = Math.max(0, Math.floor(Number(lastRunSs.promotedNotSeen7dCount) || 0));
  const tier2Count = Math.max(0, Math.floor(Number(lastRunSs.tier2Count) || 0));
  const appendZeroPrimaryReason = computeAppendZeroPrimaryReason({
    appended,
    signalsLen: signals.length,
    skipped: '',
    persistentOn,
    smartOnlyOn,
    promotedReplayBypassOn,
    duplicateSkippedPersistent,
    duplicateSkippedRun,
    promotedReplayBypassCount,
    promotedManifestPersistentDupAttempts,
    promotedReplayBlockedReasons,
    sourceSummary: lastRunSs,
    smartReplayV2Stats,
    smartReplayObservability,
  });

  const smartReplayLastRunDefaults = {
    smartReplayV2Enabled: false,
    smartReplayPolicyIntegrated: false,
    smartReplayPolicyMode: 'legacy',
    smartReplayCandidatesSeen: null,
    smartReplayCandidatesSelected: null,
    smartReplayBoostedSelected: null,
    smartReplayNeutralSelected: null,
    smartReplayThrottledDropped: null,
    smartReplayFrozenDropped: null,
    smartReplayAvgBaseScore: null,
    smartReplayAvgFinalScore: null,
    smartReplayGlobalControlsApplied: null,
    smartReplayTopSelected: null,
    smartReplayPolicyInfluenceHistogram: null,
    autoThrottleEnabled: false,
    autoThrottlePolicyIntegrated: false,
    autoThrottlePolicyMode: null,
    autoThrottlePolicyGeneratedAt: null,
    autoThrottleProtectSeen: null,
    autoThrottleThrottleSeen: null,
    autoThrottleFrozenSeen: null,
    autoThrottleFrozenDropped: null,
    autoThrottleReducedBudgetCount: null,
    smartReplayAutoThrottleHistogram: null,
    capitalAllocationEnabled: false,
    capitalAllocationPolicyIntegrated: false,
    capitalAllocationPolicyGeneratedAt: null,
    capitalAllocationPolicyMode: null,
    capitalAllocationCoreSeen: null,
    capitalAllocationActiveSeen: null,
    capitalAllocationReducedSeen: null,
    capitalAllocationSuspendedSeen: null,
    capitalAllocationReducedBudgetCount: null,
    capitalAllocationSuspendedDropped: null,
    capitalAllocationGlobalControlsApplied: null,
    capitalAllocationConcentrationRisk: null,
    smartReplayCapitalAllocationHistogram: null,
  };

  writePaperExecLastRun(lastRunPath, {
    schemaVersion: PAPER_EXEC_LAST_RUN_SCHEMA_VERSION,
    writtenAt: new Date().toISOString(),
    effectiveAppended: appended,
    duplicateSkippedRun,
    duplicateSkippedPersistent,
    tier1Count,
    tier2Count,
    promotedManifestPersistentDupAttempts,
    promotedManifestBypassGranted: promotedReplayBypassCount,
    appendZeroPrimaryReason,
    seenKeysBefore,
    seenKeysAfter,
    seenKeysStorePath,
    ...shadowLaneLastRunFields(opts),
    ...(opts.shadowRenewalLane ? { lastRunPath } : {}),
    ...renewalShadowInjectionLastRunSlice(opts),
    ...renewalShadowTradeOutcomeLastRunSlice(
      opts,
      appended,
      renewalShadowInjectedTradesWritten,
      renewalShadowBaseTradesWritten
    ),
    paperExecBarThrottleEnabled: throttleOn,
    paperExecPersistentThrottleEnabled: persistentOn,
    promotedReplayBypassEnabled: promotedReplayBypassOn,
    promotedReplayMaxPerRun,
    promotedReplayBypassCount,
    promotedReplayBypassSample,
    promotedReplaySmartOnlyEnabled: smartOnlyOn,
    promotedReplayRequireNotSeen7dEnabled: requireNotSeen7dOn,
    promotedReplayMaxSetupsPerRun: maxSetupsPerRun,
    promotedReplayMaxBarsPerSetup: maxBarsPerSetup,
    promotedReplayEligibleSetupCount: smartAllowlist.selectedSetupKeys.size,
    promotedReplayEligibleSetupSample: Array.from(smartAllowlist.selectedSetupKeys).sort().slice(0, 10),
    promotedReplayUsedSetupCount: promotedReplayUsedSetups.size,
    promotedReplayUsedSetupSample: Array.from(promotedReplayUsedSetups).sort().slice(0, 10),
    promotedReplayBarsBySetup: barsBySetupObj,
    promotedReplayAllowlistSourceSummary: smartAllowlist.sourceSummary,
    promotedReplayBlockedReasons,
    promotedReplayRecentMarketAlignEnabled: recentMarketAlignOn,
    promotedReplayRecentAlignmentCount,
    smartAllowlistV2Used: smartReplayV2Stats != null,
    smartReplaySelectionStats: smartReplayV2Stats,
    ...(smartReplayObservability || smartReplayLastRunDefaults),
    ...replayBoostLastRunExtras,
  });

  return {
    enabled: true,
    appended,
    outPath: outJsonl,
    lastRunPath,
    ...renewalShadowInjectionLastRunSlice(opts),
    ...renewalShadowTradeOutcomeLastRunSlice(
      opts,
      appended,
      renewalShadowInjectedTradesWritten,
      renewalShadowBaseTradesWritten
    ),
    duplicateSkippedRun,
    duplicateSkippedPersistent,
    tier1Count,
    tier2Count,
    promotedManifestPersistentDupAttempts,
    promotedManifestBypassGranted: promotedReplayBypassCount,
    appendZeroPrimaryReason,
    seenKeysBefore,
    seenKeysAfter,
    seenKeysStorePath,
    paperExecBarThrottleEnabled: throttleOn,
    paperExecPersistentThrottleEnabled: persistentOn,
    promotedReplayBypassEnabled: promotedReplayBypassOn,
    promotedReplayMaxPerRun,
    promotedReplayBypassCount,
    promotedReplayBypassSample,
    promotedReplaySmartOnlyEnabled: smartOnlyOn,
    promotedReplayRequireNotSeen7dEnabled: requireNotSeen7dOn,
    promotedReplayMaxSetupsPerRun: maxSetupsPerRun,
    promotedReplayMaxBarsPerSetup: maxBarsPerSetup,
    promotedReplayEligibleSetupCount: smartAllowlist.selectedSetupKeys.size,
    promotedReplayEligibleSetupSample: Array.from(smartAllowlist.selectedSetupKeys).sort().slice(0, 10),
    promotedReplayUsedSetupCount: promotedReplayUsedSetups.size,
    promotedReplayUsedSetupSample: Array.from(promotedReplayUsedSetups).sort().slice(0, 10),
    promotedReplayBarsBySetup: barsBySetupObj,
    promotedReplayAllowlistSourceSummary: smartAllowlist.sourceSummary,
    promotedReplayBlockedReasons,
    promotedReplayRecentMarketAlignEnabled: recentMarketAlignOn,
    promotedReplayRecentAlignmentCount,
    smartAllowlistV2Used: smartReplayV2Stats != null,
    smartReplaySelectionStats: smartReplayV2Stats,
    ...(smartReplayObservability || smartReplayLastRunDefaults),
    ...replayBoostLastRunExtras,
  };
}

module.exports = {
  runPaperExecutionV1,
  PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE,
  isPromotedManifestLikeSignalSource,
  envBoolOptIn,
  isPaperExecV1Enabled,
  resolvePaperExecCycleIds,
  paperExecBarThrottleKey,
  paperExecBarThrottleEnabled,
  paperExecPersistentThrottleKey,
  paperExecPersistentThrottleEnabled,
  paperExecPromotedReplaySmartOnlyEnabled,
  paperExecPromotedReplayRequireNotSeen7dEnabled,
  paperExecPromotedReplayMaxSetupsPerRun,
  paperExecPromotedReplayMaxBarsPerSetup,
  paperExecPromotedRecentMarketAlignEnabled,
  resolveRecentBarIndexForSignal,
  loadPromotedReplaySmartAllowlist,
  getReplaySetupKey,
  shouldBypassPersistentThrottleForPromotedSignal,
  loadSeenKeysStore,
  saveSeenKeysStore,
  computeAppendZeroPrimaryReason,
};

if (require.main === module) {
  const r = runPaperExecutionV1();
  if (!r.enabled) {
    console.error(
      `[paper_exec_v1] ${r.skipped || 'disabled — set NEUROPILOT_PAPER_EXEC_V1=1 or NEUROPILOT_WAVE1_PAPER_SCALE_MODE=1'}`
    );
    process.exit(0);
  }
  if (r.skipped) {
    console.error(`[paper_exec_v1] ${r.skipped}`);
    process.exit(0);
  }
  console.log(
    `[paper_exec_v1] appended ${r.appended} trade(s) → ${r.outPath}` +
      (r.duplicateSkippedRun != null
        ? ` | run_throttle_skips=${r.duplicateSkippedRun} persistent_skips=${r.duplicateSkippedPersistent}`
        : '')
  );
  if (r.promotedReplayBypassEnabled) {
    const sm = r.promotedReplaySmartOnlyEnabled ? ' smart=1' : '';
    console.log(
      `[paper_exec_v1] promoted_replay_bypass=${r.promotedReplayBypassCount}/${r.promotedReplayMaxPerRun}${sm}`
    );
  }
  if (r.promotedReplayRecentAlignmentCount > 0) {
    console.log(`[paper_exec_v1] promoted_replay_recent_alignment_count=${r.promotedReplayRecentAlignmentCount}`);
  }
  process.exit(0);
}
