# Research next steps

After you get a small sample with good structure (e.g. filtered trend_breakout with positive expectancy at 2R), the next step is **not** to add another random filter. Pick one of these three.

---

## Option 1 — Validate on more data

Run the **same pipeline** on:

- More history (longer dataset for the same symbol/timeframe), or
- Other comparable datasets (e.g. QQQ, other timeframes).

Goal: confirm the edge holds when sample size grows. No code change needed: add data, re-run research + trade sim.

---

## Option 2 — Control stability (by period)

Check whether the positive expectancy is driven by **a few periods only** (e.g. a couple of good months).

**In the engine:**

- `tradeSimulation.performanceBreakdownByPeriod(trades, { periodFormat: 'month' })` returns `{ byPeriod: { 'YYYY-MM': summary }, periodOrder }`.
- `exampleTradeSimulationFromResearch.js` prints a **by-period (month)** block after the regime breakdown when you run it (e.g. `node engine/exampleTradeSimulationFromResearch.js SPY 5m`).

Use it to see expectancyR per month. If only one or two months carry the result, the edge may be fragile.

---

## Option 3 — Audit the trades

Inspect **each** winning and losing trade to find the exact pattern:

- Do losses share a common form (e.g. same regime, same session slice)?
- Are certain breakout subtypes (e.g. long vs short, first bar vs later) still better?

**In the engine:**

- `tradeSimulation.formatTradesForAudit(trades)` returns an array of flat objects: `entryDate`, `direction`, `regime`, `outcome`, `barsHeld`, `entryPrice`, `rMultiple`, `strategy`, etc.
- Export to file:  
  `node engine/exampleTradeSimulationFromResearch.js SPY 5m audit`  
  writes `research/trade_audit_SPY_5m.json` for manual or scripted review.

---

## Bottom line

- **Your edge is not in “trend_breakout” in general.**  
- **Your edge is in a very filtered subset of trend_breakout** (e.g. BREAKOUT regime + strength + no open + late only + confirmation, etc.).

Small sample but good structure, and 2R is clearly validated on that sub-setup. Next: more data, stability by period, or trade-level audit — not another filter at random.
