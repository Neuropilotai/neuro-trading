# Signal Journal

Converts a pipeline signal into a flattened journal record for research, analytics, and future learning. Pure function; no database writes.

## Inputs

- **signal** — Full signal object from `signalPipeline.run()` (contains features, regime, strategyDecision, tradeDecision, sizingDecision, shouldTrade, valid, reason).
- **symbol** — Instrument identifier (e.g. `"XAUUSD"`).
- **timeframe** — Bar granularity (e.g. `"2m"`, `"1h"`).
- **timestamp** — Optional. `Date`, ISO string, or ms; used for the record and for ID generation. Default: now.

## Output: journal record

Flattened record suitable for logging, CSV, or future DB insert:

```js
{
  id: "sig_20260306_120501_XAUUSD_2m",
  timestamp: "2026-03-06T12:05:01.000Z",
  symbol: "XAUUSD",
  timeframe: "2m",
  shouldTrade: true,
  valid: true,
  regime: "TREND_UP",
  regimeConfidence: 0.74,
  strategy: "trend_breakout",
  direction: "long",
  strategyConfidence: 0.76,
  tradeConfidence: 0.76,
  riskPercent: 0.01,
  riskAmount: 5,
  stopDistance: 4.5,
  positionSize: 1.11,
  reason: "Valid trend breakout long with risk-sized position"
}
```

## No-trade signals

When `signal.valid` or `signal.shouldTrade` is false, strategy/direction/confidence and sizing fields are set to `null` where not applicable; `reason` is preserved from the pipeline.

```js
{
  id: "sig_20260306_120502_XAUUSD_2m",
  timestamp: "2026-03-06T12:05:02.000Z",
  symbol: "XAUUSD",
  timeframe: "2m",
  shouldTrade: false,
  valid: false,
  regime: "HIGH_VOLATILITY",
  regimeConfidence: 0.82,
  strategy: null,
  direction: null,
  strategyConfidence: null,
  tradeConfidence: null,
  riskPercent: null,
  riskAmount: null,
  stopDistance: null,
  positionSize: null,
  reason: "No valid strategy for current regime"
}
```

## ID format

Deterministic, timestamp-based: `sig_YYYYMMDD_HHMMSS_SYMBOL_TIMEFRAME`. Symbol and timeframe are sanitized (non-alphanumeric removed) so the ID is safe for filenames and keys.

## Usage

```js
const { run } = require('../signalPipeline');
const { toRecord } = require('./journal');

const signal = run(candles, account);
const record = toRecord(signal, 'XAUUSD', '2m', new Date());

// Append to log, push to array for later analytics, or pass to a future DB layer
console.log(record.id, record.reason);
```

## API

| Export | Description |
|--------|-------------|
| `toRecord(signal, symbol, timeframe, timestamp?)` | Convert signal to flattened journal record |
| `generateId(timestampISO, symbol, timeframe)` | Generate record ID (used internally) |
| `toISOTimestamp(ts)` | Normalize Date/string/number to ISO string |
| `PREFIX` | ID prefix: `"sig_"` |

## Extending

- Add fields to the record by reading from `signal.features`, `signal.regime`, etc., and extending the object returned in `toRecord`.
- Persistence (DB, file) can be implemented in a separate layer that consumes the record; this module remains pure and write-free.
