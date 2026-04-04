'use strict';

/**
 * Minimal ops alerting from existing snapshots (no dashboard required).
 *
 * Reads:
 * - ops-snapshot/execution_status.json
 * - ops-snapshot/run_health.json (optional)
 *
 * Persists checkpoint under data root: governance/ops_alert_checkpoint.json
 *
 * Env:
 * - NEUROPILOT_OPS_ALERT_WEBHOOK_URL — optional POST JSON (Slack-compatible { text })
 * - NEUROPILOT_OPS_ALERT_WEBHOOK_DISCORD=1 — use { content } instead of { text } (Discord)
 * - NEUROPILOT_OPS_SNAPSHOT_DIR — override path to ops-snapshot (absolute or cwd-relative)
 * - NEUROPILOT_OPS_ALERT_UNMATCHED_MIN_DELTA — min increase to fire (default 1)
 *
 * Never logs the webhook URL or token.
 *
 * Stable alert codes (for parsers / playbooks):
 * - reconciliation_degraded  (CRIT) — degraded false → true
 * - drift_flag_new           (WARN) — new entry in driftFlags vs checkpoint
 * - stale_data_hard_fail     (CRIT) — staleDataHardFail false → true
 * - unmatched_fills_increase (WARN) — unmatchedFillsCount jumped by ≥ min delta
 * - lagging_pressure (WARN) — lagging dataset pressure crossed threshold (ops-only; never blocking)
 *
 * Each alert includes both `severity` (crit|warn|info) and deprecated `level`
 * (critical|warn|info) for backward compatibility with callers expecting `.level`.
 *
 * Checkpoint contract (governance/ops_alert_checkpoint.json):
 * - laggingPressureActive — derived flag for UX/alerting transitions only (vs datasets_freshness laggingSummary).
 *   NOT a domain source of truth. MUST NOT be consumed by evolution, trading, promotion, or datasetDegradedGuard.
 *   Never use for blocking or skip logic; blocking remains run_health.degradedCriticalDatasets + execution_status only.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const dataRoot = require('../dataRoot');

const CHECKPOINT_VERSION = '1.0.0';

/** Stable codes — do not rename without migration note. */
const ALERT_CODES = Object.freeze({
  RECONCILIATION_DEGRADED: 'reconciliation_degraded',
  DRIFT_FLAG_NEW: 'drift_flag_new',
  STALE_DATA_HARD_FAIL: 'stale_data_hard_fail',
  UNMATCHED_FILLS_INCREASE: 'unmatched_fills_increase',
  LAGGING_PRESSURE: 'lagging_pressure',
});

const SEVERITY = Object.freeze({
  CRIT: 'crit',
  WARN: 'warn',
  INFO: 'info',
});

/** Display prefix — single mapping from canonical severity (do not duplicate elsewhere). */
function severityPrefix(severity) {
  switch (severity) {
    case SEVERITY.CRIT:
      return 'CRIT';
    case SEVERITY.WARN:
      return 'WARN';
    default:
      return 'INFO';
  }
}

/** Deprecated mirror for consumers that still read `alert.level`. */
function severityToLegacyLevel(severity) {
  switch (severity) {
    case SEVERITY.CRIT:
      return 'critical';
    case SEVERITY.WARN:
      return 'warn';
    default:
      return 'info';
  }
}

function mapLegacyLevelToSeverity(level) {
  if (level == null) return SEVERITY.INFO;
  const l = String(level).toLowerCase();
  if (l === 'critical' || l === 'crit') return SEVERITY.CRIT;
  if (l === 'warn' || l === 'warning') return SEVERITY.WARN;
  if (l === 'info') return SEVERITY.INFO;
  return SEVERITY.INFO;
}

function parseRatioEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * True when lagging-only pressure should raise an ops warning (non-blocking).
 * Rule: count >= minCount OR worstRatio > ratioThreshold (see env).
 * @param {object|null|undefined} datasetFreshness - from datasets_freshness.json (laggingSummary)
 */
function laggingPressureActive(datasetFreshness) {
  const s = datasetFreshness && datasetFreshness.laggingSummary;
  if (!s || !Number.isFinite(Number(s.count)) || Number(s.count) < 1) return false;
  const minCount = Math.max(1, Math.floor(Number(process.env.NEUROPILOT_OPS_ALERT_LAGGING_MIN_COUNT) || 2));
  const ratioThr = parseRatioEnv('NEUROPILOT_OPS_ALERT_LAGGING_RATIO', 0.8);
  if (Number(s.count) >= minCount) return true;
  if (Number(s.worstRatio) > ratioThr) return true;
  return false;
}

/**
 * Normalize alert shape: always has `severity` + deprecated `level`.
 * @param {object} a
 * @returns {{ severity: string, level: string, code: string, message: string }}
 */
function normalizeAlert(a) {
  if (!a || typeof a !== 'object') {
    return {
      severity: SEVERITY.INFO,
      level: 'info',
      code: 'invalid_alert',
      message: '',
    };
  }
  const severity = a.severity || mapLegacyLevelToSeverity(a.level);
  return {
    severity,
    level: severityToLegacyLevel(severity),
    code: a.code != null ? String(a.code) : '',
    message: a.message != null ? String(a.message) : '',
  };
}

function buildAlert({ severity, code, message }) {
  return normalizeAlert({ severity, code, message });
}

/**
 * @param {{ severity?: string, level?: string, code: string, message: string }} a
 */
function formatAlertLine(a) {
  const n = normalizeAlert(a);
  return `[${severityPrefix(n.severity)}] ${n.code} | ${n.message}`;
}

function defaultSnapshotDir() {
  const env = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR;
  if (env && String(env).trim()) {
    return path.resolve(process.cwd(), String(env).trim());
  }
  return path.join(__dirname, '..', '..', 'ops-snapshot');
}

function checkpointPath() {
  return path.join(dataRoot.getPath('governance'), 'ops_alert_checkpoint.json');
}

function loadJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function loadJsonOptional(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return loadJsonFile(filePath);
  } catch (_) {
    return null;
  }
}

function normalizeDrift(flags) {
  if (!Array.isArray(flags)) return [];
  return [...new Set(flags.map((f) => String(f)))].sort();
}

function postWebhook(payload) {
  const urlStr = process.env.NEUROPILOT_OPS_ALERT_WEBHOOK_URL;
  if (!urlStr || !String(urlStr).trim()) {
    return Promise.resolve({ skipped: true });
  }
  const url = new URL(String(urlStr).trim());
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
      },
      (res) => {
        let drain = '';
        res.on('data', (c) => {
          drain += c;
        });
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          if (!ok) {
            return reject(new Error(`webhook HTTP ${res.statusCode}`));
          }
          resolve({ ok: true });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('webhook timeout'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * @param {object|null|undefined} datasetFreshness - optional; datasets_freshness.json payload for lagging_pressure
 * @returns {{ alerts: Array<{ severity: string, level: string, code: string, message: string }>, nextCheckpoint: { laggingPressureActive?: boolean, ... }, baselineOnly: boolean }}
 * nextCheckpoint.laggingPressureActive: ops/UX only — see file header checkpoint contract.
 */
function evaluateOpsAlerts(exec, health, prev, datasetFreshness) {
  const alerts = [];
  const unmatched = Number(exec.unmatchedFillsCount) || 0;
  const degraded = exec.reconciliationDegraded === true;
  const drift = normalizeDrift(exec.driftFlags);
  const staleFail = health && health.staleDataHardFail === true;
  const genAt = exec.generatedAt != null ? String(exec.generatedAt) : null;
  const laggingActive = laggingPressureActive(datasetFreshness);
  const degCriticalCount =
    health && Array.isArray(health.degradedCriticalDatasets) ? health.degradedCriticalDatasets.length : 0;

  const minDelta = Math.max(1, Math.floor(Number(process.env.NEUROPILOT_OPS_ALERT_UNMATCHED_MIN_DELTA) || 1));

  if (!prev) {
    return {
      alerts,
      baselineOnly: true,
      nextCheckpoint: {
        version: CHECKPOINT_VERSION,
        updatedAt: new Date().toISOString(),
        executionGeneratedAt: genAt,
        reconciliationDegraded: degraded,
        driftFlags: drift,
        unmatchedFillsCount: unmatched,
        staleDataHardFail: Boolean(staleFail),
        laggingPressureActive: Boolean(laggingActive),
      },
    };
  }

  if (degraded && !prev.reconciliationDegraded) {
    alerts.push(
      buildAlert({
        severity: SEVERITY.CRIT,
        code: ALERT_CODES.RECONCILIATION_DEGRADED,
        message: 'reconciliationDegraded transitioned to true (review reconcile / broker read)',
      })
    );
  }

  const prevDrift = new Set(normalizeDrift(prev.driftFlags));
  for (const flag of drift) {
    if (!prevDrift.has(flag)) {
      alerts.push(
        buildAlert({
          severity: SEVERITY.WARN,
          code: ALERT_CODES.DRIFT_FLAG_NEW,
          message: `new drift flag: ${flag}`,
        })
      );
    }
  }

  if (staleFail && !prev.staleDataHardFail) {
    alerts.push(
      buildAlert({
        severity: SEVERITY.CRIT,
        code: ALERT_CODES.STALE_DATA_HARD_FAIL,
        message: 'staleDataHardFail is true (see run_health / pipeline)',
      })
    );
  }

  const prevUnmatched = Number(prev.unmatchedFillsCount) || 0;
  if (unmatched >= prevUnmatched + minDelta) {
    alerts.push(
      buildAlert({
        severity: SEVERITY.WARN,
        code: ALERT_CODES.UNMATCHED_FILLS_INCREASE,
        message: `unmatchedFillsCount increased: ${prevUnmatched} → ${unmatched} (min delta ${minDelta})`,
      })
    );
  }

  const prevLaggingPressure = prev.laggingPressureActive === true;
  if (laggingActive && !prevLaggingPressure) {
    const s = datasetFreshness && datasetFreshness.laggingSummary;
    const n = s && Number.isFinite(Number(s.count)) ? Number(s.count) : 0;
    const maxL = s && s.maxLagMinutes != null && Number.isFinite(Number(s.maxLagMinutes)) ? Number(s.maxLagMinutes) : null;
    const wk = s && s.worstKey != null ? String(s.worstKey) : '—';
    alerts.push(
      buildAlert({
        severity: SEVERITY.WARN,
        code: ALERT_CODES.LAGGING_PRESSURE,
        message:
          `[LAGGING_ALERT] Datasets lagging: ${n} | Max lag: ${maxL != null ? `${maxL} min` : '—'} (${wk}) | ` +
          `No blocking impact from lagging alone (critical degraded datasets: ${degCriticalCount})`,
      })
    );
  }

  return {
    alerts,
    baselineOnly: false,
    nextCheckpoint: {
      version: CHECKPOINT_VERSION,
      updatedAt: new Date().toISOString(),
      executionGeneratedAt: genAt,
      reconciliationDegraded: degraded,
      driftFlags: drift,
      unmatchedFillsCount: unmatched,
      staleDataHardFail: Boolean(staleFail),
      laggingPressureActive: Boolean(laggingActive),
    },
  };
}

function formatAlertsText(alerts) {
  const lines = alerts.map((a) => formatAlertLine(a));
  return `NeuroPilot ops alerts (${alerts.length})\n${lines.join('\n')}`.slice(0, 1900);
}

function writeCheckpoint(cp) {
  const p = checkpointPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cp, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function readCheckpoint() {
  const p = checkpointPath();
  if (!fs.existsSync(p)) return null;
  try {
    return loadJsonFile(p);
  } catch (_) {
    return null;
  }
}

/**
 * @returns {Promise<{ alerts: object[], exitCode: number }>}
 */
async function runOpsAlertsCli() {
  const snapDir = defaultSnapshotDir();
  const execPath = path.join(snapDir, 'execution_status.json');
  const healthPath = path.join(snapDir, 'run_health.json');
  const freshnessPath = path.join(snapDir, 'datasets_freshness.json');

  if (!fs.existsSync(execPath)) {
    console.error(
      `[CRIT] ops_snapshot_missing | execution_status.json not found (${execPath}); run exportOpsSnapshot first`
    );
    return { alerts: [], exitCode: 1 };
  }

  const exec = loadJsonFile(execPath);
  const health = loadJsonOptional(healthPath);
  const datasetFreshness = loadJsonOptional(freshnessPath);
  const prev = readCheckpoint();

  const { alerts, nextCheckpoint, baselineOnly } = evaluateOpsAlerts(exec, health, prev, datasetFreshness);

  if (baselineOnly) {
    writeCheckpoint(nextCheckpoint);
    console.log(
      '[INFO] ops_alert_checkpoint_initialized | baseline written; no transition alerts on this run'
    );
    return { alerts: [], exitCode: 0 };
  }

  for (const a of alerts) {
    console.error(`opsAlerts: ${formatAlertLine(a)}`);
  }

  if (alerts.length === 0) {
    console.log('[INFO] ops_alerts_ok | no new incidents vs checkpoint');
  }

  writeCheckpoint(nextCheckpoint);

  const webhookSet = Boolean(process.env.NEUROPILOT_OPS_ALERT_WEBHOOK_URL && String(process.env.NEUROPILOT_OPS_ALERT_WEBHOOK_URL).trim());
  if (webhookSet && alerts.length > 0) {
    const text = formatAlertsText(alerts);
    const discord = process.env.NEUROPILOT_OPS_ALERT_WEBHOOK_DISCORD === '1';
    const payload = discord ? { content: text } : { text };
    try {
      await postWebhook(payload);
      console.log('[INFO] ops_alert_webhook_sent | notify delivered');
    } catch (e) {
      const msg = e && e.message ? e.message : 'webhook failed';
      console.error(`[WARN] ops_alert_webhook_failed | ${msg}`);
      return { alerts, exitCode: 2 };
    }
  }

  const exitOnAlert = process.env.NEUROPILOT_OPS_ALERT_EXIT_ON_ALERT === '1';
  return { alerts, exitCode: exitOnAlert && alerts.length > 0 ? 3 : 0 };
}

module.exports = {
  evaluateOpsAlerts,
  laggingPressureActive,
  runOpsAlertsCli,
  defaultSnapshotDir,
  checkpointPath,
  readCheckpoint,
  ALERT_CODES,
  SEVERITY,
  formatAlertLine,
  severityPrefix,
  normalizeAlert,
  buildAlert,
  severityToLegacyLevel,
  mapLegacyLevelToSeverity,
};

if (require.main === module) {
  runOpsAlertsCli()
    .then(({ exitCode }) => process.exit(exitCode))
    .catch((e) => {
      console.error(e && e.message ? e.message : e);
      process.exit(1);
    });
}
