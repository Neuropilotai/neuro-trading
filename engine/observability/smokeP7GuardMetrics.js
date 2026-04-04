#!/usr/bin/env node
'use strict';

/**
 * Smoke: p7_guard_metrics aggregation + env `enabled` at refresh.
 * Run: node engine/observability/smokeP7GuardMetrics.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  refreshP7GuardMetrics,
  appendP7GuardEvent,
  parseP7GuardLine,
} = require('./p7GuardMetrics');

function withEnv(patches, fn) {
  const keys = Object.keys(patches);
  const old = {};
  for (const k of keys) old[k] = process.env[k];
  try {
    for (const k of keys) {
      const v = patches[k];
      if (v == null) delete process.env[k];
      else process.env[k] = String(v);
    }
    return fn();
  } finally {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

function mkGovernanceDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np_p7_guard_metrics_'));
  return path.join(tmp, 'governance');
}

{
  const gov = mkGovernanceDir();
  fs.mkdirSync(gov, { recursive: true });
  withEnv({ NEUROPILOT_ENABLE_P7_HEALTH_GUARD: null }, () => {
    const { payload } = refreshP7GuardMetrics({ governanceDir: gov });
    assert.strictEqual(payload.enabled, false);
    assert.strictEqual(payload.lastAction, null);
    assert.strictEqual(payload.lastAlert, null);
    assert.deepStrictEqual(payload.counts, { normal: 0, attenuate: 0, skip: 0 });
    assert.strictEqual(payload.attenuateRate, 0);
    assert.strictEqual(payload.skipRate, 0);
    assert.strictEqual(payload.eventsConsidered, 0);
  });
}

{
  const gov = mkGovernanceDir();
  fs.mkdirSync(gov, { recursive: true });
  withEnv({ NEUROPILOT_ENABLE_P7_HEALTH_GUARD: 'true' }, () => {
    appendP7GuardEvent(
      '[P7 guard] enabled=true p7Alert=none action=normal factor=1.000',
      { governanceDir: gov }
    );
    const { payload } = refreshP7GuardMetrics({ governanceDir: gov });
    assert.strictEqual(payload.enabled, true);
    assert.strictEqual(payload.lastAction, 'normal');
    assert.strictEqual(payload.lastAlert, null);
    assert.strictEqual(payload.counts.normal, 1);
    assert.strictEqual(payload.attenuateRate, 0);
    assert.strictEqual(payload.skipRate, 0);
  });
}

{
  const gov = mkGovernanceDir();
  fs.mkdirSync(gov, { recursive: true });
  withEnv({ NEUROPILOT_ENABLE_P7_HEALTH_GUARD: 'true' }, () => {
    appendP7GuardEvent(
      '[P7 guard] enabled=true p7Alert=low_report_coverage action=attenuate factor=0.500',
      { governanceDir: gov }
    );
    appendP7GuardEvent(
      '[P7 guard] enabled=true p7Alert=parse_errors action=skip factor=0.000',
      { governanceDir: gov }
    );
    const { payload } = refreshP7GuardMetrics({ governanceDir: gov });
    assert.strictEqual(payload.lastAction, 'skip');
    assert.strictEqual(payload.lastAlert, 'parse_errors');
    assert.deepStrictEqual(payload.counts, { normal: 0, attenuate: 1, skip: 1 });
    assert.strictEqual(payload.attenuateRate, 0.5);
    assert.strictEqual(payload.skipRate, 0.5);
    assert.strictEqual(payload.eventsConsidered, 2);
  });
}

{
  const row = parseP7GuardLine(
    '2026-03-20T12:00:00.000Z [P7 guard] enabled=true p7Alert=empty_window action=attenuate factor=0.500'
  );
  assert.strictEqual(row.action, 'attenuate');
  assert.strictEqual(row.p7Alert, 'empty_window');
}

console.log('smokeP7GuardMetrics: all passed');
