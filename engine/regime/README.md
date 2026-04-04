# Regime Engine

Classifies market regime from the Feature Engine output. Pure function API.

## Regimes

| Regime           | Conditions |
|------------------|------------|
| `TREND_UP`       | price > ema20, ema20 > ema50, ema20Slope > 0 |
| `TREND_DOWN`     | price < ema20, ema20 < ema50, ema20Slope < 0 |
| `RANGE`          | ema20 close to ema50, price near VWAP, low volatility |
| `BREAKOUT`       | rangeState === 'expansion' && volumeSpike === true |
| `HIGH_VOLATILITY`| ATR% above threshold or volatility === 'high' |

## Usage

```js
const { compute } = require('../features');
const { classify, REGIMES } = require('./regime');

const features = compute(ohlcvCandles);
const { regime, confidence } = classify(features);
// e.g. { regime: 'TREND_UP', confidence: 0.75 }
```

## Options

Pass a second argument to `classify(features, options)` to override defaults:

- `rangeEmaProximityPct` — max |ema20−ema50|/ema50 for RANGE (default 0.005)
- `rangeVwapDistanceAtrMax` — max |vwapDistance| in ATR units for RANGE (default 0.5)
- `highVolatilityAtrPctMin` — min ATR% for HIGH_VOLATILITY (default 0.02)
- `minConfidenceToAssign` — minimum score to assign a non-RANGE regime (default 0.2)
- `priorityOrder` — order in which regimes are preferred when scores tie (default: BREAKOUT → HIGH_VOLATILITY → TREND_UP → TREND_DOWN → RANGE)
