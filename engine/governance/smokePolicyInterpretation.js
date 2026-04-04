#!/usr/bin/env node
'use strict';

/**
 * Smoke: policyInterpretation (fallback_frequent vs trend apply env).
 * Run: node engine/governance/smokePolicyInterpretation.js
 */

const assert = require('assert');
const { computePolicyInterpretation } = require('./computePolicyInterpretation');

{
  const r = computePolicyInterpretation({
    policyHealth: { lastAlertReason: null },
    miniReport: { trendMemoryApply: { envEnabled: false } },
  });
  assert.strictEqual(r.status, 'normal');
  assert.strictEqual(r.reason, null);
}

{
  const r = computePolicyInterpretation({
    policyHealth: { lastAlertReason: 'fallback_frequent' },
    miniReport: { trendMemoryApply: { envEnabled: false } },
  });
  assert.strictEqual(r.status, 'expected_by_config');
  assert.strictEqual(r.reason, 'fallback_under_trend_apply_disabled');
  assert.strictEqual(r.envTrendMemoryApplyEnabled, false);
}

{
  const r = computePolicyInterpretation({
    policyHealth: { lastAlertReason: 'fallback_frequent' },
    miniReport: { trendMemoryApply: { envEnabled: true } },
  });
  assert.strictEqual(r.status, 'investigate');
  assert.strictEqual(r.reason, 'fallback_frequent_with_apply_enabled');
}

{
  const r = computePolicyInterpretation({
    policyHealth: { lastAlertReason: 'fallback_frequent' },
    miniReport: {},
  });
  assert.strictEqual(r.status, 'unknown');
  assert.strictEqual(r.reason, 'missing_trend_memory_apply_on_mini_report');
}

{
  const r = computePolicyInterpretation({
    policyHealth: { lastAlertReason: 'fallback_frequent' },
    miniReport: { trendMemoryApply: { governor: {} } },
  });
  assert.strictEqual(r.status, 'unknown');
  assert.strictEqual(r.reason, 'trend_apply_env_enabled_indeterminate');
}

console.log('smokePolicyInterpretation: all passed');
