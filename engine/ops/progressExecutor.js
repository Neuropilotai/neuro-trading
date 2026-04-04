#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_ACTIONS_PER_RUN = 1;
const ALLOWED_TYPES = new Set(['data_repair', 'validation_growth']);
const FORBIDDEN_TYPES = new Set(['owner_decision', 'governance_resolution', 'promotion_growth']);
const DEFAULT_COOLDOWN_MIN = 10;

function safeString(v, fallback = '') {
  return v == null ? fallback : String(v);
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function safeBool(v) {
  return v === true;
}

function toPriority(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJsonBestEffort(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) {
    // best effort only
  }
}

function parseIsoMs(ts) {
  const ms = new Date(safeString(ts, '')).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function cooldownMinutes() {
  const n = Number(process.env.NEUROPILOT_PROGRESS_EXECUTOR_COOLDOWN_MIN);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_COOLDOWN_MIN;
  return Math.floor(n);
}

function readExecutorState(statePath) {
  const s = readJson(statePath);
  if (!s || typeof s !== 'object') {
    return {
      lastRunAt: null,
      lastExecutedActionId: null,
      actions: {},
    };
  }
  const actions = s.actions && typeof s.actions === 'object' ? s.actions : {};
  return {
    lastRunAt: s.lastRunAt ? String(s.lastRunAt) : null,
    lastExecutedActionId: s.lastExecutedActionId ? String(s.lastExecutedActionId) : null,
    actions,
  };
}

function resultBase(status, reason) {
  return {
    mode: 'execute_limited',
    status,
    executed: false,
    executedActionId: null,
    executedActionType: null,
    skipped: true,
    reason: safeString(reason, ''),
    safety: {
      maxActionsPerRun: MAX_ACTIONS_PER_RUN,
      whitelistEnforced: true,
    },
    generatedAt: new Date().toISOString(),
  };
}

function runValidationGrowthSafe(repoRoot) {
  const { computeStrategyValidationFromFile } = require('../governance/computeStrategyValidationFramework');
  const dataRoot = require('../dataRoot');
  const govDir = dataRoot.getPath('governance', true);
  const paperTradesPath = path.join(govDir, 'paper_trades.jsonl');
  const snapshotDir = path.join(repoRoot, 'ops-snapshot');
  const outValidationPath = path.join(snapshotDir, 'strategy_validation.json');
  try {
    // Real, bounded business hook: compute validation state from existing paper trades.
    const payload = computeStrategyValidationFromFile(paperTradesPath);
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(outValidationPath, JSON.stringify(payload, null, 2), 'utf8');
    execFileSync(process.execPath, ['engine/evolution/scripts/exportOpsSnapshot.js'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return {
      simulated: false,
      reason: 'VALIDATION_FRAMEWORK_SCOPED',
      attemptedRealHook: true,
      realHookName: 'computeStrategyValidationFramework.js',
      fallbackReason: null,
    };
  } catch (e) {
    const msg = safeString(e && e.message, '');
    if (msg.includes('EPERM') || msg.includes('operation not permitted') || msg.includes('EACCES')) {
      // Safe fallback: refresh-only if real hook is blocked by environment permissions.
      execFileSync(process.execPath, ['engine/evolution/scripts/exportOpsSnapshot.js'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      return {
        simulated: true,
        reason: 'validation_growth_refresh_only',
        attemptedRealHook: true,
        realHookName: 'computeStrategyValidationFramework.js',
        fallbackReason: 'VALIDATION_HOOK_PERMISSION_BLOCKED',
      };
    }
    throw e;
  }
}

function runDataRepairSafe(repoRoot) {
  // Safe bounded hook: existing OANDA backfill utility, scoped to core symbol/timeframes.
  try {
    execFileSync(
      process.execPath,
      ['engine/scripts/backfillOanda.js', '--symbols', 'XAUUSD', '--timeframes', '5m,15m,1h', '--days', '90'],
      {
        cwd: repoRoot,
        stdio: 'pipe',
      }
    );
    // Refresh ops snapshot after data repair hook.
    execFileSync(process.execPath, ['engine/evolution/scripts/exportOpsSnapshot.js'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return {
      simulated: false,
      reason: 'OANDA_BACKFILL_SCOPED',
      attemptedRealHook: true,
      realHookName: 'backfillOanda.js',
      fallbackReason: null,
    };
  } catch (e) {
    const msg = safeString(e && e.message, '');
    if (msg.includes('EPERM') || msg.includes('operation not permitted') || msg.includes('EACCES')) {
      return {
        simulated: true,
        reason: 'DATA_REPAIR_HOOK_PERMISSION_BLOCKED',
        attemptedRealHook: true,
        realHookName: 'backfillOanda.js',
        fallbackReason: 'DATA_REPAIR_HOOK_PERMISSION_BLOCKED',
      };
    }
    throw e;
  }
}

function main() {
  const defaultLatest = path.join(__dirname, '..', '..', 'ops-snapshot', 'latest.json');
  const latestPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultLatest;
  const snapshotDir = path.dirname(latestPath);
  const dryRunPath = path.join(snapshotDir, 'progress_executor_dry_run.json');
  const outPath = path.join(snapshotDir, 'progress_executor_execution.json');
  const statePath = path.join(snapshotDir, 'progress_executor_state.json');
  const repoRoot = path.join(__dirname, '..', '..');

  try {
    const latest = readJson(latestPath);
    const dryRun = readJson(dryRunPath);
    if (!latest || !dryRun || typeof latest !== 'object' || typeof dryRun !== 'object') {
      const out = resultBase('executor_error', 'SAFE_ERROR_INPUT_MISSING');
      writeJsonBestEffort(outPath, out);
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }

    const plan = latest.phaseActionPlan && typeof latest.phaseActionPlan === 'object' ? latest.phaseActionPlan : null;
    const planActions = safeArray(plan && plan.actions);
    const planById = new Map(planActions.map((a) => [safeString(a && a.id), a]));
    const state = readExecutorState(statePath);
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const cooldownMs = cooldownMinutes() * 60 * 1000;

    const eligibleFromDryRun = safeArray(dryRun.results)
      .filter((r) => safeString(r && r.decision) === 'eligible')
      .map((r) => {
        const id = safeString(r && r.id);
        const planAction = planById.get(id) || {};
        return {
          id,
          type: safeString(r && r.type, safeString(planAction.type)),
          gate: safeString(r && r.gate, safeString(planAction.gate)),
          inputPriority: Number.isFinite(Number(r && r.inputPriority))
            ? Number(r.inputPriority)
            : toPriority(planAction.priority),
          ownerApprovalRequired: safeBool(r && r.ownerApprovalRequired) || safeBool(planAction.ownerApprovalRequired),
          blockingType: safeString(r && r.blockingType, safeString(planAction.blockingType)),
          status: safeString(planAction.status, ''),
        };
      })
      .sort((a, b) => a.inputPriority - b.inputPriority || a.id.localeCompare(b.id));

    const candidates = [];
    const cooldownBlocked = [];
    for (const a of eligibleFromDryRun) {
      if (!a.id || !a.type) continue;
      if (a.ownerApprovalRequired || a.blockingType === 'owner_gated' || a.status === 'blocked_pending_owner') continue;
      if (a.blockingType !== 'auto_fixable') continue;
      if (FORBIDDEN_TYPES.has(a.type)) continue;
      if (!ALLOWED_TYPES.has(a.type)) continue;
      const st = state.actions && state.actions[a.id] && typeof state.actions[a.id] === 'object'
        ? state.actions[a.id]
        : null;
      const lastExecutedMs = parseIsoMs(st && st.lastExecutedAt);
      const inCooldown = lastExecutedMs > 0 && (nowMs - lastExecutedMs) < cooldownMs;
      if (inCooldown) {
        cooldownBlocked.push({
          id: a.id,
          type: a.type,
          gate: a.gate,
          inputPriority: a.inputPriority,
          ownerApprovalRequired: false,
          blockingType: a.blockingType,
          cooldownRemainingSec: Math.max(0, Math.ceil((cooldownMs - (nowMs - lastExecutedMs)) / 1000)),
        });
        continue;
      }
      candidates.push(a);
    }

    if (candidates.length === 0) {
      const out = resultBase('executor_idle', cooldownBlocked.length > 0 ? 'blocked_cooldown' : 'no_safe_action_available');
      if (cooldownBlocked.length > 0) {
        out.cooldown = {
          minutes: cooldownMinutes(),
          blockedActionIds: cooldownBlocked.map((x) => x.id),
        };
      }
      state.lastRunAt = nowIso;
      writeJsonBestEffort(statePath, state);
      writeJsonBestEffort(outPath, out);
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }

    let chosen = candidates[0]; // max 1 action per run
    // Replay guard: if the top eligible action matches the previous run's executed action
    // and another eligible action exists, rotate to the next candidate.
    if (
      candidates.length > 1 &&
      state.lastExecutedActionId &&
      safeString(chosen && chosen.id) === safeString(state.lastExecutedActionId)
    ) {
      const rotated = candidates.find((c) => safeString(c && c.id) !== safeString(state.lastExecutedActionId));
      if (rotated) chosen = rotated;
    }
    const out = resultBase('executor_success', '');
    out.executed = true;
    out.executedActionId = chosen.id;
    out.executedActionType = chosen.type;
    out.skipped = false;

    if (chosen.type === 'validation_growth') {
      const valRes = runValidationGrowthSafe(repoRoot);
      out.reason = valRes.simulated ? 'validation_growth_refresh_only' : 'executed_validation_growth_safe_hook';
      out.attemptedRealHook = valRes.attemptedRealHook === true;
      out.realHookName = safeString(valRes.realHookName, null);
      out.fallbackReason = valRes.fallbackReason != null ? safeString(valRes.fallbackReason) : null;
      if (valRes.reason) out.validationMode = safeString(valRes.reason);
    } else if (chosen.type === 'data_repair') {
      const dataRes = runDataRepairSafe(repoRoot);
      out.reason = dataRes.simulated ? 'executed_data_repair_simulated' : 'executed_data_repair_safe_hook';
      if (dataRes.reason) out.dataRepairMode = dataRes.reason;
      out.attemptedRealHook = dataRes.attemptedRealHook === true;
      out.realHookName = safeString(dataRes.realHookName, 'backfillOanda.js');
      out.fallbackReason = dataRes.fallbackReason != null ? safeString(dataRes.fallbackReason) : null;
    } else {
      out.executed = false;
      out.executedActionId = null;
      out.executedActionType = null;
      out.skipped = true;
      out.status = 'executor_idle';
      out.reason = 'no_safe_action_available';
      out.attemptedRealHook = false;
      out.realHookName = null;
      out.fallbackReason = null;
    }

    // Update local execution memory/cooldown state.
    const prev = state.actions && state.actions[chosen.id] && typeof state.actions[chosen.id] === 'object'
      ? state.actions[chosen.id]
      : {};
    state.actions[chosen.id] = {
      lastExecutedAt: nowIso,
      runCount: Number.isFinite(Number(prev.runCount)) ? Number(prev.runCount) + 1 : 1,
      lastExecutedType: chosen.type,
    };
    state.lastExecutedActionId = chosen.id;
    state.lastRunAt = nowIso;
    writeJsonBestEffort(statePath, state);

    writeJsonBestEffort(outPath, out);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } catch (e) {
    const out = resultBase('executor_error', 'SAFE_ERROR');
    out.error = safeString(e && e.message, 'unknown');
    writeJsonBestEffort(outPath, out);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  }
}

main();
