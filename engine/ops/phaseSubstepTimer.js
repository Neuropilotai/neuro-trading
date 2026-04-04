'use strict';

const { appendPhaseSubstepMetric } = require('./phaseSubstepMetricsStore');

function safeJsonLog(obj) {
  try {
    // eslint-disable-next-line no-console -- structured ops diagnostics only
    console.log(JSON.stringify(obj));
  } catch (_) {
    /* ignore */
  }
}

function safeWarn(obj) {
  try {
    // eslint-disable-next-line no-console -- structured ops diagnostics only
    console.warn(JSON.stringify(obj));
  } catch (_) {
    /* ignore */
  }
}

/**
 * @param {object} opts
 * @param {string|null} opts.cycleId
 * @param {string} opts.phase
 * @param {string} opts.substep
 * @param {number} opts.workerCount
 * @param {object} [opts.meta]
 * @returns {{ startedAtMs: number, startedAtIso: string, progress: Function, end: Function }|null}
 */
function startPhaseSubstep(opts) {
  try {
    const phase = String(opts && opts.phase || '');
    const substep = String(opts && opts.substep || '');
    if (!phase || !substep) return null;

    const startedAtMs = Date.now();
    const startedAtIso = new Date(startedAtMs).toISOString();
    const workerCount = Number.isFinite(Number(opts.workerCount)) ? Math.floor(Number(opts.workerCount)) : null;
    const cycleId = opts.cycleId != null ? String(opts.cycleId) : null;
    const meta = opts.meta && typeof opts.meta === 'object' ? opts.meta : null;

    safeJsonLog({
      tag: 'PHASE_SUBSTEP_START',
      ts: startedAtIso,
      cycleId,
      phase,
      substep,
      workerCount,
      startedAt: startedAtIso,
      meta,
    });

    let lastProgressLogAt = 0;
    const PROGRESS_INTERVAL_MS = 2000;

    function progress(completedUnits, totalUnits, progressMeta) {
      try {
        const c = Number(completedUnits);
        const t = Number(totalUnits);
        const now = Date.now();
        if (now - lastProgressLogAt < PROGRESS_INTERVAL_MS && c !== t && c !== 1) return;
        lastProgressLogAt = now;

        const elapsedSec = Math.max(0, Math.floor((now - startedAtMs) / 1000));
        let throughputPerMin = null;
        let etaSec = null;
        if (Number.isFinite(c) && c > 0 && elapsedSec > 0) {
          throughputPerMin = Number(((c / elapsedSec) * 60).toFixed(3));
        }
        if (Number.isFinite(c) && Number.isFinite(t) && t > 0 && c > 0 && elapsedSec > 0) {
          const rate = c / elapsedSec;
          etaSec = Math.max(0, Math.round((t - c) / Math.max(1e-9, rate)));
        }

        safeJsonLog({
          tag: 'PHASE_SUBSTEP_PROGRESS',
          ts: new Date(now).toISOString(),
          cycleId,
          phase,
          substep,
          workerCount,
          elapsedSec,
          completedUnits: Number.isFinite(c) ? c : null,
          totalUnits: Number.isFinite(t) ? t : null,
          throughputPerMin,
          etaSec,
          meta: progressMeta && typeof progressMeta === 'object' ? progressMeta : null,
        });
      } catch (_) {
        /* ignore */
      }
    }

    function end(endOpts) {
      try {
        const endedAtMs = Date.now();
        const endedAtIso = new Date(endedAtMs).toISOString();
        const durationMs = Math.max(0, endedAtMs - startedAtMs);
        const elapsedSec = Math.max(0, Math.floor(durationMs / 1000));
        const status = String((endOpts && endOpts.status) || 'unknown');
        const itemsProcessed =
          endOpts && endOpts.unitsProcessed != null && Number.isFinite(Number(endOpts.unitsProcessed))
            ? Math.floor(Number(endOpts.unitsProcessed))
            : endOpts && endOpts.itemsProcessed != null && Number.isFinite(Number(endOpts.itemsProcessed))
              ? Math.floor(Number(endOpts.itemsProcessed))
              : null;
        let throughputPerMin = null;
        if (itemsProcessed != null && durationMs > 0) {
          throughputPerMin = Number((((itemsProcessed * 1000) / durationMs) * 60).toFixed(3));
        }
        const endMeta = endOpts && endOpts.meta && typeof endOpts.meta === 'object' ? endOpts.meta : null;

        const row = {
          ts: endedAtIso,
          cycleId,
          phase,
          substep,
          startedAt: startedAtIso,
          endedAt: endedAtIso,
          durationMs,
          workerCount,
          status,
          itemsProcessed,
          throughputPerMin,
          meta: endMeta,
        };

        appendPhaseSubstepMetric(row);

        safeJsonLog({
          tag: 'PHASE_SUBSTEP_DONE',
          ts: endedAtIso,
          cycleId,
          phase,
          substep,
          workerCount,
          startedAt: startedAtIso,
          endedAt: endedAtIso,
          elapsedSec,
          durationMs,
          status,
          completedUnits: itemsProcessed,
          totalUnits: null,
          throughputPerMin,
          meta: endMeta,
        });
      } catch (e) {
        safeWarn({
          tag: 'PHASE_SUBSTEP_WARNING',
          ts: new Date().toISOString(),
          cycleId,
          phase,
          substep,
          reason: 'END_SUBSTEP_FAIL_SOFT',
          message: e && e.message ? String(e.message) : String(e),
        });
      }
    }

    return {
      startedAtMs,
      startedAtIso,
      progress,
      end,
    };
  } catch (e) {
    safeWarn({
      tag: 'PHASE_SUBSTEP_WARNING',
      ts: new Date().toISOString(),
      reason: 'START_SUBSTEP_FAIL_SOFT',
      message: e && e.message ? String(e.message) : String(e),
    });
    return null;
  }
}

function recordPhaseSubstepProgress(handle, completedUnits, totalUnits, meta) {
  if (!handle || typeof handle.progress !== 'function') return;
  try {
    handle.progress(completedUnits, totalUnits, meta);
  } catch (_) {
    /* ignore */
  }
}

/** @param {ReturnType<typeof startPhaseSubstep>} handle */
function endPhaseSubstep(handle, endOpts) {
  if (!handle || typeof handle.end !== 'function') return;
  try {
    handle.end(endOpts || {});
  } catch (_) {
    /* ignore */
  }
}

/**
 * @param {object} params
 * @param {string|null} params.cycleId
 * @param {string} params.phase
 * @param {Array<{ substep: string, durationMs: number, status: string }>} params.substeps
 */
function logPhaseBottleneckSummary(params) {
  try {
    const phase = String(params && params.phase || '');
    const cycleId = params && params.cycleId != null ? String(params.cycleId) : null;
    const list = Array.isArray(params && params.substeps) ? params.substeps : [];
    const totalDurationMs = list.reduce((a, s) => a + Math.max(0, Number(s.durationMs) || 0), 0);
    const substeps = list.map((s) => {
      const d = Math.max(0, Number(s.durationMs) || 0);
      const sharePct =
        totalDurationMs > 0 ? Number(((d / totalDurationMs) * 100).toFixed(2)) : 0;
      return {
        substep: String(s.substep || ''),
        durationMs: d,
        sharePct,
        status: String(s.status || 'unknown'),
      };
    });
    substeps.sort((a, b) => b.durationMs - a.durationMs);
    const dominant = substeps[0] || null;
    const dominantSharePct = dominant ? dominant.sharePct : 0;
    const bottleneckHint = inferBottleneckHint(substeps, dominant);

    safeJsonLog({
      tag: 'PHASE_BOTTLENECK_SUMMARY',
      ts: new Date().toISOString(),
      cycleId,
      phase,
      totalDurationMs,
      substeps,
      dominantSubstep: dominant ? dominant.substep : null,
      dominantSharePct,
      bottleneckHint,
    });
  } catch (e) {
    safeWarn({
      tag: 'PHASE_SUBSTEP_WARNING',
      ts: new Date().toISOString(),
      reason: 'BOTTLENECK_SUMMARY_FAIL_SOFT',
      message: e && e.message ? String(e.message) : String(e),
    });
  }
}

function inferBottleneckHint(sortedSubsteps, dominant) {
  if (!dominant || !sortedSubsteps.length) return 'unknown';
  if (dominant.sharePct < 25) return 'unknown';

  const name = dominant.substep.toLowerCase();
  if (name.includes('read') || name.includes('parse') || name.includes('load')) {
    return 'likely_io_bound';
  }
  if (name.includes('prefilter') || name.includes('filter')) {
    return 'likely_merge_overhead';
  }
  if (name.includes('correlation') || name.includes('compute')) {
    return 'likely_compute_bound';
  }
  if (name.includes('emit') || name.includes('observer') || name.includes('metric')) {
    return 'likely_serialization_overhead';
  }
  return 'unknown';
}

module.exports = {
  startPhaseSubstep,
  endPhaseSubstep,
  recordPhaseSubstepProgress,
  logPhaseBottleneckSummary,
};
