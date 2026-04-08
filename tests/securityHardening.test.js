#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { expectedSignature } = require('../backend/middleware/webhookHmacAuth');
const replayProtectionService = require('../backend/services/replayProtectionService');
const securityRoleService = require('../backend/services/securityRoleService');
const executionModeGuard = require('../backend/services/executionModeGuard');
const capitalSafetyService = require('../backend/services/capitalSafetyService');
const requestValidationService = require('../backend/services/requestValidationService');
const securityAuditService = require('../backend/services/securityAuditService');
const { requireApiRole } = require('../backend/middleware/adminAuth');

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-test-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(n) {
      this.statusCode = n;
      return this;
    },
    json(o) {
      this.body = o;
      return this;
    },
  };
}

async function run() {
  console.log('securityHardening tests…');

  const secret = 'test-secret-hmac';
  const raw = '{"symbol":"XAUUSD","action":"BUY"}';
  const ts = Math.floor(Date.now() / 1000);
  const sig = expectedSignature(secret, ts, raw);
  const sig2 = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`, 'utf8').digest('hex');
  assert.strictEqual(sig, sig2);

  process.env.WEBHOOK_HMAC_MAX_SKEW_SECONDS = '300';
  const staleTs = ts - 999999;
  const staleSig = expectedSignature(secret, staleTs, raw);
  assert.notStrictEqual(staleSig, sig);

  await withDir(async () => {
    const fp = 'abc123';
    const a = await replayProtectionService.checkAndRecord({ fingerprint: fp });
    assert.strictEqual(a.replay, false);
    const b = await replayProtectionService.checkAndRecord({ fingerprint: fp });
    assert.strictEqual(b.replay, true);
    assert.strictEqual(b.reason, 'replay_detected');
  });

  process.env.ADMIN_API_TOKEN = 'adm-sectok';
  process.env.OPERATOR_API_TOKEN = 'op-sectok';
  process.env.READONLY_API_TOKEN = 'ro-sectok';
  assert.strictEqual(securityRoleService.resolveRoleFromToken('adm-sectok'), 'admin');
  assert.strictEqual(securityRoleService.resolveRoleFromToken('op-sectok'), 'operator');
  assert.strictEqual(securityRoleService.resolveRoleFromToken('bad'), null);

  const reqAdmin = { headers: { authorization: 'Bearer adm-sectok' }, ip: '127.0.0.1', path: '/x' };
  const resOk = mockRes();
  let nextCalled = false;
  requireApiRole('operator')(reqAdmin, resOk, () => {
    nextCalled = true;
  });
  assert.strictEqual(nextCalled, true);

  const reqRo = { headers: { authorization: 'Bearer ro-sectok' }, ip: '127.0.0.1', path: '/x' };
  const resForbidden = mockRes();
  requireApiRole('operator')(reqRo, resForbidden, () => {});
  assert.strictEqual(resForbidden.statusCode, 403);

  delete process.env.ADMIN_API_TOKEN;
  delete process.env.OPERATOR_API_TOKEN;
  delete process.env.READONLY_API_TOKEN;

  const envPaper = { TRADING_MODE: 'paper', ENABLE_LIVE_EXECUTION: 'false' };
  const oi = { symbol: 'XAUUSD', action: 'BUY', quantity: 1, price: 2000, actionSource: 'autonomous_entry_engine' };
  const p = executionModeGuard.evaluateLiveExecutionAllowed(oi, { env: envPaper });
  assert.strictEqual(p.allowed, true);

  const envLiveOff = { TRADING_MODE: 'live', ENABLE_LIVE_EXECUTION: 'false' };
  const lv = executionModeGuard.evaluateLiveExecutionAllowed(oi, { env: envLiveOff });
  assert.strictEqual(lv.allowed, false);

  process.env.GLOBAL_TRADING_KILL_SWITCH = 'true';
  const ks = await capitalSafetyService.evaluateCapitalSafety({ source: 'webhook', orderIntent: oi, env: process.env });
  assert.strictEqual(ks.allowed, false);
  delete process.env.GLOBAL_TRADING_KILL_SWITCH;

  process.env.AUTONOMOUS_TRADING_KILL_SWITCH = 'true';
  const aks = await capitalSafetyService.evaluateCapitalSafety({ source: 'autonomous', orderIntent: oi, env: process.env });
  assert.strictEqual(aks.allowed, false);
  delete process.env.AUTONOMOUS_TRADING_KILL_SWITCH;

  const badPayload = requestValidationService.validateWebhookStrict({ foo: 1 });
  assert.strictEqual(badPayload.ok, false);

  const goodPayload = requestValidationService.validateWebhookStrict({
    symbol: 'XAUUSD',
    action: 'BUY',
    price: 100,
    quantity: 0.1,
    alert_id: 'a1',
    timestamp: Date.now(),
  });
  assert.strictEqual(goodPayload.ok, true);

  await withDir(async () => {
    await securityAuditService.appendAudit({
      eventType: 'test_event',
      severity: 'info',
      outcome: 'ok',
    });
    const rows = await securityAuditService.readRecentAudit(5);
    assert.ok(rows.length >= 1);
    assert.strictEqual(rows[0].eventType, 'test_event');
  });

  const securityStatusService = require('../backend/services/securityStatusService');
  const st = securityStatusService.buildSecurityStatus(process.env);
  assert.ok(st.executionMode != null);
  assert.ok(typeof st.liveExecutionEnabled === 'boolean');

  console.log('✅ securityHardening tests passed');
  process.exit(0);
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
