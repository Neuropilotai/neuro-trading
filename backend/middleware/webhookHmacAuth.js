'use strict';

const crypto = require('crypto');
const securityAuditService = require('../services/securityAuditService');
const replayProtectionService = require('../services/replayProtectionService');

function isTruthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

function parseIntSafe(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function getMaxSkewSeconds() {
  return Math.min(Math.max(parseIntSafe(process.env.WEBHOOK_HMAC_MAX_SKEW_SECONDS, 300), 30), 3600);
}

/**
 * Canonical: HMAC_SHA256(secret, `${timestamp}.${rawBody}`) as hex
 */
function expectedSignature(secret, timestampSec, rawBody) {
  const payload = `${String(timestampSec)}.${String(rawBody || '')}`;
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a).trim(), 'hex');
    const bb = Buffer.from(String(b).trim(), 'hex');
    if (ba.length !== bb.length || ba.length === 0) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (e) {
    return false;
  }
}

async function webhookHmacAuth(req, res, next) {
  if (!isTruthy(process.env.ENABLE_WEBHOOK_HMAC_AUTH)) {
    return next();
  }

  const secret = process.env.WEBHOOK_HMAC_SECRET || process.env.TRADINGVIEW_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook-hmac] WEBHOOK_HMAC_SECRET / TRADINGVIEW_WEBHOOK_SECRET not set');
    await securityAuditService.appendAudit({
      eventType: 'webhook_hmac_misconfigured',
      severity: 'critical',
      actorType: 'system',
      route: req.path,
      ip: req.ip,
      outcome: 'error',
      reason: 'secret_missing',
    });
    return res.status(500).json({
      error: 'security_misconfiguration',
      message: 'WEBHOOK_HMAC_SECRET required when ENABLE_WEBHOOK_HMAC_AUTH=true',
    });
  }

  const sig = req.headers['x-np-signature'] || req.headers['X-NP-Signature'];
  const tsHeader = req.headers['x-np-timestamp'] || req.headers['X-NP-Timestamp'];
  const keyId = req.headers['x-np-key-id'] || req.headers['X-NP-Key-Id'];

  const rawBody = req.rawBody;
  if (!rawBody && rawBody !== '') {
    await securityAuditService.appendAudit({
      eventType: 'webhook_hmac_failure',
      severity: 'high',
      route: req.path,
      ip: req.ip,
      outcome: 'blocked',
      reason: 'raw_body_missing',
    });
    return res.status(500).json({ error: 'raw_body_missing', message: 'Cannot verify HMAC' });
  }

  function legacyAllowed() {
    const v = process.env.ENABLE_LEGACY_BODY_SECRET;
    if (v === undefined || v === '') return true;
    return isTruthy(v);
  }

  if (!sig || !tsHeader) {
    if (legacyAllowed()) {
      await securityAuditService.appendAudit({
        eventType: 'webhook_legacy_auth_path',
        severity: 'warn',
        route: req.path,
        ip: req.ip,
        outcome: 'allowed',
        reason: 'legacy_body_secret_fallback',
        metadata: { keyId: keyId || null },
      });
      return next();
    }
    await securityAuditService.appendAudit({
      eventType: 'webhook_hmac_failure',
      severity: 'high',
      route: req.path,
      ip: req.ip,
      outcome: 'blocked',
      reason: 'missing_signature',
    });
    return res.status(401).json({
      error: 'unauthorized',
      reason: 'missing_signature',
      message: 'x-np-signature and x-np-timestamp required',
    });
  }

  const tsSec = parseInt(String(tsHeader), 10);
  if (!Number.isFinite(tsSec)) {
    await securityAuditService.appendAudit({
      eventType: 'webhook_hmac_failure',
      severity: 'high',
      route: req.path,
      ip: req.ip,
      outcome: 'blocked',
      reason: 'invalid_timestamp',
    });
    return res.status(401).json({ error: 'unauthorized', reason: 'invalid_timestamp' });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const skew = getMaxSkewSeconds();
  if (Math.abs(nowSec - tsSec) > skew) {
    await securityAuditService.appendAudit({
      eventType: 'webhook_hmac_failure',
      severity: 'high',
      route: req.path,
      ip: req.ip,
      outcome: 'blocked',
      reason: 'stale_timestamp',
      metadata: { tsSec, nowSec, skew },
    });
    return res.status(401).json({ error: 'unauthorized', reason: 'stale_timestamp' });
  }

  let sigHex = String(sig).trim();
  if (sigHex.startsWith('sha256=')) sigHex = sigHex.slice(7);

  const expected = expectedSignature(secret, tsSec, rawBody);
  if (!timingSafeEqualHex(expected, sigHex)) {
    await securityAuditService.appendAudit({
      eventType: 'webhook_hmac_failure',
      severity: 'high',
      route: req.path,
      ip: req.ip,
      outcome: 'blocked',
      reason: 'invalid_signature',
    });
    return res.status(401).json({ error: 'unauthorized', reason: 'invalid_signature' });
  }

  let bodyObj = req.body;
  if (!bodyObj || typeof bodyObj !== 'object') {
    try {
      bodyObj = JSON.parse(rawBody || '{}');
    } catch (e) {
      bodyObj = {};
    }
  }
  const alertId = bodyObj.alert_id != null ? String(bodyObj.alert_id) : '';

  const fingerprint = replayProtectionService.buildFingerprint({
    rawBody,
    signature: sigHex,
    alertId,
    timestampHeader: String(tsSec),
  });

  const replay = await replayProtectionService.checkAndRecord({
    fingerprint,
    meta: { alertId, path: req.path },
  });

  if (!replay.ok && replay.replay) {
    await securityAuditService.appendAudit({
      eventType: 'webhook_replay_detected',
      severity: 'high',
      route: req.path,
      ip: req.ip,
      outcome: 'blocked',
      reason: 'replay_detected',
      metadata: { alertId },
    });
    return res.status(409).json({ error: 'conflict', reason: 'replay_detected' });
  }

  await securityAuditService.appendAudit({
    eventType: 'webhook_hmac_success',
    severity: 'info',
    route: req.path,
    ip: req.ip,
    outcome: 'allowed',
    reason: 'hmac_ok',
    metadata: { keyId: keyId || null, alertId },
  });

  req.authModeUsed = 'np_hmac';
  req.npWebhookKeyId = keyId || null;
  return next();
}

module.exports = { webhookHmacAuth, expectedSignature };
