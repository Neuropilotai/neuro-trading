#!/usr/bin/env node
'use strict';

/**
 * Option C shadow lane + renewal injection (shadow only).
 *
 * Isolated artefacts under governance/ (see renewalShadowConstants):
 *   paper_trades_renewal_shadow.jsonl
 *   paper_exec_seen_keys_renewal_shadow.json
 *   paper_exec_v1_last_run_shadow.json
 *   paper_execution_v1_signals_renewal_shadow.json  (only when NP_SHADOW_RENEWAL_INJECTION_ENABLE=1)
 *
 * Live paper_execution_v1_signals.json, paper_trades.jsonl, seen_keys, last_run are never written.
 *
 * ⚠️ Do not include `*_renewal_shadow*` paths in live trade aggregation, promotion metrics, or official PnL rollups.
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const { runPaperExecutionV1, envBoolOptIn } = require('./runPaperExecutionV1');
const { buildRenewalShadowInjectedSignals } = require('./buildRenewalShadowSignals');
const {
  PAPER_TRADES_RENEWAL_SHADOW_JSONL,
  PAPER_EXEC_SEEN_KEYS_RENEWAL_SHADOW_JSON,
  PAPER_EXEC_V1_LAST_RUN_SHADOW_JSON,
  PAPER_EXECUTION_V1_SIGNALS_RENEWAL_SHADOW_JSON,
} = require('./renewalShadowConstants');

const DEFAULT_LANE = 'shadow_renewal';

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function envIntOpt(name, def) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return def;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function assertShadowSignalsPathNotLive(govDir, shadowSignalsPath) {
  const live = path.join(govDir, 'paper_execution_v1_signals.json');
  if (path.resolve(shadowSignalsPath) === path.resolve(live)) {
    throw new Error(
      '[paper_exec_v1_renewal_shadow] shadow signals path must not be live paper_execution_v1_signals.json'
    );
  }
}

function main() {
  if (!envBoolOptIn('NP_SHADOW_RENEWAL_LANE_ENABLE')) {
    console.error('[paper_exec_v1_renewal_shadow] NP_SHADOW_RENEWAL_LANE_ENABLE not set — no-op exit 0');
    process.exit(0);
  }
  if (!envBoolOptIn('NEUROPILOT_PAPER_EXEC_V1') && !envBoolOptIn('NEUROPILOT_WAVE1_PAPER_SCALE_MODE')) {
    console.error(
      '[paper_exec_v1_renewal_shadow] set NEUROPILOT_PAPER_EXEC_V1=1 (or NEUROPILOT_WAVE1_PAPER_SCALE_MODE=1)'
    );
    process.exit(1);
  }

  const root = dataRoot.getDataRoot();
  const govDir = path.join(root, 'governance');
  const laneName = String(process.env.NP_SHADOW_RENEWAL_LANE_NAME || DEFAULT_LANE).trim() || DEFAULT_LANE;
  const outJsonl = path.join(govDir, PAPER_TRADES_RENEWAL_SHADOW_JSONL);
  const lastRunPath = path.join(govDir, PAPER_EXEC_V1_LAST_RUN_SHADOW_JSON);
  const seenKeysStorePath = path.join(govDir, PAPER_EXEC_SEEN_KEYS_RENEWAL_SHADOW_JSON);
  const liveSignalsPath = path.join(govDir, 'paper_execution_v1_signals.json');
  const shadowSignalsPath = path.join(govDir, PAPER_EXECUTION_V1_SIGNALS_RENEWAL_SHADOW_JSON);

  assertShadowSignalsPathNotLive(govDir, shadowSignalsPath);

  let signalsPath = liveSignalsPath;
  /** @type {object|null} */
  let renewalReport = null;

  if (envBoolOptIn('NP_SHADOW_RENEWAL_INJECTION_ENABLE')) {
    const inj = buildRenewalShadowInjectedSignals({
      dataRoot: root,
      shadowSeenKeysStorePath: seenKeysStorePath,
      maxSignalsPerRun: envIntOpt('NP_SHADOW_RENEWAL_INJECTION_MAX_SIGNALS_PER_RUN', 8),
      maxPerSetup: envIntOpt('NP_SHADOW_RENEWAL_INJECTION_MAX_PER_SETUP', 1),
      maxSetupsToScan: envIntOpt('NP_SHADOW_RENEWAL_INJECTION_MAX_SETUPS', 32),
    });
    const baseDoc = readJsonSafe(liveSignalsPath);
    const baseSignals = Array.isArray(baseDoc && baseDoc.signals) ? baseDoc.signals : [];
    const merged = { signals: [...baseSignals, ...inj.signals] };
    fs.mkdirSync(path.dirname(shadowSignalsPath), { recursive: true });
    fs.writeFileSync(shadowSignalsPath, JSON.stringify(merged, null, 2), 'utf8');
    signalsPath = shadowSignalsPath;
    renewalReport = {
      candidateCount: inj.candidateCount,
      signalsAdded: inj.signalsAdded,
      keysSkippedAlreadySeen: inj.keysSkippedAlreadySeen,
      skippedNoValidBar: inj.skippedNoValidBar,
      skippedInvalidManifest: inj.skippedInvalidManifest,
      shadowSignalsPath,
    };
    console.error(
      `[paper_exec_v1_renewal_shadow] injection signalsAdded=${inj.signalsAdded} candidateCount=${inj.candidateCount} path=${shadowSignalsPath}`
    );
  }

  console.error(
    `[paper_exec_v1_renewal_shadow] lane=${laneName} dataRoot=${root} signalsPath=${signalsPath} outJsonl=${outJsonl} (isolated from live)`
  );

  const r = runPaperExecutionV1({
    dataRoot: root,
    signalsPath,
    outJsonl,
    lastRunPath,
    seenKeysStorePath,
    laneName,
    shadowRenewalLane: true,
    renewalShadowInjectionReport: renewalReport,
  });

  if (!r.enabled) {
    console.error(`[paper_exec_v1_renewal_shadow] ${r.skipped || 'disabled'}`);
    process.exit(0);
  }
  if (r.skipped) {
    console.error(`[paper_exec_v1_renewal_shadow] ${r.skipped}`);
    process.exit(0);
  }
  console.log(
    `[paper_exec_v1_renewal_shadow] appended=${r.appended} → ${r.outPath} lastRun=${r.lastRunPath} persistent_skips=${r.duplicateSkippedPersistent}`
  );
  process.exit(0);
}

main();
