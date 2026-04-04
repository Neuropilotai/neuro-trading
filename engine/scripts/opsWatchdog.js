'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { spawnSync, execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_ROOT = process.env.NEUROPILOT_DATA_ROOT || '/Volumes/TradingDrive/NeuroPilotAI';
const CHECK_SCRIPT = path.join(PROJECT_ROOT, 'engine', 'scripts', 'checkSystemHealth.js');
const SNAPSHOT_DIR = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR
  ? path.resolve(process.cwd(), String(process.env.NEUROPILOT_OPS_SNAPSHOT_DIR))
  : path.join(PROJECT_ROOT, 'ops-snapshot');
const HISTORY_PATH = path.join(SNAPSHOT_DIR, 'watchdog_health_history.jsonl');

const INTERVAL_SEC = Math.max(60, Number(process.env.NEUROPILOT_WATCHDOG_INTERVAL_SEC || 300));
const NEARLIVE_LABEL = process.env.NEUROPILOT_NEARLIVE_LABEL || 'com.neuropilot.nearlive';
const SMARTLOOP_LABEL = process.env.NEUROPILOT_SMARTLOOP_LABEL || 'com.neuropilot.smartloop';
const ONE_SHOT = process.env.NEUROPILOT_WATCHDOG_ONE_SHOT === '1';
const FORCE_CRIT = process.env.NEUROPILOT_WATCHDOG_FORCE_CRIT === '1';
const IS_SMOKETEST = FORCE_CRIT;

function nowIso() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[opsWatchdog ${nowIso()}] ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function processRunning(pattern) {
  try {
    execSync(`pgrep -f "${pattern}"`, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function restartService(label) {
  try {
    const cmd = `launchctl kickstart -k gui/$(id -u)/${label}`;
    execSync(cmd, { stdio: 'pipe' });
    return { ok: true, command: cmd };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function runHealthCheck() {
  if (FORCE_CRIT) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: '',
      oks: [],
      warns: ['WARN forced watchdog critical test mode'],
      crits: ['CRIT forced watchdog critical test mode'],
    };
  }

  const res = spawnSync(process.execPath, [CHECK_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: process.env,
    encoding: 'utf8',
  });

  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const lines = `${stdout}\n${stderr}`
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const warns = lines.filter((l) => l.startsWith('WARN '));
  const crits = lines.filter((l) => l.startsWith('CRIT '));
  const oks = lines.filter((l) => l.startsWith('OK '));

  return {
    exitCode: Number.isInteger(res.status) ? res.status : 1,
    stdout,
    stderr,
    oks,
    warns,
    crits,
  };
}

function appendSnapshot(entry) {
  ensureDir(path.dirname(HISTORY_PATH));
  fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}

function webhookUrl() {
  const candidates = [
    process.env.NEUROPILOT_WATCHDOG_WEBHOOK_URL,
    process.env.NEUROPILOT_OPS_ALERT_WEBHOOK_URL,
    process.env.SLACK_WEBHOOK_URL,
    process.env.DISCORD_WEBHOOK_URL,
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) return String(c).trim();
  }
  return '';
}

function isDiscordPayload() {
  if (process.env.NEUROPILOT_WATCHDOG_WEBHOOK_DISCORD === '1') return true;
  return process.env.NEUROPILOT_OPS_ALERT_WEBHOOK_DISCORD === '1';
}

function postWebhook(text) {
  const u = webhookUrl();
  if (!u) return Promise.resolve({ skipped: true });
  const payload = isDiscordPayload() ? { content: text } : { text };
  const body = JSON.stringify(payload);
  const url = new URL(u);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true });
          return reject(new Error(`webhook HTTP ${res.statusCode}`));
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('webhook timeout')));
    req.write(body);
    req.end();
  });
}

async function runCycle() {
  const nearLiveUp = processRunning('node .*engine/ops/nearLiveBatchScheduler\\.js');
  const smartLoopUp = processRunning('bash .*run-smart-evolution-loop\\.sh');

  const restart = {
    nearLiveAttempted: false,
    nearLiveOk: true,
    smartLoopAttempted: false,
    smartLoopOk: true,
  };

  if (!nearLiveUp) {
    restart.nearLiveAttempted = true;
    const r = restartService(NEARLIVE_LABEL);
    restart.nearLiveOk = r.ok;
    log(r.ok ? `near-live restarted (${NEARLIVE_LABEL})` : `near-live restart failed (${NEARLIVE_LABEL})`);
  }

  if (!smartLoopUp) {
    restart.smartLoopAttempted = true;
    const r = restartService(SMARTLOOP_LABEL);
    restart.smartLoopOk = r.ok;
    log(r.ok ? `smart-loop restarted (${SMARTLOOP_LABEL})` : `smart-loop restart failed (${SMARTLOOP_LABEL})`);
  }

  const health = runHealthCheck();
  const snapshot = {
    generatedAt: nowIso(),
    intervalSec: INTERVAL_SEC,
    healthExitCode: health.exitCode,
    okCount: health.oks.length,
    warnCount: health.warns.length,
    critCount: health.crits.length,
    restart,
  };
  appendSnapshot(snapshot);

  if (health.exitCode === 2) {
    const prefix = IS_SMOKETEST ? '[TEST]' : '[ALERT]';
    const body = [
      `${prefix} NeuroPilot WATCHDOG CRITICAL`,
      `exit=2`,
      `warn=${health.warns.length} crit=${health.crits.length}`,
      `restarts nearLive=${restart.nearLiveAttempted ? (restart.nearLiveOk ? 'ok' : 'fail') : 'n/a'} smartLoop=${restart.smartLoopAttempted ? (restart.smartLoopOk ? 'ok' : 'fail') : 'n/a'}`,
      ...health.crits.slice(0, 6),
      ...health.warns.slice(0, 4),
    ].join('\n');
    try {
      await postWebhook(body.slice(0, 1800));
      log('critical alert delivered to webhook');
    } catch (e) {
      log(`critical alert webhook failed: ${e && e.message ? e.message : e}`);
    }
  }

  log(`cycle done exit=${health.exitCode} warn=${health.warns.length} crit=${health.crits.length}`);
}

async function main() {
  log(`watchdog started interval=${INTERVAL_SEC}s dataRoot=${DATA_ROOT} oneShot=${ONE_SHOT ? '1' : '0'} forceCrit=${FORCE_CRIT ? '1' : '0'}`);
  // Immediate first pass, then periodic passes unless one-shot mode.
  await runCycle();
  if (ONE_SHOT) {
    log('one-shot mode complete');
    return;
  }
  setInterval(() => {
    runCycle().catch((e) => log(`cycle error: ${e && e.message ? e.message : e}`));
  }, INTERVAL_SEC * 1000);
}

main().catch((e) => {
  log(`fatal: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
