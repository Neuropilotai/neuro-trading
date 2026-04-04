'use strict';

/**
 * Discovery Engine — Step 6 (optional): Walk-forward validation.
 *
 * For a given setup (or list of setups): train on window A, test on window B.
 * Example: Train 2019–2022, Test 2023; then Train 2020–2023, Test 2024.
 * If expectancy stays positive on the test window → strong signal.
 *
 * Input: setup id, data group with year splits (or single-year groups), train years, test year.
 * Output: { trainExpectancy, testExpectancy, survived: boolean }.
 *
 * TODO: Implement.
 * - Load candles for train years + test year (or filter by date)
 * - Run backtest on train period only → get signals/params (no overfitting on test)
 * - Run backtest on test period with same rules → testExpectancy
 * - survived = testExpectancy > 0
 */

async function walkForwardTest(options = {}) {
  const {
    setupId = 'setup_001',
    trainYears = [2019, 2020, 2021, 2022],
    testYear = 2023,
    symbol = 'SPY',
    timeframe = '5m',
  } = options;
  // TODO: load train data, run research/backtest; load test data, run same setup; compare
  return {
    setupId,
    trainYears,
    testYear,
    trainExpectancy: null,
    testExpectancy: null,
    survived: null,
    _stub: true,
  };
}

module.exports = { walkForwardTest };
