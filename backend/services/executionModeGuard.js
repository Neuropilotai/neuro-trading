'use strict';

const securityAuditService = require('./securityAuditService');

function readTradingMode(env = process.env) {
  return String(env.TRADING_MODE || 'paper').toLowerCase();
}

function readExecutionMode(env = process.env) {
  const explicit = String(env.EXECUTION_MODE || '').toLowerCase().trim();
  if (explicit === 'paper' || explicit === 'live_disabled' || explicit === 'live_guarded') {
    return explicit;
  }
  const tm = readTradingMode(env);
  if (tm !== 'live') return 'paper';
  const liveOn = isTruthy(env.ENABLE_LIVE_EXECUTION);
  if (!liveOn) return 'live_disabled';
  return 'live_guarded';
}

function isTruthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

function parseList(s) {
  return String(s || '')
    .split(',')
    .map((x) => String(x || '').toUpperCase().trim())
    .filter(Boolean);
}

function isAutonomousIntent(orderIntent) {
  const src = orderIntent?.actionSource || orderIntent?.metadata?.source;
  return String(src || '').includes('autonomous');
}

/**
 * Evaluate whether live broker execution should be allowed.
 * @returns {{ allowed: boolean, reason?: string, code?: string }}
 */
function evaluateLiveExecutionAllowed(orderIntent, options = {}) {
  const env = options.env || process.env;
  const tm = readTradingMode(env);

  if (tm !== 'live') {
    return { allowed: true, reason: 'not_live_mode' };
  }

  if (!isTruthy(env.ENABLE_LIVE_EXECUTION)) {
    return {
      allowed: false,
      reason: 'live_execution_disabled',
      code: 'paper_live_mode_mismatch',
    };
  }

  if (isAutonomousIntent(orderIntent)) {
    if (!isTruthy(env.ENABLE_AUTONOMOUS_LIVE_EXECUTION)) {
      return {
        allowed: false,
        reason: 'autonomous_live_execution_disabled',
        code: 'paper_live_mode_mismatch',
      };
    }
  }

  if (isTruthy(env.LIVE_EXECUTION_REQUIRE_EXPLICIT_ALLOWLIST)) {
    const sym = String(orderIntent?.symbol || '').toUpperCase().trim();
    const allow = parseList(env.LIVE_SYMBOL_ALLOWLIST);
    if (!sym || !allow.includes(sym)) {
      return { allowed: false, reason: 'symbol_not_allowed', code: 'symbol_not_allowed' };
    }
  }

  return { allowed: true };
}

/**
 * Webhook-sourced orders: must be paper-only unless live is explicitly enabled and allowlisted.
 */
function evaluateWebhookExecutionAllowed(orderIntent, env = process.env) {
  const tm = readTradingMode(env);
  if (tm === 'paper' || tm === 'dry_run') {
    const sym = String(orderIntent?.symbol || '').toUpperCase().trim();
    const raw = env.PAPER_SYMBOL_ALLOWLIST;
    if (raw !== undefined && String(raw).trim() !== '') {
      const paperAllow = parseList(raw);
      if (paperAllow.length && sym && !paperAllow.includes(sym)) {
        return { allowed: false, reason: 'symbol_not_allowed_for_paper_allowlist', code: 'symbol_not_allowed' };
      }
    }
    return { allowed: true };
  }
  return evaluateLiveExecutionAllowed(orderIntent, { env });
}

async function auditBlockedLiveAttempt(reason, meta = {}) {
  await securityAuditService.appendAudit({
    eventType: 'blocked_live_attempt',
    severity: 'critical',
    actorType: 'system',
    outcome: 'blocked',
    reason,
    metadata: meta,
  });
}

function getExecutionModeStatus(env = process.env) {
  return {
    executionMode: readExecutionMode(env),
    tradingMode: readTradingMode(env),
    liveExecutionEnabled: isTruthy(env.ENABLE_LIVE_EXECUTION),
    autonomousLiveExecutionEnabled: isTruthy(env.ENABLE_AUTONOMOUS_LIVE_EXECUTION),
    paperOnlyEnforced: readTradingMode(env) === 'paper' || !isTruthy(env.ENABLE_LIVE_EXECUTION),
    liveExecutionRequireExplicitAllowlist: isTruthy(env.LIVE_EXECUTION_REQUIRE_EXPLICIT_ALLOWLIST),
  };
}

module.exports = {
  readTradingMode,
  readExecutionMode,
  evaluateLiveExecutionAllowed,
  evaluateWebhookExecutionAllowed,
  auditBlockedLiveAttempt,
  getExecutionModeStatus,
  isAutonomousIntent,
};
