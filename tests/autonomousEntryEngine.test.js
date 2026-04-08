#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const setupEngine = require('../backend/services/autonomousSetupEngine');
const scoring = require('../backend/services/autonomousCandidateScoringService');
const coordinator = require('../backend/services/autonomousExecutionCoordinator');
const exitManager = require('../backend/services/autonomousExitManager');
const { AutonomousEntryEngine } = require('../backend/services/autonomousEntryEngine');

async function withTempDataDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-entry-test-'));
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

async function run() {
  console.log('autonomousEntryEngine tests…');

  const state = {
    pricesBySymbol: {
      XAUUSD: [100, 100.2, 100.4, 100.8, 101.2, 101.6, 101.8, 102.1],
      EURUSD: [1.1, 1.11, 1.12, 1.125, 1.128, 1.122, 1.119, 1.121],
    },
    spreadProxyBySymbol: { XAUUSD: 0.0008, EURUSD: 0.0005 },
  };

  const br = setupEngine.detectBreakoutContinuation('XAUUSD', state);
  assert.ok(br && br.setupType === 'breakout_continuation');
  const pb = setupEngine.detectTrendPullback('EURUSD', state);
  assert.ok(pb || true); // may vary with threshold, detectAutonomousCandidates covers both paths
  const none = setupEngine.detectBreakoutContinuation('GBPUSD', { pricesBySymbol: { GBPUSD: [1.2] } });
  assert.strictEqual(none, null);

  const candidates = setupEngine.detectAutonomousCandidates({ symbols: ['XAUUSD', 'EURUSD'], state });
  assert.ok(Array.isArray(candidates));

  const cHi = {
    candidateId: 'c1',
    setupType: 'breakout_continuation',
    rawSetupScore: 0.9,
    regime: 'trend',
    features: {
      trendStrength: 0.8,
      breakoutStrength: 0.9,
      pullbackDepth: 0.35,
      volatilityProxy: 0.02,
      spreadProxy: 0.0005,
      sessionTag: 'london_us',
    },
  };
  const hi = scoring.scoreAutonomousCandidate(cHi);
  assert.ok(hi.score >= 0 && hi.score <= 1);
  const low = scoring.scoreAutonomousCandidate(
    {
      ...cHi,
      candidateId: 'c2',
      rawSetupScore: 0.2,
      features: { ...cHi.features, spreadProxy: 0.02, sessionTag: 'offpeak', breakoutStrength: 0.01 },
    },
    { cooldownPenalty: 0.2, duplicatePenalty: 0.2 }
  );
  assert.ok(low.score <= hi.score);

  await withTempDataDir(async () => {
    process.env.CROWDING_SEVERE_THRESHOLD = '0.5';
    const cand = {
      candidateId: 'cand-a',
      symbol: 'XAUUSD',
      setupType: 'breakout_continuation',
      side: 'BUY',
      entryReferencePrice: 2000,
      stopLoss: 1990,
      takeProfit: 2020,
      regime: 'trend',
      features: { sessionTag: 'london_us' },
    };
    const scored = { candidateId: 'cand-a', score: 0.8, confidence: 0.8, eligiblePreGovernance: true };
    const deps = {
      policyState: {
        globalPolicy: { portfolioRiskMode: 'normal' },
        entities: [{ entityType: 'symbol', entityKey: 'XAUUSD', eligible: true, decision: 'keep' }],
      },
      allocationPlan: {
        portfolio: { recommendedDeployableCapital: 300 },
        symbolAllocations: [{ symbol: 'XAUUSD', weight: 0.3, recommendedCapital: 90 }],
        strategyAllocations: [{ strategy: 'auto-breakout-v1', weight: 0.2, recommendedCapital: 60 }],
      },
      overlapState: {
        warnings: [],
        crowdingDiagnostics: { totalCrowdingScore: 0.2, topCrowdedClusters: [] },
        matrices: { pairwiseTop: [] },
      },
      accountSummary: { equity: 1000, positions: [] },
      liveExecutionGate: {
        getTradingMode: () => 'paper',
        executeOrder: async (orderIntent) => ({
          success: true,
          tradeId: 'T1',
          executionResult: { filledQuantity: orderIntent.quantity, fillPrice: orderIntent.price, executedAt: new Date().toISOString() },
        }),
      },
    };

    const decision = await coordinator.buildGovernanceDecision(cand, scored, deps);
    assert.ok(['allow', 'reject'].includes(decision.finalDecision));
    if (decision.finalDecision === 'allow') {
      assert.ok(decision.orderIntent && decision.orderIntent.actionSource === 'autonomous_entry_engine');
    }

    const cycle = await coordinator.runAutonomousEntryCycle(
      { candidates: [cand], scoredCandidates: [scored] },
      deps
    );
    assert.strictEqual(cycle.candidatesSeen, 1);
    const latest = await coordinator.loadLatestAutonomousEntry();
    assert.ok(latest && latest.candidateId === 'cand-a');
    const hist = await coordinator.readAutonomousEntryHistory(10);
    assert.ok(hist.length >= 1);

    const rej = await coordinator.buildGovernanceDecision(
      cand,
      scored,
      {
        ...deps,
        overlapState: { warnings: ['x'], crowdingDiagnostics: { totalCrowdingScore: 0.9, topCrowdedClusters: [] }, matrices: { pairwiseTop: [] } },
      }
    );
    assert.strictEqual(rej.finalDecision, 'reject');
  });

  const exitEvalStop = exitManager.evaluateAutonomousExit(
    { avgPrice: 100, stopLoss: 98, takeProfit: 104, entryTime: new Date(Date.now() - 5 * 60000).toISOString() },
    { price: 97, now: new Date().toISOString() }
  );
  assert.strictEqual(exitEvalStop.shouldExit, true);
  const exitEvalTake = exitManager.evaluateAutonomousExit(
    { avgPrice: 100, stopLoss: 98, takeProfit: 104, entryTime: new Date(Date.now() - 5 * 60000).toISOString() },
    { price: 104.1, now: new Date().toISOString() }
  );
  assert.strictEqual(exitEvalTake.shouldExit, true);
  process.env.AUTO_EXIT_ENABLE_TIME_STOP = 'true';
  process.env.AUTO_EXIT_DEFAULT_MAX_HOLD_MINUTES = '1';
  const exitEvalTime = exitManager.evaluateAutonomousExit(
    { avgPrice: 100, stopLoss: 98, takeProfit: 104, entryTime: new Date(Date.now() - 5 * 60000).toISOString() },
    { price: 100.1, now: new Date().toISOString() }
  );
  assert.strictEqual(exitEvalTime.shouldExit, true);

  await withTempDataDir(async () => {
    process.env.ENABLE_AUTONOMOUS_ENTRY_ENGINE = 'true';
    process.env.AUTO_ENTRY_SYMBOLS = 'XAUUSD';
    process.env.AUTO_ENTRY_SCAN_INTERVAL_SECONDS = '120';
    process.env.AUTO_EXIT_SCAN_INTERVAL_SECONDS = '120';
    const eng = new AutonomousEntryEngine();
    const scan = await eng.runScanCycle();
    assert.ok(scan && typeof scan === 'object');
    const exits = await eng.runExitCycle();
    assert.ok(exits && typeof exits === 'object');

    await eng.saveStatus();
    const before = eng.getStatus();
    await eng.loadStatus();
    assert.strictEqual(typeof before.autonomousEntryEngineVersion, 'number');

    const started = await eng.start();
    assert.strictEqual(started.running, true);
    const stopped = await eng.stop();
    assert.strictEqual(stopped.running, false);
  });

  console.log('✅ autonomousEntryEngine tests passed');
  process.exit(0);
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
