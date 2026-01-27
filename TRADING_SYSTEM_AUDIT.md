# Trading System Comprehensive Audit
**Date:** 2026-01-26  
**Auditor:** Senior Quant Systems Architect  
**Branch:** `trading/main`  
**Status:** ✅ **AUDIT COMPLETE**

---

## EXECUTIVE SUMMARY

This trading system is **functionally complete** for paper trading with **real backtesting**, but contains **misleading AI/ML claims**. The core execution, risk management, and evaluation infrastructure is production-ready. Pattern learning is **rule-based**, not machine learning.

**Key Findings:**
- ✅ Real backtesting with no-lookahead enforcement
- ✅ Production-ready risk engine and trade ledger
- ✅ Real market data providers (Binance, CSV)
- ❌ **FAKE:** Pattern learning claims "AI" but is rule-based
- ❌ **FAKE:** Files like `super_trading_agent.js` simulate "neural networks"
- ⚠️ Limited test coverage (only 1 test file)
- ⚠️ Pattern performance not validated by outcomes

---

## PHASE 1 — HARD INVENTORY

### 1. Webhook / API Entry Points

| File | Purpose | Status | Runtime? | Safe? | Notes |
|------|---------|--------|----------|-------|-------|
| `simple_webhook_server.js` | Main TradingView webhook server | **PRODUCTION** | ✅ Yes | ✅ Yes | Express server, HMAC auth, rate limiting |
| `backend/middleware/webhookAuth.js` | HMAC signature verification | **PRODUCTION** | ✅ Yes | ✅ Yes | Timing-safe comparison, dual auth (HMAC + body secret) |
| `backend/middleware/webhookValidation.js` | Payload validation | **PRODUCTION** | ✅ Yes | ✅ Yes | Validates required fields |
| `backend/middleware/riskCheck.js` | Pre-execution risk validation | **PRODUCTION** | ✅ Yes | ✅ Yes | Calls riskEngine.validateOrder() |

**Status:** ✅ **PRODUCTION READY**

---

### 2. Risk Engine

| File | Purpose | Status | Runtime? | Safe? | Notes |
|------|---------|--------|----------|-------|-------|
| `backend/services/riskEngine.js` | Risk limit enforcement | **PRODUCTION** | ✅ Yes | ✅ Yes | Daily loss limit, position size, max positions, stop loss requirement |
| `backend/middleware/riskCheck.js` | Risk middleware | **PRODUCTION** | ✅ Yes | ✅ Yes | Wraps riskEngine |

**Status:** ✅ **PRODUCTION READY**

**Risk Limits (from env vars):**
- `MAX_DAILY_LOSS_PERCENT`: 2.0% (default)
- `MAX_POSITION_SIZE_PERCENT`: 25.0% (default)
- `MAX_OPEN_POSITIONS`: 5 (default)
- `REQUIRE_STOP_LOSS`: true (default)
- `REQUIRE_TAKE_PROFIT`: false (default, optional)

**Daily Stats Persistence:** ✅ Saves to `evaluationDb.daily_risk_stats` table

---

### 3. Paper Trading

| File | Purpose | Status | Runtime? | Safe? | Notes |
|------|---------|--------|----------|-------|-------|
| `backend/services/paperTradingService.js` | Paper trading execution | **PRODUCTION** | ✅ Yes | ✅ Yes | Simulates order execution, tracks account balance, positions, P&L |
| `backend/adapters/PaperBrokerAdapter.js` | Paper broker adapter | **PRODUCTION** | ✅ Yes | ✅ Yes | Implements BrokerAdapter interface, wraps paperTradingService |

**Status:** ✅ **PRODUCTION READY**

**Account Model:**
- Default balance: $500 (from `ACCOUNT_BALANCE` env var)
- Position tracking: Map<symbol, {quantity, avgPrice, entryTime, stopLoss, takeProfit}>
- P&L calculation: Real-time, includes unrealized P&L
- State persistence: Saves to `data/paper_account.json` every minute

---

### 4. Trade Ledger / Database

| File | Purpose | Status | Runtime? | Safe? | Notes |
|------|---------|--------|----------|-------|-------|
| `backend/db/tradeLedger.js` | Immutable trade ledger | **PRODUCTION** | ✅ Yes | ✅ Yes | SQLite, append-only, idempotency keys |
| `backend/db/evaluationDb.js` | Backtest/walk-forward storage | **PRODUCTION** | ✅ Yes | ✅ Yes | SQLite, stores backtest runs, walk-forward folds, pattern performance |
| `backend/db/evaluationSchema.sql` | Database schema | **PRODUCTION** | ✅ Yes | ✅ Yes | Tables: backtest_runs, walkforward_runs, daily_risk_stats, pattern_performance, trade_pattern_attribution |

**Status:** ✅ **PRODUCTION READY**

**Storage:**
- Trade ledger: `./data/trade_ledger.db` (SQLite)
- Evaluation DB: `./data/evaluation.db` (SQLite)
- Both use SQLite3 (no external dependencies)

---

### 5. Pattern Learning

| File | Purpose | Status | Runtime? | Safe? | Notes |
|------|---------|--------|----------|-------|-------|
| `backend/services/patternLearningEngine.js` | Pattern extraction from OHLCV | **PARTIAL** | ✅ Yes | ⚠️ **MISLEADING** | Rule-based pattern detection, NOT ML/AI. Claims "learning" but uses rule-based feature extraction |
| `backend/services/patternRecognitionService.js` | Pattern detection | **PARTIAL** | ✅ Yes | ⚠️ **MISLEADING** | Rule-based (opening gaps, range breakouts, double tops/bottoms). No ML. |
| `backend/services/patternLearningAgents.js` | Pattern learning agents | **STUB** | ✅ Yes | ⚠️ **MISLEADING** | Wraps patternRecognitionService, no actual ML |
| `backend/services/googleDrivePatternStorage.js` | Pattern storage | **PRODUCTION** | ✅ Yes | ✅ Yes | Stores patterns to Google Drive (optional) |

**Status:** ⚠️ **RULE-BASED, NOT ML/AI**

**Pattern Types (Rule-Based):**
- Opening gap (up/down)
- Opening range breakout (up/down)
- Double top/bottom
- Support bounce
- Resistance rejection
- Momentum burst (scalping)
- Volatility expansion (scalping)

**Feature Extraction:**
- Returns, volatility (std of returns)
- ATR (Average True Range)
- Trend slope (linear regression)
- Volume ratio
- Regime classification (TRENDING/SIDEWAYS/VOLATILE)

**NO MACHINE LEARNING:** No tensorflow, pytorch, sklearn, or any ML libraries. Pure rule-based pattern matching.

---

### 6. Pattern Recognition

| File | Purpose | Status | Runtime? | Safe? | Notes |
|------|---------|--------|----------|-------|-------|
| `backend/services/patternRecognitionService.js` | Real-time pattern detection | **PARTIAL** | ✅ Yes | ⚠️ **MISLEADING** | Rule-based detection, matches against learned patterns (from patternLearningEngine) |

**Status:** ⚠️ **RULE-BASED, NOT ML**

**Detection Process:**
1. Add to price history (rolling window, max 1000 candles)
2. Detect opening patterns (first 5-15 minutes)
3. Detect price action patterns (double tops, support/resistance)
4. Match against known patterns (from patternLearningEngine)
5. Return matched patterns with confidence scores

**Confidence Calculation:** Rule-based (gap size, breakout strength, etc.)

---

### 7. Market Data Providers

| File | Purpose | Status | Runtime? | Safe? | Notes |
|------|---------|--------|----------|-------|-------|
| `backend/services/marketDataProvider.js` | Base provider interface | **PRODUCTION** | ✅ Yes | ✅ Yes | Abstract base class |
| `backend/services/providers/binanceProvider.js` | Binance API provider | **PRODUCTION** | ✅ Yes | ✅ Yes | Real API calls to `api.binance.com`, rate limiting |
| `backend/services/providers/localCsvProvider.js` | Local CSV provider | **PRODUCTION** | ✅ Yes | ✅ Yes | Reads from `data/csv/{symbol}_{timeframe}.csv` |
| `backend/services/providers/yahooFinanceProvider.js` | Yahoo Finance provider | **STUB** | ❌ No | ⚠️ **PLACEHOLDER** | Returns empty array, comment says "unreliable, placeholder" |
| `backend/services/providerFactory.js` | Provider factory | **PRODUCTION** | ✅ Yes | ✅ Yes | Creates appropriate provider based on symbol metadata |

**Status:** ✅ **PRODUCTION** (Binance, CSV), ⚠️ **STUB** (Yahoo Finance)

**Real Providers:**
- ✅ Binance: Real HTTPS requests to Binance API
- ✅ Local CSV: Reads from filesystem
- ❌ Yahoo Finance: Placeholder (returns empty array)

---

### 8. PineScript Integration

| File | Purpose | Status | Runtime? | Safe? | Notes |
|------|---------|--------|----------|-------|-------|
| `simple_webhook_server.js` | Webhook endpoint | **PRODUCTION** | ✅ Yes | ✅ Yes | `/webhook/tradingview` endpoint |
| `backend/tradingview_api_wrapper.js` | TradingView API wrapper | **PRODUCTION** | ✅ Yes | ✅ Yes | Wraps TradingView API calls |
| `backend/services/tradingViewSync.js` | Sync trades to TradingView | **PRODUCTION** | ✅ Yes | ✅ Yes | Exports trades to CSV/JSON for TradingView |

**Status:** ✅ **PRODUCTION READY**

**Integration:**
- Webhook receives alerts from TradingView Pine Script
- HMAC authentication (X-TradingView-Signature header)
- Body secret authentication (fallback)
- Rate limiting (10 requests/min per IP)

---

### 9. Backtesting / Evaluation Logic

| File | Purpose | Status | Runtime? | Safe? | Notes |
|------|---------|--------|----------|-------|-------|
| `backend/services/backtestEngine.js` | Deterministic backtester | **PRODUCTION** | ✅ Yes | ✅ Yes | **REAL BACKTESTING**, no-lookahead enforced, deterministic |
| `backend/services/walkForwardValidator.js` | Walk-forward validation | **PRODUCTION** | ✅ Yes | ✅ Yes | Rolling window validation, degradation detection |
| `backend/services/patternAttributionService.js` | Pattern performance tracking | **PRODUCTION** | ✅ Yes | ✅ Yes | Links trades to patterns, tracks pattern performance |
| `cli/backtest.js` | Backtest CLI | **PRODUCTION** | ✅ Yes | ✅ Yes | Command-line interface for backtesting |
| `cli/walkforward.js` | Walk-forward CLI | **PRODUCTION** | ✅ Yes | ✅ Yes | Command-line interface for walk-forward validation |

**Status:** ✅ **PRODUCTION READY - REAL BACKTESTING**

**No Lookahead Enforcement:**
- ✅ Processes candles sequentially (one at a time)
- ✅ Signal generated on candle close → filled at next candle open
- ✅ Only uses data up to current candle
- ✅ Unit tests verify no lookahead (`tests/backtestEngine.test.js`)

**Fill Model:**
- Entry: Signal on candle close → fill at next candle open
- Exit: Stop loss/take profit checked on candle close → fill at next candle open
- Spread: 0.1% crypto, 0.05% stocks
- Slippage: 0.05% for market orders
- Commission: 0.1% (Binance-like)

**Performance Metrics:**
- ✅ Net profit, net profit %
- ✅ Win rate, profit factor
- ✅ Sharpe ratio (annualized)
- ✅ Max drawdown, max drawdown %
- ✅ Average trade duration

**Deterministic IDs:** Uses SHA256 hash of inputs for deterministic backtest IDs

---

### 10. CLI / Scripts

| File | Purpose | Status | Runtime? | Safe? | Notes |
|------|---------|--------|----------|-------|-------|
| `cli/backtest.js` | Backtest CLI | **PRODUCTION** | ✅ Yes | ✅ Yes | Runs backtests from command line |
| `cli/walkforward.js` | Walk-forward CLI | **PRODUCTION** | ✅ Yes | ✅ Yes | Runs walk-forward validation |
| `scripts/verify_tradingview_webhook.sh` | Webhook verification script | **PRODUCTION** | ✅ Yes | ✅ Yes | Tests webhook endpoint |

**Status:** ✅ **PRODUCTION READY**

---

### 11. Tests

| File | Purpose | Status | Runtime? | Safe? | Notes |
|------|---------|--------|----------|-------|-------|
| `tests/backtestEngine.test.js` | Backtest engine unit tests | **PRODUCTION** | ✅ Yes | ✅ Yes | Tests no-lookahead, P&L calculation, drawdown |

**Status:** ⚠️ **LIMITED COVERAGE** (only 1 test file)

**Test Coverage:**
- ✅ No-lookahead guarantee
- ✅ P&L calculation (winning/losing trades)
- ✅ Drawdown calculation
- ❌ Risk engine tests: **MISSING**
- ❌ Paper trading tests: **MISSING**
- ❌ Pattern recognition tests: **MISSING**
- ❌ Trade ledger tests: **MISSING**
- ❌ Webhook auth tests: **MISSING**

---

### 12. Documentation

| File | Purpose | Status | Runtime? | Safe? | Notes |
|------|---------|--------|----------|-------|-------|
| `BACKTESTING_DOCUMENTATION.md` | Backtesting guide | **PRODUCTION** | N/A | ✅ Yes | Comprehensive documentation |
| `TRADING_ONLY_SETUP.md` | Trading setup guide | **PRODUCTION** | N/A | ✅ Yes | Setup instructions |
| `README.md` | Main README | **PRODUCTION** | N/A | ✅ Yes | General documentation |

**Status:** ✅ **GOOD DOCUMENTATION**

---

## PHASE 2 — TRUTH CHECK

### Is there REAL backtesting? (not random / fake)

**✅ YES** — Real deterministic backtesting implemented in `backend/services/backtestEngine.js`:
- Processes candles sequentially (no lookahead)
- Realistic fill model (signal on close → fill at next open)
- Spread, slippage, commission applied
- Performance metrics calculated correctly
- Unit tests verify correctness

**Evidence:**
- `backend/services/backtestEngine.js` lines 107-148: Sequential candle processing
- `tests/backtestEngine.test.js`: Unit tests verify no lookahead and correct P&L

---

### Is there NO-LOOKAHEAD enforcement?

**✅ YES** — Enforced by design:
- Candles processed one at a time in a loop
- Signal generated from current candle only
- Next candle only used for fill price (realistic execution delay)
- Unit test explicitly checks for lookahead violations

**Evidence:**
- `backend/services/backtestEngine.js` line 108: `for (let i = 0; i < candles.length; i++)`
- `backend/services/backtestEngine.js` line 113: `const signal = strategy.generateSignal(candle, strategyState);` (only current candle)
- `tests/backtestEngine.test.js` lines 11-91: Lookahead detection test

---

### Are performance metrics mathematically correct?

**✅ YES** — Metrics calculated correctly:
- Net profit: `account.equity - account.initialBalance`
- Win rate: `winningTrades / totalTrades`
- Sharpe ratio: Annualized using `(avgReturn / stdDev) * sqrt(252)`
- Profit factor: `grossProfit / grossLoss`
- Max drawdown: Peak-to-trough calculation

**Evidence:**
- `backend/services/backtestEngine.js` lines 437-487: Metric calculations

---

### Is pattern learning validated by outcomes?

**❌ NO** — Pattern learning is **NOT validated by trade outcomes**:
- Patterns are extracted from OHLCV data (rule-based)
- Pattern performance is tracked (`patternAttributionService`)
- But patterns are **NOT filtered** based on performance
- No validation that patterns actually predict profitable trades

**Evidence:**
- `backend/services/patternAttributionService.js`: Tracks pattern performance but doesn't filter patterns
- `backend/services/patternRecognitionService.js`: Uses all learned patterns regardless of performance

**Gap:** Patterns should be filtered by win rate, profit factor, or Sharpe ratio before use in live trading.

---

### Are "AI / neural network" claims real or simulated?

**❌ FAKE** — Multiple files claim "neural networks" but are **simulated**:

**Fake Files (DO NOT USE):**
1. `backend/super_trading_agent.js` (lines 107, 978, 1013-1033)
   - Claims "Deep learning layers", "Neural Network optimization"
   - **REALITY:** Simulated, no actual ML libraries
   - **DANGER:** Misleading if trusted

2. `backend/ultra_enhanced_super_agent.js` (lines 172-173, 196-201, 612-629)
   - Claims "Quantum Neural Networks", "consciousness"
   - **REALITY:** Pure simulation, Map-based "neural networks"
   - **DANGER:** Extremely misleading

3. `backend/super_learning_ai_agent.js` (lines 19, 154-155, 388-527)
   - Claims "neural networks" with "weights"
   - **REALITY:** Simulated, no actual ML

**Real Pattern Learning:**
- `backend/services/patternLearningEngine.js`: Rule-based feature extraction
- `backend/services/patternRecognitionService.js`: Rule-based pattern matching
- **NO ML LIBRARIES:** No tensorflow, pytorch, sklearn, or any ML libraries in use

**Recommendation:** Delete or clearly mark fake AI files as "simulation/demo only".

---

### Is any code misleading or dangerous if trusted?

**⚠️ YES** — Several misleading files:

1. **Fake AI Files:**
   - `backend/super_trading_agent.js` — Claims neural networks, simulated
   - `backend/ultra_enhanced_super_agent.js` — Claims "quantum neural networks", simulated
   - `backend/super_learning_ai_agent.js` — Claims ML, simulated

2. **Pattern Learning Claims:**
   - Files claim "AI" but use rule-based pattern matching
   - No actual machine learning

3. **Yahoo Finance Provider:**
   - `backend/services/providers/yahooFinanceProvider.js` — Placeholder, returns empty array
   - Comment says "unreliable, placeholder" but could be used unknowingly

**Danger Level:**
- **HIGH:** Fake AI files could mislead developers into thinking ML is implemented
- **MEDIUM:** Pattern learning claims "AI" but is rule-based
- **LOW:** Yahoo Finance placeholder is clearly marked

---

## PHASE 3 — SYSTEM CONTRACT LOCK

### Fill Model

**Entry:**
- Signal generated on candle close
- Fill executed at **next candle open**
- Rationale: Conservative, realistic (can't get filled at exact close price)

**Exit:**
- Stop loss/take profit checked on candle close
- Fill executed at **next candle open** (or at stop/take price if hit)

**Evidence:** `backend/services/backtestEngine.js` lines 115-128

---

### Cost Model

**Spread:**
- Crypto: 0.1% (buy higher, sell lower)
- Stocks: 0.05%
- Configurable via `spreadPct` in backtest config

**Slippage:**
- Default: 0.05% for market orders
- Applied on top of spread

**Commission:**
- Default: 0.1% (Binance-like)
- Applied on both entry and exit

**Evidence:** `backend/services/backtestEngine.js` lines 19-27, 220-232

---

### Position Model

**Single Position Per Symbol:**
- Only one position per symbol at a time
- New BUY signal closes existing position first (reversal)

**Position Sizing:**
- Backtest: 10% of equity per trade (hardcoded in `backtestEngine.js` line 270)
- Live trading: Uses `riskEngine` limits (max 25% position size)

**Evidence:**
- `backend/services/backtestEngine.js` line 270: `const positionSize = account.equity * 0.1;`
- `backend/services/riskEngine.js` lines 183-195: Position size validation

---

### Risk Limits

**Daily Loss Limit:**
- Default: 2.0% (`MAX_DAILY_LOSS_PERCENT`)
- Enforced by `riskEngine.validateOrder()`

**Position Size Limit:**
- Default: 25.0% (`MAX_POSITION_SIZE_PERCENT`)
- Enforced by `riskEngine.validateOrder()`

**Max Open Positions:**
- Default: 5 (`MAX_OPEN_POSITIONS`)
- Enforced by `riskEngine.validateOrder()`

**Stop Loss Requirement:**
- Default: Required (`REQUIRE_STOP_LOSS=true`)
- Enforced by `riskEngine.validateOrder()`

**Evidence:** `backend/services/riskEngine.js` lines 14-18, 156-237

---

### Data Sources

**Primary:**
- Binance API (`backend/services/providers/binanceProvider.js`)
- Local CSV files (`backend/services/providers/localCsvProvider.js`)

**Secondary:**
- Yahoo Finance (placeholder, returns empty array)

**Evidence:** `backend/services/providerFactory.js`

---

### Timeframes

**Supported:**
- 1m, 5m, 15m, 60m, 240m, D (daily)

**Evidence:** `backend/services/marketDataProvider.js` lines 69-79

---

### Storage

**SQLite Databases:**
- Trade ledger: `./data/trade_ledger.db`
- Evaluation DB: `./data/evaluation.db`

**File Storage:**
- Paper account state: `./data/paper_account.json`
- Pattern storage: Google Drive (optional) or local cache
- OHLCV cache: Local filesystem

**Evidence:** `backend/db/tradeLedger.js`, `backend/db/evaluationDb.js`

---

## PHASE 4 — GAP IDENTIFICATION (TOP 5)

### 1. Pattern Performance Validation (CRITICAL)

**Why it matters:**
- Patterns are extracted but not validated by trade outcomes
- System may use unprofitable patterns in live trading
- No filtering based on win rate, profit factor, or Sharpe ratio

**What breaks without it:**
- Live trading may use patterns that lose money
- No way to know which patterns are actually profitable
- Pattern learning becomes "garbage in, garbage out"

**Blocks live trading:** ⚠️ **PARTIALLY** — System works but may trade unprofitable patterns

**Evidence:**
- `backend/services/patternAttributionService.js`: Tracks performance but doesn't filter
- `backend/services/patternRecognitionService.js`: Uses all patterns regardless of performance

---

### 2. Limited Test Coverage (HIGH RISK)

**Why it matters:**
- Only 1 test file (`tests/backtestEngine.test.js`)
- Risk engine, paper trading, trade ledger, webhook auth not tested
- Bugs may go undetected until production

**What breaks without it:**
- Risk limits may not work correctly
- Trade execution may have bugs
- Webhook authentication may fail

**Blocks live trading:** ⚠️ **YES** — High risk of bugs in production

**Missing Tests:**
- Risk engine validation
- Paper trading execution
- Trade ledger persistence
- Webhook authentication
- Pattern recognition

---

### 3. Fake AI/ML Files (MEDIUM RISK)

**Why it matters:**
- Misleading files claim "neural networks" but are simulated
- Developers may trust fake AI code
- Wastes time debugging non-functional code

**What breaks without it:**
- Nothing breaks, but developers are misled
- Code quality suffers

**Blocks live trading:** ❌ **NO** — But creates confusion

**Files to Delete/Mark:**
- `backend/super_trading_agent.js`
- `backend/ultra_enhanced_super_agent.js`
- `backend/super_learning_ai_agent.js`

---

### 4. Position Sizing Hardcoded in Backtest (MEDIUM RISK)

**Why it matters:**
- Backtest uses 10% of equity (hardcoded)
- Live trading uses risk engine limits (25% max)
- Backtest and live trading behave differently

**What breaks without it:**
- Backtest results don't match live trading behavior
- Strategy may appear profitable in backtest but fail live

**Blocks live trading:** ⚠️ **PARTIALLY** — Results may not match expectations

**Evidence:**
- `backend/services/backtestEngine.js` line 270: `const positionSize = account.equity * 0.1;`
- `backend/services/riskEngine.js` line 188: Uses `MAX_POSITION_SIZE_PERCENT` (25%)

---

### 5. Pattern Learning Not Validated by Regime (LOW RISK)

**Why it matters:**
- Patterns learned in one market regime may fail in another
- No regime detection (TRENDING/SIDEWAYS/VOLATILE) filtering
- Patterns may work in backtest but fail in different market conditions

**What breaks without it:**
- Patterns may fail when market regime changes
- No way to know which patterns work in which regimes

**Blocks live trading:** ❌ **NO** — But reduces reliability

**Evidence:**
- `backend/services/patternLearningEngine.js` lines 226-234: Regime classification exists but not used for filtering

---

## PHASE 5 — NEXT STEP DEFINITION

### Selected Next Step: **Pattern Performance Validation**

**Why this step:**
1. **Reduces risk:** Prevents trading unprofitable patterns
2. **Improves correctness:** Only uses patterns validated by outcomes
3. **Prepares for scaling:** Foundation for pattern filtering and regime-based selection
4. **Achievable in ≤ 1 week:** Can implement pattern filtering based on existing performance data

**What it involves:**
1. Add pattern performance filters to `patternRecognitionService`:
   - Filter patterns by win rate (e.g., > 50%)
   - Filter by profit factor (e.g., > 1.0)
   - Filter by minimum sample size (e.g., ≥ 10 trades)
2. Update pattern matching to only use validated patterns
3. Add configuration for performance thresholds (env vars)
4. Add logging/metrics for filtered patterns

**Justification:**
- **Risk reduction:** Prevents trading losing patterns
- **Truth/validation:** Uses only patterns proven by outcomes
- **Safety:** No risk of breaking existing functionality (additive change)
- **Foundation:** Enables future regime-based and time-based filtering

**Not chosen:**
- Test coverage: Important but doesn't reduce risk of trading bad patterns
- Fake AI cleanup: Important but doesn't improve correctness
- Position sizing alignment: Important but less critical than pattern validation

---

## PHASE 6 — HANDOFF PREP

### Files That Will Be Modified

1. `backend/services/patternRecognitionService.js`
   - Add pattern performance filtering
   - Only return patterns that meet performance thresholds

2. `backend/services/patternAttributionService.js`
   - Add helper methods to query pattern performance
   - Add filtering logic

3. `backend/db/evaluationDb.js`
   - Add query methods for pattern performance stats
   - (May need to add indexes)

4. `simple_webhook_server.js` (optional)
   - Add metrics/logging for filtered patterns

### Files That Must NOT Be Touched

1. `backend/services/backtestEngine.js` — **DO NOT TOUCH** (core backtesting logic)
2. `backend/services/riskEngine.js` — **DO NOT TOUCH** (risk limits)
3. `backend/services/paperTradingService.js` — **DO NOT TOUCH** (paper trading execution)
4. `backend/db/tradeLedger.js` — **DO NOT TOUCH** (trade ledger)
5. `backend/middleware/webhookAuth.js` — **DO NOT TOUCH** (authentication)

### Data That Must Exist

1. **Pattern performance data:**
   - `pattern_performance` table in `evaluation.db`
   - Must have `win_rate`, `profit_factor`, `total_trades` columns
   - Populated by `patternAttributionService.attributeTrade()`

2. **Trade pattern attribution:**
   - `trade_pattern_attribution` table in `evaluation.db`
   - Links trades to patterns
   - Populated by `patternAttributionService.attributeTrade()`

**Verification:**
```sql
SELECT COUNT(*) FROM pattern_performance WHERE total_trades >= 10;
SELECT pattern_id, win_rate, profit_factor FROM pattern_performance WHERE total_trades >= 10;
```

### Tests That Must Pass

1. **Existing tests:**
   - `tests/backtestEngine.test.js` — Must still pass

2. **New tests (to be added):**
   - Pattern filtering by win rate
   - Pattern filtering by profit factor
   - Pattern filtering by minimum sample size
   - Pattern matching only returns validated patterns

### Environment Variables to Add

```bash
# Pattern Performance Filters
PATTERN_MIN_WIN_RATE=0.50          # Minimum win rate (50%)
PATTERN_MIN_PROFIT_FACTOR=1.0      # Minimum profit factor
PATTERN_MIN_SAMPLE_SIZE=10         # Minimum trades for validation
ENABLE_PATTERN_FILTERING=true      # Enable/disable filtering
```

### Success Criteria

1. ✅ Only patterns with `win_rate >= PATTERN_MIN_WIN_RATE` are used
2. ✅ Only patterns with `profit_factor >= PATTERN_MIN_PROFIT_FACTOR` are used
3. ✅ Only patterns with `total_trades >= PATTERN_MIN_SAMPLE_SIZE` are used
4. ✅ Filtered patterns are logged (for monitoring)
5. ✅ Existing backtest tests still pass
6. ✅ No breaking changes to existing functionality

---

## SUMMARY

**System Status:** ✅ **PRODUCTION READY** for paper trading with real backtesting

**Critical Findings:**
- ✅ Real backtesting (no-lookahead enforced)
- ✅ Production-ready risk engine and trade ledger
- ❌ Pattern learning is rule-based, NOT ML/AI (despite claims)
- ❌ Fake AI files (simulated "neural networks")
- ⚠️ Limited test coverage
- ⚠️ Pattern performance not validated by outcomes

**Next Step:** Implement pattern performance validation to filter patterns by win rate, profit factor, and sample size.

**System Contract:** Locked — Fill model, cost model, position model, risk limits, data sources, timeframes, storage all defined and documented.

---

**END OF AUDIT**

