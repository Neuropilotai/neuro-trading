'use strict';

const ROLE_RANK = {
  read_only: 1,
  operator: 2,
  admin: 3,
};

function parseBearer(req) {
  const auth = req.headers && req.headers.authorization;
  if (!auth || typeof auth !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}

function resolveRoleFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const t = token.trim();
  if (!t) return null;
  const admin = process.env.ADMIN_API_TOKEN;
  const op = process.env.OPERATOR_API_TOKEN;
  const ro = process.env.READONLY_API_TOKEN;
  if (admin && t === admin) return 'admin';
  if (op && t === op) return 'operator';
  if (ro && t === ro) return 'read_only';
  return null;
}

function resolveRequest(req) {
  const token = parseBearer(req);
  if (!token) return null;
  const role = resolveRoleFromToken(token);
  if (!role) return null;
  return { token, role };
}

function roleMeetsMinimum(role, minRole) {
  const r = ROLE_RANK[role] || 0;
  const m = ROLE_RANK[minRole] || 99;
  return r >= m;
}

function isRoleAuthConfigured() {
  return !!(
    (process.env.ADMIN_API_TOKEN && String(process.env.ADMIN_API_TOKEN).length > 0) ||
    (process.env.OPERATOR_API_TOKEN && String(process.env.OPERATOR_API_TOKEN).length > 0) ||
    (process.env.READONLY_API_TOKEN && String(process.env.READONLY_API_TOKEN).length > 0)
  );
}

function isEnforceAuth() {
  return String(process.env.SECURITY_ENFORCE_API_AUTH || '').toLowerCase() === 'true';
}

module.exports = {
  ROLE_RANK,
  parseBearer,
  resolveRoleFromToken,
  resolveRequest,
  roleMeetsMinimum,
  isRoleAuthConfigured,
  isEnforceAuth,
};
