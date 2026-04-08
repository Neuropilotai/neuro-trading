'use strict';

/**
 * After a closed trade is appended to closed_trades.jsonl, refresh RL state and policy/allocation.
 * Runs on the next tick (setImmediate) so paper execution never waits on disk-heavy work.
 *
 * Opt-out: AUTO_LEARNING_POLICY_AFTER_CLOSED_TRADE=false
 */

function isAutoPipelineEnabled() {
  return String(process.env.AUTO_LEARNING_POLICY_AFTER_CLOSED_TRADE || 'true').toLowerCase() !== 'false';
}

async function runLearningThenPolicy() {
  const reinforcementLearningService = require('./reinforcementLearningService');
  const policyApplicationService = require('./policyApplicationService');
  const closedTradeAnalyticsService = require('./closedTradeAnalyticsService');

  const dataDir = process.env.DATA_DIR || '';
  const closedPath = closedTradeAnalyticsService.getClosedTradesPath();
  console.log(
    `[closed-trade→learning→policy] pipeline start DATA_DIR=${dataDir || '(unset → cwd/data)'} closed_trades_file=${closedPath}`
  );

  try {
    const rlState = await reinforcementLearningService.runLearningCycle({});
    const used = rlState?.diagnostics?.tradeRowsUsed;
    const buckets = rlState?.diagnostics?.bucketCount;
    console.log(
      `[closed-trade→learning] ok tradeRowsUsed=${used ?? '?'} bucketCount=${buckets ?? '?'}`
    );
  } catch (e) {
    console.warn(`[closed-trade→learning] runLearningCycle: ${e && e.message}`);
  }

  try {
    const pol = await policyApplicationService.runPolicyCycle({});
    const n = Array.isArray(pol?.entities) ? pol.entities.length : 0;
    console.log(`[closed-trade→policy] ok policyEntities=${n}`);
  } catch (e) {
    console.warn(`[closed-trade→policy] runPolicyCycle: ${e && e.message}`);
  }

  console.log('[closed-trade→learning→policy] pipeline end');
}

function scheduleLearningAndPolicyAfterClosedTrade() {
  if (!isAutoPipelineEnabled()) {
    return;
  }

  console.log('[closed-trade→learning→policy] scheduled (setImmediate)');

  setImmediate(() => {
    runLearningThenPolicy().catch((e) => {
      console.warn(`[closed-trade→learning→policy] pipeline: ${e && e.message}`);
    });
  });
}

module.exports = {
  scheduleLearningAndPolicyAfterClosedTrade,
  runLearningThenPolicy,
  isAutoPipelineEnabled,
};
