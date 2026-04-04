#!/usr/bin/env node
'use strict';

/**
 * Example: run research from named config group (uses real ./data files).
 *
 * Run from repo root or neuropilot_trading_v2:
 *   node engine/exampleRunResearchFromConfig.js baseline                 # current best baseline (SPY, trend_breakout, no filters, 2R)
 *   node engine/exampleRunResearchFromConfig.js                         # default group, all strategies
 *   node engine/exampleRunResearchFromConfig.js us_indices_core         # all strategies
 *   node engine/exampleRunResearchFromConfig.js us_indices_core trend_breakout           # trend_breakout only
 *   node engine/exampleRunResearchFromConfig.js us_indices_core trend_breakout confirmed  # + one-bar confirmation
 *   node engine/exampleRunResearchFromConfig.js us_indices_core trend_breakout strength   # + breakout strength filter
 *   node engine/exampleRunResearchFromConfig.js us_indices_core mean_reversion            # mean_reversion only
 *   node engine/exampleRunResearchFromConfig.js spy_only trend_breakout '' '' BREAKOUT   # trend_breakout, regime = BREAKOUT only
 *   node engine/exampleRunResearchFromConfig.js baseline '' '' '' BREAKOUT               # baseline + regime BREAKOUT only
 *   node engine/exampleRunResearchFromConfig.js us_indices_core trend_breakout strength noopen   # + no trades 09:30–10:00
 *   node engine/exampleRunResearchFromConfig.js baseline '' '' '' '' noopen               # baseline + exclude session open
 *   Arg positions: arg3=strategy, arg4=confirmed, arg5=strength, arg6=regime, arg7=noopen, arg8=late
 *   node engine/exampleRunResearchFromConfig.js spy_5m_2022_2025 trend_breakout confirmed strength BREAKOUT noopen late   # full premium setup
 *   node engine/exampleRunResearchFromConfig.js baseline trend_breakout confirmed strength BREAKOUT noopen late
 *   node engine/exampleRunResearchFromConfig.js spy_5m_2022_2025 trend_breakout            # SPY 5m more data (needs spy_5m_2022.csv … spy_5m_2025.csv)
 *   node engine/exampleRunResearchFromConfig.js spy_5m_single trend_breakout              # SPY 5m single file when year files not yet added
 */

const runResearchFromConfig = require('./runResearchFromConfig');
const baselineStrategyConfig = require('./baselineStrategyConfig');

async function main() {
  const requestedGroup = (process.argv[2] || '').trim();
  const strategyFilter = (process.argv[3] || '').trim();
  const arg4 = (process.argv[4] || '').trim().toLowerCase();
  const arg5 = (process.argv[5] || '').trim().toLowerCase();
  const regimeFilter = (process.argv[6] || '').trim();
  const arg7 = (process.argv[7] || '').trim().toLowerCase();
  const arg8 = (process.argv[8] || '').trim().toLowerCase();

  const confirmedArg = arg4 === 'confirmed' || arg4 === 'confirm';
  const strengthArg = arg5 === 'strength';
  const excludeOpen = arg7 === 'noopen' || arg7 === 'excludeopen' || arg7 === 'no_open';
  const lateOnlyArg = arg8 === 'late';

  const groupResolved = baselineStrategyConfig.resolveBaselineGroup(requestedGroup || runResearchFromConfig.DEFAULT_GROUP);
  const { group: groupName, isBaseline } = groupResolved;

  let multiAsset = { debugExportAllowedSignals: true };
  let runOptions = { research: { multiAsset } };
  if (isBaseline) {
    multiAsset = { ...baselineStrategyConfig.BASELINE_MULTI_ASSET };
    if (confirmedArg) {
      multiAsset.breakoutConfirmation = true;
    }
    if (strengthArg) {
      multiAsset.breakoutStrengthFilter = true;
    }
    if (regimeFilter) {
      multiAsset.includeRegimes = [regimeFilter];
    }
    if (excludeOpen) {
      multiAsset.excludeSessionOpenMinutes = 30;
    }
    if (lateOnlyArg) {
      multiAsset.allowSessionBuckets = ['late'];
    }
    runOptions = {
      ...baselineStrategyConfig.getBaselineResearchOptions(),
      research: { multiAsset },
    };
  } else {
    if (strategyFilter) {
      multiAsset.includeStrategies = [strategyFilter.trim()];
    }
    if (confirmedArg) {
      multiAsset.breakoutConfirmation = true;
    }
    if (strengthArg) {
      multiAsset.breakoutStrengthFilter = true;
    }
    if (regimeFilter) {
      multiAsset.includeRegimes = [regimeFilter];
    }
    if (excludeOpen) {
      multiAsset.excludeSessionOpenMinutes = 30;
    }
    if (lateOnlyArg) {
      multiAsset.allowSessionBuckets = ['late'];
    }
  }

  if (regimeFilter) {
    console.log('Regime filter: includeRegimes =', multiAsset.includeRegimes);
  }
  if (excludeOpen) {
    console.log('Exclude session open: no trades 09:30–10:00 ET (excludeSessionOpenMinutes = 30)');
  }
  if (lateOnlyArg) {
    console.log('Session filter: allowSessionBuckets = [\'late\'] (last 60 min of session only)');
  }

  console.log('Effective multiAsset:', JSON.stringify(multiAsset, null, 2));

  const output = await runResearchFromConfig.run(groupName, runOptions);

  if (isBaseline) {
    const parts = [
      baselineStrategyConfig.BASELINE_SYMBOL,
      baselineStrategyConfig.BASELINE_TIMEFRAME,
      '| trend_breakout',
      multiAsset.breakoutConfirmation ? '| with confirmation' : '| no confirmation',
      multiAsset.breakoutStrengthFilter ? '| with strength' : '| no strength filter',
    ];
    if (multiAsset.includeRegimes && multiAsset.includeRegimes.length > 0) {
      parts.push('|', multiAsset.includeRegimes[0], 'only');
    }
    if (multiAsset.excludeSessionOpenMinutes) {
      parts.push('| no open');
    }
    if (multiAsset.allowSessionBuckets && multiAsset.allowSessionBuckets.includes('late')) {
      parts.push('| late only');
    }
    console.log('Baseline profile:', parts.join(' '));
  }
  if (multiAsset.includeStrategies) {
    console.log('Strategy filter: includeStrategies =', multiAsset.includeStrategies);
  }
  if (multiAsset.breakoutConfirmation) {
    console.log('Breakout confirmation: one-bar confirmation enabled (trend_breakout only)');
  }
  if (multiAsset.breakoutStrengthFilter) {
    console.log('Breakout strength filter: enabled (body >= 60%, closeStrength >= 0.7)');
  }
  if (multiAsset.excludeSessionOpenMinutes) {
    console.log('Exclude session open: no trades in first', multiAsset.excludeSessionOpenMinutes, 'min of session');
  }
  if (multiAsset.allowSessionBuckets && multiAsset.allowSessionBuckets.length > 0) {
    console.log('Session filter: allowSessionBuckets =', multiAsset.allowSessionBuckets);
  }
  runResearchFromConfig.printSummary(output);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
