# Risk Sizing Engine

Converts a valid trade decision into a position sizing decision: risk percent, risk amount, ATR-based stop distance, position size, and max loss if stopped. Pure function API.

## Inputs

- **features** — Feature object from Feature Engine (must contain `atr` for stop distance).
- **regime** — Regime object (for pipeline consistency).
- **strategyDecision** — Strategy decision (for pipeline consistency).
- **tradeDecision** — Trade decision; sizing only runs when `shouldTrade === true` and `valid === true`.
- **account** — `{ equity: number, dailyPnL: number, openPositions: number }`.

Example account:

```js
{ equity: 500, dailyPnL: 0, openPositions: 0 }
```

## Output: valid sizing

```js
{
  shouldSize: true,
  valid: true,
  riskPercent: 0.01,
  riskAmount: 5,
  stopDistance: 4.5,
  positionSize: 1.11,
  maxLossIfStopped: 5,
  reason: "Risk sized using ATR stop and 1.0% account risk"
}
```

## Output: no sizing

```js
{
  shouldSize: false,
  valid: false,
  riskPercent: null,
  riskAmount: null,
  stopDistance: null,
  positionSize: null,
  maxLossIfStopped: null,
  reason: "Daily loss limit reached"
}
```

Other rejection reasons: `"Trade decision is no-trade"`, `"Account equity must be positive"`, `"Open positions (n) at or above max (m)"`, `"ATR unavailable or invalid; cannot compute stop distance"`.

## Rules

1. **No trade** — If `tradeDecision.shouldTrade` is false, return `shouldSize: false`.
2. **Stop distance** — By default ATR-based: `stopDistance = atr * stopAtrMultiplier` (default multiplier 1.0).
3. **Default risk settings** — `riskPercent = 0.01`, `stopAtrMultiplier = 1.0`, `maxDailyLossPercent = 0.02`, `maxOpenPositions = 5`.
4. **Reject sizing if** — `equity <= 0`, `openPositions >= maxOpenPositions`, or daily loss exceeds `maxDailyLossPercent` of equity.
5. **Position size** — `positionSize = riskAmount / stopDistance`, with `riskAmount = equity * riskPercent`; `maxLossIfStopped = riskAmount` (per position).

## Usage

```js
const { compute } = require('../features');
const { classify } = require('../regime');
const { select } = require('../strategies');
const { decide } = require('../execution');
const { size } = require('../risk');

const features = compute(ohlcvCandles);
const regime = classify(features);
const strategyDecision = select(features, regime);
const tradeDecision = decide(features, regime, strategyDecision);
const account = { equity: 500, dailyPnL: 0, openPositions: 0 };

const sizingDecision = size(features, regime, strategyDecision, tradeDecision, account);

if (sizingDecision.shouldSize) {
  // Use positionSize, stopDistance, riskAmount for order construction
} else {
  // sizingDecision.reason explains why no size
}
```

## Configurable options

Pass as sixth argument: `size(features, regime, strategyDecision, tradeDecision, account, options)`.

| Option | Default | Description |
|--------|---------|-------------|
| `riskPercent` | 0.01 | Fraction of equity to risk per trade (1%) |
| `stopAtrMultiplier` | 1.0 | Stop distance = atr × this |
| `maxDailyLossPercent` | 0.02 | Reject if daily loss ≥ this fraction of equity (2%) |
| `maxOpenPositions` | 5 | Reject if openPositions ≥ this |
| `minStopDistance` | 1e-6 | Floor for stop distance (avoids division by zero) |

## Extending

- **Custom stop distance:** use or extend `getStopDistance(features, opts)` (e.g. from trade decision’s `stopModel`).
- **Per-strategy risk:** pass different `riskPercent` or `stopAtrMultiplier` in `options` based on `tradeDecision.strategy` from the caller.
