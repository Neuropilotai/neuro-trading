#!/usr/bin/env node
'use strict';

/**
 * Near-live batch scheduler (Level 2):
 * - lock anti-concurrency
 * - run data pipeline cycle
 * - export ops snapshot
 * - evaluate dataset freshness guards
 * - compute 24h freshness SLO
 * - write run_health.json + freshness_slo.json
 *
 * Defaults:
 * - 5m stale threshold: 12 min
 * - 1h stale threshold: 90 min
 * - SLO target: 95% runs with lag < 7 min
 * - run interval: 180000 ms (3 min)
 *
 * Freshness / hard-fail tuning (ops):
 * - NEUROPILOT_CRITICAL_DATASETS — comma list (e.g. XAUUSD_5m,XAUUSD_1h). Only these gate hard fail.
 *   If unset, all datasets in datasets_freshness.json are considered critical for hard fail.
 * - NEUROPILOT_SOFT_MONITOR_DATASETS — stale here is reported in softMonitorStaleDatasets only (no hard fail).
 * - NEUROPILOT_STALE_THRESHOLD_5M_MIN / NEUROPILOT_STALE_THRESHOLD_1H_MIN / NEUROPILOT_STALE_THRESHOLD_DEFAULT_MIN
 * - NEUROPILOT_DISABLE_STALE_DATA_FAIL=1 — emergency: do not hard-fail on critical stale (even if CRITICAL_DATASETS unset).
 *   Still writes staleDatasets. Prefer partial degrade below for bounded “prop shop” continuity.
 * - NEUROPILOT_PARTIAL_DEGRADE_ON_STALE=1 or NEUROPILOT_TRADING_CONTINUITY=1 — resilient mode: if NEUROPILOT_CRITICAL_DATASETS
 *   is set (non-empty), critical stale does NOT stop the cycle (staleDataHardFail false) but staleDatasets still lists offenders.
 *   If CRITICAL_DATASETS is unset, partial degrade does nothing (fail closed on full-manifest critical stale).
 * - NEUROPILOT_ALLOW_STALE_SOFT=1 — near-live --once: exit 0 even if stale (run_health still reflects stale until bypass above).
 *
 * Data guard (downstream): run_health.degradedCriticalDatasets lists manifest keys (e.g. XAUUSD_1h) that
 * are status === 'degraded' only (never lagging). run_health.laggingDatasets is ops-only / non-blocking.
 * runDataEngine / datasetUpdater / datasetBatchLoader skip degraded keys when NEUROPILOT_DATA_GUARD_SKIP is not 0.
 *
 * Freshness classification: engine/data/datasetFreshnessEval.js (healthy / lagging / degraded).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dataRoot = require('../dataRoot');
const datasetFreshnessEval = require('../data/datasetFreshnessEval');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** Align with exportOpsSnapshot.js + datasetDegradedGuard: optional NEUROPILOT_OPS_SNAPSHOT_DIR (cwd-relative). */
function resolveOpsSnapshotDir() {
  const env = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR;
  if (env && String(env).trim()) {
    return path.resolve(process.cwd(), String(env).trim());
  }
  return path.join(PROJECT_ROOT, 'ops-snapshot');
}

const OPS_SNAPSHOT_DIR = resolveOpsSnapshotDir();

const RUN_HEALTH_PATH = path.join(OPS_SNAPSHOT_DIR, 'run_health.json');
const FRESHNESS_SLO_PATH = path.join(OPS_SNAPSHOT_DIR, 'freshness_slo.json');
const FRESHNESS_HISTORY_PATH = path.join(OPS_SNAPSHOT_DIR, 'freshness_runs_history.jsonl');

function parseBool(v) {
  return v === '1' || String(v).toLowerCase() === 'true';
}

function parsePartialDegradeOnStale() {
  return (
    parseBool(process.env.NEUROPILOT_PARTIAL_DEGRADE_ON_STALE) ||
    parseBool(process.env.NEUROPILOT_TRADING_CONTINUITY)
  );
}

/** One-shot stderr JSON so ops can prove why staleDataHardFail fired (nohup without env is a common cause). */
let freshnessEnvLogged = false;
function logNearLiveFreshnessEnvOnce() {
  if (freshnessEnvLogged) return;
  freshnessEnvLogged = true;
  const criticalSet = parseCriticalDatasetsFromEnv();
  const partial = parsePartialDegradeOnStale();
  const bounded = criticalSet != null && criticalSet.size > 0;
  let guardMode = 'unbounded_manifest_critical';
  if (bounded && partial) guardMode = 'bounded_partial_degrade';
  else if (bounded) guardMode = 'bounded_hard_fail_on_stale_critical';
  const advisory =
    !bounded
      ? 'NEUROPILOT_CRITICAL_DATASETS unset: every row in datasets_freshness.json gates hard-fail; partial degrade inactive. Use ops/launchd/run-nearlive.sh or export a bounded list.'
      : !partial
        ? 'Partial degrade off: any stale critical dataset hard-fails the cycle. Set NEUROPILOT_PARTIAL_DEGRADE_ON_STALE=1 for continuity.'
        : undefined;
  const softSet = parseDatasetSetFromEnv('NEUROPILOT_SOFT_MONITOR_DATASETS');
  const softBounded = softSet != null && softSet.size > 0;
  console.error(
    JSON.stringify({
      event: 'near_live_freshness_env',
      at: new Date().toISOString(),
      criticalDatasetsFromEnv: bounded,
      criticalDatasetCount: bounded ? criticalSet.size : null,
      partialDegradeOnStale: partial,
      freshnessGuardMode: guardMode,
      softMonitorDatasetsFromEnv: softBounded,
      softMonitorDatasetCount: softBounded ? softSet.size : null,
      ...(advisory ? { advisory } : {}),
    })
  );
}

function parseNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function runNodeScript(scriptRelPath, args = [], env = process.env) {
  const scriptAbs = path.join(PROJECT_ROOT, scriptRelPath);
  const res = spawnSync(process.execPath, [scriptAbs, ...args], {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf8',
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function acquireLock(lockPath) {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }));
    fs.closeSync(fd);
    return true;
  } catch (_) {
    return false;
  }
}

function releaseLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch (_) {
    // ignore
  }
}

function readFreshnessSnapshot() {
  return readJson(path.join(OPS_SNAPSHOT_DIR, 'datasets_freshness.json'), { datasets: [] }) || { datasets: [] };
}

function parseCriticalDatasetsFromEnv() {
  // Example: XAUUSD_5m,XAUUSD_1h,BTCUSDT_5m
  const raw = String(process.env.NEUROPILOT_CRITICAL_DATASETS || '').trim();
  if (!raw) return null;
  const set = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.toUpperCase())
  );
  return set.size > 0 ? set : null;
}

function parseDatasetSetFromEnv(varName) {
  const raw = String(process.env[varName] || '').trim();
  if (!raw) return null;
  const set = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.toUpperCase())
  );
  return set.size > 0 ? set : null;
}

function keyFor(row) {
  return String(row.key || `${row.symbol || ''}_${row.timeframe || ''}`).toUpperCase();
}

/** Build input row for datasetFreshnessEval from a datasets_freshness.json row. */
function rowForFreshnessEval(d) {
  return {
    symbol: d.symbol,
    timeframe: d.timeframe,
    dataset_age_minutes: d.dataset_age_minutes,
    dataset_last_candle_ts: d.dataset_last_candle_ts,
    source: d.source != null ? d.source : null,
  };
}

function evaluateFreshness(datasets, criticalSet) {
  const softSet = parseDatasetSetFromEnv('NEUROPILOT_SOFT_MONITOR_DATASETS');
  const considered = Array.isArray(datasets)
    ? datasets.filter((d) => {
        if (!criticalSet) return true;
        return criticalSet.has(keyFor(d));
      })
    : [];
  const softOnly = Array.isArray(datasets)
    ? datasets.filter((d) => {
        if (!softSet) return false;
        return softSet.has(keyFor(d));
      })
    : [];

  /** Blocking / hard-fail only — status === 'degraded' */
  const staleDatasets = [];
  /** Ops-only — non-blocking */
  const laggingDatasets = [];
  let maxLagMinutes = 0;

  for (const d of considered) {
    const ev = datasetFreshnessEval.evaluateDatasetFreshness(rowForFreshnessEval(d));
    const lag = ev.ageMinutes != null && Number.isFinite(ev.ageMinutes) ? ev.ageMinutes : NaN;
    if (Number.isFinite(lag) && lag > maxLagMinutes) maxLagMinutes = lag;

    if (ev.status === 'degraded') {
      staleDatasets.push({
        key: d.key,
        timeframe: d.timeframe,
        provider: d.provider_used,
        lagMinutes: Number.isFinite(lag) ? lag : null,
        thresholdMinutes: ev.thresholds.degradedMinutes,
        laggingThresholdMinutes: ev.thresholds.laggingMinutes,
        status: 'degraded',
      });
    } else if (ev.status === 'lagging') {
      laggingDatasets.push({
        key: d.key,
        timeframe: d.timeframe,
        provider: d.provider_used,
        lagMinutes: Number.isFinite(lag) ? lag : null,
        laggingThresholdMinutes: ev.thresholds.laggingMinutes,
        degradedThresholdMinutes: ev.thresholds.degradedMinutes,
        status: 'lagging',
      });
    }
  }

  const softMonitorStaleDatasets = [];
  const softMonitorLaggingDatasets = [];
  for (const d of softOnly) {
    const ev = datasetFreshnessEval.evaluateDatasetFreshness(rowForFreshnessEval(d));
    const lag = ev.ageMinutes != null && Number.isFinite(ev.ageMinutes) ? ev.ageMinutes : NaN;

    if (ev.status === 'degraded') {
      softMonitorStaleDatasets.push({
        key: d.key,
        timeframe: d.timeframe,
        provider: d.provider_used,
        lagMinutes: Number.isFinite(lag) ? lag : null,
        thresholdMinutes: ev.thresholds.degradedMinutes,
        laggingThresholdMinutes: ev.thresholds.laggingMinutes,
        status: 'degraded',
      });
    } else if (ev.status === 'lagging') {
      softMonitorLaggingDatasets.push({
        key: d.key,
        timeframe: d.timeframe,
        provider: d.provider_used,
        lagMinutes: Number.isFinite(lag) ? lag : null,
        laggingThresholdMinutes: ev.thresholds.laggingMinutes,
        degradedThresholdMinutes: ev.thresholds.degradedMinutes,
        status: 'lagging',
      });
    }
  }

  return {
    consideredCount: considered.length,
    staleDatasets,
    laggingDatasets,
    softMonitorCount: softOnly.length,
    softMonitorStaleDatasets,
    softMonitorLaggingDatasets,
    noFreshProgress:
      considered.length > 0 &&
      considered.every((d) => {
        const ev = datasetFreshnessEval.evaluateDatasetFreshness(rowForFreshnessEval(d));
        return ev.status !== 'healthy';
      }),
    maxLagMinutes: Number(maxLagMinutes.toFixed(3)),
  };
}

function appendHistoryRun(entry) {
  ensureDir(path.dirname(FRESHNESS_HISTORY_PATH));
  fs.appendFileSync(FRESHNESS_HISTORY_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

function readHistoryRuns24h(nowMs) {
  if (!fs.existsSync(FRESHNESS_HISTORY_PATH)) return [];
  const lines = fs
    .readFileSync(FRESHNESS_HISTORY_PATH, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  const minMs = nowMs - 24 * 60 * 60 * 1000;
  const out = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      const ts = new Date(r.finishedAt || r.startedAt || 0).getTime();
      if (Number.isFinite(ts) && ts >= minMs) out.push(r);
    } catch (_) {
      // ignore malformed
    }
  }
  return out;
}

function p95(nums) {
  const arr = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil(arr.length * 0.95) - 1));
  return Number(arr[idx].toFixed(3));
}

function computeSlo(history24h) {
  const lagTargetMin = parseNum(
    process.env.NEUROPILOT_FRESHNESS_LAG_TARGET_MIN ?? process.env.NEUROPILOT_SLO_LAG_TARGET_MIN,
    7
  );
  const targetRate = parseNum(
    process.env.NEUROPILOT_FRESHNESS_TARGET_RATE ?? process.env.NEUROPILOT_SLO_RATE_TARGET,
    0.95
  );

  const runs24h = history24h.length;
  const freshRuns24h = history24h.filter((r) => Number.isFinite(r.maxLagMinutes) && r.maxLagMinutes < lagTargetMin).length;
  const successRate = runs24h > 0 ? freshRuns24h / runs24h : 0;
  const lags = history24h.map((r) => Number(r.maxLagMinutes)).filter(Number.isFinite);
  const lagP95 = p95(lags);

  return {
    generatedAt: new Date().toISOString(),
    lagTargetMinutes: lagTargetMin,
    targetRate,
    runs24h,
    freshRuns24h,
    successRate: Number(successRate.toFixed(4)),
    freshnessLagMinutesP95: lagP95,
    sloMet: runs24h > 0 ? successRate >= targetRate : false,
  };
}

function runOneCycle(cycleId) {
  const startedAt = new Date().toISOString();
  const criticalSet = parseCriticalDatasetsFromEnv();

  const dataRun = runNodeScript('engine/data/runDataEngine.js', []);
  const snapshotRun = runNodeScript('engine/evolution/scripts/exportOpsSnapshot.js', []);

  const freshness = readFreshnessSnapshot();
  const freshnessEval = evaluateFreshness(freshness.datasets || [], criticalSet);

  const criticalStale = freshnessEval.staleDatasets.length > 0; // degraded only
  const emergencyStaleBypass = parseBool(process.env.NEUROPILOT_DISABLE_STALE_DATA_FAIL);
  const boundedCriticalList = criticalSet != null && criticalSet.size > 0;
  const partialDegradeOnStaleActive =
    criticalStale && parsePartialDegradeOnStale() && boundedCriticalList;
  const staleHardFailEmergencyBypassActive = criticalStale && emergencyStaleBypass;
  const hardFailStale =
    criticalStale && !emergencyStaleBypass && !partialDegradeOnStaleActive;
  const staleHardFailSuppressed = criticalStale && !hardFailStale;
  const noFreshProgress = !!freshnessEval.noFreshProgress;
  const ok = dataRun.ok && snapshotRun.ok && !hardFailStale;

  const degradedCriticalDatasets = freshnessEval.staleDatasets
    .map((d) => String(d.key || '').trim().toUpperCase())
    .filter(Boolean);

  const finishedAt = new Date().toISOString();
  const result = {
    cycleId,
    startedAt,
    finishedAt,
    ok,
    dataRun: { ok: dataRun.ok, status: dataRun.status },
    snapshotRun: { ok: snapshotRun.ok, status: snapshotRun.status },
    stale_data_hard_fail: hardFailStale,
    critical_stale_detected: criticalStale,
    stale_hard_fail_emergency_bypass_active: staleHardFailEmergencyBypassActive,
    /** @deprecated use stale_hard_fail_emergency_bypass_active; emergency bypass only */
    stale_hard_fail_bypass_active: staleHardFailEmergencyBypassActive,
    partial_degrade_on_stale_active: partialDegradeOnStaleActive,
    stale_hard_fail_suppressed: staleHardFailSuppressed,
    degraded_critical_datasets: degradedCriticalDatasets,
    no_fresh_progress: noFreshProgress,
    consideredDatasets: freshnessEval.consideredCount,
    softMonitorDatasets: freshnessEval.softMonitorCount,
    staleDatasets: freshnessEval.staleDatasets,
    laggingDatasets: freshnessEval.laggingDatasets,
    softMonitorStaleDatasets: freshnessEval.softMonitorStaleDatasets,
    softMonitorLaggingDatasets: freshnessEval.softMonitorLaggingDatasets,
    maxLagMinutes: freshnessEval.maxLagMinutes,
  };

  appendHistoryRun(result);
  const history24h = readHistoryRuns24h(Date.now());
  const slo = computeSlo(history24h);

  const prevHealth = readJson(RUN_HEALTH_PATH, {});
  const staleConsecutive = hardFailStale
    ? Number(prevHealth.staleConsecutiveRuns || 0) + 1
    : 0;

  const runHealth = {
    generatedAt: new Date().toISOString(),
    lastRunStartedAt: startedAt,
    lastRunFinishedAt: finishedAt,
    lastSuccessfulRunAt: ok ? finishedAt : (prevHealth.lastSuccessfulRunAt || null),
    staleDatasets: freshnessEval.staleDatasets,
    laggingDatasets: freshnessEval.laggingDatasets,
    staleConsecutiveRuns: staleConsecutive,
    staleDataHardFail: hardFailStale,
    criticalStaleDetected: criticalStale,
    staleHardFailEmergencyBypassActive: staleHardFailEmergencyBypassActive,
    /** @deprecated use staleHardFailEmergencyBypassActive */
    staleHardFailBypassActive: staleHardFailEmergencyBypassActive,
    partialDegradeOnStaleActive: partialDegradeOnStaleActive,
    staleHardFailSuppressed: staleHardFailSuppressed,
    degradedCriticalDatasets,
    noFreshProgress,
    softMonitorStaleDatasets: freshnessEval.softMonitorStaleDatasets,
    softMonitorLaggingDatasets: freshnessEval.softMonitorLaggingDatasets,
    dataRunOk: dataRun.ok,
    snapshotRunOk: snapshotRun.ok,
    maxLagMinutes: freshnessEval.maxLagMinutes,
  };

  writeJson(RUN_HEALTH_PATH, runHealth);
  writeJson(FRESHNESS_SLO_PATH, slo);

  return { result, runHealth, slo };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const runOnce = process.argv.includes('--once');
  const intervalMs = parseNum(
    process.env.NEUROPILOT_NEAR_LIVE_INTERVAL_MS,
    parseNum(process.env.NEUROPILOT_NEAR_LIVE_INTERVAL_SEC, 180) * 1000
  );
  const lockPath = path.join(dataRoot.getDataRoot(), '.near_live_batch.lock');
  const failOnStale = !parseBool(process.env.NEUROPILOT_ALLOW_STALE_SOFT);

  ensureDir(OPS_SNAPSHOT_DIR);
  ensureDir(path.dirname(lockPath));

  if (!acquireLock(lockPath)) {
    console.error(JSON.stringify({
      event: 'near_live_batch_lock_busy',
      lockPath,
      at: new Date().toISOString(),
    }));
    process.exit(2);
  }

  logNearLiveFreshnessEnvOnce();

  try {
    let cycle = 0;
    do {
      cycle += 1;
      const { result } = runOneCycle(cycle);
      console.error(JSON.stringify({
        event: 'near_live_batch_cycle',
        ...result,
      }));
      if (runOnce) {
        if (!result.ok || (failOnStale && result.stale_data_hard_fail)) {
          process.exitCode = 1;
        }
        break;
      }
      await sleep(intervalMs);
    } while (true);
  } finally {
    releaseLock(lockPath);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({
    event: 'near_live_batch_fatal',
    message: err && err.message ? err.message : String(err),
  }));
  process.exit(1);
});

