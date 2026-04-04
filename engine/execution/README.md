# Trade Decision Engine (Execution)

Transforms a strategy decision into a trade decision: whether to trade, entry type, stop/target models, and risk-reward. Pure function API.

## Inputs

- **features** — Feature object from Feature Engine (used for reason enrichment).
- **regime** — `{ regime: string, confidence: number }` from Regime Engine.
- **strategyDecision** — `{ strategy, direction, confidence, reason, valid }` from Strategy Engine.

## Output: valid trade

```js
{
  shouldTrade: true,
  strategy: "trend_breakout",
  direction: "long",
  confidence: 0.78,
  entryType: "market",
  stopModel: "atr",
  targetModel: "rr_multiple",
  riskReward: 2.0,
  valid: true,
  reason: "TREND_UP, positive EMA slope, price above VWAP in TREND_UP regime"
}
```

## Output: no trade

```js
{
  shouldTrade: false,
  strategy: null,
  direction: null,
  confidence: 0,
  entryType: null,
  stopModel: null,
  targetModel: null,
  riskReward: null,
  valid: false,
  reason: "No valid trade decision"
}
```

When a threshold fails, `reason` explains which one (e.g. regime or strategy confidence below minimum).

## Rules

1. **Invalid strategy decision** → `shouldTrade: false`, no trade.
2. **Confidence below thresholds** → `shouldTrade: false`; reason indicates which threshold failed.
3. **trend_breakout**: `entryType: "market"`, `stopModel: "atr"`, `targetModel: "rr_multiple"`, `riskReward: 2.0`.
4. **mean_reversion**: `entryType: "market"`, `stopModel: "atr"`, `targetModel: "vwap_revert"`, `riskReward: 1.5`.

## Usage

```js
const { decide } = require('./engine/execution');

const tradeDecision = decide(features, regime, strategyDecision);

if (tradeDecision.shouldTrade) {
  // Use tradeDecision.entryType, stopModel, targetModel, riskReward for order construction
} else {
  // tradeDecision.reason explains why no trade
}
```

## Configurable options

Pass as fourth argument to `decide(features, regime, strategyDecision, options)`:

| Option | Default | Description |
|--------|---------|-------------|
| `minConfidence` | 0.4 | Minimum (strategy) confidence to allow a trade |
| `minRegimeConfidence` | 0.3 | Minimum regime confidence |
| `minStrategyConfidence` | 0.35 | Minimum strategy decision confidence |

## Strategy execution defaults

| Strategy | entryType | stopModel | targetModel | riskReward |
|----------|-----------|-----------|-------------|------------|
| trend_breakout | market | atr | rr_multiple | 2.0 |
| mean_reversion | market | atr | vwap_revert | 1.5 |

To add a new strategy’s execution params, extend `STRATEGY_EXECUTION_DEFAULTS` in `tradeDecisionEngine.js` and use `getExecutionParams(strategyName)` (or rely on the fallback: market / atr / rr_multiple / 1.5).
