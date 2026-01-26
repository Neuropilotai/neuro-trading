# Opening Range Breakout Strategy - Implementation Guide

## Strategy Overview
This Pine Script v5 strategy implements an Opening Range Breakout (ORB) strategy for QQC on 1-minute charts during Regular Trading Hours (RTH).

## Rule Implementation

### 1. Time Rules ✅
**Implementation:**
- **Wait Period (09:30-09:45):** `isInORWindow` flag prevents trading during OR calculation
- **Trading Window (09:45-11:15):** `isInTradingWindow` flag restricts entries to this period
- **Max 2 Trades/Day:** `dailyTrades < maxTradesPerDay` check enforced before each entry

**Location:** Lines 49-75 (Time Logic section)
**Adjust:** Modify `tradeStartTime`, `tradeEndTime`, `orStartTime`, `orEndTime` inputs

---

### 2. Direction Filter (VWAP Bias) ✅
**Implementation:**
- VWAP calculated from 09:30 session start, resets daily
- At 09:45, compares `close >= vwapAtOrEnd` for LONG bias, `close <= vwapAtOrEnd` for SHORT bias
- `allowLong` and `allowShort` flags set at OR end, persist for the day

**Location:** Lines 86-111 (VWAP Calculation), Lines 129-138 (Direction Filter)
**Adjust:** VWAP calculation is automatic; bias determined by price vs VWAP at 09:45

---

### 3. Opening Range Calculation ✅
**Implementation:**
- Tracks `orHigh` and `orLow` during 09:30-09:45 window
- OR width validated at 09:45: `(orHigh - orLow) / close * 100` must be between min/max %
- `isTradable` flag set based on width validation

**Location:** Lines 113-127 (Opening Range Calculation)
**Adjust:** Modify `orWidthMinPct` (default 0.20%) and `orWidthMaxPct` (default 0.80%)

---

### 4. Entry Triggers ✅
**Implementation:**
- **Long:** `close > orHigh` after 09:45, within trading window, with LONG bias
- **Short:** `close < orLow` after 09:45, within trading window, with SHORT bias
- Both require `isTradable == true` and `canTradeToday == true`

**Location:** Lines 185-209 (Trade Logic)
**Adjust:** Entry logic is fixed per rules; no parameters to adjust

---

### 5. No-Trade Filter (OR Width) ✅
**Implementation:**
- Calculated at 09:45: `orWidthPct = (orHigh - orLow) / close * 100`
- Must be between `orWidthMinPct` and `orWidthMaxPct` (default: 0.20% - 0.80%)
- Sets `isTradable` flag; if false, no trades for the day

**Location:** Lines 123-127
**Adjust:** `orWidthMinPct` and `orWidthMaxPct` inputs

---

### 6. Risk Management ✅
**Implementation:**
- **Risk Per Trade ($2):** `riskPerTrade` input used in position sizing
- **Daily Max Loss ($8):** `currentDailyPnL > -dailyMaxLoss` check before entries
- **Stop Loss:** Uses tighter of OR-based stop or ATR stop
  - OR stop: `orLow` for longs, `orHigh` for shorts
  - ATR stop: `entryPrice ± (atr * atrMult)`
- **Take Profit:** `entryPrice ± (initialRisk * tpMultiple)` where `tpMultiple = 1.2R`
- **Break-Even:** When profit reaches `beTriggerR` (0.6R), stop moves to entry price

**Location:** 
- Position Sizing: Lines 146-157
- Stop Calculation: Lines 159-171
- Trade Logic: Lines 185-225
**Adjust:** 
- `riskPerTrade` (default $2)
- `dailyMaxLoss` (default $8)
- `tpMultiple` (default 1.2)
- `beTriggerR` (default 0.6)
- `atrMult` (default 1.5)

---

### 7. Position Sizing ✅
**Implementation:**
- Formula: `qty = floor(riskPerTrade / (stopDistance + slippageCost + commissionCost))`
- Accounts for:
  - Stop distance (entry to stop)
  - Slippage (ticks × tick size)
  - Commission (entry + exit estimate)
- Minimum 1 share

**Location:** Lines 146-157
**Adjust:** `riskPerTrade`, `slippageTicks`, `commissionPct`, `tickSize` inputs

---

### 8. Commission & Slippage ✅
**Implementation:**
- Used in position sizing calculations to ensure accurate risk targeting
- **Note:** Actual commission/slippage in backtesting must be set in Strategy Tester → Settings
- Inputs are for position sizing math only

**Location:** Lines 43-47 (Inputs), Lines 146-157 (Position Sizing)
**Adjust:** Set in Strategy Tester UI for backtesting; inputs affect position sizing only

---

## Visual Elements

### Plots
- **OR High/Low:** Green/red lines showing opening range boundaries
- **VWAP:** Blue line showing volume-weighted average price
- **Entry/Stop/TP:** Yellow/red/green lines when in position

### Labels
- **Tradability Label:** Shows at 09:45 indicating if OR width passed filter (✅/❌)
- **VWAP Bias Label:** Shows at 09:45 indicating LONG/SHORT/NEUTRAL bias

**Location:** Lines 237-273

---

## Test Checklist

### Setup
1. Chart: 1-minute timeframe
2. Symbol: QQC (or appropriate exchange prefix)
3. Date Range: Last 7 trading days (exclude weekends)
4. Strategy Tester Settings:
   - Commission: 0.1% (or your broker rate)
   - Slippage: 1 tick (or realistic for QQC)

### Metrics to Record
- **Profit Factor:** `netprofit / abs(grossloss)` (if grossloss < 0)
- **Win Rate:** `(wintrades / closedtrades) * 100`
- **Avg Trade:** `netprofit / closedtrades`
- **Max Drawdown:** Check Strategy Tester → Performance Summary
- **Trades/Day:** `closedtrades / trading_days`

### Verification Checklist
- [ ] Max 2 trades per day enforced (check daily trade count)
- [ ] Daily max loss ($8) enforced (check if trading stops after loss)
- [ ] OR width filter working (check labels - should see ❌ on narrow/wide days)
- [ ] VWAP bias filter working (check labels - should match price vs VWAP at 09:45)
- [ ] Break-even stops moving (check stop loss line moves to entry after +0.6R)
- [ ] Position sizing targets $2 risk (verify stop distance × quantity ≈ $2)

---

## Iteration Plan

### Priority 1: OR Width Bounds
**Parameters:** `orWidthMinPct`, `orWidthMaxPct`
- **Current:** 0.20% - 0.80%
- **If too many no-trade days:** Widen to 0.15% - 1.0%
- **If losing on choppy days:** Tighten to 0.30% - 0.60%
- **Metric to watch:** Win rate and avg trade quality

### Priority 2: ATR Multiplier
**Parameter:** `atrMult`
- **Current:** 1.5
- **If stopped out too often:** Increase to 2.0-2.5
- **If stops too wide (reducing R):** Decrease to 1.0-1.2
- **Metric to watch:** Stop distance vs win rate

### Priority 3: Take Profit Multiple
**Parameter:** `tpMultiple`
- **Current:** 1.2R
- **If leaving money on table:** Increase to 1.5R-2.0R
- **If TP rarely hit:** Decrease to 1.0R-1.1R
- **Metric to watch:** TP hit rate vs avg winning trade

### Priority 4: Break-Even Trigger
**Parameter:** `beTriggerR`
- **Current:** 0.6R
- **If stopped at BE too often:** Increase to 0.8R-1.0R
- **If missing larger moves:** Decrease to 0.4R-0.5R
- **Metric to watch:** BE stop-outs vs larger winners

### Priority 5: Trading Window
**Parameters:** `tradeStartTime`, `tradeEndTime`
- **Current:** 09:45 - 11:15
- **If early trades fail:** Start later (10:00)
- **If missing moves:** Extend window (11:30)
- **Metric to watch:** Trade quality by hour

---

## What NOT to Overfit

❌ **Don't optimize on < 20 trades** (need statistical significance)
❌ **Don't change multiple parameters at once** (isolate effects)
❌ **Don't optimize on in-sample data only** (use walk-forward)
❌ **Don't ignore max trades/day and daily loss limits** (they're risk controls)
❌ **Don't add filters without clear edge hypothesis**
❌ **Don't tune commission/slippage to improve results** (use realistic values)
❌ **Don't optimize on recent data only** (test across different market conditions)

---

## Quick Reference: Input Locations

| Parameter | Input Name | Default | Location |
|-----------|-----------|---------|----------|
| OR Width Min % | `orWidthMinPct` | 0.20% | Line 27 |
| OR Width Max % | `orWidthMaxPct` | 0.80% | Line 28 |
| ATR Length | `atrLength` | 14 | Line 32 |
| ATR Multiplier | `atrMult` | 1.5 | Line 33 |
| Risk Per Trade | `riskPerTrade` | $2.00 | Line 37 |
| Daily Max Loss | `dailyMaxLoss` | $8.00 | Line 38 |
| Take Profit (R) | `tpMultiple` | 1.2 | Line 39 |
| Break-Even Trigger | `beTriggerR` | 0.6 | Line 40 |
| Max Trades/Day | `maxTradesPerDay` | 2 | Line 41 |
| Commission % | `commissionPct` | 0.1% | Line 45 |
| Slippage (Ticks) | `slippageTicks` | 1 | Line 46 |

---

## File Structure

- **Main Strategy:** `opening_range_breakout_strategy.pine`
- **Implementation Guide:** This file (`ORB_STRATEGY_IMPLEMENTATION.md`)

The strategy is complete and ready for testing. Copy the Pine Script into TradingView and follow the test checklist above.

