'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const AUDIT_VERSION = 1;

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getSecurityDir() {
  return path.join(getDataDir(), 'security');
}

function getAuditLogPath() {
  return path.join(getSecurityDir(), 'security_audit_log.jsonl');
}

function getAuditLatestPath() {
  return path.join(getSecurityDir(), 'security_audit_latest.json');
}

function getMaxRead() {
  const n = parseInt(process.env.SECURITY_AUDIT_HISTORY_MAX_READ || '2000', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 2000;
}

let lastError = null;
const warnings = [];
const WARN_CAP = 40;

function pushWarn(msg) {
  warnings.push(`${new Date().toISOString()} ${msg}`);
  if (warnings.length > WARN_CAP) warnings.splice(0, warnings.length - WARN_CAP);
  console.warn(`[security-audit] ${msg}`);
}

/**
 * Append a durable audit record (fail-soft).
 * @param {object} partial
 */
async function appendAudit(partial) {
  const record = {
    auditVersion: AUDIT_VERSION,
    generatedAt: new Date().toISOString(),
    eventType: partial.eventType || 'unknown',
    severity: partial.severity || 'info',
    actorType: partial.actorType || 'unknown',
    actorId: partial.actorId != null ? String(partial.actorId) : null,
    role: partial.role || null,
    route: partial.route || null,
    ip: partial.ip || null,
    symbol: partial.symbol || null,
    strategy: partial.strategy || null,
    executionMode: partial.executionMode || null,
    outcome: partial.outcome || 'unknown',
    reason: partial.reason != null ? String(partial.reason) : null,
    metadata: partial.metadata && typeof partial.metadata === 'object' ? partial.metadata : {},
  };

  try {
    const dir = getSecurityDir();
    await fs.mkdir(dir, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    await fs.appendFile(getAuditLogPath(), line, 'utf8');
    try {
      await fs.writeFile(getAuditLatestPath(), JSON.stringify(record, null, 2), 'utf8');
    } catch (e) {
      pushWarn(`latest_write:${e.message}`);
    }
  } catch (e) {
    lastError = e.message;
    pushWarn(`append_failed:${e.message}`);
  }

  return record;
}

function appendAuditSync(partial) {
  appendAudit(partial).catch(() => {});
}

async function readRecentAudit(limit = 100) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), getMaxRead());
  try {
    const text = await fs.readFile(getAuditLogPath(), 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < lim; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch (e) {
        void e;
      }
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    pushWarn(`readRecentAudit:${e.message}`);
    return [];
  }
}

function getAuditHealth() {
  return {
    auditLogHealthy: lastError == null,
    lastSecurityError: lastError,
    securityWarnings: [...warnings],
  };
}

function hashForActor(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const ua = req.get?.('user-agent') || '';
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 16);
}

module.exports = {
  AUDIT_VERSION,
  appendAudit,
  appendAuditSync,
  readRecentAudit,
  getAuditHealth,
  getAuditLogPath,
  hashForActor,
};
