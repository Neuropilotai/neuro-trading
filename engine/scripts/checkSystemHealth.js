'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_ROOT = process.env.NEUROPILOT_DATA_ROOT || '/Volumes/TradingDrive/NeuroPilotAI';
const OPS_SNAPSHOT_DIR = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR
  ? path.resolve(process.cwd(), String(process.env.NEUROPILOT_OPS_SNAPSHOT_DIR))
  : path.join(PROJECT_ROOT, 'ops-snapshot');
const RUN_HEALTH_PATH = path.join(OPS_SNAPSHOT_DIR, 'run_health.json');
const MANIFEST_PATH = path.join(DATA_ROOT, 'datasets_manifest.json');
const SMART_LOOP_LOG_DIR = path.join(DATA_ROOT, 'loop_logs');
const NEAR_LIVE_LOCK_PATH = path.join(DATA_ROOT, '.near_live_batch.lock');

const MAX_RUN_HEALTH_AGE_MIN = readNumberEnv('HEALTH_RUN_HEALTH_MAX_AGE_MIN', 20);
const MAX_XAUUSD_5M_AGE_MIN = readNumberEnv('HEALTH_XAUUSD_5M_MAX_AGE_MIN', 12);
const MAX_XAUUSD_1H_AGE_MIN = readNumberEnv('HEALTH_XAUUSD_1H_MAX_AGE_MIN', 90);

const warnings = [];
const critical = [];
const ok = [];

function readNumberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function readJsonOptional(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function minutesSince(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return null;
  return (Date.now() - t) / 60000;
}

function parseIsoToMs(v) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function processRunning(pattern) {
  try {
    execSync(`pgrep -f "${pattern}"`, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function checkProcesses() {
  const nearLivePattern = 'node .*engine/ops/nearLiveBatchScheduler\\.js';
  const smartLoopPattern = 'bash .*run-smart-evolution-loop\\.sh';
  const nearLiveUp = processRunning(nearLivePattern);
  const smartLoopUp = processRunning(smartLoopPattern);

  if (nearLiveUp) ok.push('near-live process alive');
  else critical.push('near-live process not running');

  if (smartLoopUp) ok.push('smart loop process alive');
  else critical.push('smart loop process not running');
}

function checkNearLiveLock() {
  if (!fs.existsSync(NEAR_LIVE_LOCK_PATH)) {
    ok.push('near-live lock not present (idle between cycles)');
    return;
  }

  const lock = readJsonOptional(NEAR_LIVE_LOCK_PATH);
  const pid = lock && Number(lock.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    critical.push('near-live lock exists but pid is invalid');
    return;
  }

  try {
    process.kill(pid, 0);
    ok.push(`near-live lock coherent (pid ${pid} alive)`);
  } catch (_) {
    critical.push(`near-live lock is stale (pid ${pid} not alive)`);
  }
}

function checkRunHealthFreshness() {
  const runHealth = readJsonOptional(RUN_HEALTH_PATH);
  if (!runHealth) {
    critical.push(`run_health.json missing or invalid at ${RUN_HEALTH_PATH}`);
    return;
  }

  const finishedAtMs = parseIsoToMs(runHealth.lastRunFinishedAt);
  if (!Number.isFinite(finishedAtMs)) {
    critical.push('run_health.json missing valid lastRunFinishedAt');
    return;
  }

  const ageMin = minutesSince(finishedAtMs);
  if (ageMin == null) {
    critical.push('unable to compute run_health age');
    return;
  }

  if (ageMin > MAX_RUN_HEALTH_AGE_MIN) {
    critical.push(`run_health stale: lastRunFinishedAt age ${ageMin.toFixed(1)} min > ${MAX_RUN_HEALTH_AGE_MIN} min`);
  } else {
    ok.push(`run_health fresh: ${ageMin.toFixed(1)} min`);
  }
}

function checkManifestAge(datasetKey, maxAgeMin) {
  const manifest = readJsonOptional(MANIFEST_PATH);
  if (!manifest || typeof manifest !== 'object' || typeof manifest.datasets !== 'object') {
    critical.push(`datasets_manifest.json missing or invalid at ${MANIFEST_PATH}`);
    return;
  }

  const entry = manifest.datasets[datasetKey];
  if (!entry || typeof entry !== 'object') {
    critical.push(`dataset missing in manifest: ${datasetKey}`);
    return;
  }

  const lastTs = Number(entry.lastTs);
  if (!Number.isFinite(lastTs) || lastTs <= 0) {
    critical.push(`dataset ${datasetKey} has invalid lastTs`);
    return;
  }

  const ageMin = minutesSince(lastTs);
  if (ageMin == null) {
    critical.push(`unable to compute age for ${datasetKey}`);
    return;
  }

  if (ageMin > maxAgeMin) {
    warnings.push(`dataset ${datasetKey} stale: ${ageMin.toFixed(1)} min > ${maxAgeMin} min`);
  } else {
    ok.push(`dataset ${datasetKey} fresh: ${ageMin.toFixed(1)} min`);
  }
}

function newestSmartLoopLogPath() {
  if (!fs.existsSync(SMART_LOOP_LOG_DIR)) return null;
  const files = fs
    .readdirSync(SMART_LOOP_LOG_DIR)
    .filter((f) => /^smart_loop_.*\.log$/i.test(f))
    .map((f) => path.join(SMART_LOOP_LOG_DIR, f));
  if (files.length === 0) return null;
  files.sort((a, b) => {
    const aMs = fs.statSync(a).mtimeMs;
    const bMs = fs.statSync(b).mtimeMs;
    return bMs - aMs;
  });
  return files[0];
}

function checkSmartLoopLog() {
  const p = newestSmartLoopLogPath();
  if (!p) {
    warnings.push(`no smart loop log found in ${SMART_LOOP_LOG_DIR}`);
    return;
  }

  const content = fs.readFileSync(p, 'utf8');
  const tail = content.slice(Math.max(0, content.length - 250000));
  const low = tail.toLowerCase();

  if (low.includes('pipeline exited with code 1')) {
    critical.push(`latest smart loop log has pipeline failure: ${p}`);
  } else {
    ok.push('latest smart loop log has no pipeline code 1');
  }

  const hasGuardSkip = low.includes('skipped_data_guard_degraded');
  if (!hasGuardSkip) {
    ok.push('latest smart loop log has no skipped_data_guard_degraded');
    return;
  }

  if (low.includes('xauusd_5m') || low.includes('xauusd_1h')) {
    critical.push(`latest smart loop log still skips degraded critical dataset(s): ${p}`);
  } else {
    warnings.push(`latest smart loop log includes skipped_data_guard_degraded: ${p}`);
  }
}

function printResults() {
  for (const msg of ok) {
    console.log(`OK ${msg}`);
  }
  for (const msg of warnings) {
    console.log(`WARN ${msg}`);
  }
  for (const msg of critical) {
    console.log(`CRIT ${msg}`);
  }

  if (critical.length > 0) {
    console.log(`STATUS CRITICAL (${critical.length} critical, ${warnings.length} warning)`);
    process.exit(2);
  }
  if (warnings.length > 0) {
    console.log(`STATUS WARNING (0 critical, ${warnings.length} warning)`);
    process.exit(1);
  }
  console.log('STATUS OK');
  process.exit(0);
}

function main() {
  checkProcesses();
  checkNearLiveLock();
  checkRunHealthFreshness();
  checkManifestAge('XAUUSD_5m', MAX_XAUUSD_5M_AGE_MIN);
  checkManifestAge('XAUUSD_1h', MAX_XAUUSD_1H_AGE_MIN);
  checkSmartLoopLog();
  printResults();
}

main();
