'use strict';

/**
 * Read-only aggregate for operator dashboard. Fails soft per section.
 */

async function buildOperatorOverview() {
  const generatedAt = new Date().toISOString();
  const sections = {};

  const mark = async (key, fn) => {
    try {
      sections[key] = { ok: true, data: await fn() };
    } catch (e) {
      sections[key] = { ok: false, error: e && e.message ? String(e.message) : 'unknown_error' };
    }
  };

  await mark('health', async () => {
    const liveExecutionGate = require('./liveExecutionGate');
    const riskEngine = require('./riskEngine');
    const paperTradingService = require('./paperTradingService');
    const priceFeedService = require('./priceFeedService');
    const tradingLearningService = require('./tradingLearningService');
    const summary = paperTradingService.getAccountSummary();
    const positions = Array.isArray(summary.positions) ? summary.positions : [];
    const syms = positions.map((p) => String(p.symbol || '').toUpperCase()).filter(Boolean);
    const pricingMeta = priceFeedService.getAccountPricingMeta(syms);
    let brokerConnected = null;
    try {
      const { getBrokerAdapter } = require('../adapters/brokerAdapterFactory');
      const b = getBrokerAdapter();
      brokerConnected = typeof b.isConnected === 'function' ? b.isConnected() : null;
    } catch (e) {
      brokerConnected = false;
    }
    return {
      tradingMode: liveExecutionGate.getTradingMode(),
      killSwitch: liveExecutionGate.getKillSwitchStatus(),
      tradingEnabled: riskEngine.isTradingEnabled(),
      paperTradingEnabled: process.env.ENABLE_PAPER_TRADING !== 'false',
      learningEnabled: tradingLearningService.enabled === true,
      autonomousEnabled: String(process.env.ENABLE_AUTONOMOUS_ENTRY_ENGINE || 'false').toLowerCase() === 'true',
      brokerType: process.env.BROKER || 'paper',
      brokerConnected,
      account: summary,
      pricing: pricingMeta,
    };
  });

  await mark('autonomous', async () => {
    const autonomousEntryEngine = require('./autonomousEntryEngine');
    return autonomousEntryEngine.getStatus();
  });

  await mark('policy', async () => {
    const policyApplicationService = require('./policyApplicationService');
    return policyApplicationService.getPolicyOverview();
  });

  await mark('allocation', async () => {
    const capitalAllocationService = require('./capitalAllocationService');
    return capitalAllocationService.getAllocationOverview();
  });

  await mark('overlap', async () => {
    const correlationOverlapService = require('./correlationOverlapService');
    return correlationOverlapService.getCorrelationOverlapOverview();
  });

  await mark('overlapClusters', async () => {
    const correlationOverlapService = require('./correlationOverlapService');
    return correlationOverlapService.getCorrelationOverlapClusters();
  });

  await mark('stability', async () => {
    const policyStabilityService = require('./policyStabilityService');
    return (await policyStabilityService.loadLatestStabilityDiagnostics()) || null;
  });

  await mark('shadow', async () => {
    const shadowAllocationService = require('./shadowAllocationService');
    return shadowAllocationService.loadLatestShadowAllocationRecord();
  });

  await mark('learning', async () => {
    const reinforcementLearningService = require('./reinforcementLearningService');
    return reinforcementLearningService.getLearningOverview();
  });

  await mark('capitalSafety', async () => {
    const securityStatusService = require('./securityStatusService');
    return securityStatusService.buildSecurityStatus(process.env);
  });

  await mark('execution', async () => {
    const executionQualityService = require('./executionQualityService');
    const summary = await executionQualityService.getExecutionQualitySummary({ limit: 200 });
    try {
      await executionQualityService.persistLatest(summary);
    } catch (e) {
      void e;
    }
    return summary;
  });

  return { generatedAt, sections };
}

module.exports = {
  buildOperatorOverview,
};
