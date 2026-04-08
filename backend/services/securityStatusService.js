'use strict';

const executionModeGuard = require('./executionModeGuard');
const securityRoleService = require('./securityRoleService');
const securityAuditService = require('./securityAuditService');
const capitalSafetyService = require('./capitalSafetyService');

function isTruthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

function buildSecurityStatus(env = process.env) {
  const exec = executionModeGuard.getExecutionModeStatus(env);
  const audit = securityAuditService.getAuditHealth();

  return {
    ...exec,
    autonomousEnabled: isTruthy(env.ENABLE_AUTONOMOUS_ENTRY_ENGINE),
    webhookHmacEnabled: isTruthy(env.ENABLE_WEBHOOK_HMAC_AUTH),
    legacyBodySecretEnabled:
      env.ENABLE_LEGACY_BODY_SECRET === undefined || env.ENABLE_LEGACY_BODY_SECRET === ''
        ? true
        : isTruthy(env.ENABLE_LEGACY_BODY_SECRET),
    replayProtectionEnabled: true,
    adminAuthEnabled: securityRoleService.isRoleAuthConfigured(),
    globalKillSwitch: isTruthy(env.GLOBAL_TRADING_KILL_SWITCH),
    autonomousKillSwitch: isTruthy(env.AUTONOMOUS_TRADING_KILL_SWITCH),
    auditLogHealthy: audit.auditLogHealthy,
    lastSecurityError: audit.lastSecurityError,
    securityWarnings: audit.securityWarnings,
    roleConfigPresent: securityRoleService.isRoleAuthConfigured(),
    capitalSafetyConfigPresent: true,
    capitalSafetyStatePath: capitalSafetyService.getStatePath(),
    securityEnforceApiAuth: securityRoleService.isEnforceAuth(),
  };
}

module.exports = {
  buildSecurityStatus,
};
