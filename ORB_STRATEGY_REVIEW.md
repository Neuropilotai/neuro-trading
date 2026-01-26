# Opening Range Breakout Strategy - Code Review

## ✅ What's Good

1. **Cleaner Time Logic**: Your hour/minute input approach is more intuitive than timestamp inputs
2. **Built-in VWAP**: Using `ta.vwap()` is simpler than manual calculation
3. **Crossover Detection**: Using `ta.crossover()`/`ta.crossunder()` is more precise than `close > orHigh`
4. **Window Close**: Closing positions at end of trading window is a good risk management practice
5. **Daily State Management**: Clean use of `var` for daily state

## ⚠️ Potential Issues

### 1. VWAP Reset Timing
**Issue:** `ta.vwap(hlc3)` resets at the chart's session start, which may not be exactly 09:30 NY time.

**Fix:** Capture VWAP value at OR end explicitly:
```pine
var float vwapAtOrEnd = na
if atOREnd
    vwapAtOrEnd := vwapVal
    bias := close > vwapAtOrEnd ? 1 : close < vwapAtOrEnd ? -1 : 0
```

### 2. Daily Trades Counter
**Issue:** You increment `tradesToday` on entry, but the requirement is "max 2 trades/day" (completed trades).

**Fix:** Increment on trade close:
```pine
if strategy.closedtrades > strategy.closedtrades[1]
    tradesToday += 1
```

### 3. OR Width Calculation
**Issue:** You use `orMid` (average of OR High/Low) as denominator, but requirement says "0.20% and 0.80% of price" (should use `close` at OR end).

**Fix:**
```pine
if atOREnd and not na(orHigh) and not na(orLow)
    orFinal := true
    widthPct = close != 0.0 ? ((orHigh - orLow) / close) * 100.0 : na
    tradable := not na(widthPct) and widthPct >= orWidthMinPct and widthPct <= orWidthMaxPct
```

### 4. Break-Even Logic
**Issue:** You recalculate `reachedBE` every bar, but should track if BE was already moved to avoid unnecessary recalculations.

**Fix:**
```pine
var bool movedBE = false

if strategy.position_size != 0 and initRisk > 0 and not movedBE
    if strategy.position_size > 0
        reachedBE = high >= entryPrice + beTriggerR * initRisk
        if reachedBE
            movedBE := true
            stopNow = entryPrice
        else
            stopNow = initStop
        tpNow = entryPrice + tpMultiple * initRisk
        strategy.exit("L-exit", "L", stop=stopNow, limit=tpNow)
    else
        reachedBE = low <= entryPrice - beTriggerR * initRisk
        if reachedBE
            movedBE := true
            stopNow = entryPrice
        else
            stopNow = initStop
        tpNow = entryPrice - tpMultiple * initRisk
        strategy.exit("S-exit", "S", stop=stopNow, limit=tpNow)
```

### 5. Position Sizing - Commission/Slippage
**Issue:** Your sizing doesn't account for commission and slippage, which can reduce actual risk per trade.

**Current:**
```pine
f_qty(entry, stop) =>
    dist = math.abs(entry - stop)
    dist > syminfo.mintick ? math.floor(riskPerTrade / dist) : 0.0
```

**Improved (accounts for costs):**
```pine
f_qty(entry, stop, commissionPct, slippageTicks, tickSize) =>
    dist = math.abs(entry - stop)
    slippageCost = slippageTicks * tickSize
    commissionCost = entry * (commissionPct / 100) * 2  // Entry + exit
    totalCostPerShare = dist + slippageCost + commissionCost
    totalCostPerShare > syminfo.mintick ? math.floor(riskPerTrade / totalCostPerShare) : 0.0
```

### 6. Initial Capital Mismatch
**Issue:** You set `initial_capital=500` but risk $2 per trade. With $500 account, max 2 trades/day at $2 risk is very conservative (0.4% risk per trade).

**Note:** This is fine for testing, but ensure your backtesting reflects realistic account size.

## 🔧 Recommended Fixes

Here's a corrected version addressing the issues above:

```pine
//@version=5
strategy("Opening Range Breakout - QQQ (Fixed)",
     overlay=true,
     initial_capital=500,
     currency=currency.CAD,
     commission_type=strategy.commission.percent,
     commission_value=0.01,
     slippage=1,
     process_orders_on_close=true,
     pyramiding=0)

// ===================== INPUTS =====================
tz = input.string("America/New_York", "Timezone")

// Windows (NY time)
orStartH = input.int(9,  "OR Start Hour", minval=0, maxval=23)
orStartM = input.int(30, "OR Start Min",  minval=0, maxval=59)
orEndH   = input.int(9,  "OR End Hour",   minval=0, maxval=23)
orEndM   = input.int(45, "OR End Min",    minval=0, maxval=59)

tradeStartH = input.int(9,  "Trade Start Hour", minval=0, maxval=23)
tradeStartM = input.int(45, "Trade Start Min",  minval=0, maxval=59)
tradeEndH   = input.int(11, "Trade End Hour",   minval=0, maxval=23)
tradeEndM   = input.int(15, "Trade End Min",    minval=0, maxval=59)

// OR width filter
orWidthMinPct = input.float(0.20, "OR Width Min %", step=0.01)
orWidthMaxPct = input.float(0.80, "OR Width Max %", step=0.01)

// ATR stop
atrLength = input.int(14, "ATR Length", minval=1)
atrMult   = input.float(1.5, "ATR Mult", step=0.1)

// Risk
riskPerTrade    = input.float(2.0, "Risk per trade ($)", step=0.25)
dailyMaxLoss    = input.float(8.0, "Daily max loss ($)", step=0.5)
tpMultiple      = input.float(1.2, "Take Profit (R)", step=0.1)
beTriggerR      = input.float(0.6, "Move stop to BE at (R)", step=0.1)
maxTradesPerDay = input.int(2, "Max trades/day", minval=1)

// Costs (for position sizing)
commissionPct = input.float(0.1, "Commission % (for sizing)", step=0.01)
slippageTicks = input.int(1, "Slippage (Ticks)", minval=0)
tickSize = input.float(0.01, "Tick Size", step=0.001)

// ===================== TIME LOGIC =====================
f_hhmm(h, m) => h * 60 + m

curH = hour(time, tz)
curM = minute(time, tz)
curMin = f_hhmm(curH, curM)

orStartMin   = f_hhmm(orStartH, orStartM)
orEndMin     = f_hhmm(orEndH, orEndM)
tradeStartMin= f_hhmm(tradeStartH, tradeStartM)
tradeEndMin  = f_hhmm(tradeEndH, tradeEndM)

inORWindow      = curMin >= orStartMin and curMin < orEndMin
atOREnd         = (curMin == orEndMin)
afterOR         = curMin >= orEndMin
inTradeWindow   = curMin >= tradeStartMin and curMin <= tradeEndMin

newDay = ta.change(time("D", tz))

// ===================== DAILY STATE =====================
var float orHigh = na
var float orLow  = na
var bool  orFinal = false
var bool  tradable = false

var int tradesToday = 0
var float dayNetStart = 0.0
var bool dailyLocked = false

if newDay
    orHigh := na
    orLow := na
    orFinal := false
    tradable := false
    tradesToday := 0
    dayNetStart := strategy.netprofit
    dailyLocked := false

// ===================== VWAP =====================
vwapVal = ta.vwap(hlc3)
var float vwapAtOrEnd = na
var int bias = 0  // +1 long only, -1 short only, 0 none

// ===================== OPENING RANGE BUILD =====================
if inORWindow
    orHigh := na(orHigh) ? high : math.max(orHigh, high)
    orLow  := na(orLow)  ? low  : math.min(orLow,  low)

if atOREnd and not na(orHigh) and not na(orLow)
    orFinal := true
    // Capture VWAP at OR end
    vwapAtOrEnd := vwapVal
    // OR width filter (use close, not orMid)
    widthPct = close != 0.0 ? ((orHigh - orLow) / close) * 100.0 : na
    tradable := not na(widthPct) and widthPct >= orWidthMinPct and widthPct <= orWidthMaxPct
    // VWAP bias locked at OR end
    bias := close > vwapAtOrEnd ? 1 : close < vwapAtOrEnd ? -1 : 0

// ===================== DAILY LOSS LOCK =====================
dayPnL = strategy.netprofit - dayNetStart
if not dailyLocked and dayPnL <= -dailyMaxLoss
    dailyLocked := true

// Track completed trades (not entries)
if strategy.closedtrades > strategy.closedtrades[1]
    tradesToday += 1

canTrade = orFinal and tradable and not dailyLocked and inTradeWindow and tradesToday < maxTradesPerDay and bias != 0

// ===================== SIZING + STOPS =====================
atr = ta.atr(atrLength)

f_tighterStop(isLong, entry, orH, orL, atrv) =>
    orStop  = isLong ? orL : orH
    atrStop = isLong ? entry - atrv * atrMult : entry + atrv * atrMult
    isLong ? math.max(orStop, atrStop) : math.min(orStop, atrStop)

f_qty(entry, stop) =>
    dist = math.abs(entry - stop)
    slippageCost = slippageTicks * tickSize
    commissionCost = entry * (commissionPct / 100) * 2  // Entry + exit
    totalCostPerShare = dist + slippageCost + commissionCost
    totalCostPerShare > syminfo.mintick ? math.floor(riskPerTrade / totalCostPerShare) : 0.0

var float entryPrice = na
var float initStop   = na
var float initRisk   = na
var bool  movedBE    = false

// Breakout events
longBreak  = canTrade and bias == 1 and ta.crossover(high, orHigh) and strategy.position_size == 0
shortBreak = canTrade and bias == -1 and ta.crossunder(low, orLow) and strategy.position_size == 0

if longBreak
    entryPrice := close
    initStop   := f_tighterStop(true, entryPrice, orHigh, orLow, atr)
    initRisk   := entryPrice - initStop
    movedBE    := false
    q = f_qty(entryPrice, initStop)
    if q >= 1
        strategy.entry("L", strategy.long, qty=q)

if shortBreak
    entryPrice := close
    initStop   := f_tighterStop(false, entryPrice, orHigh, orLow, atr)
    initRisk   := initStop - entryPrice
    movedBE    := false
    q = f_qty(entryPrice, initStop)
    if q >= 1
        strategy.entry("S", strategy.short, qty=q)

// Exits: TP + BE move (only recalculate if not already moved)
if strategy.position_size != 0 and initRisk > 0 and not movedBE
    if strategy.position_size > 0
        reachedBE = high >= entryPrice + beTriggerR * initRisk
        stopNow = reachedBE ? entryPrice : initStop
        if reachedBE
            movedBE := true
        tpNow = entryPrice + tpMultiple * initRisk
        strategy.exit("L-exit", "L", stop=stopNow, limit=tpNow)
    else
        reachedBE = low <= entryPrice - beTriggerR * initRisk
        stopNow = reachedBE ? entryPrice : initStop
        if reachedBE
            movedBE := true
        tpNow = entryPrice - tpMultiple * initRisk
        strategy.exit("S-exit", "S", stop=stopNow, limit=tpNow)
else if strategy.position_size != 0 and movedBE
    // Already moved to BE, just maintain TP
    if strategy.position_size > 0
        tpNow = entryPrice + tpMultiple * initRisk
        strategy.exit("L-exit", "L", stop=entryPrice, limit=tpNow)
    else
        tpNow = entryPrice - tpMultiple * initRisk
        strategy.exit("S-exit", "S", stop=entryPrice, limit=tpNow)

// Optional: close after window
if afterOR and curMin > tradeEndMin and strategy.position_size != 0
    strategy.close_all(comment="EndWindow")

// ===================== PLOTS =====================
plot(orHigh, "OR High", color=color.new(color.green, 0), linewidth=2, style=plot.style_linebr)
plot(orLow,  "OR Low",  color=color.new(color.red, 0), linewidth=2, style=plot.style_linebr)
plot(vwapVal, "VWAP", color=color.new(color.blue, 0))
plot(vwapAtOrEnd, "VWAP at OR End", color=color.new(color.blue, 50), linewidth=1, style=plot.style_cross)
```

## Summary of Changes

1. ✅ **VWAP Capture**: Store `vwapAtOrEnd` at OR end for accurate bias calculation
2. ✅ **OR Width**: Use `close` instead of `orMid` per requirements
3. ✅ **Daily Trades**: Count completed trades, not entries
4. ✅ **Break-Even**: Track `movedBE` to avoid unnecessary recalculations
5. ✅ **Position Sizing**: Account for commission and slippage in risk calculation
6. ✅ **Visual**: Added plot for VWAP at OR end for debugging

Your implementation is very clean overall! These fixes ensure it matches the requirements exactly.

