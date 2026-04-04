# Strategy Engine

Selects an execution model based on market regime and features. Consumes Feature Engine output and Regime Engine output; returns a single strategy decision (or "no strategy").

## Decision shape

```js
{
  strategy: "trend_breakout" | "mean_reversion" | null,
  direction: "long" | "short" | null,
  confidence: number,  // 0..1
  reason: string,
  valid: boolean
}
```

When no strategy is valid (e.g. regime is `HIGH_VOLATILITY` or strategy conditions not met):

```js
{
  strategy: null,
  direction: null,
  confidence: 0,
  reason: "No valid strategy for current regime",
  valid: false
}
```

## Usage

```js
const { compute } = require('../features');
const { classify } = require('../regime');
const { select } = require('./strategies');

const features = compute(ohlcvCandles);
const regime = classify(features);
const decision = select(features, regime);

if (decision.valid) {
  // e.g. decision.strategy === 'trend_breakout', decision.direction === 'long'
} else {
  // No trade: decision.strategy === null
}
```

## Strategies

| Strategy         | Regimes              | Direction logic |
|------------------|----------------------|-----------------|
| **trend_breakout** | TREND_UP, TREND_DOWN, BREAKOUT | Long for TREND_UP, short for TREND_DOWN; BREAKOUT inferred from price vs EMA20/EMA50/VWAP |
| **mean_reversion** | RANGE                | Long when price &lt; VWAP, short when price &gt; VWAP |

## Regime → strategy mapping

- **TREND_UP** → trend_breakout (long)
- **TREND_DOWN** → trend_breakout (short)
- **BREAKOUT** → trend_breakout (direction inferred)
- **RANGE** → mean_reversion (direction from VWAP)
- **HIGH_VOLATILITY** → no strategy (`valid: false`)

## Options

Pass per-strategy options as the third argument to `select`:

```js
select(features, regime, {
  trend_breakout: { minRegimeConfidence: 0.4, volumeExpansionBoost: 0.15 },
  mean_reversion: { minStretchAtr: 0.3 }
});
```

See `trendBreakout.DEFAULT_OPTIONS` and `meanReversion.DEFAULT_OPTIONS` for available keys.

## Extending

1. Add a new module under `engine/strategies/` (e.g. `momentum.js`) with `name`, `applicableRegimes`, and `evaluate(features, regime, options)`.
2. Register it in `strategyEngine.js`: add to `STRATEGIES` and set `REGIME_TO_STRATEGY[REGIMES.XXX] = momentum` for the desired regime(s).
3. Export the new strategy from `index.js` if needed for direct use.
