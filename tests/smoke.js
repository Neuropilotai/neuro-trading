#!/usr/bin/env node
'use strict';

/**
 * Minimal smoke test for v2: server startup, /health, /debug/routes, webhook path.
 * Run from repo root: node neuropilot_trading_v2/tests/smoke.js
 * Or from v2: node tests/smoke.js
 *
 * Uses Node built-in http; no auth for webhook (ENABLE_WEBHOOK_AUTH=false).
 */

const http = require('http');
const path = require('path');

// Set test env before requiring server (so auth can be off for webhook test)
process.env.ENABLE_WEBHOOK_AUTH = 'false';
process.env.ENABLE_WEBHOOK_VALIDATION = 'true';
process.env.TRADING_ENABLED = 'false'; // avoid paper execution for simple smoke
const dataDir = path.join(__dirname, '..', 'data');
process.env.DATA_DIR = dataDir;

const app = require('../server');

function request(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port, path, method };
    if (body && (method === 'POST' || method === 'PUT')) {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    }
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const json = buf ? JSON.parse(buf) : {};
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        } catch {
          resolve({ status: res.statusCode, body: buf });
        }
      });
    });
    req.on('error', reject);
    if (body && (method === 'POST' || method === 'PUT')) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function run() {
  const server = app.listen(0);
  const port = server.address().port;
  const results = { passed: 0, failed: 0, tests: [] };

  function ok(name, cond, detail = '') {
    if (cond) {
      results.passed++;
      results.tests.push({ name, ok: true, detail });
      return true;
    }
    results.failed++;
    results.tests.push({ name, ok: false, detail });
    return false;
  }

  try {
    // 1. Server startup (we got here if listen(0) worked)
    ok('server_start', true, `listening on port ${port}`);

    // 2. GET /health
    const healthRes = await request(port, 'GET', '/health');
    ok('health_endpoint', healthRes.status === 200, `status=${healthRes.status}`);

    // 3. GET /debug/routes
    const routesRes = await request(port, 'GET', '/debug/routes');
    const routesOk = routesRes.status === 200 && routesRes.body && routesRes.body.ok === true && Array.isArray(routesRes.body.routes);
    ok('debug_routes', routesOk, routesOk ? `count=${routesRes.body.count}` : `status=${routesRes.status}`);

    // 4. POST /webhook/tradingview — minimal valid payload (validation only; ledger may write)
    const webhookPayload = {
      symbol: 'XAUUSD',
      action: 'BUY',
      price: 2650.5,
      quantity: 0.01,
      alert_id: 'smoke-' + Date.now(),
      timestamp: Math.floor(Date.now() / 1000),
    };
    const webhookRes = await request(port, 'POST', '/webhook/tradingview', webhookPayload);
    // 200 = accepted and ledger written; 503 = ledger write failed (e.g. no DB); 409 = duplicate
    const webhookOk = [200, 409].includes(webhookRes.status) || (webhookRes.status === 503 && /LEDGER|database/i.test(JSON.stringify(webhookRes.body)));
    ok('webhook_request', webhookRes.status >= 200 && webhookRes.status < 500, `status=${webhookRes.status} (ledger/execution may be skipped with TRADING_ENABLED=false)`);
  } finally {
    server.close();
  }

  console.log(JSON.stringify(results, null, 2));
  process.exit(results.failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Smoke test error:', err);
  process.exit(1);
});
