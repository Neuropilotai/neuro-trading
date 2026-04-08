'use strict';

/**
 * Run: node tests/postClosedTradeLearningPolicyHook.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;

const hook = require('../backend/services/postClosedTradeLearningPolicyHook');

async function run() {
  console.log('postClosedTradeLearningPolicyHook tests…');

  const prevAuto = process.env.AUTO_LEARNING_POLICY_AFTER_CLOSED_TRADE;
  const prevData = process.env.DATA_DIR;

  const tmp = path.join(__dirname, 'tmp_post_closed_hook_' + Date.now());
  process.env.DATA_DIR = tmp;
  await fs.mkdir(tmp, { recursive: true });

  try {
    delete process.env.AUTO_LEARNING_POLICY_AFTER_CLOSED_TRADE;
    assert.strictEqual(hook.isAutoPipelineEnabled(), true);

    process.env.AUTO_LEARNING_POLICY_AFTER_CLOSED_TRADE = 'false';
    assert.strictEqual(hook.isAutoPipelineEnabled(), false);

    process.env.AUTO_LEARNING_POLICY_AFTER_CLOSED_TRADE = 'true';
    assert.strictEqual(hook.isAutoPipelineEnabled(), true);

    // Pipeline runs without throw (empty closed trades is OK)
    await hook.runLearningThenPolicy();
  } finally {
    if (prevAuto === undefined) delete process.env.AUTO_LEARNING_POLICY_AFTER_CLOSED_TRADE;
    else process.env.AUTO_LEARNING_POLICY_AFTER_CLOSED_TRADE = prevAuto;
    if (prevData === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevData;
    try {
      await fs.rm(tmp, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }

  console.log('✅ postClosedTradeLearningPolicyHook tests passed');
  process.exit(0);
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
