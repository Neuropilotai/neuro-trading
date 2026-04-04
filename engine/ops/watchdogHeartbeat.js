'use strict';

/**
 * Shared watchdog liveness for long Node jobs (same contract as bash pipeline):
 * $DATA_ROOT/loop_logs/heartbeat.log (append) + last_progress.ts (atomic epoch).
 *
 * Env:
 * - NEUROPILOT_WATCHDOG_HEARTBEAT_MIN_INTERVAL_MS — throttle for emitters (if set)
 * - NEUROPILOT_META_HEARTBEAT_MIN_INTERVAL_MS — fallback when WATCHDOG unset (default 60000)
 *
 * Per-job override: pass { minIntervalMs: N } to createWatchdogHeartbeatEmitter().
 * strategyEvolution.js also honors NEUROPILOT_EVOLUTION_HEARTBEAT_MIN_INTERVAL_MS (e.g. 30000).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MIN_INTERVAL_MS = 60000;

function resolveDataRoot() {
  return (
    process.env.NEUROPILOT_DATA_ROOT ||
    process.env.DATA_ROOT ||
    path.resolve(process.cwd(), 'data_workspace')
  );
}

function pathsFromRoot(root) {
  const loopLogDir = path.join(root, 'loop_logs');
  return {
    loopLogDir,
    heartbeatFile: path.join(loopLogDir, 'heartbeat.log'),
    lastProgressFile: path.join(loopLogDir, 'last_progress.ts'),
  };
}

function ensureLoopLogDir(loopLogDir) {
  try {
    fs.mkdirSync(loopLogDir, { recursive: true });
  } catch (_) {
    /* best-effort */
  }
}

function writeLastProgressAtomic(lastProgressFile, epochSec) {
  const tmp = `${lastProgressFile}.tmp`;
  try {
    fs.writeFileSync(tmp, `${epochSec}\n`, 'utf8');
    fs.renameSync(tmp, lastProgressFile);
  } catch (_) {
    try {
      fs.unlinkSync(tmp);
    } catch (_e) {
      /* ignore */
    }
  }
}

/**
 * @param {{ minIntervalMs?: number, dataRoot?: string }} [options]
 * @returns {(stage: string, opts?: { force?: boolean, extra?: Record<string, unknown> }) => boolean}
 */
function createWatchdogHeartbeatEmitter(options = {}) {
  const root = options.dataRoot || resolveDataRoot();
  const { loopLogDir, heartbeatFile, lastProgressFile } = pathsFromRoot(root);
  const minIntervalMs = Number(
    options.minIntervalMs ??
      process.env.NEUROPILOT_WATCHDOG_HEARTBEAT_MIN_INTERVAL_MS ??
      process.env.NEUROPILOT_META_HEARTBEAT_MIN_INTERVAL_MS ??
      DEFAULT_MIN_INTERVAL_MS
  );
  let lastHeartbeatMs = 0;
  let stageSeq = 0;

  return function emitWatchdogHeartbeat(stage, opts = {}) {
    const nowMs = Date.now();
    const force = opts.force === true;
    const extra = opts.extra && typeof opts.extra === 'object' ? opts.extra : null;

    if (!force && nowMs - lastHeartbeatMs < minIntervalMs) {
      return false;
    }

    lastHeartbeatMs = nowMs;
    stageSeq += 1;

    const iso = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const epochSec = Math.floor(nowMs / 1000);
    const experimentId = process.env.EXPERIMENT_ID || '';
    const pid = process.pid;

    let suffix = '';
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined || v === null) continue;
        const safeKey = String(k).replace(/[^A-Za-z0-9_.-]/g, '_');
        const safeVal = String(v).replace(/\s+/g, '_');
        suffix += ` ${safeKey}=${safeVal}`;
      }
    }

    const line =
      `${iso} PIPELINE_STAGE=${stage} PIPELINE_STAGE_SEQ=${stageSeq} ` +
      `pid=${pid} experiment=${experimentId}${suffix}\n`;

    try {
      ensureLoopLogDir(loopLogDir);
      fs.appendFileSync(heartbeatFile, line, 'utf8');
    } catch (_) {
      /* never throw */
    }

    writeLastProgressAtomic(lastProgressFile, epochSec);
    return true;
  };
}

module.exports = {
  resolveDataRoot,
  pathsFromRoot,
  writeLastProgressAtomic,
  createWatchdogHeartbeatEmitter,
  DEFAULT_MIN_INTERVAL_MS,
};
