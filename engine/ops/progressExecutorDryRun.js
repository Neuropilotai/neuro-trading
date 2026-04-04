#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const TOP_LEVEL_STATUSES = new Set([
  'dry_run_ready',
  'dry_run_blocked',
  'dry_run_idle',
  'dry_run_unknown',
]);

const ACTION_DECISIONS = new Set([
  'eligible',
  'blocked_owner',
  'blocked_policy',
  'blocked_cooldown',
  'blocked_quota',
  'skipped_informational',
  'skipped_idempotent',
  'skipped_unsupported',
  'unknown',
]);

const SUPPORTED_TYPES = new Set([
  'data_repair',
  'validation_growth',
  'promotion_growth',
  'execution_recovery',
  'research_expansion',
]);

const MAX_ELIGIBLE_TOTAL = 2;
const MAX_ELIGIBLE_PER_GATE = 1;

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

function isMalformedAction(action) {
  if (!action || typeof action !== 'object') return true;
  const id = safeString(action.id).trim();
  const type = safeString(action.type).trim();
  const gate = safeString(action.gate).trim();
  const status = safeString(action.status).trim();
  const blockingType = safeString(action.blockingType).trim();
  const ownerApprovalRequired =
    typeof action.ownerApprovalRequired === 'boolean' ||
    action.ownerApprovalRequired === 0 ||
    action.ownerApprovalRequired === 1;
  return !id || !type || !gate || !status || !blockingType || !ownerApprovalRequired;
}

function buildBaseResult(action) {
  return {
    id: safeString(action && action.id, ''),
    type: safeString(action && action.type, ''),
    gate: safeString(action && action.gate, ''),
    inputPriority: Number.isFinite(Number(action && action.priority)) ? Number(action.priority) : null,
    decision: 'unknown',
    reasonCode: 'UNKNOWN',
    ownerApprovalRequired: safeBool(action && action.ownerApprovalRequired),
    blockingType: safeString(action && action.blockingType, ''),
    wouldExecute: false,
    cooldownActive: false,
    idempotentSkip: false,
    quotaBlocked: false,
    notes: '',
  };
}

function main() {
  const defaultLatest = path.join(__dirname, '..', '..', 'ops-snapshot', 'latest.json');
  const latestPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultLatest;
  const latest = readJson(latestPath);

  if (!latest || typeof latest !== 'object') {
    const out = {
      mode: 'dry_run',
      status: 'dry_run_unknown',
      summary: 'Dry-run input missing latest snapshot',
      evaluatedActionCount: 0,
      eligibleActionCount: 0,
      blockedActionCount: 0,
      skippedActionCount: 0,
      results: [],
      generatedAt: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  const plan = latest.phaseActionPlan;
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.actions)) {
    const out = {
      mode: 'dry_run',
      status: 'dry_run_unknown',
      summary: 'Dry-run input missing phaseActionPlan',
      evaluatedActionCount: 0,
      eligibleActionCount: 0,
      blockedActionCount: 0,
      skippedActionCount: 0,
      results: [],
      generatedAt: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  const actions = safeArray(plan.actions)
    .slice()
    .sort((a, b) => {
      const pa = toPriority(a && a.priority);
      const pb = toPriority(b && b.priority);
      if (pa !== pb) return pa - pb;
      return safeString(a && a.id).localeCompare(safeString(b && b.id));
    });

  const seenIds = new Set();
  const gateEligibleCount = new Map();
  let eligibleCount = 0;
  let blockedCount = 0;
  let skippedCount = 0;
  const results = [];

  for (const action of actions) {
    const out = buildBaseResult(action);
    const id = out.id;
    const type = out.type;
    const gate = out.gate;
    const status = safeString(action && action.status, '');
    const blockingType = out.blockingType;
    const ownerRequired = out.ownerApprovalRequired;

    if (isMalformedAction(action)) {
      out.decision = 'unknown';
      out.reasonCode = 'ACTION_MALFORMED';
      out.notes = 'Malformed action payload';
      results.push(out);
      continue;
    }

    if (seenIds.has(id)) {
      out.decision = 'skipped_idempotent';
      out.reasonCode = 'DUPLICATE_ACTION_ID';
      out.idempotentSkip = true;
      out.notes = 'Duplicate action id skipped';
      skippedCount += 1;
      results.push(out);
      continue;
    }
    seenIds.add(id);

    if (status === 'blocked_pending_owner' || ownerRequired || blockingType === 'owner_gated' || type === 'owner_decision') {
      out.decision = 'blocked_owner';
      out.reasonCode = 'OWNER_APPROVAL_REQUIRED';
      out.notes = 'Owner-gated action';
      blockedCount += 1;
      results.push(out);
      continue;
    }

    if (blockingType === 'informational') {
      out.decision = 'skipped_informational';
      out.reasonCode = 'INFORMATIONAL_ONLY';
      out.notes = 'Informational action';
      skippedCount += 1;
      results.push(out);
      continue;
    }

    if (type === 'governance_resolution') {
      out.decision = 'blocked_policy';
      out.reasonCode = 'GOVERNANCE_REVIEW_REQUIRED';
      out.notes = 'Governance actions require policy review';
      blockedCount += 1;
      results.push(out);
      continue;
    }

    if (!SUPPORTED_TYPES.has(type)) {
      out.decision = 'skipped_unsupported';
      out.reasonCode = 'ACTION_TYPE_UNSUPPORTED';
      out.notes = 'Unsupported action type';
      skippedCount += 1;
      results.push(out);
      continue;
    }

    const gateCount = gateEligibleCount.get(gate) || 0;
    if (eligibleCount >= MAX_ELIGIBLE_TOTAL || gateCount >= MAX_ELIGIBLE_PER_GATE) {
      out.decision = 'blocked_quota';
      out.reasonCode = 'QUOTA_REACHED';
      out.quotaBlocked = true;
      out.notes = 'Dry-run quota reached';
      blockedCount += 1;
      results.push(out);
      continue;
    }

    out.decision = 'eligible';
    out.reasonCode = 'AUTO_FIXABLE_SUPPORTED';
    out.wouldExecute = false;
    out.notes = 'Dry-run only; no execution performed';
    eligibleCount += 1;
    gateEligibleCount.set(gate, gateCount + 1);
    results.push(out);
  }

  let status = 'dry_run_unknown';
  if (results.length === 0) {
    status = 'dry_run_idle';
  } else if (eligibleCount > 0) {
    status = 'dry_run_ready';
  } else if (blockedCount > 0) {
    status = 'dry_run_blocked';
  } else if (skippedCount > 0) {
    status = 'dry_run_idle';
  }

  if (!TOP_LEVEL_STATUSES.has(status)) status = 'dry_run_unknown';

  let summary = 'No actionable dry-run candidates';
  if (status === 'dry_run_unknown') {
    summary = 'Dry-run evaluation incomplete';
  } else if (eligibleCount > 0 || blockedCount > 0 || skippedCount > 0) {
    summary = `${eligibleCount} eligible, ${blockedCount} blocked, ${skippedCount} skipped`;
  }

  const finalResults = results.map((r) => ({
    ...r,
    decision: ACTION_DECISIONS.has(r.decision) ? r.decision : 'unknown',
  }));

  const out = {
    mode: 'dry_run',
    status,
    summary,
    evaluatedActionCount: actions.length,
    eligibleActionCount: eligibleCount,
    blockedActionCount: blockedCount,
    skippedActionCount: skippedCount,
    results: finalResults,
    generatedAt: new Date().toISOString(),
  };

  // Best effort mirror artifact near latest snapshot.
  try {
    const outFile = path.join(path.dirname(latestPath), 'progress_executor_dry_run.json');
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  } catch (_) {
    // noop
  }

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main();
