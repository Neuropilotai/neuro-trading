'use strict';

const fs = require('fs');
const path = require('path');

const { runInParallel } = require('./parallelBatchRunner');
const { shapeResearchResultRow } = require('../contracts/researchResultContract');
const { computeBacktestValidity } = require('../validation/backtestValidity');
const { deriveWalkForwardPassBoolean } = require('./walkForwardPassFromSplits');
const dataRoot = require('../dataRoot');

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function computeTradeReturn(trade) {
  const entry = Number(trade.entryPrice);
  const exit = Number(trade.exitPrice);

  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry === 0) {
    return 0;
  }

  if (trade.side === 'short') {
    return (entry - exit) / entry;
  }

  return (exit - entry) / entry;
}

function evaluateRulesOnRow(rules = {}, row = {}) {
  if (!rules || typeof rules !== 'object') return true;

  if (
    rules.session_phase &&
    row.session_phase != null &&
    String(row.session_phase) !== String(rules.session_phase)
  ) {
    return false;
  }

  if (
    rules.regime &&
    row.regime != null &&
    String(row.regime) !== String(rules.regime)
  ) {
    return false;
  }

  if (
    rules.body_pct_min != null &&
    safeNum(row.body_pct, -Infinity) < safeNum(rules.body_pct_min, -Infinity)
  ) {
    return false;
  }

  if (
    rules.close_strength_min != null &&
    safeNum(row.close_strength, -Infinity) < safeNum(rules.close_strength_min, -Infinity)
  ) {
    return false;
  }

  if (
    rules.volume_ratio != null &&
    safeNum(row.volume_ratio, -Infinity) < safeNum(rules.volume_ratio, -Infinity)
  ) {
    return false;
  }

  return true;
}

function sortCandlesByTs(candles) {
  return (Array.isArray(candles) ? candles.slice() : []).sort((a, b) => {
    const aTs = Number(a && (a.ts || a.timestamp || a.time || 0));
    const bTs = Number(b && (b.ts || b.timestamp || b.time || 0));
    return aTs - bTs;
  });
}

function splitCandlesWalkForward(candles, opts = {}) {
  const sorted = sortCandlesByTs(candles);
  const trainRatio = Math.max(
    0.5,
    Math.min(0.95, Number(opts.trainRatio || process.env.WALKFORWARD_TRAIN_RATIO || 0.7))
  );

  if (!sorted.length) {
    return {
      trainCandles: [],
      validationCandles: [],
      splitIndex: 0,
      total: 0,
      trainRatio,
    };
  }

  const splitIndex = Math.max(
    1,
    Math.min(sorted.length - 1, Math.floor(sorted.length * trainRatio))
  );

  return {
    trainCandles: sorted.slice(0, splitIndex),
    validationCandles: sorted.slice(splitIndex),
    splitIndex,
    total: sorted.length,
    trainRatio,
  };
}

function attachWalkforwardMetadata(result, splitName, candles, allCandles, opts = {}) {
  const trainRatio = Math.max(
    0.5,
    Math.min(0.95, Number(opts.trainRatio || process.env.WALKFORWARD_TRAIN_RATIO || 0.7))
  );

  return {
    ...result,
    walkforwardSplit: splitName,
    datasetSplit: splitName,
    isValidation: splitName === 'validation',
    splitTrainRatio: trainRatio,
    splitCandles: Array.isArray(candles) ? candles.length : 0,
    totalCandles: Array.isArray(allCandles) ? allCandles.length : 0,
  };
}

/**
 * Run one setup on candles + feature matrix.
 * Current research logic: if row passes rules at bar i, enter at candles[i].close and exit at candles[i+1].close.
 */
function runOneBacktest(setup, candles, featureMatrix, context = {}) {
  const rules = setup.rules || {};
  const trades = [];

  const maxIndex = Math.min(
    Array.isArray(candles) ? candles.length - 1 : 0,
    Array.isArray(featureMatrix) ? featureMatrix.length - 1 : 0
  );

  for (let i = 0; i < maxIndex; i += 1) {
    const row = featureMatrix[i] || {};
    if (!evaluateRulesOnRow(rules, row)) continue;

    const entryPrice = safeNum(candles[i]?.close, NaN);
    const exitPrice = safeNum(candles[i + 1]?.close, NaN);

    if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice === 0) {
      continue;
    }

    trades.push({
      entryPrice,
      exitPrice,
      side: 'long'
    });
  }

  const tradeReturns = trades
    .map(computeTradeReturn)
    .filter((r) => Number.isFinite(r));

  const tradeCount = tradeReturns.length;
  const expectancy = tradeCount
    ? tradeReturns.reduce((sum, r) => sum + r, 0) / tradeCount
    : 0;

  const winRate = tradeCount
    ? tradeReturns.filter((r) => r > 0).length / tradeCount
    : 0;

  const validity = computeBacktestValidity(
    {
      requiredCandles: context.requiredCandles,
      loadedCandles: context.loadedCandles
    },
    {
      coverageThreshold: context.coverageThreshold
    }
  );

  return shapeResearchResultRow(
    {
      setupId: setup.setupId,
      name: setup.name || null,
      rules,
      source: setup.source || 'grid',
      generation: setup.generation != null ? Number(setup.generation) : 0,
      parentSetupId: setup.parentSetupId || null,
      parentFamilyId: setup.parentFamilyId || null,
      mutationType: setup.mutationType || null,
      expectancy,
      trades: tradeCount,
      winRate,
      tradeReturns,
      drawdown: null,
      _fromTopK: true,
      _stub: false
    },
    {
      requiredCandles: validity.requiredCandles,
      loadedCandles: validity.loadedCandles,
      coverageRatio: validity.coverageRatio,
      backtestInvalid: validity.backtestInvalid,
      invalidReason: validity.invalidReason,
      symbol: context.symbol || null,
      timeframe: context.timeframe || null,
      dataGroup: context.dataGroup || null,
      datasetVersionId: context.datasetVersionId || null,
      producer: 'runTopKBacktests',
      runId: context.runId || null,
      experimentId: context.experimentId || null,
      script: 'engine/batch/runTopKBacktests.js'
    }
  );
}

function writeResults(outPath, payload) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
}

async function runTopKBacktests(setups, opts = {}) {
  const candles = Array.isArray(opts.candles) ? opts.candles : [];
  const featureMatrix = Array.isArray(opts.featureMatrix) ? opts.featureMatrix : [];
  const workers = Math.max(1, safeNum(opts.workers, 1));

  const requiredCandles = Math.max(
    1,
    safeNum(opts.requiredCandles, candles.length || featureMatrix.length || 1)
  );

  const loadedCandles = Math.max(
    0,
    safeNum(opts.loadedCandles, candles.length || featureMatrix.length || 0)
  );

  const context = {
    requiredCandles,
    loadedCandles,
    coverageThreshold: opts.coverageThreshold,
    symbol: opts.symbol || null,
    timeframe: opts.timeframe || null,
    dataGroup: opts.dataGroup || null,
    datasetVersionId: opts.datasetVersionId || null,
    runId: opts.runId || null,
    experimentId: opts.experimentId || null
  };

  let results = [];

  const walkforwardEnabled =
    opts.walkforwardEnabled != null
      ? !!opts.walkforwardEnabled
      : String(process.env.WALKFORWARD_ENABLED || '1') === '1';

  if (!candles.length || !featureMatrix.length) {
    results = (setups || []).map((setup) =>
      shapeResearchResultRow(
        {
          setupId: setup.setupId,
          name: setup.name || null,
          rules: setup.rules || {},
          source: setup.source || 'grid',
          generation: setup.generation != null ? Number(setup.generation) : 0,
          parentSetupId: setup.parentSetupId || null,
          parentFamilyId: setup.parentFamilyId || null,
          mutationType: setup.mutationType || null,
          expectancy: null,
          trades: 0,
          winRate: null,
          tradeReturns: [],
          drawdown: null,
          _fromTopK: false,
          _stub: true
        },
        {
          requiredCandles,
          loadedCandles,
          backtestInvalid: true,
          invalidReason: 'missing_candles_or_features',
          symbol: context.symbol,
          timeframe: context.timeframe,
          dataGroup: context.dataGroup,
          datasetVersionId: context.datasetVersionId,
          producer: 'runTopKBacktests',
          runId: context.runId,
          experimentId: context.experimentId,
          script: 'engine/batch/runTopKBacktests.js'
        }
      )
    );
  } else if (walkforwardEnabled) {
    const trainRatio = Math.max(
      0.5,
      Math.min(0.95, Number(opts.trainRatio || process.env.WALKFORWARD_TRAIN_RATIO || 0.7))
    );

    const indexed = candles.map((c, i) => ({
      c,
      i,
      ts: Number(c && (c.ts || c.timestamp || c.time || 0)),
    }));
    indexed.sort((a, b) => a.ts - b.ts);

    const sortedCandles = indexed.map((x) => x.c);
    const sortedFeatureMatrix = indexed.map((x) => featureMatrix[x.i] || {});

    const wf = splitCandlesWalkForward(sortedCandles, opts);
    const trainCandles = wf.trainCandles;
    const validationCandles = wf.validationCandles;
    const trainFeatureMatrix = sortedFeatureMatrix.slice(0, wf.splitIndex);
    const validationFeatureMatrix = sortedFeatureMatrix.slice(wf.splitIndex);

    const trainContext = {
      ...context,
      requiredCandles: trainCandles.length,
      loadedCandles: trainCandles.length,
    };

    const validationContext = {
      ...context,
      requiredCandles: validationCandles.length,
      loadedCandles: validationCandles.length,
    };

    const nestedResults = await runInParallel(setups || [], workers, async (setup) => {
      const trainResultRaw = await runOneBacktest(
        setup,
        trainCandles,
        trainFeatureMatrix,
        trainContext
      );
      const validationResultRaw = await runOneBacktest(
        setup,
        validationCandles,
        validationFeatureMatrix,
        validationContext
      );

      const trainResult = attachWalkforwardMetadata(
        trainResultRaw,
        'train',
        trainCandles,
        candles,
        opts
      );
      const validationResult = attachWalkforwardMetadata(
        validationResultRaw,
        'validation',
        validationCandles,
        candles,
        opts
      );

      const wfPass = deriveWalkForwardPassBoolean(trainResult, validationResult, {
        timeframe: context.timeframe || null,
      });
      if (typeof wfPass === 'boolean') {
        trainResult.walkForwardPass = wfPass;
        trainResult.walk_forward_pass = wfPass;
        validationResult.walkForwardPass = wfPass;
        validationResult.walk_forward_pass = wfPass;
      }

      return [trainResult, validationResult];
    });

    results = nestedResults.flat();
  } else {
    results = await runInParallel(
      setups || [],
      workers,
      async (setup) => runOneBacktest(setup, candles, featureMatrix, context)
    );
  }

  // Force every row written to disk to be contract-compliant (requiredCandles, loadedCandles, coverageRatio, backtestInvalid, invalidReason).
  // Guarantees meta/evolution get validity fields even if a worker or serialization path dropped them.
  const writeContext = {
    requiredCandles: context.requiredCandles,
    loadedCandles: context.loadedCandles,
    coverageThreshold: context.coverageThreshold,
    symbol: context.symbol,
    timeframe: context.timeframe,
    dataGroup: context.dataGroup,
    datasetVersionId: context.datasetVersionId,
    experimentId: context.experimentId,
    producer: 'runTopKBacktests',
    script: 'engine/batch/runTopKBacktests.js',
  };
  const normalizedResults = results.map((row) => shapeResearchResultRow(row, writeContext));

  if (walkforwardEnabled && candles.length > 0 && featureMatrix.length > 0) {
    let pairs = 0;
    let withBool = 0;
    for (let i = 0; i < normalizedResults.length - 1; i += 1) {
      const a = normalizedResults[i];
      const b = normalizedResults[i + 1];
      const ta = a && String(a.walkforwardSplit || '').toLowerCase() === 'train';
      const vb = b && String(b.walkforwardSplit || '').toLowerCase() === 'validation';
      if (ta && vb && a.setupId === b.setupId) {
        pairs += 1;
        if (typeof a.walkForwardPass === 'boolean') withBool += 1;
      }
    }
    if (pairs > 0) {
      console.log(
        JSON.stringify({
          tag: '[wf-validation-write]',
          trainRows: pairs,
          validationRows: pairs,
          pairsWithWalkForwardPassBool: withBool,
        })
      );
    }
  }

  const payload = {
    dataGroup: context.dataGroup,
    symbol: context.symbol,
    timeframe: context.timeframe,
    generatedAt: new Date().toISOString(),
    experimentId: context.experimentId,
    _source: 'runTopKBacktests',
    ...(walkforwardEnabled &&
      candles.length > 0 &&
      featureMatrix.length > 0 && {
        walkforward: {
          enabled: true,
          trainRatio: Number(
            opts.trainRatio || process.env.WALKFORWARD_TRAIN_RATIO || 0.7
          ),
        },
      }),
    results: normalizedResults,
  };

  const outPath =
    opts.outPath ||
    path.join(
      dataRoot.getPath('batch_results'),
      `strategy_batch_results${context.symbol && context.timeframe ? `_${context.symbol}_${context.timeframe}` : ''}.json`
    );

  writeResults(outPath, payload);

  console.log(`Written (top-K backtest): ${outPath}`);
  console.log(`  Setups: ${normalizedResults.length} | Workers: ${workers}`);

  return {
    outPath,
    payload,
    results: normalizedResults,
  };
}

module.exports = {
  runTopKBacktests,
  runOneBacktest,
  computeTradeReturn
};

if (require.main === module) {
  const topK = safeNum(process.argv[2], 30);
  const outPath = path.join(dataRoot.getPath('batch_results'), 'strategy_batch_results.json');

  writeResults(outPath, {
    generatedAt: new Date().toISOString(),
    _source: 'runTopKBacktests',
    note: 'Direct CLI mode is not wired to candle/features inputs in this file.',
    requestedTopK: topK,
    results: []
  });

  console.log(`Written (top-K backtest): ${outPath}`);
  console.log('  Setups: 0 | Workers: 1');
}
