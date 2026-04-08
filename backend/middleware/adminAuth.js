'use strict';

const securityRoleService = require('../services/securityRoleService');
const securityAuditService = require('../services/securityAuditService');

/**
 * @param {'readonly'|'operator'|'admin'} minRole
 */
function requireApiRole(minRole) {
  return function adminAuthMiddleware(req, res, next) {
    if (!securityRoleService.isRoleAuthConfigured()) {
      if (securityRoleService.isEnforceAuth()) {
        return res.status(503).json({
          ok: false,
          error: 'security_not_configured',
          reason: 'tokens_required',
        });
      }
      return next();
    }

    const resolved = securityRoleService.resolveRequest(req);
    if (!resolved) {
      securityAuditService.appendAuditSync({
        eventType: 'admin_auth_failure',
        severity: 'medium',
        actorType: 'user',
        route: req.path,
        ip: req.ip,
        outcome: 'blocked',
        reason: 'unauthorized',
      });
      return res.status(401).json({ ok: false, error: 'unauthorized', reason: 'unauthorized' });
    }

    if (!securityRoleService.roleMeetsMinimum(resolved.role, minRole)) {
      securityAuditService.appendAuditSync({
        eventType: 'admin_auth_forbidden',
        severity: 'medium',
        actorType: 'user',
        role: resolved.role,
        route: req.path,
        ip: req.ip,
        outcome: 'blocked',
        reason: 'forbidden',
      });
      return res.status(403).json({ ok: false, error: 'forbidden', reason: 'forbidden' });
    }

    req.securityRole = resolved.role;
    return next();
  };
}

/**
 * Dev endpoints open in development; production requires API role.
 */
function allowDevOrSecuredRole(minRole, isDevFn) {
  return function (req, res, next) {
    if (typeof isDevFn === 'function' && isDevFn()) {
      return next();
    }
    return requireApiRole(minRole)(req, res, next);
  };
}

module.exports = {
  requireApiRole,
  allowDevOrSecuredRole,
};
